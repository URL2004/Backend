'use strict';
const { normalizeText, splitLines, isHeading, splitParagraphs } = require('../analysis/textStats');
const { scoreText } = require('../analysis/riskScorer');

function blockize(text) {
  const t = normalizeText(text);
  if (!t) return [];
  const rawBlocks = splitParagraphs(t);
  const blocks = [];
  let idx = 1;
  for (const para of rawBlocks) {
    const lines = para.split('\n').map(x => x.trim()).filter(Boolean);
    if (lines.length > 1 && lines.every(line => line.length < 80)) {
      for (const line of lines) blocks.push(makeBlock(line, idx++));
    } else {
      blocks.push(makeBlock(para, idx++));
    }
  }
  return blocks;
}

function makeBlock(text, idx) {
  return {
    id: `B${String(idx).padStart(4, '0')}`,
    type: isHeading(text) ? 'heading' : 'paragraph',
    text
  };
}

function renderBlocks(blocks) {
  return blocks.map(b => b.text.trim()).filter(Boolean).join('\n\n');
}

function scoreBlocks(blocks, policy) {
  return blocks.map(b => ({ ...b, score: scoreText(b.text, policy).risk }));
}

function selectPatchTargets(blocks, policy) {
  const scored = scoreBlocks(blocks, policy)
    .filter(b => b.type !== 'heading')
    .filter(b => (b.text || '').replace(/\s+/g, '').length >= policy.length.patchMinBlockChars)
    .filter(b => b.score >= policy.length.patchMinBlockRisk)
    .sort((a, b) => b.score - a.score);

  const maxByRatio = Math.ceil(blocks.filter(b => b.type !== 'heading').length * policy.length.patchTargetRatio);
  const limit = Math.min(policy.length.patchMaxTargets, Math.max(1, maxByRatio));
  return scored.slice(0, limit).map((b, i) => ({ ...b, priority: i + 1 }));
}

function modeForText(text, blocks, policy) {
  const len = normalizeText(text).length;
  if (len <= policy.length.fullMaxChars) return 'full_single_call';
  if (len <= policy.length.blockLockedMaxChars && blocks.length <= policy.length.blockLockedMaxBlocks) return 'block_locked_single_call';
  return 'patch_single_call';
}

function patchContext(blocks, target, policy) {
  const idx = blocks.findIndex(b => b.id === target.id);
  const prev = idx > 0 ? blocks[idx - 1].text.slice(-policy.length.patchContextChars) : '';
  const next = idx >= 0 && idx < blocks.length - 1 ? blocks[idx + 1].text.slice(0, policy.length.patchContextChars) : '';
  let heading = '';
  for (let i = idx; i >= 0; i--) {
    if (blocks[i] && blocks[i].type === 'heading') { heading = blocks[i].text; break; }
  }
  return { previousHeading: heading, previous: prev, next };
}

module.exports = { blockize, renderBlocks, scoreBlocks, selectPatchTargets, modeForText, patchContext };
