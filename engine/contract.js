// [engine/contract.js] Contract — 한 번 만들고 모든 가드가 참조하는 "단일 진실"(보고서 §5.5·§7.3)
// ────────────────────────────────────────────────────────────────
// 그동안 가드별로 흩어져 있던 계약 데이터(pov_seed·화자 게이트·길이 정책·Soft Claim Ledger)를
// rawText에서 1회 구성한 하나의 객체로 모은다. rawText는 불변이며 모든 검증의 기준.

const floor = require('./floor');

/**
 * @typedef {Object} Contract
 * @property {string}  rawText            불변 원문 (모든 검증의 기준)
 * @property {('assignment'|'blog'|'thesis'|'resume')} mode
 * @property {('ko'|'en')} lang
 * @property {boolean} optIn              "내 경험 추가" 허용 여부
 * @property {{fp_singular:number, fp_plural:number, org_voice_likely:boolean}} povSeed  화자 시드(정규식 실측)
 * @property {boolean} speakerGateClosed  원문 1인칭 0 && !optIn → 새 1인칭 화자 금지
 * @property {{min:number, max:number, hardMax:number}} lengthPolicy  모드별 분량 정책
 * @property {?object} softClaimLedger    judge가 비동기로 채움(닫힌세계 claim 원장). 미생성 시 null
 */

/**
 * rawText에서 Contract를 1회 구성. 가드/파이프라인은 이 객체를 단일 소스로 참조한다.
 * @returns {Contract}
 */
function buildContract(rawText, { mode = 'assignment', lang = 'ko', optIn = false } = {}) {
  const povSeed = floor.computePovSeed(rawText);
  return {
    rawText,
    mode,
    lang,
    optIn,
    povSeed,
    speakerGateClosed: floor.isSpeakerGateClosed(povSeed, optIn),
    lengthPolicy: floor.LENGTH_POLICY[mode] || floor.LENGTH_POLICY.assignment,
    softClaimLedger: null
  };
}

module.exports = { buildContract };
