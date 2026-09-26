'use strict';

// A model edits only judge-grounded windows. IDs and offsets are server-owned;
// a missing/duplicate ID or an overlapping window cannot replace other prose.
// This proposes a candidate, never a semantic pass. The caller must re-audit it.
function buildRelationPatchTargets(output, findings) {
  const text = String(output || '');
  const windows = [];
  for (const v of findings || []) {
    const quote = String(v.candidateSpan || '');
    const start = text.indexOf(quote);
    if (!v.repairable || !v.relationGrounded || v.origin !== 'introduced'
        || quote.length < 12 || quote.length > 1800 || start < 0
        || text.indexOf(quote, start + 1) >= 0) continue;
    windows.push({ start, end: start + quote.length, findings: [v] });
  }
  windows.sort((a,b) => a.start-b.start);
  const merged = [];
  for (const w of windows) {
    const previous = merged.at(-1);
    if (previous && w.start < previous.end) {
      previous.end = Math.max(previous.end, w.end);
      previous.findings.push(...w.findings);
    } else merged.push({ ...w });
  }
  const bounded = merged.filter(w => w.end-w.start <= 1800).slice(0, 4);
  if (bounded.reduce((n,w)=>n+w.end-w.start,0) > text.length*.75) return [];
  return bounded.map((w,i) => ({
    ...w, id: `R${i+1}`, text: text.slice(w.start,w.end)
  }));
}

function applyRelationPatches(output, targets, patches) {
  const text = String(output || '');
  const unchanged = { outputText: text, repaired: false, notes: ['invalid_relation_patch'] };
  if (!Array.isArray(patches) || patches.length !== targets.length || !targets.length
      || new Set(patches.map(p => p?.id)).size !== targets.length) return unchanged;
  const changes = [];
  for (const t of targets) {
    const p = patches.find(p => p?.id === t.id);
    if (!p || typeof p.replacement !== 'string' || !p.replacement.trim()
        || p.replacement.length > Math.max(t.text.length*2, 300)
        || text.slice(t.start,t.end) !== t.text) return unchanged;
    changes.push({ ...t, replacement: p.replacement });
  }
  let result = text;
  for (const p of changes.sort((a,b) => b.start-a.start))
    result = result.slice(0,p.start)+p.replacement+result.slice(p.end);
  return { outputText: result, repaired: result !== text, notes: ['paired_relation_patch'] };
}

module.exports = { buildRelationPatchTargets, applyRelationPatches };
