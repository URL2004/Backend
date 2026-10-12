'use strict';
const bare = s => String(s || '').replace(/\s/gu, '');
const blocks = s => String(s || '').split(/\n\s*\n/u).map(x => x.trim()).filter(Boolean);

// Independent textual evidence for a completed omission verdict. A model fail
// alone is insufficient: a newly orphaned literal fragment or a clipped subject
// and list prefix must also be witnessed in exactly one source paragraph.
function residualSourceLoss(source, candidate) {
  const before = blocks(source).map(bare), after = blocks(candidate);
  const findings = [];
  for (const paragraph of after) {
    const first = paragraph.match(/^[\s\S]*?[.!?。！？](?=\s|$)/u)?.[0] || paragraph;
    const kept = bare(first);
    if (kept.length < 7 || kept.length > 240 || before.includes(kept)
      || String(source).split('\n').some(line => bare(line) === kept)) continue;
    const witnesses = before.filter(s => s.includes(kept) && s.indexOf(kept) === s.lastIndexOf(kept));
    if (witnesses.length !== 1) continue;
    const original = witnesses[0], at = original.indexOf(kept), prefix = original.slice(0, at);
    const orphan = first === paragraph && !/[.!?。！？][”’"']?$/u.test(kept)
      && original.length >= 40 && kept.length / original.length < 0.35
      && !/[\n\t|]/u.test(paragraph) && at > 15;
    const clippedSubject = at >= 12 && at <= 120 && /[은는이가]/u.test(prefix)
      && /[,，]/u.test(prefix) && /[.·,，]$/u.test(prefix)
      && !after.some(p => bare(p).includes(prefix));
    if (orphan || clippedSubject) findings.push({ kind: orphan ? 'orphaned_source_fragment' : 'clipped_subject_prefix', sourceChars: original.length, retainedChars: kept.length,
      sourceWitness: original, candidateWitness: kept });
  }
  return findings;
}

// Mixed scripts already present elsewhere in a document are not a whitelist
// for newly corrupting a Korean word. Only mark a one-character substitution
// with a unique, longer Korean witness; never guess a replacement.
function mixedScriptWordChanges(source, candidate) {
  const words = [...new Set(String(source || '').match(/[가-힣]{3,}/gu) || [])];
  return [...String(candidate || '').matchAll(/[가-힣\u3040-\u30ff]{3,}/gu)]
    .filter(m => /[가-힣]/u.test(m[0]) && /[\u3040-\u30ff]/u.test(m[0]) && !String(source).includes(m[0]))
    .filter(m => {
      const suffix = String(candidate).slice(m.index + m[0].length).match(/^\s+[가-힣]{2,}/u)?.[0];
      return suffix && words.filter(s => s.length === m[0].length
        && [...s].filter((c,i) => c !== m[0][i]).length === 1 && String(source).includes(s + suffix)).length === 1;
    }).map(m => ({ code: 'mixed_script_word_changed', chars: m[0].length }));
}
module.exports = { residualSourceLoss, mixedScriptWordChanges };
