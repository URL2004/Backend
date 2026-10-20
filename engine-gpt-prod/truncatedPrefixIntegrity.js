'use strict';
const { syntaxSpans } = require('../engine/textSyntax');
const { sentenceSimilarity } = require('./sentenceAlignment');

// A source sentence cut inside a word at a physical line break can be retained
// as an unfinished prefix before its full rewrite. Only diagnose the uniquely
// owned prefix plus adjacent rewrite; never guess how to delete or complete it.
function audit(source, output) {
  if (source.length > 100000 || output.length > 100000 || !/\n\s*\n/u.test(output)) return [];
  // Some extracted sources use reversed curly quotes around short titles.
  // Recognize those exact local pairs so their closing/opening marks do not
  // masquerade as one quotation spanning the intervening prose. Keep both
  // actual title spans protected; ordinary multi-paragraph quotes stay intact.
  const reversed = [...output.matchAll(/’[^’‘\n]{1,100}‘|”[^”“\n]{1,100}“/gu)]
    .map(m => ({ start: m.index, end: m.index + m[0].length }));
  const protectedSpans = syntaxSpans(output).filter(s => ['quote', 'code', 'parenthetical'].includes(s.spanType)
    && !(s.spanType === 'quote' && reversed.some(r => r.end - 1 === s.start)
      && reversed.some(r => r.start === s.end - 1))).concat(reversed);
  const issues = [], bare = text => text.replace(/\s/gu, '');
  const pattern = /(?:^|[.!?。！？]\s+)([^\n.!?。！？]{14,80})\n[ \t]*\n/gu;
  for (const match of output.matchAll(pattern)) {
    const fragment = match[1].trim();
    // A verified split inside the particle "부터" is unfinished prose, unlike
    // an arbitrary noun at a line end (which may be a legitimate heading).
    if (fragment.split(/\s+/u).length < 4 || !/[가-힣]{2,}부$/u.test(fragment)
        || /[|<>\t`“”‘’"']/u.test(fragment)) continue;
    const sourceStart = source.indexOf(fragment);
    if (sourceStart < 0 || sourceStart !== source.lastIndexOf(fragment)
        || (sourceStart && !/[.!?。！？]\s*$/u.test(source.slice(Math.max(0, sourceStart - 12), sourceStart)))
        || !/^\r?\n터(?:\s|[가-힣])/u.test(source.slice(sourceStart + fragment.length))) continue;
    const owner = source.slice(sourceStart, sourceStart + 800).match(/^[^.!?。！？]+[.!?。！？]/u)?.[0];
    const nextStart = match.index + match[0].length;
    const next = output.slice(nextStart, nextStart + 800).match(/^[^\n.!?。！？]+[.!?。！？]/u)?.[0];
    if (!owner || !next || next.length < fragment.length * 2
        || !bare(next).startsWith(bare(fragment).slice(0, 8))) continue;
    const outputStart = match.index + match[0].indexOf(fragment);
    if (protectedSpans.some(s => s.start < nextStart + next.length && s.end > outputStart)) continue;
    if (sentenceSimilarity(owner.replace(/\r?\n/gu, ''), next) < 0.55) continue;
    issues.push({ code: 'introduced_truncated_sentence_prefix', sourceStart,
      sourceEnd: sourceStart + owner.length, outputStart, outputEnd: outputStart + fragment.length,
      successorStart: nextStart });
    if (issues.length >= 20) break;
  }
  return issues;
}
function introducedTruncatedPrefixes(source, output, { preserveLines = false } = {}) {
  if (preserveLines) return [];
  const a = String(source || ''), b = String(output || '');
  return require('../engine/textAnalysisCache').memoizeSpans('truncated-prefix-v1', a.length + ':' + a + b, () => audit(a, b));
}
module.exports = { introducedTruncatedPrefixes };
