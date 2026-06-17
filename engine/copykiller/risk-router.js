'use strict';
// [engine/copykiller/risk-router.js] 저위험 원문 보호 라우터 (P0).
//   원문 점수가 낮으면 재작성하지 않는다. 문학비평 11%→20% 참사("건드릴수록 손해")의 재발 방지.
//   실측 점수(카피킬러 %)가 있으면 우선, 없으면 프록시 위험으로 판단.
//   minimal_cleanup = 맞춤법·띄어쓰기·문장부호·줄바꿈·중복공백만(무LLM). full = 정상 처리.

const LOW_RISK_MEASURED = 30;   // 실측 AI작성률 ≤ 30% → 보존
const LOW_RISK_PROXY = 0.30;    // 프록시 composite_risk ≤ 0.30 → 보존 (튜닝 가능)

// { measuredScore?:0~100, proxyRisk?:0~1 } → { mode:'minimal_cleanup'|'full', reason }
function decideMode({ measuredScore = null, proxyRisk = null } = {}) {
  if (measuredScore != null && measuredScore <= LOW_RISK_MEASURED) {
    return { mode: 'minimal_cleanup', reason: `실측 ${measuredScore}% ≤ ${LOW_RISK_MEASURED}% — 저위험 원문 보존(재작성 시 오히려 상승 위험)` };
  }
  if (measuredScore == null && proxyRisk != null && proxyRisk <= LOW_RISK_PROXY) {
    return { mode: 'minimal_cleanup', reason: `프록시 위험 ${proxyRisk.toFixed(3)} ≤ ${LOW_RISK_PROXY} — 저위험 추정, 원문 보존` };
  }
  return { mode: 'full', reason: '정상 처리 대상' };
}

// minimal_cleanup에서 허용/금지 (파이프라인이 참조)
const MINIMAL_CLEANUP_ALLOW = ['오탈자', '띄어쓰기', '문장부호', '깨진 줄바꿈', '중복 공백'];
const MINIMAL_CLEANUP_FORBID = ['문단 재구성', '분량 축약', '논지 재정리', '문체 통일', '비평 문체 정돈'];

module.exports = { decideMode, LOW_RISK_MEASURED, LOW_RISK_PROXY, MINIMAL_CLEANUP_ALLOW, MINIMAL_CLEANUP_FORBID };
