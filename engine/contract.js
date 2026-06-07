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
 * @property {('individual'|'organization'|'impersonal')} speakerType  화자 유형(prompt 화자 규칙 근거)
 * @property {string[]} allowedPronouns   유지 가능한 인칭(예: we/our/우리)
 * @property {string[]} forbiddenPronouns 새로 끌어들이면 안 되는 인칭(예: I/저/제가)
 * @property {{min:number, max:number, hardMax:number}} lengthPolicy  모드별 분량 정책
 * @property {?object} softClaimLedger    judge가 비동기로 채움(닫힌세계 claim 원장). 미생성 시 null
 */

/**
 * rawText에서 Contract를 1회 구성. 가드/파이프라인은 이 객체를 단일 소스로 참조한다.
 * @returns {Contract}
 */
// 원문 종결 문체 감지: 평어체(~다/~이다/~한다) vs 존댓말(~합니다/~해요). 출력에서 일관 유지하기 위함.
function detectRegister(t) {
  const polite = ((t || '').match(/(습니다|합니다|입니다|됩니다|세요|해요|어요|예요|에요|니까요)(?=[.!?\s"”'’)]|$)/g) || []).length;
  const plain = ((t || '').match(/(?:이?다|한다|된다|않다|없다|있다|었다|였다|진다|간다|난다|온다|본다)(?=[.!?\s"”'’)]|$)/g) || []).length;
  if (plain >= polite * 1.5) return 'plain';
  if (polite >= plain * 1.5) return 'polite';
  return 'mixed';
}

function buildContract(rawText, { mode = 'assignment', lang = 'ko', optIn = false } = {}) {
  const povSeed = floor.computePovSeed(rawText);
  const register = detectRegister(rawText);
  // 화자 유형: 개인(I/저) > 조직(we/우리/본 연구) > 비인칭.
  let speakerType, allowedPronouns, forbiddenPronouns;
  if (povSeed.fp_singular > 0) {
    speakerType = 'individual'; allowedPronouns = ['I', 'my', '저', '제가']; forbiddenPronouns = [];
  } else if (povSeed.fp_plural > 0) {
    // 조직/집단 화자는 실제 복수대명사(우리/we)로만 판정 — '본 연구/이 글은' 자기참조는 비인칭으로 둔다.
    speakerType = 'organization'; allowedPronouns = ['we', 'our', '우리']; forbiddenPronouns = ['I', 'my', '저', '제가(개인)'];
  } else {
    speakerType = 'impersonal'; allowedPronouns = []; forbiddenPronouns = ['I', 'we', '저', '우리(모든 1인칭)'];
  }
  return {
    rawText,
    mode,
    lang,
    optIn,
    povSeed,
    speakerGateClosed: floor.isSpeakerGateClosed(povSeed, optIn),
    speakerType,
    allowedPronouns,
    forbiddenPronouns,
    register,
    lengthPolicy: floor.LENGTH_POLICY[mode] || floor.LENGTH_POLICY.assignment,
    softClaimLedger: null
  };
}

module.exports = { buildContract, detectRegister };
