const { normalizeText, splitLines, charCountNoSpace } = require('../analysis/textStats');
const { analyzeRisk } = require('../analysis/riskScorer');

function isHeadingLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (/^(#{1,6}\s+|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.\s*|\d+\.\s+|[가-힣A-Za-z]\)\s+)/.test(t)) return true;
  if (t.length <= 46 && !/[.!?。！？]$/.test(t) && /[가-힣A-Za-z]/.test(t)) return true;
  return false;
}

function isListLine(line) {
  return /^\s*([-*•]|\d+[.)]|[가-힣A-Za-z]\))\s+/.test(String(line || ''));
}

function blockize(text) {
  const lines = splitLines(String(text || '').replace(/\r\n/g, '\n'));
  const blocks = [];
  let buf = [];
  let bufType = 'paragraph';

  function flush() {
    if (!buf.length) return;
    const raw = buf.join('\n').trim();
    if (raw) {
      const id = `B${String(blocks.length + 1).padStart(4, '0')}`;
      blocks.push({ id, type: bufType, text: raw });
    }
    buf = [];
    bufType = 'paragraph';
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (isHeadingLine(trimmed)) {
      flush();
      const id = `B${String(blocks.length + 1).padStart(4, '0')}`;
      blocks.push({ id, type: 'heading', text: trimmed });
      continue;
    }
    const lt = isListLine(line) ? 'list' : 'paragraph';
    if (buf.length && bufType !== lt) flush();
    bufType = lt;
    buf.push(line.trim());
  }
  flush();
  return blocks;
}

function assembleBlocks(blocks) {
  return (blocks || []).map(b => String(b.text || '').trim()).filter(Boolean).join('\n\n');
}

function makeBlockMap(blocks) {
  const map = new Map();
  for (const b of blocks || []) map.set(b.id, b);
  return map;
}

function applyPatches(blocks, patches, opts = {}) {
  const allowHeadingPatch = Boolean(opts.allowHeadingPatch);
  const patchMap = new Map();
  for (const p of patches || []) {
    if (!p || typeof p.id !== 'string') continue;
    if (typeof p.text !== 'string') continue;
    patchMap.set(p.id, p.text.trim());
  }
  const out = (blocks || []).map(b => {
    if (!patchMap.has(b.id)) return { ...b };
    if (b.type === 'heading' && !allowHeadingPatch) return { ...b };
    return { ...b, text: patchMap.get(b.id) };
  });
  return assembleBlocks(out);
}

function blockCoverage(originalBlocks, returnedBlocks) {
  const originalIds = (originalBlocks || []).map(b => b.id);
  const returnedIds = (returnedBlocks || []).map(b => b.id);
  const originalSet = new Set(originalIds);
  const returnedSet = new Set(returnedIds);
  return {
    missing: originalIds.filter(id => !returnedSet.has(id)),
    extra: returnedIds.filter(id => !originalSet.has(id)),
    sameCount: originalIds.length === returnedIds.length,
    sameOrder: originalIds.length === returnedIds.length && originalIds.every((id, i) => returnedIds[i] === id)
  };
}

function mergeReturnedBlocks(originalBlocks, returnedBlocks) {
  const byId = makeBlockMap(returnedBlocks || []);
  return assembleBlocks((originalBlocks || []).map(b => {
    const r = byId.get(b.id);
    if (!r) return { ...b };
    if (b.type === 'heading') return { ...b, text: b.text };
    return { ...b, text: String(r.text || '').trim() || b.text };
  }));
}

function summarizeContext(blocks, index) {
  const prevHeading = findPrev(blocks, index, b => b.type === 'heading');
  const prev = blocks[index - 1];
  const next = blocks[index + 1];
  return {
    previousHeading: prevHeading ? prevHeading.text : '',
    previous: prev && prev.type !== 'heading' ? shorten(prev.text, 160) : '',
    next: next && next.type !== 'heading' ? shorten(next.text, 160) : ''
  };
}

function findPrev(blocks, index, pred) {
  for (let i = index - 1; i >= 0; i--) if (pred(blocks[i])) return blocks[i];
  return null;
}

function shorten(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

function selectPatchTargets({ blocks, policy, sourceRisk }) {
  const cfg = policy.longDocument || {};
  const maxTargets = cfg.patchMaxTargets ?? 28;
  const maxRatio = cfg.patchTargetRatio ?? 0.34;
  const minChars = cfg.patchMinBlockChars ?? 70;
  const minRisk = cfg.patchMinBlockRisk ?? 0.43;
  const candidates = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || b.type === 'heading') continue;
    const len = charCountNoSpace(b.text);
    if (len < minChars) continue;
    const r = analyzeRisk(b.text, policy);
    const c = r.components || {};
    const priority = r.score
      + 0.22 * (c.formulaic || 0)
      + 0.18 * (c.uniformity || 0)
      + 0.15 * (c.repetition || 0)
      + 0.12 * (c.impersonal || 0)
      + 0.10 * (c.abstractness || 0);
    if (r.score >= minRisk || c.formulaic >= 0.18 || c.uniformity >= 0.35 || c.repetition >= 0.05) {
      candidates.push({
        id: b.id,
        type: b.type,
        before: b.text,
        risk: round(r.score),
        priority: round(priority),
        components: r.components,
        context: summarizeContext(blocks, i)
      });
    }
  }

  const byPriority = candidates.sort((a, b) => b.priority - a.priority);
  const capByRatio = Math.max(1, Math.floor(blocks.length * maxRatio));
  let limit = Math.min(maxTargets, capByRatio, byPriority.length);

  // If the whole document is high-risk but no block clears the threshold, patch the top few non-heading blocks.
  if (limit === 0 && sourceRisk && sourceRisk.score >= (policy.highRiskThreshold || 0.62)) {
    const fallback = blocks.map((b, i) => ({ b, i }))
      .filter(x => x.b.type !== 'heading' && charCountNoSpace(x.b.text) >= minChars)
      .map(x => {
        const r = analyzeRisk(x.b.text, policy);
        return { id: x.b.id, type: x.b.type, before: x.b.text, risk: round(r.score), priority: round(r.score), components: r.components, context: summarizeContext(blocks, x.i) };
      })
      .sort((a, b) => b.priority - a.priority)
      .slice(0, Math.min(6, maxTargets));
    return fallback;
  }

  return byPriority.slice(0, limit).sort((a, b) => a.id.localeCompare(b.id));
}

function round(x) { return Math.round(Number(x || 0) * 1000) / 1000; }

module.exports = {
  blockize,
  assembleBlocks,
  applyPatches,
  blockCoverage,
  mergeReturnedBlocks,
  selectPatchTargets,
  isHeadingLine
};
