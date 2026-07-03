function chooseLengthMode({ text, blocks, sourceRisk, policy }) {
  const cfg = policy.longDocument || {};
  const chars = String(text || '').length;
  const blockCount = (blocks || []).length;
  const fullMax = cfg.fullMaxChars || 4200;
  const blockMax = cfg.blockLockedMaxChars || 10000;
  const blockCountMax = cfg.blockLockedMaxBlocks || 90;

  if (!cfg.enabled) return 'full_single_call';
  if (chars <= fullMax) return 'full_single_call';
  if (chars <= blockMax && blockCount <= blockCountMax) return 'block_locked_single_call';
  return 'patch_single_call';
}

module.exports = { chooseLengthMode };
