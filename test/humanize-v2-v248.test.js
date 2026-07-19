'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sectionRecovery = require('../engine-gpt-prod/sectionRecovery');
const humanizationDepth = require('../engine-gpt-prod/humanizationDepth');
const fingerprintAudit = require('../engine-gpt-prod/fingerprintAudit');
const endingStyleAudit = require('../engine-gpt-prod/endingStyleAudit');
const resumeCoverage = require('../engine-gpt-prod/resumeCoverage');
const experienceAudit = require('../engine-gpt-prod/experienceAudit');
const structure = require('../engine-gpt-prod/structureChunk');
const transformRouter = require('../routes/transform');
const qualityV2 = require('../engine-gpt-prod/finalQualityV2');
const runtime = require('../lib/gptRuntimeConfig');
const fingerprintReport = require('../scripts/humanize-fingerprint-report');
const { isV248FeatureEnabled } = require('../lib/humanizeV248Flags');

function withEnv(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function buildSection(sectionIndex) {
  return Array.from({ length: 20 }, (_, sentenceIndex) => (
    `또한 ${sectionIndex + 1}-${sentenceIndex + 1}번째 자료는 현대 사회에서 중요한 역할을 할 수 있습니다. 따라서 관련 문제를 체계적으로 개선할 필요가 있습니다.`
  )).join(' ');
}

function rewrittenSection(sectionIndex) {
  return Array.from({ length: 20 }, (_, sentenceIndex) => (
    `${sectionIndex + 1}-${sentenceIndex + 1}번째 운영 자료부터 실제 기록과 대조했습니다. 조건별 판단 근거는 검토 순서에 맞춰 다시 배치했습니다.`
  )).join(' ');
}

test('v2.4.8 기능은 운영 릴리스에서 기본 활성화되고 환경변수 0으로 각각 복귀한다', { concurrency: false }, t => {
  const flags = [
    ['sectionRecovery', 'HUMANIZE_SECTION_RECOVERY_ENABLED'],
    ['fingerprintAudit', 'HUMANIZE_FINGERPRINT_AUDIT_ENABLED'],
    ['effectConfirmation', 'HUMANIZE_EFFECT_CONFIRMATION_ENABLED'],
    ['billingProtection', 'HUMANIZE_BILLING_PROTECTION_ENABLED']
  ];
  for (const [, name] of flags) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }

  for (const [key, name] of flags) {
    assert.equal(isV248FeatureEnabled(key), true);
    process.env[name] = '0';
    assert.equal(isV248FeatureEnabled(key), false);
    process.env[name] = '1';
    assert.equal(isV248FeatureEnabled(key), true);
  }
});

test('장문 섹션 회복은 mini 최대 8개·동시성 3·상위 모델 최대 2개 계약을 지킨다', { concurrency: false }, async t => {
  withEnv(t, 'HUMANIZE_SECTION_RECOVERY_ENABLED', '1');
  const chunks = Array.from({ length: 10 }, (_, index) => {
    const text = buildSection(index);
    assert.ok(text.length >= sectionRecovery.MIN_SECTION_CHARS && text.length <= sectionRecovery.MAX_SECTION_CHARS);
    return { index, text, outputText: text, locked: false, sectionPath: `section_${index + 1}` };
  });
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const report = await sectionRecovery.recoverSections({
    chunks,
    sourceLength: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: { profile: 'long_explainer', confidence: 0.9 },
    inputRisk: { abstractRiskRatio: 1 },
    retrySection: async entry => {
      calls.push({ index: entry.index, tier: entry.tier });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 8));
      active -= 1;
      return {
        outputText: entry.tier === 'mini' ? entry.output : rewrittenSection(entry.index),
        safeChangeFound: true,
        usage: { totalTokens: 1 }
      };
    },
    validateCandidate: () => true
  });
  assert.equal(report.metrics.selectedSectionCount, 8);
  assert.equal(report.metrics.miniAttemptCount, 8);
  assert.equal(report.metrics.escalationAttemptCount, 2);
  assert.equal(report.metrics.escalated, 2);
  assert.equal(report.metrics.applied, 2);
  assert.equal(report.metrics.appliedSectionIndices.length, 2);
  assert.equal(calls.length, 10);
  assert.equal(calls.filter(call => call.tier === 'escalation').length, 2);
  assert.ok(maxActive <= 3);
  assert.ok(maxActive >= 2);
});

test('장문 섹션 회복은 안전 감사에서 거부되거나 더 나쁘지 않은 후보를 채택하지 않는다', { concurrency: false }, async t => {
  withEnv(t, 'HUMANIZE_SECTION_RECOVERY_ENABLED', '1');
  const text = buildSection(0);
  const chunks = [{ index: 0, text, outputText: text, locked: false }];
  const report = await sectionRecovery.recoverSections({
    chunks,
    sourceLength: 2400,
    mode: 'assignment',
    requestStrength: 'basic',
    documentProfile: { profile: 'long_explainer', confidence: 0.9 },
    inputRisk: { abstractRiskRatio: 1 },
    retrySection: async () => ({ outputText: rewrittenSection(0), safeChangeFound: true }),
    validateCandidate: () => false
  });
  assert.equal(report.metrics.applied, 0);
  assert.equal(chunks[0].outputText, text);
});

test('상투구 감사는 같은 신규 계열 1회만 허용하고 일반 표현은 shadow로만 기록한다', { concurrency: false }, t => {
  withEnv(t, 'HUMANIZE_FINGERPRINT_AUDIT_ENABLED', '1');
  const source = '자료를 검토했다. 적용 범위를 확인했다. 결과를 정리했다.';
  const one = fingerprintAudit.auditFingerprint(source, '자료 검토에 머무르지 않고 적용 범위를 확인했다. 결과를 정리했다.');
  const repeated = fingerprintAudit.auditFingerprint(source, '자료 검토에 머무르지 않고 적용 범위를 확인했다. 기록하는 데서 그치지 않고 결과를 정리했다.');
  const shadow = fingerprintAudit.auditFingerprint(source, '그 과정에서 자료를 검토할 수 있고 적용 범위를 확인했다. 결과를 정리했다.');
  assert.equal(one.pass, true);
  assert.equal(repeated.pass, false);
  assert.ok(repeated.issueCodes.includes('engine_phrase_fingerprint'));
  assert.equal(repeated.excessIntroducedCount, 1);
  assert.equal(shadow.pass, true);
  assert.ok(shadow.shadow.some(item => item.code === 'in_the_process' && item.delta === 1));
  assert.ok(shadow.shadow.some(item => item.code === 'can_and' && item.delta === 1));
});

test('부정·배제 관계를 인정·가산 관계로 바꾸면 한 번만 발생해도 수리 대상으로 잡는다', () => {
  const source = '이 연구는 새로운 도구 개발이 아니라 기존 자료의 문헌비판과 맥락화를 연구의 중심에 둔다.';
  const output = '이 연구는 새로운 도구 개발에 머무르지 않고 기존 자료의 문헌비판과 맥락화를 연구의 중심에 둔다.';
  const report = fingerprintAudit.auditFingerprint(source, output);
  assert.equal(report.relationShift.detected, true);
  assert.ok(report.issueCodes.includes('contrast_relation_shift'));
});

test('섹션별 지배 종결체에 새 종결체가 2문장 이상 섞이면 잡고 원래 혼합 문체는 강제하지 않는다', () => {
  const plain = Array.from({ length: 8 }, (_, index) => `${index + 1}번째 자료를 확인했다.`).join(' ');
  const mixedOutput = Array.from({ length: 8 }, (_, index) => index < 2
    ? `${index + 1}번째 자료를 확인했습니다.`
    : `${index + 1}번째 자료를 확인했다.`).join(' ');
  const issue = endingStyleAudit.auditEndingStyle(plain, mixedOutput);
  assert.equal(issue.pass, false);
  assert.ok(issue.issueCodes.includes('ending_style_mixed'));

  const originalMixed = [
    ...Array.from({ length: 4 }, (_, index) => `${index + 1}번째 자료를 확인했다.`),
    ...Array.from({ length: 4 }, (_, index) => `${index + 5}번째 자료를 확인했습니다.`)
  ].join(' ');
  const unchanged = endingStyleAudit.auditEndingStyle(originalMixed, originalMixed);
  assert.equal(unchanged.pass, true);
});

test('음슴체 섹션 일부가 했다체로 바뀐 경우 ending_style_mixed로 잡는다', () => {
  const source = Array.from({ length: 8 }, (_, index) => `${index + 1}번째 점검 결과를 기록함.`).join(' ');
  const output = Array.from({ length: 8 }, (_, index) => index < 2
    ? `${index + 1}번째 점검 결과를 기록했다.`
    : `${index + 1}번째 점검 결과를 기록함.`).join(' ');
  const report = endingStyleAudit.auditEndingStyle(source, output);
  assert.equal(report.pass, false);
  assert.equal(report.sections[0].dominantStyle, 'nominal');
});

test('고신뢰 자소서는 행동·역량·성과·직무 연결 문장의 통누락을 잡고 원문 위치 복원 후 통과한다', () => {
  const source = [
    '저는 고객 문의 데이터를 분석해 반복되는 불편 유형을 분류했습니다.',
    '팀원과 처리 절차를 설계하고 자동화 도구를 개발해 응답 시간을 20% 줄였습니다.',
    '이 경험에서 익힌 문제 해결 역량을 지원 직무의 운영 개선에 활용하겠습니다.'
  ].join(' ');
  const omitted = [
    '저는 고객 문의 데이터를 분석해 반복되는 불편 유형을 분류했습니다.',
    '이 경험에서 익힌 문제 해결 역량을 지원 직무의 운영 개선에 활용하겠습니다.'
  ].join(' ');
  const profile = { profile: 'resume_application', confidence: 0.91 };
  const before = resumeCoverage.auditResumeCoverage(source, omitted, profile);
  const restored = resumeCoverage.auditResumeCoverage(source, source, profile);
  assert.equal(before.applicable, true);
  assert.equal(before.pass, false);
  assert.ok(before.omissions.some(item => /응답 시간을 20% 줄였습니다/u.test(item.sourceSentence)));
  assert.equal(restored.pass, true);
  assert.equal(resumeCoverage.isImproved(before, restored), true);
  assert.equal(resumeCoverage.isSafeRestorationShape(source, omitted, source, before.omissions.length), true);
  assert.equal(resumeCoverage.isSafeRestorationShape(source, omitted, `${source} 원문에 없던 별도 결론을 덧붙였습니다.`, before.omissions.length), false);
  assert.equal(resumeCoverage.auditResumeCoverage(source, omitted, { profile: 'resume_application', confidence: 0.74 }).applicable, false);
});

test('특수 불릿·라벨은 접두부와 행 경계를 잠그고 본문만 편집하며 제목 형식은 회귀 보존한다', () => {
  const source = [
    'Ⅰ. 운영 개요',
    '# 1. 마크다운 제목',
    '“독립 제목 행”',
    '● 첫 번째 항목의 본문은 편집할 수 있습니다.',
    '■ 두 번째 항목의 본문도 편집할 수 있습니다.',
    '검증 방법: 결과 수치를 같은 기준으로 다시 확인합니다.'
  ].join('\n');
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true, preserveLineBoundaries: 'structural' });
  assert.ok(plan.chunks.some(chunk => chunk.locked && chunk.lockType === 'heading' && /Ⅰ/u.test(chunk.text)));
  assert.ok(plan.chunks.some(chunk => chunk.locked && /# 1\./u.test(chunk.text)));
  assert.ok(plan.chunks.some(chunk => chunk.locked && chunk.lockType === 'title' && /독립 제목/u.test(chunk.text)));
  assert.equal(plan.chunks.filter(chunk => chunk.lockType === 'bullet_prefix').length, 2);
  assert.equal(plan.chunks.filter(chunk => chunk.lockType === 'label_prefix').length, 1);
  assert.ok(plan.chunks.some(chunk => !chunk.locked && /첫 번째 항목의 본문/u.test(chunk.text)));
  assert.ok(plan.chunks.some(chunk => !chunk.locked && /결과 수치를 같은 기준/u.test(chunk.text)));
  assert.equal(structure.mergeChunks(plan.chunks), source);
});

test('참고문헌 안의 라벨형 행은 접두부 규칙보다 동결 블록 보존이 우선한다', () => {
  const source = [
    '본문에서는 운영 자료의 비교 기준을 설명한다. 첫 번째 자료와 두 번째 자료의 적용 범위도 함께 검토한다.',
    '결과를 해석할 때에는 같은 조건과 같은 시점을 기준으로 삼는다.',
    '',
    '참고문헌',
    '저자: 홍길동, 운영 연구의 실제, 2025.',
    'DOI: 10.1234/example.2025.1'
  ].join('\n');
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true, preserveLineBoundaries: 'structural' });
  const referenceChunks = plan.chunks.filter(chunk => /홍길동|10\.1234/u.test(chunk.text));
  assert.ok(referenceChunks.length >= 1);
  assert.ok(referenceChunks.every(chunk => chunk.locked === true && chunk.lockType === 'reference_item'));
  assert.equal(structure.mergeChunks(plan.chunks), source);
});

test('동일 문장 잔존율은 라벨 접두부를 제외한 본문을 일반 산문으로 계산한다', () => {
  const sentence = '결과 수치를 같은 기준으로 다시 확인하고 기록합니다.';
  const source = `검증 방법: ${sentence}\n● 목록 문장은 잔존율에서 제외합니다.`;
  const eligible = humanizationDepth.eligibleProseSentences(source);
  assert.deepEqual(eligible, [sentence]);
  const carryover = humanizationDepth.measureSubstantiveCarryover(source, source);
  assert.equal(carryover.eligibleSentenceCount, 1);
  assert.equal(carryover.ratio, 1);
});

test('경험 의역은 외부 후보로 만들지 않고 새 1인칭·시점·행동 결합만 의미 심사 후보가 된다', () => {
  const source = '프로젝트 회의에 참여해 고객 요구를 조사하고 개선안을 발표했습니다.';
  const paraphrase = '고객 요구를 조사한 뒤 프로젝트 회의에서 개선안을 발표했습니다.';
  const fabricated = '저는 지난해 어느 날 현장을 방문해 고객을 만나고 문제를 직접 해결했습니다.';
  assert.equal(experienceAudit.detectExperienceCandidate(source, paraphrase).candidate, false);
  const candidate = experienceAudit.detectExperienceCandidate('일반적인 운영 절차를 설명합니다.', fabricated);
  assert.equal(candidate.candidate, true);
  assert.ok(candidate.introduced.firstPerson > 0);
  assert.ok(candidate.introduced.time > 0);
  assert.ok(candidate.introduced.action > 0);

  // 과거형 장면으로 분류되지 않더라도 새 화자·시점·행동이 모두 생기면
  // 의미 심사로 보내야 한다. 결정론 검출 결과 자체는 외부 경고가 아니다.
  const futureFabrication = '저는 올해 현장을 방문해 고객을 인터뷰할 예정입니다.';
  const futureCandidate = experienceAudit.detectExperienceCandidate('일반적인 운영 절차를 설명합니다.', futureFabrication);
  assert.equal(futureCandidate.legacyCount, 0);
  assert.equal(futureCandidate.candidate, true);
});

test('과금 분기는 효과 제한 확인·품질 미달·동일 문서 재결제 보호를 구분한다', () => {
  const classify = transformRouter.classifyBillingDisposition;
  assert.equal(classify({ adminNoCharge: true }), 'admin_no_charge');
  assert.equal(classify({ plan: 'unlimited' }), 'plan_unlimited');
  assert.equal(classify({ protectionEnabled: true, noBenefit: true, effectExpectation: 'limited' }), 'waived_quality_shortfall');
  assert.equal(classify({ protectionEnabled: true, depthShortfall: true, effectExpectation: 'normal' }), 'waived_quality_shortfall');
  assert.equal(classify({ protectionEnabled: true, depthShortfall: true, previousLowBenefit: true, effectExpectation: 'limited' }), 'waived_repeat_low_benefit');
  assert.equal(classify({ protectionEnabled: true, depthShortfall: true, effectExpectation: 'limited' }), 'charged');
  assert.equal(classify({ protectionEnabled: false, depthShortfall: true, effectExpectation: 'normal' }), 'charged');
});

test('섹션 회복 재시도는 mini와 상위 모델 선택을 요청 본문에 정확히 반영한다', { concurrency: false }, async t => {
  withEnv(t, 'OPENAI_API_KEY', 'v248-openai-test');
  const originalFetch = global.fetch;
  const seen = [];
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    return new Response(JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ outputText: '문장 순서와 호흡을 안전하게 다시 구성했습니다.', safeChangeFound: true, notes: [] }) }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { global.fetch = originalFetch; });
  const config = runtime.publicConfig(runtime.DEFAULT_CONFIG, 'test');
  await qualityV2.retryGeneralSurface({
    source: '이 문장은 운영 자료를 체계적으로 설명할 수 있습니다.',
    currentOutput: '이 문장은 운영 자료를 체계적으로 설명할 수 있습니다.',
    humanizationPlan: { applicable: true, requestStrength: 'advanced', requiredChangedSentenceCount: 1, minSubstantiveEditRatio: 0.1 },
    humanizationDepthReport: { reasons: ['substantive_edit_ratio_low'], metrics: {} },
    config,
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    phase: 'section_depth_escalation'
  });
  assert.equal(seen[0].model, 'gpt-5.4');
  assert.equal(seen[0].reasoning?.effort, 'high');
});

test('주간 n-gram 보고서는 10문서·2배·순증 8 기준과 사람 승인 대기를 강제한다', () => {
  const pairs = Array.from({ length: 12 }, (_, index) => ({
    source: index < 2 ? '자료에 머무르지 않고 판단을 정리했다.' : '원문 자료를 직접 검토했다.',
    output: '검토하는 데서 그치지 않고 판단 근거를 함께 정리했다.'
  }));
  const report = fingerprintReport.buildReport(pairs, { minN: 2, maxN: 5 });
  const candidate = report.candidates.find(item => /그치지 않고/u.test(item.phrase));
  assert.ok(candidate);
  assert.ok(candidate.outputDocumentCount >= 10);
  assert.ok(candidate.delta >= 8);
  assert.equal(candidate.approvalStatus, 'candidate_requires_human_approval');
  assert.equal(candidate.runtimeDictionary, false);
});

test('원문 재결제 보호 지문은 NFKC·도메인 분리 HMAC이며 원문을 노출하지 않는다', { concurrency: false }, t => {
  withEnv(t, 'OPENAI_SAFETY_SALT', 'v248-test-secret');
  const first = transformRouter.sourceBenefitFingerprint('ＡＢＣ 연구  결과');
  const second = transformRouter.sourceBenefitFingerprint('ABC 연구 결과');
  const plain = crypto.createHmac('sha256', 'v248-test-secret').update('ABC 연구 결과').digest('hex');
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.notEqual(first, plain);
  assert.doesNotMatch(first, /연구/u);
});

test('/transform은 효과 제한 확인 플래그가 켜졌을 때 작업·과금 전에 409를 반환한다', { concurrency: false }, async t => {
  withEnv(t, 'HUMANIZE_ENGINE_V2_ENABLED', '1');
  withEnv(t, 'HUMANIZE_EFFECT_CONFIRMATION_ENABLED', '1');
  const handler = transformRouter.stack.find(layer => layer.route?.path === '/transform' && layer.route?.methods?.post)
    .route.stack[0].handle;
  const text = '비가 왔다. 우산은 가방 안에 넣어 두었다. 학교 앞 오래된 빵집에서는 주인이 아침마다 직접 구운 식빵과 작은 단팥빵을 창가의 나무 선반 위에 차례로 올려놓곤 했다. 버스는 제시간에 도착했다. 집에 돌아와 젖은 운동화를 현관 신문지 위에 놓고 창문을 조금 열어 두었다.';
  let statusCode = 200;
  let payload = null;
  const req = { body: { text, mode: 'blog', basicStyle: 'blog' }, headers: {}, query: {} };
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; }
  };
  await handler(req, res);
  assert.equal(statusCode, 409);
  assert.equal(payload.code, 'LIMITED_EFFECT_CONFIRMATION_REQUIRED');
  assert.equal(payload.effectExpectation, 'limited');
  assert.equal(payload.requiresEffectConfirmation, true);
});
