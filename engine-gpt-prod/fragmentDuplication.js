'use strict';
const { syntaxSpans } = require('../engine/textSyntax');

// A long clause may not be copied into a second prose paragraph when neither
// literal nor closely paraphrased source repetition accounts for it.
// Report positions, never the text. Quotations, code and table rows are exempt;
// intentional repetition already present in the source is not a new defect.
function introducedClauseDuplicates(source, output) {
  const normalize = s => String(s || '').replace(/\s/gu, '');
  const old = normalize(source), text = String(output || '');
  if (old.length > 100000 || text.length > 100000) return [];
  if (!/\n\s*\n/u.test(text)) return [];
  const syntax = syntaxSpans(text).filter(s => ['quote','code'].includes(s.spanType));
  const sourceSentences = require('../engine/koreanText').splitSentences(source).map(normalize);
  // A source can repeat the same thesis under different introductory words.
  // After a substantial paraphrase, 65% character overlap is not reliable
  // evidence that repetition was introduced. If a repeated long source claim
  // exists and the candidate clause itself is paraphrased, abstain from the
  // hard gate: deciding which repeated claim it represents needs semantics.
  const repeatedSource = [], sourceGrams = new Map();
  for (let row = 0; row < sourceSentences.length; row++) {
    const sentence = sourceSentences[row];
    for (let n = 0; n + 36 <= sentence.length; n++) {
      const key = sentence.slice(n, n + 36);
      if (/[.!?。！？]/u.test(key)) continue;
      const prior = sourceGrams.get(key);
      if (prior !== undefined && prior !== row) { repeatedSource.push(sentence); break; }
      sourceGrams.set(key, row);
    }
  }
  const inherited = key => {
    const pairs = new Set(Array.from({ length: key.length - 1 }, (_, i) => key.slice(i, i + 2)));
    if (repeatedSource.length && !old.includes(key)) return true;
    let matches = 0;
    for (const sentence of sourceSentences) {
      let found = 0; for (const pair of pairs) if (sentence.includes(pair)) found++;
      if (found / pairs.size >= .65 && ++matches >= 2) return true;
    }
    return false;
  };
  const grams = new Map(), issues = [], used = new Set();
  let offset = 0;
  for (const paragraph of text.split(/\n\s*\n/u)) {
    const start = text.indexOf(paragraph, offset); offset = start + paragraph.length;
    if (/\t|^\s*\||^\s*(?:출처|참고문헌|자료)\s*:/u.test(paragraph)) continue;
    const p = normalize(paragraph);
    for (let i = 0; i + 36 <= p.length; i++) {
      const key = p.slice(i, i + 36);
      if (!/[가-힣]{2}/u.test(key) || /[.!?。！？]/u.test(key)) continue;
      const at = old.indexOf(key);
      if (at >= 0 && at !== old.lastIndexOf(key)) continue;
      // Exempt a paragraph wholly/partly owned by a quotation. Source-relative
      // quote integrity already checks attribution and permits quoted repeats.
      if (syntax.some(s => s.start < start + paragraph.length && s.end > start)) continue;
      const prior = grams.get(key);
      if (prior !== undefined && prior !== start && !used.has(start)) {
        if (inherited(key)) continue;
        issues.push({ code: 'introduced_unique_clause_duplication', outputStart: start,
          outputEnd: start + paragraph.length, predecessorStart: prior });
        used.add(start); break;
      }
      grams.set(key, start);
    }
  }
  return issues.slice(0, 20);
}
function introducedResidualTails(source, output) {
  const { splitSentenceSpans, splitSentences, ngramSet } = require('../engine/koreanText');
  const bare = s => String(s).replace(/\s/gu, '');
  if (String(source || '').length > 100000 || String(output || '').length > 100000) return [];
  // This narrow lexical equivalence applies only to ownership of a physical
  // dependent tail. It never rewrites text or infers a missing noun/predicate.
  const tailKey = s => bare(s).replace(/(?:나누어|구분해|구분하여)(?=관리(?:한다|했다|합니다)[.!?]$)/u, '구분해');
  const old = splitSentences(String(source || '').replace(/\r?\n+/gu,' ')).map(bare), spans = splitSentenceSpans(output), findings = [];
  const literals = syntaxSpans(output).filter(s => ['quote','code'].includes(s.spanType));
  for (let i = 1; i < spans.length; i++) {
    const right = spans[i], left = spans[i-1], tail = right.text.trim();
    // Dependent instrumental tails have no subject and cannot stand alone.
    const match = tail.match(/^([가-힣]{2,8})(?:으로|로)\s+[가-힣]{2,8}\s+([가-힣]{2,8}(?:한다|했다|됩니다|합니다))[.!?]$/u);
    if (!match || tail.length > 45 || left.text.length < tail.length * 2
        || !/\n\s*\n/u.test(String(output).slice(left.end,right.start))
        || literals.some(s => s.start < right.end && s.end > left.start)) continue;
    const key = tailKey(tail), owners = old.filter(s => tailKey(s).endsWith(key));
    if (owners.length !== 1 || owners[0].length < key.length * 2
        || !left.text.includes(match[1]) || !bare(left.text).endsWith(match[2] + tail.at(-1))) continue;
    const a = ngramSet(owners[0],2), b = ngramSet(bare(left.text),2);
    let common=0; for (const x of a) if(b.has(x)) common++;
    if (common / Math.max(1,a.size+b.size-common) < .45) continue;
    findings.push({code:'introduced_redundant_dependent_tail',outputStart:right.start,outputEnd:right.end,predecessorStart:left.start});
  }
  return findings.slice(0,20);
}
// Request-local bounded cache only. Repeated candidate/final audits share the
// result, while a later user/request cannot retain or observe these strings.
function cached(kind, audit) {
  return (source, output, { preserveLines = false } = {}) => {
    if (preserveLines) return [];
    const a = String(source || ''), b = String(output || '');
    return require('../engine/textAnalysisCache').memoizeSpans(kind, a.length + ':' + a + b, () => audit(a, b));
  };
}
module.exports = {
  introducedClauseDuplicates: cached('introduced-clause-duplicates-v1', introducedClauseDuplicates),
  introducedResidualTails: cached('introduced-residual-tails-v1', introducedResidualTails)
};
