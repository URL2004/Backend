'use strict';

const { syntaxSpans } = require('../engine/textSyntax');
// Explicit punctuation distinguishes enumeration from family/order nouns
// (첫째 아이, 두 번째 실험). Never infer or renumber a missing item.
const ORDINAL = '(?:(?:첫|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열|열한|열두|열세|열네|열다섯|열여섯|열일곱|열여덟|열아홉|스무)째|(?:첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\\s*번째)';
const PREFIX = new RegExp(`^(\\s*${ORDINAL}[,，:：]\\s*)(\\S[\\s\\S]*)$`, 'u');
// Explicit enumerative predicate frames, not arbitrary ordinal adjectives
// such as "첫 번째 실험" or "첫째 아이". These may have no comma.
const FRAME_LEAD = '(?:(?:본|이번|해당)\\s*(?:연구|조사|분석|프로젝트)의\\s+)?';
const FRAME_TAIL = '\\s+(?:의의|이유|목적|한계|원칙|특징|과제|장점|문제|요인)(?:은|는)\\s+';
// Lock only the enumerator. Keep the grammatical subject ("의의는")
// with its predicate in the editable body; otherwise a model seeing only
// the complement can turn "의의는 ... 점이다" into "의의는 ... 했다".
const FRAME_PREFIX = new RegExp(`^(\\s*${FRAME_LEAD}${ORDINAL}\\s+)((?:의의|이유|목적|한계|원칙|특징|과제|장점|문제|요인)(?:은|는)\\s+\\S[\\s\\S]*)$`, 'u');

function ordinalPrefix(value) {
  return String(value || '').match(PREFIX) || String(value || '').match(FRAME_PREFIX);
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
