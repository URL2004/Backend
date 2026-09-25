'use strict';

const { syntaxSpans } = require('../engine/textSyntax');
// Explicit punctuation distinguishes enumeration from family/order nouns
// (첫째 아이, 두 번째 실험). Never infer or renumber a missing item.
const ORDINAL = '(?:(?:첫|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열|열한|열두|열세|열네|열다섯|열여섯|열일곱|열여덟|열아홉|스무)째|(?:첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\\s*번째)';
const PREFIX = new RegExp(`^(\\s*${ORDINAL}[,，:：]\\s*)(\\S[\\s\\S]*)$`, 'u');
// Explicit enumerative predicate frames, not arbitrary ordinal adjectives
// such as "첫 번째 실험" or "첫째 아이". These may have no comma.
const FRAME_LEAD = '(?:(?:본|이번|해당)\\s*(?:연구|조사|분석|프로젝트)의\\s+)?';
const FRAME_NOUN = '(?:의의|이유|목적|한계|원칙|특징|과제|장점|문제|요인)';
const FRAME_TAIL = `\\s+${FRAME_NOUN}(?:(?:은|는|로는|으로는)\\s+|(?:로|으로)[,，:：]\\s*)`;
function ordinalPrefix(value) {
  // A comma enumerator is syntactically independent; a frame such as
  // "본 연구의 첫 번째 의의는" is not. Keep the entire frame sentence
  // editable, and enforce its ordinal through the structural signature.
  // Splitting even just "첫 번째" can create "첫 번째 개 물림 사고...".
  return String(value || '').match(PREFIX);
}

function ordinalNumber(value) {
  const ordinal = String(value).replace(/\s+/gu, '');
  const roots = ['첫', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '열한', '열두', '열세', '열네', '열다섯', '열여섯', '열일곱', '열여덟', '열아홉', '스무'];
  const root = ordinal.replace(/(?:번째|째)$/u, '');
  return roots.indexOf(({ 두: '둘', 세: '셋', 네: '넷' })[root] || root) + 1;
}

function ordinalMarkers(value) {
  const text = String(value || '');
  const literals = syntaxSpans(text);
  const re = new RegExp(`(^[ \\t]*|\\n[ \\t]*|[.!?。！？][ \\t]+)(${ORDINAL})[,，:：](?=\\s|[가-힣A-Za-z])`, 'gu');
  const markers = [];
  for (const match of text.matchAll(re)) {
    const start = match.index + match[1].length;
    if (literals.some(span => span.start <= start && span.end > start)) continue;
    markers.push({ marker: match[2].replace(/\s+/gu, ''), number: ordinalNumber(match[2]), start,
      lineOrdinal: text.slice(0, start).split('\n').length });
  }
  const frames = new RegExp(`(^[ \\t]*|\\n[ \\t]*|[.!?。！？][ \\t]+)(${FRAME_LEAD})(${ORDINAL})${FRAME_TAIL}`, 'gu');
  for (const match of text.matchAll(frames)) {
    const boundaryStart = match.index + match[1].length;
    const start = boundaryStart + match[2].length;
    if (literals.some(span => span.start <= start && span.end > start)) continue;
    markers.push({ marker: match[3].replace(/\s+/gu, ''), number: ordinalNumber(match[3]), start,
      boundaryStart, lineOrdinal: text.slice(0, start).split('\n').length });
  }
  // An editable frame may move its ordinal into the predicate without
  // losing the enumeration: "첫 번째 의의는 X다" -> "X가 첫 번째 의의다".
  // Count only explicit affirmative copulas, never arbitrary ordinal nouns,
  // quoted discussion, negation or references to another item's contents.
  const predicates = new RegExp(`(?<![가-힣])(${ORDINAL})\\s+${FRAME_NOUN}(?:이다|다|입니다)(?=[.!?。！？\\s(]|$)`, 'gu');
  for (const match of text.matchAll(predicates)) {
    const start = match.index;
    if (literals.some(span => span.start <= start && span.end > start)) continue;
    markers.push({ marker: match[1].replace(/\s+/gu, ''), number: ordinalNumber(match[1]), start,
      predicateFrame: true, lineOrdinal: text.slice(0, start).split('\n').length });
  }
  return markers.sort((a, b) => a.start - b.start);
}

// Only restore a visual boundary for a source-backed list. Never invent a
// missing ordinal, infer a list from family nouns, or move an item's words.
function restoreOrdinalParagraphGaps(source, value) {
  let text = String(value || '');
  const sourceText = String(source || '');
  const before = ordinalMarkers(sourceText), after = ordinalMarkers(text);
  if (before.length < 2 || before.length !== after.length
      || before.some((item, i) => item.number !== after[i].number)) return { text, repairCount: 0 };
  let repairCount = 0;
  for (let i = after.length - 1; i >= 0; i--) {
    // A predicate is part of its sentence, not an item-start boundary.
    if (after[i].predicateFrame || before[i].predicateFrame) continue;
    const sourceStart = before[i].boundaryStart ?? before[i].start;
    const sourceLine = sourceText.slice(sourceText.lastIndexOf('\n', sourceStart - 1) + 1, sourceStart);
    if (sourceLine.trim()) continue;
    const right = after[i].boundaryStart ?? after[i].start;
    let left = right;
    while (left > 0 && /\s/u.test(text[left - 1])) left--;
    if (!left || left === right || /\n[ \t]*\n/u.test(text.slice(left, right))) continue;
    text = text.slice(0, left) + '\n\n' + text.slice(right);
    repairCount++;
  }
  return { text, repairCount };
}

module.exports = { ordinalPrefix, ordinalMarkers, restoreOrdinalParagraphGaps };
