'use strict';

// Additive API metadata, with no source text, UID, prompt or history ID.
// probability stays the legacy 0..100 display score.
function sanitizeAdjustment(value, score) {
  if (value?.basis !== 'service_history' || typeof value.matched !== 'boolean') return null;
  if (!value.matched) return { matched: false, applied: false, basis: 'service_history' };
  if (![value.before, value.after, value.delta].every(Number.isFinite)
    || value.before < 0 || value.before > 100 || value.after < 0 || value.after > value.before
    || value.delta !== value.after - value.before || value.after !== score) return null;
  return { matched: true, applied: value.after < value.before, before: value.before,
    after: value.after, delta: value.delta, basis: 'service_history',
    version: String(value.version || '').slice(0, 80) };
}

function scorePresentation(calibration) {
  const matched = calibration?.meta?.reason === 'own_humanized_history_match';
  const before = calibration?.rawProbability, after = calibration?.probability;
  return { scoreKind: 'ai_style', scoreLabel: 'AI식 문체 점수',
    scoreMeaning: '문체 신호의 참고 점수이며 AI 작성 확률이나 외부 검사 통과 확률이 아닙니다.',
    scoreAdjustment: matched && Number.isFinite(before) && Number.isFinite(after) && after <= before
      ? { matched: true, applied: after < before, before, after, delta: after - before,
          basis: 'service_history', version: calibration.meta.version }
      : { matched: false, applied: false, basis: 'service_history' } };
}

module.exports = { scorePresentation, sanitizeAdjustment };
