'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const { sentenceSimilarity } = require('./sentenceAlignment');
const CODES = ['numbered_subset_scope_candidate', 'anchored_relation_omission_candidate'];
const unique = (text, value) => value.length >= 12 && text.indexOf(value) >= 0
  && text.indexOf(value) === text.lastIndexOf(value);

// Bounded questions for the existing semantic judge. Neither a broader count
// nor a missing literal sentence proves a meaning change; no edits are made.
function candidates(source, candidate) {
  const before = String(source || ''), after = String(candidate || '');
  const sources = splitSentenceSpans(before), outputs = splitSentenceSpans(after);
  if (sources.length > 1000 || outputs.length > 1000) return [];
  const locked = text => syntaxSpans(text).filter(span => ['quote', 'code'].includes(span.spanType));
  const sourceLocks = locked(before), outputLocks = locked(after);
  const prose = (span, locks) => !locks.some(lock => lock.start < span.end && lock.end > span.start)
    && !/^\s*(?:>|#{1,6}\s|\|)/u.test(span.text);
  const found = [];
  const subset = sources.filter(span => {
    const match = span.text.match(/사례\s*([1-9]\d?)\s*(?:과|와|및|,)\s*(?:사례\s*)?([1-9]\d?)(?:은|는|이|가)[^.!?\n]{0,130}공통/u);
    return prose(span, sourceLocks) && match && match[1] !== match[2];
  });
  const numbers = { 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
  for (const output of outputs) {
    if (found.length >= 4) break;
    if (!prose(output, outputLocks)) continue;
    const frame = output.text.match(/(?:^|\s)(세|네|다섯|여섯|일곱|여덟|아홉|열|[3-9]|10)\s*(?:가지\s*)?사례(?:는|가|의|에서)[^.!?\n]{0,130}공통/u);
    if (!frame || !(numbers[frame[1]] || Number(frame[1]))) continue;
    const claim = output.text.split('공통')[0].replace(/[^가-힣]/gu, '');
    const ranked = subset.filter(span => {
      const original = span.text.split('공통')[0].replace(/[^가-힣]/gu, '');
      return [...Array(Math.max(0, claim.length - 9)).keys()].some(i => original.includes(claim.slice(i, i + 10)));
    }).map(span => ({ span, score: Math.max(sentenceSimilarity(span.text, output.text), sentenceSimilarity(output.text, span.text)) }))
      .sort((a, b) => b.score - a.score);
    if (!ranked[0] || ranked[0].score < 0.28 || (ranked[1] && ranked[0].score - ranked[1].score < 0.08)) continue;
    if (!unique(before, ranked[0].span.text) || !unique(after, output.text)) continue;
    found.push({ code: CODES[0], sourceSpan: ranked[0].span.text, outputSpan: output.text });
  }
  for (let i = 1; i < sources.length - 1 && found.length < 4; i++) {
    const row = sources[i], left = sources[i - 1], right = sources[i + 1];
    // A relational interpretation disappeared between two verbatim anchors.
    // Limit this nomination to an explicit gap/lag relation, not generic prose.
    if (row.text.length > 400 || !/(?:사이|간)[^.!?\n]{0,35}(?:시차|격차|간극)/u.test(row.text)
        || !prose(row, sourceLocks) || !prose(left, sourceLocks) || !prose(right, sourceLocks)
        || after.includes(row.text) || !unique(before, row.text)
        || !unique(before, left.text) || !unique(before, right.text)
        || !unique(after, left.text) || !unique(after, right.text)) continue;
    const at = outputs.findIndex(span => span.text === left.text);
    if (at < 0 || outputs[at + 1]?.text !== right.text
        || !prose(outputs[at], outputLocks) || !prose(outputs[at + 1], outputLocks)) continue;
    const outputSpan = after.slice(outputs[at].start, outputs[at + 1].end);
    if (unique(after, outputSpan)) found.push({ code: CODES[1], sourceSpan: row.text, outputSpan });
  }
  return found;
}

function unresolvedWarnings(rows, semanticState) {
  if (semanticState === 'verified_pass') return [];
  const codes = new Set((rows || []).map(row => row.code));
  return CODES.filter(code => codes.has(code)).map(code => ({
    code: code === CODES[0] ? 'numbered_subset_scope_review' : 'anchored_relation_omission_review',
    severity: 'warning',
    message: code === CODES[0]
      ? '사례의 공통점을 설명하는 대상 범위를 확정하지 못했어요. 원문과 결과를 대조해 주세요.'
      : '원문의 관계 설명이 다른 위치나 표현으로 유지됐는지 확정하지 못했어요. 앞뒤 문장과 함께 대조해 주세요.'
  }));
}
const instruction = 'numbered_subset_scope_candidate는 번호로 한정된 일부 사례의 공통점이 더 많은 사례 전체로 넓어졌는지 묻는다. 뒤에 차이점이 남아 있어도 앞의 공통 서술 범위가 같다는 증거는 아니다. 원문 전체가 더 넓은 공통점을 실제로 뒷받침하면 preserved이다. anchored_relation_omission_candidate는 두 동일한 앞뒤 문장 사이의 시차·격차·간극 설명이 결과에서 사라졌는지 묻는다. 결과 전체와 인접 문장에서 이동·의역·통합된 동등한 해석 및 인과 관계를 반드시 찾아보고, 주변 사실 서술이 남은 것과 그 사실에서 도출한 별도 해석이 남은 것을 구별한다. 후보만으로 오류나 전체 의미 유실을 단정하지 않는다. 실제 변화가 확인될 때만 정확한 introduced violation을 쓰며, 불확실하면 uncertain으로 답한다. 숫자 치환·문장 자동 복원은 금지한다.';

module.exports = { CODES, candidates, unresolvedWarnings, instruction };
