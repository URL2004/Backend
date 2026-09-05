'use strict';

const INLINE_CODE_RE = /(?<!`)`([^`\n]+)`(?!`)/gu;
const URL_LITERAL_RE = /https?:\/\/[^\s<>"'“”‘’]+|www\.[^\s<>"'“”‘’]+/giu;
const MATH_LITERAL_RE = /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|(?<![$\\])\$(?!\$)(?:\\.|[^$\n\\]){1,500}(?<!\\)\$(?!\$)|(?<![A-Za-z0-9_])R_?\d+\s*(?:←|<-|=)\s*R_?\d+(?:\s*[+−-]\s*(?:\d+(?:\.\d+)?\s*)?R_?\d+)?|(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_]*\s*=\s*[−-]?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?(?:\s*,\s*[A-Za-z][A-Za-z0-9_]*\s*=\s*[−-]?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?){0,8}(?![A-Za-z0-9_])/gu;

function freezeInlineCode(value) {
  const source = String(value || '');
  const blocks = [];
  const text = source.replace(INLINE_CODE_RE, match => {
    const token = `ZXQCODE${String(blocks.length).padStart(4, '0')}QXZ`;
    blocks.push({ token, value: match });
    return token;
  });
  return { text, blocks, count: blocks.length };
}

function restoreInlineCode(value, frozen) {
  let text = String(value || '');
  const missing = [];
  for (const block of frozen?.blocks || []) {
    const occurrences = text.split(block.token).length - 1;
    if (occurrences !== 1) {
      missing.push(block.token);
      continue;
    }
    text = text.replace(block.token, block.value);
  }
  return {
    text,
    pass: missing.length === 0,
    restoredCount: (frozen?.blocks || []).length - missing.length,
    missingCount: missing.length
  };
}

// 토큰 복원 뒤에 실행되는 모델 기반 공백 수리나 한국어 결정론 수리가
// 인라인 코드 리터럴까지 건드리지 못하게 최종 출력의 코드 span을 원문
// 순서대로 다시 고정한다. 개수나 순서가 달라진 경우에는 위치를 추측해
// 삽입하지 않고 감사 실패로 남긴다.
function restoreInlineCodeByOrder(value, frozen) {
  const before = String(value || '');
  const expected = frozen?.blocks || [];
  if (!expected.length) {
    return { text: before, pass: true, orderPass: true, applied: false, restoredCount: 0, missingCount: 0 };
  }
  const spans = [...before.matchAll(INLINE_CODE_RE)].map(match => ({
    start: Number(match.index || 0),
    end: Number(match.index || 0) + match[0].length,
    value: match[0]
  }));
  if (spans.length !== expected.length) {
    return {
      text: before,
      pass: false,
      orderPass: false,
      applied: false,
      restoredCount: 0,
      missingCount: Math.abs(expected.length - spans.length) || 1
    };
  }
  let text = before;
  let restoredCount = 0;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    const original = expected[index].value;
    if (span.value === original) continue;
    text = `${text.slice(0, span.start)}${original}${text.slice(span.end)}`;
    restoredCount += 1;
  }
  return {
    text,
    pass: true,
    orderPass: true,
    applied: restoredCount > 0,
    restoredCount,
    missingCount: 0
  };
}

function freezeMath(value) {
  const source = String(value || '');
  const spans = mathSpans(source);
  const blocks = spans.map((span, index) => ({ token: `ZXQMATH${String(index).padStart(4, '0')}QXZ`, value: span.value }));
  let text = source;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    text = text.slice(0, span.start) + blocks[index].token + text.slice(span.end);
  }
  return { text, blocks, count: blocks.length };
}

// URL query parameters and inline code are literals with their own owners.
// Use the same exclusions before tokenization and after literal restoration;
// otherwise a preserved URL such as ?v=2 looks like a new or missing equation.
function mathSpans(value) {
  const source = String(value || '');
  const excluded = [...source.matchAll(URL_LITERAL_RE), ...source.matchAll(INLINE_CODE_RE)]
    .map(match => ({ start: match.index, end: match.index + match[0].length }))
    .sort((left, right) => left.start - right.start);
  let cursor = 0;
  return [...source.matchAll(MATH_LITERAL_RE)].filter(match => {
    while (cursor < excluded.length && excluded[cursor].end <= match.index) cursor += 1;
    return !excluded[cursor] || match.index < excluded[cursor].start;
  }).map(match => ({ start: match.index, end: match.index + match[0].length, value: match[0] }));
}

function restoreMath(value, frozen) {
  let text = String(value || '');
  const missing = [];
  const positions = [];
  for (const block of frozen?.blocks || []) {
    const occurrences = text.split(block.token).length - 1;
    if (occurrences !== 1) {
      missing.push(block.token);
      continue;
    }
    positions.push(text.indexOf(block.token));
  }
  const orderPass = positions.every((position, index) => index === 0 || position > positions[index - 1]);
  for (const block of frozen?.blocks || []) {
    if (missing.includes(block.token)) continue;
    text = text.replace(block.token, block.value);
  }
  return {
    text,
    pass: missing.length === 0 && orderPass,
    orderPass,
    restoredCount: (frozen?.blocks || []).length - missing.length,
    missingCount: missing.length,
    applied: (frozen?.blocks || []).length > missing.length
  };
}

// 토큰을 복원한 뒤의 공백·레이아웃 보정이나 제한적 후단 수리가 수식 내부를
// 건드렸는지 마지막 고정점에서 다시 확인한다. 수식 구획의 개수와 순서가
// 그대로일 때만 원문의 리터럴을 같은 위치에 되돌리며, 누락된 수식을 추측해
// 새 위치에 삽입하지 않는다.
function restoreMathByOrder(value, frozen) {
  const before = String(value || '');
  const expected = frozen?.blocks || [];
  if (!expected.length) {
    return { text: before, pass: true, orderPass: true, applied: false, restoredCount: 0, missingCount: 0 };
  }
  const spans = mathSpans(before);
  if (spans.length !== expected.length) {
    return {
      text: before,
      pass: false,
      orderPass: false,
      applied: false,
      restoredCount: 0,
      missingCount: Math.abs(expected.length - spans.length) || 1
    };
  }
  let text = before;
  let restoredCount = 0;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    const original = expected[index].value;
    if (span.value === original) continue;
    text = `${text.slice(0, span.start)}${original}${text.slice(span.end)}`;
    restoredCount += 1;
  }
  return {
    text,
    pass: true,
    orderPass: true,
    applied: restoredCount > 0,
    restoredCount,
    missingCount: 0
  };
}

module.exports = {
  freezeInlineCode,
  restoreInlineCode,
  restoreInlineCodeByOrder,
  freezeMath,
  restoreMath,
  restoreMathByOrder
};
