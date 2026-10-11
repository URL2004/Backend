'use strict';

// 비싼 모델이 초안을 다시 쓰거나(escalation) 수리할 때의 추론 강도를 작업 단위로 정한다.
//
// 기준은 구간이 아니라 제출 원문 전체의 글자 수다. 2026-10-11 같은 날 비교가 글 단위로
// 갈렸기 때문이다: 4,000자 미만 글에서는 medium과 high의 결과 차이가 관측되지 않았고,
// 4,000자 이상 글에서는 medium의 다시 쓴 구간에 깨진 문장과 반복이 조금 더 나왔다.
//
// 확인 판정(reasoning.judgeEscalation), 감지·근거 검색의 승격 호출은 이 값과 무관하다.

function resolveRewriteEscalation(cfg, sourceText) {
  const reasoning = cfg?.reasoning || {};
  const short = String(reasoning.rewriteEscalationShort || '');
  const limit = Number(cfg?.escalation?.shortRewriteChars) || 0;
  if (short && limit > 0 && String(sourceText || '').length < limit) return short;
  // 긴 글이거나 규칙이 꺼져 있으면 값을 두지 않는다. 호출부가 reasoning.escalation을 쓴다.
  return '';
}

// 설정 객체는 여러 작업이 함께 쓰는 캐시일 수 있으므로 고치지 않고 새로 만든다.
function withRewriteEscalation(cfg, sourceText) {
  const effort = resolveRewriteEscalation(cfg, sourceText);
  const reasoning = { ...(cfg?.reasoning || {}) };
  if (effort) reasoning.rewriteEscalation = effort;
  else delete reasoning.rewriteEscalation;
  return { ...cfg, reasoning };
}

function rewriteEscalationEffort(cfg) {
  return cfg?.reasoning?.rewriteEscalation || cfg?.reasoning?.escalation;
}

module.exports = { resolveRewriteEscalation, withRewriteEscalation, rewriteEscalationEffort };
