'use strict';

const { syntaxSpans } = require('../engine/textSyntax');

const VERSION = 'fragment-integrity-v2';
const MAX_ISSUES = 40;
const ORPHAN_ENDING = /^(다|니다|습니다)[.!?。！？](?=\s|$)/u;
const KOREAN_MARKERS = '가나다라마바사아자차카타파하';

// This audit is deliberately narrower than a grammar checker. It detects new
// source-relative boundary accidents, never deletes a tail or invents a join.
// Evidence contains UTF-16 positions only; no source/result text is emitted.
function auditFragmentIntegrity(sourceText, outputText) {
  const source = String(sourceText || '');
  const output = String(outputText || '');
  if (!source || !output || source === output) return result([]);
  const sourceInfo = analyzeLines(source);
  const outputInfo = analyzeLines(output);
  const issues = [];
  const oldOrphans = orphanEndings(sourceInfo);
  const newOrphans = orphanEndings(outputInfo);

  // Existing input damage is not labelled as a newly introduced error. Match
  // unchanged right context first, then retain only the excess by ending type.
  const allowance = new Map();
  for (const old of oldOrphans) {
    const values = allowance.get(old.ending) || [];
    values.push(old.context);
    allowance.set(old.ending, values);
  }
  const remaining = [];
  for (const item of newOrphans) {
    const values = allowance.get(item.ending) || [];
    const exact = values.indexOf(item.context);
    if (exact >= 0) values.splice(exact, 1);
    else remaining.push(item);
  }
  for (const item of remaining) {
    const values = allowance.get(item.ending) || [];
    if (values.length) { values.pop(); continue; }
    issues.push({
      code: 'introduced_orphan_ending',
      outputStart: item.start,
      outputEnd: item.end,
      predecessorStart: item.previousStart
    });
  }

  const sourceTails = sourceBrokenTails(sourceInfo);
  const existingRepeats = adjacentPredicateRepeatKeys(sourceInfo);
  for (let i = 1; i < outputInfo.lines.length; i += 1) {
    const line = outputInfo.lines[i];
    const previous = outputInfo.lines[i - 1];
    if (line.protected || previous.protected || !completeProse(previous.text)) continue;
    const head = shortPredicateHead(line.text);
    if (!head) continue;
    const key = predicateKey(head);
    const candidates = sourceTails.get(key) || [];
    // A repeated source tail does not establish which boundary owns it.
    if (candidates.length !== 1) continue;
    const prevKey = predicateKey(previous.text);
    if (!prevKey.endsWith(key) || prevKey.length <= key.length + 5) continue;
    // Exact repeats already present in the input are not new edit failures.
    if (existingRepeats.has(key)) continue;
    issues.push({
      code: 'introduced_duplicate_predicate_tail',
      sourceStart: candidates[0].start,
      sourceEnd: candidates[0].end,
      outputStart: line.start,
      outputEnd: line.start + head.length,
      predecessorStart: previous.start
    });
  }
  // A page-split dependent predicate may survive while only its left owner is
  // rewritten ("...하는 / 방식처럼 보였다" -> "...태도는 / 방식처럼 보였다").
  // Source-relative, unique and blank-line bounded; warning only, no deletion.
  for (let i = 1; i < outputInfo.lines.length; i++) {
    const tail = outputInfo.lines[i], left = outputInfo.lines[i - 1];
    if (tail.protected || left.protected || !/\n\s*\n/u.test(output.slice(left.end, tail.start))) continue;
    if (!/^[가-힣]{2,12}(?:처럼|으로)\s*(?:읽혔다|느껴졌다|보였다|여겨졌다)[.!?]$/u.test(tail.text)) continue;
    if (!/[가-힣]{2,}(?:은|는)$/u.test(left.text) || /(?:하는|되는|한|된|할|될|인)$/u.test(left.text)) continue;
    const owners = sourceInfo.lines.flatMap((line, j) => j > 0 && !line.protected && line.text === tail.text
      && !sourceInfo.lines[j - 1].protected ? [{ tail: line, left: sourceInfo.lines[j - 1] }] : []);
    if (owners.length !== 1 || !/(?:하는|되는|한|된|할|될|인)$/u.test(owners[0].left.text)) continue;
    issues.push({ code: 'introduced_dependent_tail_owner_shift', sourceStart: owners[0].left.start,
      sourceEnd: owners[0].tail.end, outputStart: left.start, outputEnd: tail.end });
  }
  return result(issues);
}

function result(issues) {
  return {
    version: VERSION,
    pass: issues.length === 0,
    codes: [...new Set(issues.map(issue => issue.code))],
    issueCount: issues.length,
    issues: issues.slice(0, MAX_ISSUES),
    truncated: issues.length > MAX_ISSUES
  };
}

function analyzeLines(text) {
  const spans = [];
  for (const span of syntaxSpans(text)) {
    if (!['quote', 'code', 'parenthetical'].includes(span.spanType)) continue;
    const previous = spans.at(-1);
    if (previous && previous.end >= span.start) previous.end = Math.max(previous.end, span.end);
    else spans.push({ start: span.start, end: span.end });
  }
  let spanCursor = 0;
  const lines = [];
  const pattern = /[^\r\n]+/gu;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = match.index + raw.indexOf(trimmed);
    const end = start + trimmed.length;
    const explicitStructure = /^(?:>|\|)|\t|\S {3,}\S|^\s*<\/?(?:table|tr|td|th)\b/iu.test(raw);
    while (spanCursor < spans.length && spans[spanCursor].end <= start) spanCursor += 1;
    const insideSyntax = spans[spanCursor]?.start <= start && spans[spanCursor]?.end > start;
    lines.push({ start, end, text: trimmed, protected: explicitStructure || insideSyntax });
  }
  // Do not trust a lone "다." classified as a list marker: that is the bug.
  // A nearby ordered neighbour, however, is concrete list/outline evidence.
  for (let i = 0; i < lines.length; i += 1) {
    if (hasOrderedNeighbour(lines, i)) lines[i].protected = true;
  }
  return { text, lines };
}

function markerIndex(text) {
  const marker = String(text || '').match(/^([가-하])[.)](?=\s|$)/u)?.[1];
  return marker ? KOREAN_MARKERS.indexOf(marker) : -1;
}

function hasOrderedNeighbour(lines, index) {
  const current = markerIndex(lines[index].text);
  if (current < 0) return false;
  for (const direction of [-1, 1]) {
    for (let distance = 1; distance <= 6; distance += 1) {
      const neighbour = lines[index + direction * distance];
      if (!neighbour || Math.abs(neighbour.start - lines[index].start) > 1800) break;
      const other = markerIndex(neighbour.text);
      if (other < 0) continue;
      if (other === current + direction) return true;
      break;
    }
  }
  return false;
}

function completeProse(text) {
  return String(text || '').length >= 10 && /[가-힣]/u.test(text)
    && /[.!?。！？]["”’』」')\]]*$/u.test(text);
}

function orphanEndings(info) {
  const found = [];
  for (let i = 1; i < info.lines.length; i += 1) {
    const line = info.lines[i];
    const previous = info.lines[i - 1];
    if (line.protected || previous.protected || !completeProse(previous.text)) continue;
    const ending = line.text.match(ORPHAN_ENDING)?.[0];
    if (!ending) continue;
    found.push({
      ending,
      start: line.start,
      end: line.start + ending.length,
      previousStart: previous.start,
      context: `${line.text.slice(ending.length)} ${info.lines[i + 1]?.text || ''}`.replace(/\s+/gu, ' ').trim().slice(0, 80)
    });
  }
  return found;
}

function shortPredicateHead(text) {
  // Short line-leading predicate only: not a whole repeated sentence with a
  // subject, label, quantity, quote or list marker. Longer repeats are semantic
  // audit territory, not grounds for automatic boundary repair.
  const head = String(text || '').match(/^[가-힣]{2,18}(?:[ \t]+[가-힣]{1,10}){0,2}[.!?。！？]/u)?.[0] || '';
  if (!head || head.replace(/\s/gu, '').length < 6 || head.length > 45) return '';
  if (!/(?:합니다|하였다|했다|하겠습니다|해야 한다|해야 합니다|해야겠습니다|하자|됩니다|되었다|된다|되겠습니다|있습니다|없습니다)[.!?。！？]$/u.test(head)) return '';
  if (/(?:은|는|이|가|을|를|의)\s/u.test(head)) return '';
  return head;
}

function predicateKey(value) {
  // This auxiliary variation is used only to *flag* a duplicate with an exact
  // unique source tail, never to delete it or claim semantic equivalence.
  return String(value || '').replace(/\s+/gu, '').replace(/해주어야/gu, '해야');
}

function sourceBrokenTails(info) {
  const tails = new Map();
  for (let i = 1; i < info.lines.length; i += 1) {
    const line = info.lines[i];
    const previous = info.lines[i - 1];
    if (line.protected || previous.protected || completeProse(previous.text)) continue;
    if (previous.text.length < 12 || /[:：.!?。！？]$/u.test(previous.text)) continue;
    const head = shortPredicateHead(line.text);
    if (!head) continue;
    const key = predicateKey(head);
    const entries = tails.get(key) || [];
    entries.push({ start: line.start, end: line.start + head.length });
    tails.set(key, entries);
  }
  return tails;
}

function adjacentPredicateRepeatKeys(info) {
  const keys = new Set();
  for (let i = 1; i < info.lines.length; i += 1) {
    const line = info.lines[i], previous = info.lines[i - 1];
    if (line.protected || previous.protected || !completeProse(previous.text)) continue;
    const head = shortPredicateHead(line.text);
    if (!head) continue;
    const key = predicateKey(head);
    if (predicateKey(previous.text).endsWith(key)) keys.add(key);
  }
  return keys;
}

module.exports = { VERSION, auditFragmentIntegrity };
