'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
    ['effectConfirmation', 'HUMANIZE_EFFECT_CONFIRMATION_ENABLED']
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
  withEnv(t, 'HUMANIZE_SECTION_ESCALATION_MAX', '2');
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

test('제목이 촘촘해 모든 산문 청크가 1200자 미만이어도 짧은 절 조각을 회복 후보로 고른다', { concurrency: false }, async t => {
  withEnv(t, 'HUMANIZE_SECTION_RECOVERY_ENABLED', '1');
  const chunks = [];
  for (let index = 0; index < 12; index += 1) {
    chunks.push({
      index: chunks.length,
      text: `${index + 1}. 세부 절`,
      outputText: `${index + 1}. 세부 절`,
      locked: true,
      sectionPath: `section_${index + 1}`
    });
    const text = Array.from({ length: 4 }, (_, sentenceIndex) => (
      `또한 ${index + 1}-${sentenceIndex + 1}번째 자료는 현대 사회에서 중요한 역할을 할 수 있습니다. 따라서 관련 내용을 체계적으로 살펴볼 필요가 있습니다.`
    )).join(' ');
    assert.ok(text.length >= sectionRecovery.MIN_FRAGMENT_CHARS);
    assert.ok(text.length < sectionRecovery.MIN_SECTION_CHARS);
    chunks.push({
      index: chunks.length,
      text,
      outputText: text,
      locked: false,
      sectionPath: `section_${index + 1}`
    });
  }
  const lockedBefore = chunks.filter(item => item.locked).map(item => item.outputText);
  const report = await sectionRecovery.recoverSections({
    chunks,
    sourceLength: 4500,
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: { profile: 'report_assignment', confidence: 0.94 },
    inputRisk: { abstractRiskRatio: 1 },
    retrySection: async entry => ({
      outputText: entry.source
        .replaceAll('또한 ', '')
        .replaceAll('현대 사회에서 중요한 역할을 할 수 있습니다', '자료별 차이를 직접 확인했습니다')
        .replaceAll('따라서 관련 내용을 체계적으로 살펴볼 필요가 있습니다', '검토 기준에 따라 결과를 다시 정리했습니다'),
      safeChangeFound: true
    }),
    validateCandidate: () => true
  });
  assert.equal(report.metrics.selectedPreferredSectionCount, 0);
  assert.equal(report.metrics.selectedFragmentCount, 8);
  assert.equal(report.metrics.miniAttemptCount, 8);
  assert.ok(report.metrics.applied > 0, JSON.stringify(report.metrics));
  assert.deepEqual(chunks.filter(item => item.locked).map(item => item.outputText), lockedBefore);
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
    validateCandidate: () => ({ pass: false, codes: ['number_changed'] })
  });
  assert.equal(report.metrics.applied, 0);
  assert.equal(chunks[0].outputText, text);
  assert.equal(report.metrics.rejectedAttemptCount, 1);
  assert.deepEqual(report.metrics.rejectionCodes, ['number_changed']);
  assert.equal(report.metrics.rejectionCodeCounts.number_changed, 1);
  assert.equal(report.metrics.escalationAttemptCount, 0);
  assert.ok(report.metrics.escalationSkipCodes.includes('unsafe_mini_candidate'));
});

test('최소선만 통과하고 체감 목표가 1%p 이상 남은 장문 절도 최대 4개까지 회복한다', { concurrency: false }, t => {
  withEnv(t, 'HUMANIZE_SECTION_RECOVERY_ENABLED', '1');
  const originalBuildPlan = humanizationDepth.buildHumanizationPlan;
  const originalEvaluate = humanizationDepth.evaluateHumanizationDepth;
  t.after(() => {
    humanizationDepth.buildHumanizationPlan = originalBuildPlan;
    humanizationDepth.evaluateHumanizationDepth = originalEvaluate;
  });
  humanizationDepth.buildHumanizationPlan = () => ({
    version: 99,
    applicable: true,
    requestStrength: 'advanced',
    targetSubstantiveEditMin: 0.24
  });
  humanizationDepth.evaluateHumanizationDepth = () => ({
    applicable: true,
    pass: true,
    plan: { targetSubstantiveEditMin: 0.24 },
    metrics: {
      targetDepthMet: false,
      substantiveEditRatio: 0.18
    },
    reasons: []
  });
  const chunks = Array.from({ length: 7 }, (_, index) => ({
    index,
    text: '일반 산문 문장을 충분한 길이로 반복해 회복 대상 절을 구성합니다. '.repeat(30),
    outputText: '일반 산문 문장을 충분한 길이로 반복해 회복 대상 절을 구성합니다. '.repeat(30),
    locked: false
  }));
  const selected = sectionRecovery.selectRecoverySections(chunks, {
    sourceLength: 5000,
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: { profile: 'long_explainer' }
  });
  assert.equal(selected.length, sectionRecovery.MAX_TARGET_ONLY_ATTEMPTS);
  assert.equal(selected.every(item => item.targetOnly === true), true);
  assert.equal(selected.every(item => item.targetGap === 0.06), true);
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

test('최근 결과의 반복 전환·검토·포부 문구는 원문 대비 순증만 shadow로 기록한다', () => {
  const source = '실험 기록을 검토했다. 이 경험은 다음 업무의 기준이 되었다. 조직의 목표에 기여하겠다.';
  const output = '기록을 함께 살펴봤다. 이러한 경험은 다음 업무로 이어졌고, 조직에 보탬이 되고자 한다.';
  const report = fingerprintAudit.auditFingerprint(source, output);
  assert.equal(report.pass, true);
  assert.ok(report.shadow.some(item => item.code === 'experience_transition' && item.delta === 1));
  assert.ok(report.shadow.some(item => item.code === 'review_together' && item.delta === 1));
  assert.ok(report.shadow.some(item => item.code === 'contribution_cliche' && item.delta === 1));

  const alreadyPresent = fingerprintAudit.auditFingerprint(output, output);
  assert.ok(alreadyPresent.shadow.every(item => item.delta === 0));
});

test('부정·배제 관계를 인정·가산 관계로 바꾸면 한 번만 발생해도 수리 대상으로 잡는다', () => {
  const source = '이 연구는 새로운 도구 개발이 아니라 기존 자료의 문헌비판과 맥락화를 연구의 중심에 둔다.';
  const output = '이 연구는 새로운 도구 개발에 머무르지 않고 기존 자료의 문헌비판과 맥락화를 연구의 중심에 둔다.';
  const report = fingerprintAudit.auditFingerprint(source, output);
  assert.equal(report.relationShift.detected, true);
  assert.ok(report.issueCodes.includes('contrast_relation_shift'));
});

test('목적·근거·대조·행위 방향과 새 즉시성의 의미 변화를 원문 상대 감사로 잡는다', () => {
  const cases = [
    ['가능성을 증명하기 위해 실험을 설계했다.', '가능성을 확인하기 위해 실험을 설계했다.', 'proof_goal_weakened_to_check'],
    ['정책 효과도 함께 고려해야 한다.', '정책 효과도 함께 봐야 한다.', 'consideration_weakened_to_seeing'],
    ['자료의 가치를 재발견해 연구 방향을 정했다.', '자료의 가치를 다시 살려 연구 방향을 정했다.', 'rediscovery_changed_to_reviving'],
    ['자원이 부족해 외부로 내몰린 학생들을 조사했다.', '자원이 부족해 외부에서 몰려온 학생들을 조사했다.', 'coercion_direction_reversed'],
    ['조건은 불리했지만 분석은 계속했다.', '조건은 불리했고 분석은 계속했다.', 'contrast_connector_removed'],
    ['연구를 통해 정책의 적용 결과와 구체적인 효과를 확인할 수 있었다.', '정책의 적용 결과와 구체적인 효과는 분명했다.', 'evidence_frame_removed']
  ];
  for (const [source, output, family] of cases) {
    const report = fingerprintAudit.auditFingerprint(source, output);
    assert.ok(report.issueCodes.includes('semantic_relation_shift'), `${family}: ${JSON.stringify(report)}`);
    assert.ok(report.semanticRelations.shifts.some(item => item.family === family), JSON.stringify(report));
  }
  const urgency = fingerprintAudit.auditFingerprint(
    '직무 전문성을 다지기 위해 교육에 참여했습니다.',
    '직무 전문성을 다지기 위해 바로 움직여 교육에 참여했습니다.'
  );
  assert.ok(urgency.semanticRelations.shifts.some(item => item.family === 'unsupported_immediacy'));

  const safe = fingerprintAudit.auditFingerprint(
    '디지털 기술을 사용할 수 있지만 결과는 활용 방식에 따라 달라진다.',
    '디지털 기술을 쓰지만 결과는 활용 방식에 따라 달라진다.'
  );
  assert.equal(safe.semanticRelations.detected, false, JSON.stringify(safe));
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

test('완료 작업은 품질·변화량·반복 여부와 관계없이 과금한다', () => {
  const classify = transformRouter.classifyBillingDisposition;
  assert.equal(classify({ adminNoCharge: true }), 'admin_no_charge');
  assert.equal(classify({ plan: 'unlimited' }), 'plan_unlimited');
  assert.equal(classify({ protectionEnabled: true, noBenefit: true, effectExpectation: 'limited' }), 'charged');
  assert.equal(classify({ protectionEnabled: true, depthShortfall: true, effectExpectation: 'normal' }), 'charged');
  assert.equal(classify({ protectionEnabled: true, depthShortfall: true, previousLowBenefit: true, effectExpectation: 'limited' }), 'charged');
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

test('지원서 의미 반복 회복은 문단 역할을 나누되 없는 경험과 프로그램 생성을 금지한다', { concurrency: false }, async t => {
  withEnv(t, 'OPENAI_API_KEY', 'v2415-resume-repetition-test');
  const originalFetch = global.fetch;
  const seen = [];
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    return new Response(JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ outputText: '지원 동기와 참여 계획을 원문 범위에서 나누어 정리했습니다.', safeChangeFound: true, notes: [] }) }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { global.fetch = originalFetch; });
  const config = runtime.publicConfig(runtime.DEFAULT_CONFIG, 'test');
  await qualityV2.retryGeneralSurface({
    source: '저는 캠프에 지원하고 싶습니다. 진로를 찾고 싶습니다. 캠프에서 진로를 찾고 싶습니다.',
    currentOutput: '저는 캠프에 지원하고 싶습니다. 진로를 찾고 싶습니다. 캠프에서 진로를 찾고 싶습니다.',
    humanizationPlan: {
      applicable: true,
      requestStrength: 'basic',
      profile: 'resume_application',
      targetIndices: [0, 1, 2],
      requiredChangedSentenceCount: 2,
      requiredTargetChangedCount: 2,
      minSubstantiveEditRatio: 0.1,
      resumeRepetitionPlan: { applicable: true, requiredReduction: 1 }
    },
    humanizationDepthReport: {
      reasons: ['resume_semantic_repetition_low'],
      metrics: { resumeRepetition: { requiredReduction: 1, achievedReduction: 0 } }
    },
    config
  });
  const request = JSON.stringify(seen[0]);
  assert.match(request, /같은 지원 전제/u);
  assert.match(request, /문단별 역할/u);
  assert.match(request, /없는 전공 관심/u);
  assert.match(request, /학교 프로그램/u);
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

test('/transform은 효과 제한 확인 플래그가 켜졌을 때 작업·과금 전에 409를 반환한다', { concurrency: false }, async t => {
  withEnv(t, 'HUMANIZE_EFFECT_CONFIRMATION_ENABLED', '1');
  withEnv(t, 'DEV_NO_AUTH', '1');
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
