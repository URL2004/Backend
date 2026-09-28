'use strict';
const { syntaxSpans } = require('../engine/textSyntax');

// Preserve a CURRENT, uniquely attested Korean word spelling while restoring
// its surrounding source meaning. Never guess a word, cross a physical line,
// alter quoted/code text or transfer a new non-whitespace character. This is
// a proposal transformation, not a semantic pass; all caller audits still run.
function retainAttestedRestorationSpacing(sourceWindow, currentWindow) {
  const source = String(sourceWindow || ''), current = String(currentWindow || '');
  const protectedSource = syntaxSpans(source).filter(p => p.spanType !== 'parenthetical');
  const protectedCurrent = syntaxSpans(current).filter(p => p.spanType !== 'parenthetical');
  const words = [...current.matchAll(/(?<![가-힣])[가-힣]{4,30}(?![가-힣])/gu)];
  const counts = new Map();
  for (const m of words) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
  const edits = [];
  for (const m of words) {
    if (counts.get(m[0]) !== 1 || protectedCurrent.some(p => p.start < m.index + m[0].length && p.end > m.index)) continue;
    const pattern = new RegExp('(?<![가-힣])' + [...m[0]].join('[ \\t]*') + '(?![가-힣])', 'gu');
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1 || !/[ \t]/u.test(matches[0][0])) continue;
    const hit = matches[0], start = hit.index, end = start + hit[0].length;
    // A tab can delimit table cells; it is not evidence of a broken word.
    if (hit[0].includes('\t')) continue;
    const fragments = hit[0].split(/[ \t]+/u);
    // Do not fuse determiners/particles into a neighbouring noun. A word in
    // the candidate is not by itself proof that its spacing is grammatical.
    if (fragments.slice(0,-1).some(part => part.length < 2 || /(?:은|는|이|가|을|를|의|와|과|도|만|에|로)$/u.test(part))) continue;
    if (protectedSource.some(p => p.start < end && p.end > start)
        || edits.some(p => p.start < end && p.end > start)) continue;
    edits.push({ start, end, text: m[0] });
  }
  let text = source;
  for (const edit of edits.sort((a,b) => b.start-a.start)) text = text.slice(0,edit.start)+edit.text+text.slice(edit.end);
  if (text.replace(/[ \t]/gu,'') !== source.replace(/[ \t]/gu,'')) return source;
  return text;
}
module.exports = { retainAttestedRestorationSpacing };
