'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const safeEditAccumulator = require('../engine-gpt-prod/safeEditAccumulator');
const humanizationDepth = require('../engine-gpt-prod/humanizationDepth');
const sectionRecovery = require('../engine-gpt-prod/sectionRecovery');
const layoutStructure = require('../engine-gpt-prod/layoutStructure');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const documentProfile = require('../engine-gpt-prod/documentProfile');
const humanizePrompts = require('../engine-gpt-prod/prompts/humanize');
const fingerprintAudit = require('../engine-gpt-prod/fingerprintAudit');
const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const chunkPolicy = require('../engine-gpt-prod/chunkPolicy');
const humanizeUserBlock = require('../engine-gpt-prod/prompts/humanize/userBlock');

function repeatedSection() {
  return Array.from({ length: 14 }, (_, index) => (
    `또한 ${index + 1}번째 자료는 현장에서 중요한 역할을 할 수 있습니다. 따라서 관련 내용을 체계적으로 확인할 필요가 있습니다.`
  )).join(' ');
}

test('안전 편집 누적기는 위험한 한 문장 때문에 나머지 안전한 재작성을 버리지 않는다', () => {
  const source = [
    '또한 현장에서는 20명의 참여자가 중요한 역할을 할 수 있습니다.',
    '따라서 관련 자료를 체계적으로 확인할 필요가 있습니다.',
    '이러한 경험을 통해 업무의 중요성을 깊이 이해하게 되었습니다.'
  ].join(' ');
  const candidate = [
    '현장 운영의 핵심은 20명 참여자의 역할에서 드러났습니다.',
    '관련 자료 30건은 확인 순서에 따라 다시 살폈습니다.',
    '업무가 왜 중요한지는 이 경험에서 구체적으로 확인했습니다.'
  ].join(' ');
  const plan = humanizationDepth.buildHumanizationPlan(source, {
    requestStrength: 'basic',
    documentProfile: { profile: 'general_essay' },
    inputRisk: { abstractRiskRatio: 0.8 }
  });
  const currentReport = humanizationDepth.evaluateHumanizationDepth(source, source, plan);
  const result = safeEditAccumulator.accumulateSafeEdits({
    source,
    current: source,
    candidate,
    plan,
    currentReport,
    validateCandidate: value => ({
      pass: !value.includes('30건'),
      codes: value.includes('30건') ? ['number_changed'] : []
    })
  });

  assert.equal(result.applied, true);
  assert.equal(result.appliedCount, 2);
  assert.ok(result.outputText.includes('20명 참여자의 역할'));
  assert.ok(result.outputText.includes('업무가 왜 중요한지는'));
  assert.ok(!result.outputText.includes('30건'));
  assert.ok(result.rejectedCodes.includes('number_changed'));
  assert.ok(result.report.metrics.substantiveEditRatio > currentReport.metrics.substantiveEditRatio);
});

test('장문 절 회복도 전체 후보가 거부되면 안전 문장만 누적 채택한다', { concurrency: false }, async t => {
  const previous = process.env.HUMANIZE_SECTION_RECOVERY_ENABLED;
  process.env.HUMANIZE_SECTION_RECOVERY_ENABLED = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.HUMANIZE_SECTION_RECOVERY_ENABLED;
    else process.env.HUMANIZE_SECTION_RECOVERY_ENABLED = previous;
  });
  const source = repeatedSection();
  const candidate = source
    .replace('또한 1번째 자료는 현장에서 중요한 역할을 할 수 있습니다.', '현장 운영에서 1번째 자료가 맡는 역할부터 확인했습니다.')
    .replace('또한 2번째 자료는 현장에서 중요한 역할을 할 수 있습니다.', '현장 운영에서 2번째 자료가 맡는 역할부터 확인했습니다.')
    .replace('또한 3번째 자료는 현장에서 중요한 역할을 할 수 있습니다.', '현장 운영에서 99번째 자료가 맡는 역할부터 확인했습니다.');
  const chunks = [{ index: 0, text: source, outputText: source, locked: false }];
  const report = await sectionRecovery.recoverSections({
    chunks,
    sourceLength: 2400,
    mode: 'assignment',
    requestStrength: 'basic',
    documentProfile: { profile: 'long_explainer', confidence: 0.9 },
    inputRisk: { abstractRiskRatio: 0.8 },
    retrySection: async entry => ({
      outputText: entry.tier === 'mini' ? candidate : entry.output,
      safeChangeFound: true
    }),
    validateCandidate: ({ candidate: value }) => ({
      pass: !value.includes('99번째'),
      codes: value.includes('99번째') ? ['number_changed'] : []
    })
  });

  assert.equal(report.metrics.partialAppliedCount, 1);
  assert.equal(report.metrics.partialAppliedSentenceCount, 2);
  assert.ok(chunks[0].outputText.includes('1번째 자료가 맡는 역할'));
  assert.ok(chunks[0].outputText.includes('2번째 자료가 맡는 역할'));
  assert.ok(!chunks[0].outputText.includes('99번째'));
});

test('공백·구두점·단순 표면 교체는 안전 누적 제안으로 세지 않는다', () => {
  const source = '자료를 확인했습니다. 결과를 정리했습니다.';
  const result = safeEditAccumulator.accumulateSafeEdits({
    source,
    current: source,
    candidate: '자료를 확인했습니다! 결과를 정리했습니다.',
    plan: humanizationDepth.buildHumanizationPlan(source, { requestStrength: 'basic' }),
    validateCandidate: () => true
  });
  assert.equal(result.applied, false);
  assert.equal(result.proposalCount, 0);
});

test('반복되는 짧은 다짐 행은 마침표가 있어도 자기소개서 소제목으로 잠근다', () => {
  const source = [
    '신뢰를 바탕으로 최적의 서비스를 제공하겠습니다.',
    '대상자의 건강 상태를 세심하게 확인하고 방문 일정과 투약 정보를 조율하면서 보호자에게 필요한 내용을 정확하게 안내한 경험을 바탕으로 안정적인 서비스를 제공하겠습니다.',
    '',
    '방문간호 서비스 제공 공백을 최소화하겠습니다.',
    '담당자 변경이나 일정 조정이 필요한 상황에서도 기존 기록과 인수인계 내용을 먼저 확인하고 관계 기관과 연락해 서비스가 중단되지 않도록 관리하겠습니다.',
    '',
    '명확한 의사소통으로 모두가 신뢰할 수 있는 방문간호를 제공하겠습니다.',
    '대상자와 보호자, 의료진 사이에서 정보가 다르게 전달되지 않도록 핵심 내용을 구분해 기록하고 확인이 필요한 사안은 즉시 다시 점검하는 방식으로 소통하겠습니다.',
    '',
    '적극적인 자세로 대상자를 위한 방문간호를 수행하겠습니다.',
    '현장에서 예상하지 못한 상황이 생기더라도 안전 기준과 대상자의 상태를 우선 확인하고 필요한 지원을 요청하며 맡은 역할을 끝까지 수행하겠습니다.'
  ].join('\n');
  const records = layoutStructure.buildLineRecords(source);
  const titleRows = records.filter(item => item.role === 'title');
  assert.equal(titleRows.length, 4);
  assert.ok(titleRows.every(item => /겠습니다\.$/u.test(item.text)));

  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  const lockedTexts = plan.chunks.filter(item => item.locked).map(item => item.text);
  for (const title of titleRows) assert.ok(lockedTexts.includes(title.text));
});

test('후기와 혜택·절대 주장·효능이 섞인 글은 단일 장르와 별개로 혼합 위험을 공유한다', () => {
  const source = [
    '보홀 여행에서 직접 방문해 본 마사지숍 후기예요.',
    '오일 마사지는 800페소이고 블로그를 보여 주면 전체 금액을 10% 할인해 준다고 안내받았어요.',
    '팡라오 섬 어디든 무료 픽업과 드랍이 가능하고 전 객실에 개별 샤워실이 있다고 했어요.',
    '카카오톡 문의에는 5분 이내로 바로 답변해 주셨고 망고도 서비스로 제공된다고 해요.',
    '햇볕에 탄 뒤 알로에 마사지를 받으면 화기를 빼는 데 직방이라 강력 추천합니다.'
  ].join('\n\n');
  const profile = documentProfile.detectDocumentProfile(source);
  assert.ok(profile.riskFlags.includes('commercial_claim'), JSON.stringify(profile));
  assert.ok(profile.riskFlags.includes('commercial_review'), JSON.stringify(profile));
  assert.ok(profile.riskFlags.includes('absolute_service_claim'), JSON.stringify(profile));
  assert.ok(profile.riskFlags.includes('health_claim'), JSON.stringify(profile));
  const depthPlan = humanizationDepth.buildHumanizationPlan(source, {
    requestStrength: 'basic',
    documentProfile: profile,
    inputRisk: { abstractRiskRatio: 0 }
  });
  assert.ok(depthPlan.commercialTargetSentenceCount >= 3, JSON.stringify(depthPlan));
  assert.ok(depthPlan.targetReasonCounts.commercial_offer_frame >= 1, JSON.stringify(depthPlan.targetReasonCounts));
  assert.ok(depthPlan.targetReasonCounts.commercial_absolute_claim >= 1, JSON.stringify(depthPlan.targetReasonCounts));
  assert.ok(depthPlan.targetReasonCounts.commercial_health_claim >= 1, JSON.stringify(depthPlan.targetReasonCounts));

  const built = humanizePrompts.buildHumanizePrompt('blog', 'ko', {
    register: 'haeyo',
    requestStrength: 'basic',
    documentProfile: profile,
    humanizationPlan: depthPlan
  });
  assert.match(built.stable, /\[혼합 의도 안전: 후기·광고·혜택 주장\]/u);
  assert.match(built.stable, /협찬·제휴·광고 여부가 원문이나 사용자 메모에 없으면/u);
  assert.match(built.stable, /효능 표현을 새로 만들거나 강화하지 않는다/u);
  assert.doesNotMatch(built.stable, /\[실질 휴머나이징 계약\]/u);
  assert.match(built.taskContract, /변화 분포 목표:[^\n]*최소\s+\d+개/u);
  assert.match(built.taskContract, /우선 대상 이행 목표:[^\n]*최소\s+\d+개/u);
  assert.match(built.taskContract, /구조 변화 목표:[^\n]*최소\s+\d+개/u);
  assert.match(built.taskContract, /반복 감탄·과도한 추천·혜택 나열·행동 요청/u);
  assert.ok(
    built.stable.indexOf('[혼합 의도 안전: 후기·광고·혜택 주장]')
      < built.stable.indexOf('[GPT 성향 보정]')
  );
  assert.equal(humanizePrompts.validateHumanizePrompt(built.stable, {
    taskContract: built.taskContract,
    requireHumanizationContract: true
  }).pass, true);
});

test('할인 제도를 분석하는 학술 글은 실제 광고 의도로 오인하지 않는다', () => {
  const source = [
    'Ⅰ. 서론',
    '본 연구는 온라인 플랫폼의 10% 할인과 1,000원 쿠폰, 무료 체험 문구가 소비자 선택에 미치는 영향을 분석한다.',
    'Ⅱ. 연구 방법',
    '본 연구에서는 선행 연구와 판결 자료를 검토하고 할인 쿠폰의 정보 비대칭성을 비교한다.',
    'Ⅲ. 연구 결과',
    '분석 결과 한정 기간과 선착순, 전 객실 제공, 치료 효과 같은 절대적 광고 표현이 판단에 영향을 줄 가능성이 확인되었다.',
    'Ⅳ. 결론',
    '향후 연구에서는 플랫폼 규제의 범위와 소비자 후생을 함께 검토할 필요가 있다.',
    '참고 문헌',
    '김연구(2024). 플랫폼 할인과 소비자 선택.',
    '이분석(2023). 정보 비대칭성의 구조.',
    '박자료(2022). 온라인 광고 규제.'
  ].join('\n');
  const profile = documentProfile.detectDocumentProfile(source);
  assert.ok(['academic_paper', 'report_assignment'].includes(profile.profile), JSON.stringify(profile));
  assert.equal(profile.signals.commercialSignals.suppressedAsResearchDiscussion, true, JSON.stringify(profile));
  assert.equal(profile.riskFlags.includes('commercial_claim'), false, JSON.stringify(profile));
  assert.equal(profile.riskFlags.includes('commercial_review'), false, JSON.stringify(profile));
  assert.equal(profile.riskFlags.includes('absolute_service_claim'), false, JSON.stringify(profile));
  assert.equal(profile.riskFlags.includes('health_claim'), false, JSON.stringify(profile));
  const plan = humanizationDepth.buildHumanizationPlan(source, {
    requestStrength: 'advanced',
    documentProfile: profile,
    inputRisk: { abstractRiskRatio: 0.5 }
  });
  assert.equal(plan.commercialTargetSentenceCount, 0, JSON.stringify(plan));
  assert.equal(
    Object.keys(plan.targetReasonCounts).some(key => key.startsWith('commercial_')),
    false,
    JSON.stringify(plan.targetReasonCounts)
  );
});

test('동시·수단 관계를 근거 없이 선후 관계로 바꾸면 논리 감사가 복원 대상으로 잡는다', () => {
  const source = '대화의 공백을 유지하면서 정보의 배치를 통제해 관객이 장면을 새롭게 해석하도록 한다.';
  const output = '대화의 공백을 유지하고 정보의 배치를 통제한 뒤 관객이 장면을 새롭게 해석하도록 한다.';
  const audit = fingerprintAudit.auditFingerprint(source, output, { profile: 'academic_paper' });
  assert.equal(audit.pass, false, JSON.stringify(audit));
  assert.ok(
    audit.semanticRelations.shifts.some(item => item.family === 'concurrent_relation_hardened_to_sequence'),
    JSON.stringify(audit)
  );
  const restored = fingerprintAudit.restoreUnsafeRelationSentences(source, output, audit);
  assert.equal(restored.applied, true);
  assert.equal(restored.text, source);
});

test('학술 결과에 새로 생긴 피동·사동 중첩은 잡되 원문 문제를 결과 사고로 중복 경고하지 않는다', () => {
  const source = '이 장면은 배신의 의미를 다시 드러낸다. 나는 연구의 범위는 대화 구조라고 보았다.';
  const output = '이 장면은 배신의 의미가 재의미화되게 한다. 나는 연구의 범위는 대화 구조라고 보았다.';
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'academic_paper', targetRegister: 'academic_formal' },
    mode: 'assignment'
  });
  assert.ok(audit.issueCodes.includes('passive_causative_stack'), JSON.stringify(audit));
  assert.ok(audit.residualWarnings.some(item => item.code === 'korean_passive_causative_stack'));
  assert.equal(audit.residualWarnings.some(item => item.code === 'korean_double_topic_chain'), false);
  assert.ok(audit.sourceReviewWarnings.some(item => item.code === 'double_topic_chain'));
});

test('이중 목적어 연어와 현재 지속 상태의 과거화는 일반화된 한국어 감사로 복원한다', () => {
  const source = [
    '사람들은 하루의 상당 시간을 매체를 접하며 살아간다.',
    '그 장면의 기억은 지금도 선명하게 남아 있다.'
  ].join(' ');
  const output = [
    '사람들은 매체를 하루의 상당 시간을 들이며 접하고 살아간다.',
    '그 장면의 기억은 지금도 선명하게 남아 있었다.'
  ].join(' ');
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'general_essay' },
    mode: 'assignment'
  });
  assert.ok(audit.issueCodes.includes('double_object_time_expenditure'), JSON.stringify(audit));
  assert.ok(audit.issueCodes.includes('persistent_state_tense_regression'), JSON.stringify(audit));
  const restored = koreanRefinement.restoreIntroducedIntegritySentences({
    source,
    outputText: output,
    audit
  });
  assert.equal(restored.applied, true);
  assert.equal(restored.text, source);
});

test('기본·고급은 문장 경계 토큰 충돌 없이 재구성하고 다듬기만 정확한 경계를 잠근다', () => {
  const source = '짧은 문장입니다. 이 문장은 앞 문장보다 조금 더 길게 이어집니다. 다시 짧습니다. 마지막 문장은 충분한 설명을 포함해 길게 마무리됩니다.';
  const voiceProfile = {
    lineBreakSensitive: false,
    sentence: { count: 4, cv: 0.48 }
  };
  assert.equal(
    chunkPolicy.shouldPreserveVoiceSentenceBoundaries(source, voiceProfile, 'assignment', 'basic'),
    false
  );
  assert.equal(
    chunkPolicy.shouldPreserveVoiceSentenceBoundaries(source, voiceProfile, 'assignment', 'advanced'),
    false
  );
  assert.equal(
    chunkPolicy.shouldPreserveVoiceSentenceBoundaries(source, voiceProfile, 'polish', 'polish'),
    true
  );
});

test('경계 프롬프트는 실제 존재하는 토큰만 설명하고 문장 내부 재구성을 명시한다', () => {
  const chunk = {
    text: '첫 문장입니다. 둘째 문장입니다.',
    llmText: '첫 문장입니다.[[[V2_SENTENCE_0001]]]둘째 문장입니다.',
    sentenceBoundaryMarkers: [{ marker: '[[[V2_SENTENCE_0001]]]' }],
    boundaryMarkers: [],
    lineBoundaryMarkers: [],
    position: 'body'
  };
  const prompt = humanizeUserBlock.buildHumanizeUser({
    chunk,
    chunks: [chunk],
    index: 0
  });
  assert.match(prompt, /V2_SENTENCE_/u);
  assert.match(prompt, /문장 내부를 원문대로 복사하라는 뜻이 아니다/u);
  assert.match(prompt, /절 배치·주어 위치·연결·호흡/u);
  assert.doesNotMatch(prompt, /V2_BOUNDARY_/u);
  assert.doesNotMatch(prompt, /V2_LINE_/u);
});
