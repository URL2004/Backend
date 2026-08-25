'use strict';

const medical = require('./packs/medical.ko.v1.json');
const legal = require('./packs/legal.ko.v1.json');
const finance = require('./packs/finance.ko.v1.json');
const advertising = require('./packs/advertising.ko.v1.json');

const PACKS = Object.freeze([medical, legal, finance, advertising]);
const PROMOTIONAL_RE = /(홍보|광고|판매|구매|신청|문의|예약|추천|소개|상세페이지|랜딩)/u;
const ADVICE_RE = /(진단|처방|법률\s*조언|법적\s*판단|투자\s*조언|매수\s*추천|매도\s*추천|추천\s*종목)/u;
const PERSONAL_EXPERIENCE_RE = /(후기|방문|이용|복용|진료|상담|경험|사용)/u;
const STATUS_PRIORITY = Object.freeze({
  ALLOW: 0,
  ALLOW_WITH_NOTICE: 1,
  REQUIRE_EVIDENCE: 2,
  MANUAL_REVIEW: 3,
  BLOCK: 4
});

function escalateStatus(current, next) {
  return STATUS_PRIORITY[next] > STATUS_PRIORITY[current] ? next : current;
}

function evaluatePolicy(input, ledger) {
  const text = [input.genre, input.subtype, ...Object.values(input.answers || {}), input.emphasis]
    .filter(Boolean).join('\n').normalize('NFKC');
  const matches = PACKS.map(pack => matchPack(pack, text)).filter(result => result.matched);
  const sponsorshipFact = (ledger.facts || []).find(fact => fact.field === 'sponsorship');
  const sponsorshipCode = sponsorshipFact?.enumValue || '';
  if (['provided', 'sponsored'].includes(sponsorshipCode) && !matches.some(result => result.domain === 'advertising')) {
    const advertisingPack = PACKS.find(pack => pack.domain === 'advertising');
    matches.push({
      id: advertisingPack.id,
      domain: advertisingPack.domain,
      approved: advertisingPack.approved === true,
      matched: true,
      terms: [sponsorshipCode],
      claims: [],
      blockedClaims: [],
      notice: advertisingPack.notice
    });
  }
  const regulated = matches.filter(result => ['medical', 'legal', 'finance'].includes(result.domain));
  const ad = matches.find(result => result.domain === 'advertising');
  const promotional = input.genre === 'marketing' || PROMOTIONAL_RE.test(text);
  const advice = ADVICE_RE.test(text);
  const personal = PERSONAL_EXPERIENCE_RE.test(text);
  const evidencePresent = (ledger.facts || []).some(fact => fact.categories.includes('evidence') || fact.categories.includes('source'));
  const issues = [];
  const notices = [];
  let status = 'ALLOW';

  for (const result of regulated) {
    notices.push(result.notice);
    if (result.blockedClaims.length || advice || promotional) {
      status = escalateStatus(status, 'BLOCK');
      issues.push({ code: `${result.domain.toUpperCase()}_RESTRICTED_CLAIM`, domain: result.domain, message: restrictedMessage(result.domain) });
      continue;
    }
    if (result.approved !== true) {
      status = escalateStatus(status, 'MANUAL_REVIEW');
      issues.push({
        code: `${result.domain.toUpperCase()}_POLICY_REVIEW_REQUIRED`,
        domain: result.domain,
        message: '이 분야의 세부 정책이 아직 승인되지 않아 자동 생성하지 않아요. 확인된 일반 사실만 남기거나 관리자 검토를 요청해 주세요.'
      });
      continue;
    }
    if (result.claims.length && !evidencePresent && !personal) {
      status = escalateStatus(status, 'REQUIRE_EVIDENCE');
      issues.push({ code: `${result.domain.toUpperCase()}_EVIDENCE_REQUIRED`, domain: result.domain, message: '효과·판단 표현을 사용하려면 확인 가능한 근거와 출처가 필요해요.' });
      continue;
    }
    status = escalateStatus(status, 'ALLOW_WITH_NOTICE');
  }

  if (ad) {
    notices.push(ad.notice);
    const unsupportedSuperlatives = ad.claims;
    if (unsupportedSuperlatives.length && !evidencePresent) {
      status = escalateStatus(status, 'REQUIRE_EVIDENCE');
      issues.push({ code: 'ADVERTISING_EVIDENCE_REQUIRED', domain: 'advertising', message: `근거가 필요한 표현이 있어요: ${unsupportedSuperlatives.join(', ')}` });
    }
    if (ad.approved !== true) {
      status = escalateStatus(status, 'MANUAL_REVIEW');
      issues.push({
        code: 'ADVERTISING_POLICY_REVIEW_REQUIRED',
        domain: 'advertising',
        message: '광고·협찬 글은 정책 담당자가 현재 정책 팩을 승인하기 전까지 자동 생성하지 않아요.'
      });
    } else {
      status = escalateStatus(status, 'ALLOW_WITH_NOTICE');
    }
  }

  return {
    version: 'writing-policy-v1',
    status,
    canGenerate: ['ALLOW', 'ALLOW_WITH_NOTICE'].includes(status),
    domains: [...new Set(matches.map(result => result.domain))],
    packVersions: matches.map(result => result.id),
    issues,
    notices: [...new Set(notices)],
    matchedTerms: matches.flatMap(result => result.terms).slice(0, 20),
    prohibitedClaims: regulated.flatMap(result => result.claims.concat(result.blockedClaims)).filter(Boolean),
    requiredDisclosures: ['provided', 'sponsored'].includes(sponsorshipCode) ? [{
      code: 'SPONSORSHIP_DISCLOSURE_REQUIRED',
      type: sponsorshipCode,
      message: sponsorshipCode === 'sponsored'
        ? '광고비를 받은 글이라는 사실을 본문 끝에 명확히 표시해야 해요.'
        : '상품·서비스를 제공받은 글이라는 사실을 본문 끝에 명확히 표시해야 해요.'
    }] : []
  };
}

function matchPack(pack, text) {
  const institutions = termsIn(text, pack.institutionTerms);
  const treatments = termsIn(text, pack.treatmentTerms);
  const claims = termsIn(text, pack.claimTerms);
  const blockedClaims = termsIn(text, pack.blockedClaimTerms);
  let matched = institutions.length > 0 || treatments.length > 0 || blockedClaims.length > 0;
  if (pack.domain === 'advertising') matched = institutions.length > 0 || treatments.length > 0 || claims.length > 0;
  return {
    id: pack.id,
    domain: pack.domain,
    approved: pack.approved === true,
    matched,
    terms: [...new Set([...institutions, ...treatments, ...claims, ...blockedClaims])],
    claims,
    blockedClaims,
    notice: pack.notice
  };
}

function termsIn(text, terms) {
  return (terms || []).filter(term => String(text || '').includes(term));
}

function restrictedMessage(domain) {
  if (domain === 'medical') return '의료 홍보·효능·진단·보장 표현은 자동 생성할 수 없어요. 개인이 확인한 이용 사실만 남겨 주세요.';
  if (domain === 'legal') return '구체 사건의 법적 판단·승소·처벌 결과를 자동 생성할 수 없어요. 확인된 사실 정리로 바꿔 주세요.';
  return '투자 판단·수익·원금 보장 표현은 자동 생성할 수 없어요. 확인된 상품 정보나 개인 경험만 남겨 주세요.';
}

function postGenerationPolicyCheck(text, policy) {
  const value = String(text || '');
  const violations = [];
  for (const phrase of policy?.prohibitedClaims || []) {
    if (phrase && value.includes(phrase)) violations.push({ code: 'POLICY_PROHIBITED_CLAIM', phrase });
  }
  const guarantee = value.match(/(?:무조건|반드시|100%)\s*[^.!?\n]{0,20}(?:효과|개선|완치|수익|승소|보장)/gu) || [];
  for (const phrase of guarantee) violations.push({ code: 'POLICY_GUARANTEE', phrase });
  for (const disclosure of policy?.requiredDisclosures || []) {
    const present = disclosure.type === 'sponsored'
      ? /(?:광고비|원고료|유료\s*광고|협찬)/u.test(value)
      : /(?:제공받|무상\s*제공|제품\s*제공|서비스\s*제공)/u.test(value);
    if (!present) violations.push({ code: disclosure.code, phrase: disclosure.message });
  }
  return { pass: violations.length === 0, violations };
}

module.exports = { PACKS, evaluatePolicy, matchPack, postGenerationPolicyCheck };
