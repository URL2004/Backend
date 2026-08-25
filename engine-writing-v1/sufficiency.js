'use strict';

const { GENRES } = require('./genres');
const { detectConflicts } = require('./conflicts');

// 공백을 제외한 확인 사실 1자가 공개 문장에서 안전하게 늘어날 수 있는 상한.
// 기존 2.25배 + 카테고리별 고정 가산은 247자의 사실로 1,000자를 쓸 수 있다고
// 과대평가해, 모델이 반복·인과·평가를 지어내도록 압박했다. 실생성/의미수리 결과를
// 기준으로 장르별 보수적 계수를 쓰며 새 운영 표본으로만 상향 조정한다.
const FEASIBILITY_PROFILE = Object.freeze({
  resume: { expansion: 1.48, perFact: 5 },
  review_blog: { expansion: 1.4, perFact: 6 },
  marketing: { expansion: 1.6, perFact: 6 },
  general: { expansion: 1, perFact: 7 }
});

// 장르별 계수는 공백 포함 한국어 문장 표본으로 보정했다. 사용자가 선택한 계산
// 단위로 가능 범위를 먼저 환산해야 2byte를 글자 수처럼 취급하는 오류가 생기지 않는다.
const LENGTH_MODE_SCALE = Object.freeze({ with_space: 1, no_space: 0.8, byte2: 1.6 });

function scaleForMode(value, mode) {
  return Math.max(1, Math.round(value * (LENGTH_MODE_SCALE[mode] || 1)));
}

function assessSufficiency(input, ledger, policy = null) {
  const genre = GENRES[input.genre];
  const categories = categoryMap(ledger.facts);
  const profile = genre.readiness[input.subtype] || genre.readiness.default;
  const missingGroups = [];
  const conflicts = detectConflicts(input);
  for (const group of profile) {
    if (!group.some(category => categories.has(category))) missingGroups.push(group);
  }

  const evidenceChars = ledger.facts
    .filter(fact => !fact.categories.includes('constraint') && !fact.categories.includes('policy'))
    .reduce((sum, fact) => sum + Array.from(fact.value.replace(/\s+/gu, '')).length, 0);
  const factCount = ledger.facts.filter(fact => !fact.categories.includes('constraint')).length;
  const feasibility = FEASIBILITY_PROFILE[input.genre] || FEASIBILITY_PROFILE.general;
  const baseEstimatedMax = Math.max(60, Math.min(
    genre.maxFeasible,
    Math.round(evidenceChars * feasibility.expansion + Math.min(10, factCount) * feasibility.perFact)
  ));
  const baseEstimatedMin = Math.max(40, Math.min(baseEstimatedMax, Math.round(baseEstimatedMax * 0.55)));
  const baseRecommended = Math.max(60, Math.min(baseEstimatedMax, Math.round(baseEstimatedMax * 0.9 / 10) * 10));
  const estimatedMax = Math.min(3000, scaleForMode(baseEstimatedMax, input.charLimitMode));
  const estimatedMin = Math.min(estimatedMax, scaleForMode(baseEstimatedMin, input.charLimitMode));
  const recommended = Math.min(estimatedMax, scaleForMode(baseRecommended, input.charLimitMode));
  const requested = input.targetChars || genre.defaultTarget;
  const targetFeasible = requested <= estimatedMax;

  const policyStatus = policy?.status || 'ALLOW';
  let status = 'READY';
  if (['BLOCK', 'MANUAL_REVIEW', 'REQUIRE_EVIDENCE'].includes(policyStatus)) status = policyStatus === 'BLOCK' ? 'POLICY_BLOCKED' : 'POLICY_REVIEW';
  else if (conflicts.length || missingGroups.length >= profile.length || factCount === 0) status = 'NEEDS_FACTS';
  else if (missingGroups.length > 0 || !targetFeasible) status = 'LIMITED';

  const missing = missingGroups.map(group => ({
    categories: group,
    label: missingLabel(input.genre, input.subtype, group)
  }));
  const suggestions = conflicts.map(item => item.message)
    .concat(missing.map(item => questionFor(input.genre, item.categories)).filter(Boolean))
    .slice(0, 4);

  return {
    version: 'writing-readiness-v1',
    status,
    confirmedFactCount: factCount,
    confirmedFacts: ledger.facts.map(fact => ({ id: fact.id, label: fact.label, value: fact.value, categories: fact.categories })),
    missing,
    conflicts,
    suggestions,
    feasibleRange: {
      min: estimatedMin,
      recommended,
      max: estimatedMax,
      mode: input.charLimitMode
    },
    requestedTarget: requested,
    targetFeasible,
    options: optionsFor(status),
    summary: conflicts.length
      ? `서로 다른 정보 ${conflicts.length}건을 먼저 확인해야 정확하게 작성할 수 있어요.`
      : summaryFor(status, input.genre, factCount, requested, estimatedMax, missing),
    policy
  };
}

function categoryMap(facts) {
  const set = new Set();
  for (const fact of facts || []) for (const category of fact.categories || []) set.add(category);
  return set;
}

function missingLabel(genre, subtype, group) {
  const joined = group.join('|');
  const labels = {
    prompt: '자기소개서 문항', action: '내가 직접 한 행동', 'outcome|reflection': '결과 또는 배운 점',
    context: '지원 대상·직무 맥락', subject: '방문·사용 대상', experience: '직접 확인하거나 이용한 내용',
    evaluation: '직접 느낀 점·평가', product: '상품·서비스 정의', 'audience|problem': '고객 또는 해결할 문제',
    feature: '실제 제공 기능', purpose: '글의 목적', 'message|evidence': '핵심 메시지 또는 반드시 포함할 사실',
    'logistics|action': '날짜·장소 또는 독자가 할 행동', message: '핵심 메시지', 'evidence|source': '근거 자료',
    stance: '사용자의 의견', 'evidence|message': '의견의 이유·근거', 'message|action': '제안 내용 또는 행동',
    source: '요약할 원문'
  };
  return labels[joined] || group.join(' 또는 ');
}

function questionFor(genre, group) {
  const key = group.join('|');
  const questions = {
    resume: {
      prompt: '답변할 자기소개서 문항을 붙여 넣어 주세요.',
      action: '그 상황에서 본인이 직접 한 행동은 무엇인가요?',
      'outcome|reflection': '확인 가능한 결과나 실제로 배운 점은 무엇인가요?',
      context: '어느 회사·직무에 지원하는 글인가요?'
    },
    review_blog: {
      subject: '무엇을 어디서 이용했나요?',
      experience: '주문·이용한 내용이나 직접 확인한 정보가 있나요?',
      evaluation: '직접 느낀 장점이나 아쉬움은 무엇인가요?'
    },
    marketing: {
      product: '상품·서비스가 무엇인지 한 문장으로 알려주세요.',
      'audience|problem': '누가 어떤 문제를 해결하려고 사용하나요?',
      feature: '현재 실제로 제공하는 기능은 무엇인가요?'
    },
    general: {
      purpose: '이 글을 왜, 누구에게 쓰나요?',
      'message|evidence': '독자가 반드시 알아야 할 핵심 내용은 무엇인가요?',
      'logistics|action': '언제·어디서 진행되며 독자가 무엇을 해야 하나요?',
      message: '가장 먼저 전달할 핵심 메시지는 무엇인가요?',
      'evidence|source': '설명의 근거 또는 원문을 알려주세요.',
      stance: '사용자가 직접 가진 의견은 무엇인가요?',
      'evidence|message': '그 의견을 뒷받침하는 이유나 사실은 무엇인가요?',
      'message|action': '구체적으로 무엇을 제안하나요?',
      source: '요약할 원문을 붙여 넣어 주세요.'
    }
  };
  return questions[genre]?.[key] || '';
}

function optionsFor(status) {
  if (status === 'READY') return ['generate', 'edit', 'cancel'];
  if (status === 'LIMITED') return ['add_facts', 'write_short', 'cancel'];
  if (status === 'NEEDS_FACTS') return ['add_facts', 'cancel'];
  if (status === 'POLICY_REVIEW') return ['edit', 'cancel'];
  return ['edit', 'cancel'];
}

function summaryFor(status, genre, count, requested, maximum, missing) {
  const label = GENRES[genre].label;
  if (status === 'READY') return `${count}개의 확인 정보를 바탕으로 ${label} 글을 만들 수 있어요.`;
  if (status === 'LIMITED') {
    const missingText = missing.length ? ` 더 알려주면 더 좋아요: ${missing.map(item => item.label).join(', ')}.` : '';
    return `${count}개의 정보로는 요청한 ${requested}자보다 짧은 최대 약 ${maximum}자까지 정확하게 작성할 수 있어요.${missingText}`;
  }
  if (status === 'NEEDS_FACTS') return `${label} 글을 만들 핵심 정보가 아직 부족해요. 아래 질문에 답하면 정확하게 작성할 수 있어요.`;
  if (status === 'POLICY_REVIEW') return '규제 가능 표현이 있어 근거 또는 정책 확인이 필요해요.';
  return '현재 요청은 정책상 자동 생성할 수 없어요. 제한 내용을 확인하고 입력을 수정해 주세요.';
}

module.exports = { FEASIBILITY_PROFILE, LENGTH_MODE_SCALE, scaleForMode, assessSufficiency, categoryMap };
