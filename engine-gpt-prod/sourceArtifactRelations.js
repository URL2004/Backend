'use strict';

const { syntaxSpans } = require('../engine/textSyntax');
const { locateEvidenceSpan } = require('./evidenceSpan');
const VERSION = 'source-artifact-relations-v1';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const complete = /(?:다|요|음|함|임|됨)[.!?。！？][”’"']?\s*$/u;
const particle = /^(?:에서는|에서도|에게|에서|으로|의|은|는|이|가|을|를|와|과|로)(?=\s|[,.;:!?]|$)/u;

// These are nominal-label candidates, not verified references. Repetition in
// the user's document plus an explicit completed-sentence/physical-row seam
// is required. No publisher/name dictionary and no text deletion or locking.
function trailingLabels(value) {
  const source = String(value || ''), protectedSpans = syntaxSpans(source).filter(s => s.spanType !== 'parenthetical');
  const grouped = new Map();
  for (const row of source.matchAll(/[^\r\n]+/gu)) {
    if (/^\s*(?:[>|]|```|~~~)/u.test(row[0])) continue;
    const match = row[0].match(/([.!?。！？])[ \t]+([^.!?。！？:：;；|\t]{2,48})\s*$/u);
    if (!match) continue;
    const label = match[2].trim(), start = row.index + match.index + match[1].length + (match[0].slice(1).match(/^[ \t]+/u)?.[0].length || 0);
    if (!complete.test(source.slice(row.index, start)) || label.split(/\s+/u).length > 4) continue;
    // Latin labels must look nominal, not a lower-case English continuation.
    if (!/^(?:[A-Z][A-Za-z0-9&'-]*)(?: [A-Z][A-Za-z0-9&'-]*){0,3}$/u.test(label)
        && !/^[가-힣]{2,12}(?: [가-힣]{2,12}){0,3}$/u.test(label)) continue;
    if (/[가-힣](?:은|는|이|가|을|를|의|에서|다|요|며|고)$/u.test(label)) continue;
    if (protectedSpans.some(span => span.start < start + label.length && span.end > start)) continue;
    const after = source.slice(row.index + row[0].length);
    if (!/^[\r\n]+\S/u.test(after)) continue;
    const list = grouped.get(label) || [];
    list.push({ start, end: start + label.length, rowEnd: row.index + row[0].length });
    grouped.set(label, list);
  }
  return [...grouped].filter(([, occurrences]) => occurrences.length >= 2)
    .map(([label, occurrences]) => ({ label, occurrences }));
}

function labelSeamLines(value) {
  const source = String(value || '');
  return new Set(trailingLabels(source).flatMap(row => row.occurrences.map(o => source.slice(0, o.rowEnd).split('\n').length - 1)));
}

function windowAt(text, start, end = start + 1) {
  // Bounded exact context, never concatenated/reworded evidence. Include the
  // preceding sentence so a trailing label is not mistaken for a new actor.
  return text.slice(Math.max(0, start - 160), Math.min(text.length, end + 180)).trim();
}
function occurrences(text, label) {
  return [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escape(label)}(?![A-Za-z0-9])`, 'gu'))];
}
function labelBindingCandidates(source, output, documentSource = source) {
  const out = [], protectedSource = syntaxSpans(source), protectedOutput = syntaxSpans(output);
  for (const { label } of trailingLabels(documentSource)) {
    const left = occurrences(source, label), right = occurrences(output, label);
    // Repeated occurrences have ordinal ownership only when counts agree.
    // Lost/duplicated labels belong to the existing content-coverage audit.
    if (!left.length || left.length !== right.length) continue;
    for (let i = 0; i < left.length; i += 1) {
      const a = left[i].index, b = right[i].index;
      if (!complete.test(source.slice(Math.max(0, a - 200), a))) continue;
      if (particle.test(source.slice(a + label.length)) || !particle.test(output.slice(b + label.length))) continue;
      if (protectedSource.some(s => s.start < a + label.length && s.end > a)
          || protectedOutput.some(s => s.start < b + label.length && s.end > b)) continue;
      out.push({ code: 'source_label_binding_candidate', sourceSpan: windowAt(source, a, a + label.length),
        outputSpan: windowAt(output, b, b + label.length), advisory: true });
    }
  }
  return out.slice(0, 6);
}

// Parentheses only: quotation alphabets and mathematical angle operators have
// different ownership rules. Ignore code, URLs and explicit list ordinals.
function unmatchedParentheses(value) {
  const source = String(value || ''), ignored = syntaxSpans(source).filter(s => s.spanType === 'code' || s.spanType === 'quote');
  for (const m of source.matchAll(/(?:https?:\/\/|www\.)\S+/gu)) ignored.push({ start: m.index, end: m.index + m[0].length });
  for (const row of source.matchAll(/[^\r\n]+/gu)) {
    if (require('./layoutStructure').isFormulaLine(row[0])) ignored.push({ start: row.index, end: row.index + row[0].length });
  }
  const stacks = { '(': [], '（': [] }, openFor = { ')': '(', '）': '（' }, result = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (!'()（）'.includes(ch) || ignored.some(s => s.start <= i && i < s.end)) continue;
    if (stacks[ch]) { stacks[ch].push(i); continue; }
    const rowStart = source.lastIndexOf('\n', i) + 1;
    if (ch === ')' && /^\s*(?:\d{1,3}|[A-Za-z가-하])$/u.test(source.slice(rowStart, i)) && /\s/u.test(source[i + 1] || '')) continue;
    const stack = stacks[openFor[ch]];
    if (stack.length) stack.pop();
    else result.push({ glyph: ch, kind: 'close', start: i });
  }
  for (const [glyph, stack] of Object.entries(stacks)) for (const start of stack) result.push({ glyph, kind: 'open', start });
  return result.sort((a, b) => a.start - b.start);
}

function delimiterCandidates(source, output) {
  const left = unmatchedParentheses(source), right = unmatchedParentheses(output), out = [];
  for (const item of right) {
    if (right.filter(r => r.glyph === item.glyph).length <= left.filter(r => r.glyph === item.glyph).length) continue;
    const context = (text, at) => text.slice(Math.max(0, at - 24), at + 25).replace(/\s+/gu, ' ');
    if (left.some(old => old.glyph === item.glyph && context(source, old.start) === context(output, item.start))) continue;
    // A nearby unchanged unique anchor locates the source context. Counts alone
    // are insufficient evidence, and no glyph is removed or inserted here.
    const anchors = [output.slice(item.start + 1, item.start + 61).trim(), output.slice(Math.max(0, item.start - 60), item.start).trim()];
    let paired = null;
    for (const anchor of anchors) {
      const located = locateEvidenceSpan(source, anchor, 16);
      if (located) { paired = located; break; }
    }
    if (!paired) continue;
    out.push({ code: 'introduced_delimiter_imbalance_candidate', sourceSpan: windowAt(source, paired.start, paired.end),
      outputSpan: windowAt(output, item.start), advisory: true });
  }
  return out.slice(0, 4);
}

function candidates(source, output, { documentSource = '' } = {}) {
  const before = String(source || ''), after = String(output || '');
  if (!before || !after || before === after) return [];
  return [...labelBindingCandidates(before, after, documentSource || before), ...delimiterCandidates(before, after)];
}
const instruction = 'source_label_binding_candidate는 완결 문장 끝과 물리적 줄바꿈에서 반복 확인된 명목 표식에 결과가 새 조사·소유격을 붙였는지 대조하는 질문이다. 출처명이라는 단정이나 삭제 지시가 아니다. 원문의 모호함·정상 행위 주체를 존중하고 실제 귀속 변화만 changed로 판단한다. introduced_delimiter_imbalance_candidate는 코드·URL·목록 번호를 제외한 원문 대비 괄호 미대응 증가의 국소 검토 요청이다. 원문의 기존 불균형을 새 오류로 세지 말고, 닫는 괄호 자동 삭제나 여는 괄호 추측 추가를 하지 않는다. 두 후보 모두 문맥상 정상은 preserved, 실제 신규 오류는 정확한 violation과 changed, 불명확하면 uncertain으로 보고한다. 후보만으로 점수·품질을 차감하지 않는다.';
module.exports = { VERSION, trailingLabels, labelSeamLines, unmatchedParentheses, candidates, instruction };
