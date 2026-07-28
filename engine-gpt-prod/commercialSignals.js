'use strict';

const VERSION = 2;

const DIRECT_ACTION_RE = /(?:지금\s*(?:바로\s*)?(?:신청|구매|예약|문의)|(?:신청|구매|예약|문의|클릭)\s*(?:하세요|해\s*주세요|바랍니다)|놓치지\s*마세요|달려가세요)/gu;
const OFFER_RE = /(?:\d{1,3}\s*%\s*(?:할인|OFF)|무료\s*(?:상담|체험|픽업|드랍|픽드랍|서비스|제공)|한정\s*(?:수량|기간|판매)|특가|할인\s*(?:혜택|행사|쿠폰)|선착순|오늘만|마감\s*임박|서비스로\s*(?:제공|드리))/giu;
const PRICE_RE = /(?:₩|\$|€|¥)\s*\d[\d,.]*|\d[\d,.]*\s*(?:원|페소|달러|유로)(?=$|[^가-힣A-Za-z0-9_])/gu;
const ABSOLUTE_SERVICE_CLAIM_RE = /(?:어디든\s*(?:무료\s*)?(?:픽업|드랍|가능)|전\s*객실|무조건|절대\s*(?:놓치|후회|실패|문제)|전혀\s*문제\s*없이|\d+\s*분\s*이내(?:로)?\s*(?:바로\s*)?(?:답변|응답)|누구에게나\s*(?:잘\s*)?맞|모두에게\s*적합)/gu;
const HEALTH_EFFICACY_RE = /(?:직방|치료(?:에|가)\s*(?:좋|효과)|(?:통증|붓기|화기|염증|피로|피부)\s*(?:을|를)?\s*(?:빼|없애|낫게|완화|치료)|효능이\s*(?:있|좋)|즉시\s*(?:진정|회복))/gu;
const PROMOTIONAL_LANGUAGE_RE = /(?:강력(?:하게)?\s*추천|콕\s*집어\s*추천|가성비\s*(?:대박|최고)|천국이\s*따로\s*없|완전\s*최고|엄청난\s*꿀팁|고민할\s*필요\s*없이)/gu;

/**
 * 후기·SNS·광고는 서로 배타적인 장르가 아니다. 실제 경험을 말하는 글에도
 * 가격, 무료 제공, 할인, 절대적 서비스 주장, 효능 표현이 함께 들어갈 수
 * 있다. 분류기와 위험 감사가 각자 다른 정규식을 쓰지 않도록 한 측정값을
 * 공유한다.
 */
function measureCommercialSignals(text, {
  reviewSignalCount = 0,
  researchDiscussionContext = false
} = {}) {
  const value = String(text || '');
  const directActionCount = count(value, DIRECT_ACTION_RE);
  const offerCount = count(value, OFFER_RE);
  const priceCount = count(value, PRICE_RE);
  const absoluteServiceClaimCount = count(value, ABSOLUTE_SERVICE_CLAIM_RE);
  const healthEfficacyCount = count(value, HEALTH_EFFICACY_RE);
  const promotionalLanguageCount = count(value, PROMOTIONAL_LANGUAGE_RE);
  const commercialCoreCount = directActionCount
    + offerCount
    + priceCount
    + absoluteServiceClaimCount
    + promotionalLanguageCount;
  const suppressedAsResearchDiscussion = researchDiscussionContext === true
    && Number(reviewSignalCount || 0) === 0
    && directActionCount === 0
    && promotionalLanguageCount === 0;
  const commercialIntentCount = suppressedAsResearchDiscussion ? 0 : commercialCoreCount;
  const commercialReview = Number(reviewSignalCount || 0) > 0
    && commercialIntentCount >= 2;
  return {
    version: VERSION,
    directActionCount,
    offerCount,
    priceCount,
    absoluteServiceClaimCount,
    healthEfficacyCount,
    promotionalLanguageCount,
    commercialCoreCount,
    commercialIntentCount,
    commercialReview,
    suppressedAsResearchDiscussion
  };
}

/**
 * 분류기와 강도 엔진이 같은 상업 신호를 쓰도록 문장 단위 우선 대상을 만든다.
 * 가격만 적힌 문장은 사실 보존 대상으로 남기고, 행동 요청·과장·절대 주장·
 * 효능 주장을 우선한다. 혜택 문장은 상업 신호가 충분한 후기에서만 고른다.
 */
function detectCommercialSentenceTargets(sentences, documentProfile = null) {
  const flags = new Set(documentProfile?.riskFlags || []);
  const enabled = [...flags].some(flag => [
    'commercial_claim',
    'commercial_review',
    'health_claim',
    'absolute_service_claim'
  ].includes(flag));
  if (!enabled) return { applicable: false, indices: [], reasonCounts: {} };

  const documentSignals = documentProfile?.signals?.commercialSignals || {};
  const targetOffers = flags.has('commercial_review')
    && Number(documentSignals.commercialIntentCount || 0) >= 3;
  const indices = new Set();
  const reasonCounts = {};
  const add = (index, reason) => {
    indices.add(index);
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  };

  for (const [index, raw] of (sentences || []).entries()) {
    const sentence = String(raw || '');
    if (count(sentence, PROMOTIONAL_LANGUAGE_RE) > 0) add(index, 'commercial_promotional_hype');
    if (count(sentence, DIRECT_ACTION_RE) > 0) add(index, 'commercial_call_to_action');
    if (count(sentence, ABSOLUTE_SERVICE_CLAIM_RE) > 0) add(index, 'commercial_absolute_claim');
    if (count(sentence, HEALTH_EFFICACY_RE) > 0) add(index, 'commercial_health_claim');
    if (targetOffers && count(sentence, OFFER_RE) > 0) add(index, 'commercial_offer_frame');
  }

  return {
    applicable: indices.size > 0,
    indices: [...indices].sort((left, right) => left - right),
    reasonCounts
  };
}

function riskFlagsFromSignals(signals, { profile = '' } = {}) {
  const measured = signals || {};
  // 가격·할인·효능 주장을 연구 대상으로 인용·분석하는 학술 문서는 실제
  // 구매 권유가 아니다. 상업 안전 블록과 광고형 강도 대상을 붙이지 않고,
  // 의미·수치·인용 감사가 원래 주장 범위를 보호하도록 둔다.
  if (measured.suppressedAsResearchDiscussion === true
      && ['academic_paper', 'report_assignment', 'long_explainer'].includes(profile)) {
    return [];
  }
  const flags = [];
  if (Number(measured.commercialIntentCount || 0) > 0 || profile === 'marketing') {
    flags.push('commercial_claim');
  }
  if (measured.commercialReview === true) flags.push('commercial_review');
  if (Number(measured.healthEfficacyCount || 0) > 0) flags.push('health_claim');
  if (Number(measured.absoluteServiceClaimCount || 0) > 0) flags.push('absolute_service_claim');
  return flags;
}

function buildSourceReviewWarnings(documentProfile) {
  const flags = new Set(documentProfile?.riskFlags || []);
  const warnings = [];
  if (flags.has('commercial_review')) {
    warnings.push({
      code: 'commercial_review_conditions_review',
      severity: 'notice',
      message: '가격·할인·무료 제공·픽업 같은 조건은 게시 시점과 적용 범위를 원문 작성자가 확인해야 해요.'
    });
  }
  if (flags.has('health_claim')) {
    warnings.push({
      code: 'commercial_health_claim_review',
      severity: 'notice',
      message: '치료·효능처럼 읽힐 수 있는 표현은 실제 근거와 표시 기준을 원문 작성자가 확인해야 해요.'
    });
  }
  if (flags.has('absolute_service_claim')) {
    warnings.push({
      code: 'commercial_absolute_claim_review',
      severity: 'notice',
      message: '어디든·전 객실·몇 분 이내 같은 절대적 서비스 주장은 실제 제공 조건을 확인해야 해요.'
    });
  }
  return warnings;
}

function promptSafetyBlock(documentProfile) {
  const flags = new Set(documentProfile?.riskFlags || []);
  if (![...flags].some(flag => [
    'commercial_claim',
    'commercial_review',
    'health_claim',
    'absolute_service_claim'
  ].includes(flag))) return '';
  const lines = [
    '[혼합 의도 안전: 후기·광고·혜택 주장]',
    '원문에 있는 가격, 할인, 무료 제공, 픽업·드랍, 제공 범위와 적용 조건은 사실 주장이다. 숫자와 조건을 유지하고 새 조건·기준일·예약 요건을 추정해 넣지 않는다.',
    '협찬·제휴·광고 여부가 원문이나 사용자 메모에 없으면 고지 문구나 실제 체험을 만들어 내지 않는다.',
    '기본·고급에서는 반복 감탄, 과도한 추천, 같은 행동 요청을 줄여도 되지만 업체·서비스의 핵심 정보와 원문 작성자의 실제 경험 범위는 보존한다.'
  ];
  if (flags.has('absolute_service_claim')) {
    lines.push('어디든·전 객실·무조건·몇 분 이내 같은 절대 표현을 더 강하게 만들지 않는다. 원문의 주장 범위를 임의로 넓히거나 보장으로 바꾸지 않는다.');
  }
  if (flags.has('health_claim')) {
    lines.push('직방·치료·즉시 회복 같은 효능 표현을 새로 만들거나 강화하지 않는다. 원문 효능 주장을 의학적 사실로 확정하지 않는다.');
  }
  return lines.join('\n');
}

function count(text, pattern) {
  return (String(text || '').match(pattern) || []).length;
}

module.exports = {
  VERSION,
  measureCommercialSignals,
  detectCommercialSentenceTargets,
  riskFlagsFromSignals,
  buildSourceReviewWarnings,
  promptSafetyBlock
};
