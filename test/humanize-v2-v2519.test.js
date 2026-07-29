'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const layoutStructure = require('../engine-gpt-prod/layoutStructure');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const sourcePreflight = require('../engine-gpt-prod/sourcePreflight');
const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');
const { buildVoiceProfile } = require('../engine-gpt-prod/voiceProfile');
const resumeCoverage = require('../engine-gpt-prod/resumeCoverage');
const discourse = require('../engine-gpt-prod/discourseAudit');
const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const dedupe = require('../engine/dedupe');
const humanizeEngine = require('../engine-gpt-prod');

test('v2.5.19: 순서도 행을 편집 산문과 분리해 잠그고 병합 손실을 탐지한다', () => {
  const flow = '시작 → 대학 생활 및 전공 학습 → 군 복무 → 대학 졸업 → 물류 분야 취업 → 실무 경험 축적 → 종료';
  const prose = '각 단계는 이전 단계의 결과를 바탕으로 다음 단계로 진행되도록 설계하였다.';
  const source = `${flow}\n${prose}`;

  assert.equal(layoutStructure.classifyLine(flow), 'flow');
  const plan = structureChunk.splitChunksForGpt(source);
  const lockedFlow = plan.chunks.find(chunk => chunk.lockType === 'flow');
  assert.ok(lockedFlow);
  assert.equal(lockedFlow.locked, true);
  assert.equal(lockedFlow.text.trim(), flow);
  assert.ok(plan.chunks.some(chunk => !chunk.locked && chunk.text.includes('각 단계는')));

  const mergedAudit = structureChunk.compareStructuralRoleSignatures(
    source,
    `${flow} ${prose}`
  );
  assert.equal(mergedAudit.pass, false);

  const restored = structureChunk.restoreLockedStructureLayout({
    source,
    outputText: `${flow} ${prose}`,
    chunks: plan.chunks
  });
  assert.equal(restored.pass, true);
  assert.match(restored.text, new RegExp(`${escapeRegex(flow)}\\n${escapeRegex(prose)}`, 'u'));
});

test('v2.5.19: 제목 다음의 이번·가장 같은 일반 단어를 조사로 오인해 행을 합치지 않는다', () => {
  const source = [
    '1. 프로젝트 수행 후 느낀 점',
    '이번 프로젝트를 수행하면서 나의 미래를 구체적으로 생각해 볼 수 있었다.',
    '시작 → 대학 생활 → 취업 준비 → 종료',
    '가장 먼저 전공 공부와 자격증 취득 계획을 세웠다.'
  ].join('\n');
  const repaired = koreanRefinement.applySafeFormattingRepairs({
    source,
    outputText: source,
    documentProfile: {
      profile: 'report_assignment',
      confidence: 0.95
    }
  });

  assert.equal(repaired.text, source);
  assert.equal(repaired.changeCodes.includes('particle_linebreak_join'), false);
  assert.match(repaired.text, /느낀 점\n이번 프로젝트/u);
  assert.match(repaired.text, /종료\n가장 먼저/u);
});

test('v2.5.19: 제목 뒤의 이 순서도는을 고립 주격 조사로 오인하지 않는다', () => {
  const source = [
    '3. 알고리즘 흐름 설명',
    '본 순서도는 기본 기호를 활용해 설계하였다.'
  ].join('\n');
  const output = [
    '3. 알고리즘 흐름 설명',
    '이 순서도는 기본 기호를 활용해 설계하였다.'
  ].join('\n');
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: {
      profile: 'report_assignment',
      targetRegister: 'academic_formal'
    },
    mode: 'assignment'
  });

  assert.equal(audit.issueCodes.includes('orphan_structural_particle'), false);
  assert.equal(
    koreanRefinement.applySafeDeterministicRepairs({ source, outputText: output }).text,
    output
  );
});

test('v2.5.19: 공백 없는 관찰 불릿은 접두부만 잠그고 세특 행 경계를 보존한다', () => {
  const source = [
    '고교학점제는 학생이 자신의 진로와 적성에 맞는 과목을 직접 선택해 이수하는 제도이지만 선택 과정에서 불안을 경험하는 것으로 나타남.',
    '+특히 고1 학생들은 진로가 아직 정해지지 않아 과목 선택에 큰 부담을 느낌.',
    '연구 자료에서도 진로가 바뀌어 선택 과목을 변경하려는 학생이 많다고 답함.',
    '+연구 결과 학생들은 진로 지도와 과목 정보를 충분히 제공받아야 한다고 응답함.',
    '이는 중요한 선택을 해야 한다는 압박감이 불안을 높일 수 있음을 보여 줌.'
  ].join('\n');

  assert.equal(layoutStructure.classifyLine('+특히 고1 학생들은 부담을 느낌.'), 'list');
  assert.equal(layoutStructure.classifyLine('+5% 증가했다.'), 'prose');
  const plan = structureChunk.splitChunksForGpt(source, { preserveLineBoundaries: true });
  const bulletPrefixes = plan.chunks.filter(chunk => chunk.lockType === 'bullet_prefix');
  assert.equal(bulletPrefixes.length, 2);
  assert.deepEqual(bulletPrefixes.map(chunk => chunk.text.trim()), ['+', '+']);
  assert.ok(plan.chunks.some(chunk => !chunk.locked && chunk.text.includes('특히 고1')));

  const voice = buildVoiceProfile(source, {
    documentProfile: { profile: 'student_record_teacher', confidence: 0.95 },
    mode: 'blog'
  });
  assert.equal(voice.lineBoundaryPolicy, 'all');
});

test('v2.5.19: 문제 표제와 단계형 진로 계획을 요청 모드와 무관하게 과제로 판정한다', () => {
  const source = [
    '문제 1. 진로 설계와 학교생활',
    '나는 졸업 후 직접 농사를 짓는 사람이 되고 싶다. 이 글에서는 목표를 이루기 위해 어떤 역량을 키워야 하는지 설명하고자 한다.',
    '첫째, 1~2학년에는 전공 기초를 다지고 학업 계획을 구체화한다.',
    '둘째, 3학년에는 학부 연구생으로 연구실 활동에 참여한다.',
    '셋째, 4학년에는 현장 실습과 캡스톤 디자인을 수행한다.',
    '졸업 후에는 배운 농업기계 기술을 활용해 농장을 운영할 계획이다.'
  ].join('\n');
  const blogHint = detectDocumentProfile(source, { basicStyle: 'blog' });
  const reportHint = detectDocumentProfile(source, { basicStyle: 'report' });

  assert.equal(blogHint.profile, 'report_assignment');
  assert.equal(reportHint.profile, 'report_assignment');
  assert.ok(blogHint.confidence >= 0.75);
  assert.equal(blogHint.signals.assignmentProblemHeadingSignals, 1);
  assert.ok(blogHint.signals.structuredCareerPlanSignals >= 3);
});

test('v2.5.19: 별도 행으로 밀린 종결점만 앞 문장에 복원한다', () => {
  const source = [
    '1단계에서는 데이터 역량과 금융 마인드셋을 확보하는 시기이다',
    '. 다음 문장에서는 실무 감각을 익힌다',
    '.',
    '2단계에서는 현장 경험을 바탕으로 업무 역량을 쌓는 시기이다',
    '.'
  ].join('\n');
  const repaired = sourcePreflight.repairSourceLayoutArtifacts(source);

  assert.equal(repaired.text.split('\n').some(line => line.trim() === '.'), false);
  assert.match(repaired.text, /실무 감각을 익힌다\./u);
  assert.match(repaired.text, /업무 역량을 쌓는 시기이다\./u);
  assert.ok(repaired.changes.filter(change => (
    change.code === 'source_isolated_terminal_punctuation_repaired'
  )).length >= 2);
});

test('v2.5.19: 자소서 제목은 주장 감사에서 제외하고 안전한 의역을 누락으로 보지 않는다', () => {
  const source = [
    '성장 과정과 학교 시절',
    '산업기사 자격증을 준비하면서 기하 공차와 치수 공차를 꼼꼼히 분석하는 습관을 길렀습니다.',
    '지원 동기',
    '도면 해석 역량과 측정 장비 활용 지식을 바탕으로 도면과 생산 현장 사이의 간극을 줄이는 데 기여하고 싶습니다.',
    '입사 후의 포부',
    '공정에서 발생하는 결함의 병목과 근본 원인을 찾아내는 문제 해결자가 되겠습니다.'
  ].join('\n');
  const output = [
    '성장 과정과 학교 시절',
    '산업기사 자격증을 준비하는 과정에서 기하 공차와 치수 공차를 세밀하게 보는 습관을 들였습니다.',
    '지원 동기',
    '도면을 읽는 역량과 측정 장비를 다루는 지식으로 설계와 생산 현장의 간극을 줄이는 데 힘을 보태고 싶습니다.',
    '입사 후의 포부',
    '공정 결함의 병목과 근본 원인을 정확히 짚어내는 문제 해결자로 성장하겠습니다.'
  ].join('\n');
  const report = resumeCoverage.auditResumeCoverage(
    source,
    output,
    { profile: 'resume_application', confidence: 0.95 }
  );

  assert.ok(report.claimCount >= 3);
  assert.equal(report.pass, true);
  assert.deepEqual(report.issueCodes, []);
});

test('v2.5.19: 실제 자소서 성과 문장 누락은 계속 탐지한다', () => {
  const source = [
    '직무 역량',
    '생산 라인의 불량 데이터를 분석해 결함 원인을 찾아냈고 재작업 비용을 15% 줄이는 프로젝트를 수행했습니다.',
    '입사 후 포부',
    '이 경험을 바탕으로 현장 품질을 높이는 엔지니어가 되겠습니다.'
  ].join('\n');
  const output = [
    '직무 역량',
    '현장 구성원과 원활히 협력하는 태도를 중요하게 생각합니다.',
    '입사 후 포부',
    '이 경험을 바탕으로 현장 품질을 높이는 엔지니어가 되겠습니다.'
  ].join('\n');
  const report = resumeCoverage.auditResumeCoverage(
    source,
    output,
    { profile: 'resume_application', confidence: 0.95 }
  );

  assert.equal(report.pass, false);
  assert.ok(report.issueCodes.includes('resume_claim_omission'));
});

test('v2.5.19: 모델이 만든 조사 꼬리와 같은 원문 주장 복제만 국소 제거한다', () => {
  const source = [
    '교육과정 성취기준을 중심으로 활동을 구성하였다.',
    '학생이 교사의 요청을 듣고 행동으로 옮기거나 도움이 필요할 때 자신의 생각과 요구를 적절한 말로 표현하도록 지도한다.'
  ].join(' ');
  const generated = [
    '교육과정 성취기준을 중심으로 구성하였다.',
    '를 중심으로 활동을 구성하였다.',
    '교사의 요청을 듣고 도움이 필요할 때 자신의 생각과 요구를 적절한 말로 표현하도록 지도한다.',
    '학생이 교사의 요청을 듣고 행동으로 옮기거나 도움이 필요할 때 자신의 생각과 요구를 적절한 말로 표현하도록 구체적으로 지도한다.'
  ].join(' ');
  const cleaned = dedupe.removeGeneratedLocalOverlapDuplicates(source, generated);

  assert.equal(cleaned.applied, true);
  assert.ok(cleaned.removedCount >= 1);
  assert.doesNotMatch(cleaned.text, /를 중심으로 활동을 구성하였다\./u);
  assert.ok(cleaned.reasons.includes('orphan_suffix_fragment'));
});

test('v2.5.19: 인과 방향이 다른 원문 문장 두 개는 중복으로 삭제하지 않는다', () => {
  const source = [
    '정보가 부족하면 선택에 대한 불안이 커진다.',
    '충분한 정보가 제공되면 선택에 대한 불안이 커지지 않는다.'
  ].join(' ');
  const result = dedupe.removeGeneratedLocalOverlapDuplicates(source, source);
  assert.equal(result.applied, false);
  assert.equal(result.text, source);
});

test('v2.5.19: 일반 산문 문단은 실제 담화 전환에서만 나누고 균등 분할하지 않는다', () => {
  const source = [
    '처음에는 현장의 업무 구조를 파악하는 데 집중했고 각 부서가 맡은 역할을 차례로 기록했다.',
    '담당자들의 설명을 들으며 설계 도면과 실제 작업이 연결되는 지점을 확인했다.',
    '반면 자재 조달 과정에서는 계획과 다른 변수가 자주 생겼고 현장에서는 그때마다 대안을 검토했다.',
    '기존 자재의 공급이 늦어지자 품질 기준을 유지할 수 있는 다른 공급처를 찾아 비교했다.',
    '그 과정에서 관리자는 공정 일정뿐 아니라 작업자의 의견과 안전 기준도 함께 조정했다.',
    '협의 결과는 작업 일지에 남겨 다음 교대조가 같은 기준으로 판단할 수 있도록 전달했다.',
    '관련 기록은 매일 정리해 다음 회의에서 확인할 항목과 추가 질문을 구분했다.',
    '마지막으로 실습이 끝난 뒤에는 기록을 다시 살펴보며 앞으로 준비할 자격과 학습 과제를 정리했다.',
    '현장 경험을 단순한 소감으로 남기지 않고 이후 학습 계획과 연결하는 것이 이번 활동의 결론이었다.'
  ].join(' ');
  const chunks = structureChunk.splitChunksForGpt(source).chunks;
  const restored = structureChunk.restorePostSemanticLayout({
    source,
    outputText: source,
    chunks,
    mode: 'blog',
    requestStrength: 'basic',
    documentProfile: 'general',
    profileConfidence: 0.8
  });
  const paragraphs = restored.text.split(/\n\s*\n/u).filter(Boolean);
  const sentenceCounts = paragraphs.map(paragraph => (
    paragraph.split(/(?<=[.!?])\s+/u).filter(Boolean).length
  ));

  assert.equal(restored.paragraphs.policy, 'semantic_prose_roles');
  assert.ok(paragraphs.length >= 2);
  assert.ok(new Set(sentenceCounts).size > 1);
  assert.equal(restored.paragraphs.pass, true);
});

test('v2.5.19: 담화 회복 프롬프트는 대상 문장과 강도·부정 보존을 구체적으로 지시한다', () => {
  const source = [
    '심각한 인구절벽을 방치하면 국가 소멸이라는 재앙을 초래할 수 있다.',
    '막강한 외세에 휘둘리면 공동체의 파멸을 막기 어렵다.',
    '결국 공적인 기준이 필요하다.',
    '이처럼 객관적인 판단은 매우 중요하다.'
  ].join(' ');
  const plan = discourse.buildRemediationPlan(source);
  const guidance = discourse.remediationPromptGuidance(plan);

  assert.equal(plan.applicable, true);
  assert.match(guidance, /대상 일반 문장=/u);
  assert.match(guidance, /부정, 가능성, 우려, 단정의 강도/u);
  assert.match(guidance, /결론 자체는 삭제하지 않는다/u);
});

test('v2.5.19: 잔존한 강한 수식 문장을 일반 깊이 대상보다 먼저 회복한다', () => {
  const source = [
    '이러한 관점은 공동체를 이해하는 데 중요한 의미가 있다.',
    '그는 오랜 기간 이어진 거대한 상호작용의 역사를 기록했다.',
    '결정적 근거는 위정자들의 왜곡된 보고를 비판했다는 점이다.',
    '심각한 인구절벽은 장기적인 정책 검토가 필요한 문제다.'
  ].join(' ');
  const plan = require('../engine-gpt-prod/humanizationDepth').buildHumanizationPlan(source, {
    requestStrength: 'advanced',
    documentProfile: { profile: 'report_assignment', confidence: 0.9 }
  });
  const depthReport = require('../engine-gpt-prod/humanizationDepth').evaluateHumanizationDepth(
    source,
    source,
    plan
  );
  const unresolved = discourse.unresolvedRemediationSentenceOrdinals(
    source,
    source,
    plan.rhetoricalRemediationPlan
  );
  const targets = require('../engine-gpt-prod/finalQualityV2').buildGeneralRetryTargetOrdinals(
    source,
    source,
    plan,
    depthReport
  );

  assert.deepEqual(unresolved, [2, 4]);
  assert.ok(unresolved.includes(targets[0]));
  assert.notEqual(targets[0], 1);
  assert.deepEqual(
    discourse.remediationTargetTerms(
      '심각한 인구절벽은 거대한 영향을 남길 수 있다.',
      [{ code: 'stacked_strong_modifiers' }]
    ),
    ['심각한', '거대한']
  );
  assert.equal(
    discourse.remediationCategoryCount('인구절벽이 이어지면 정책 부담이 커질 수 있다.', 'stacked_strong_modifiers'),
    0
  );
});

test('v2.5.19: 보수적 문장 회복은 0.2%대 표면 증가와 실질 진전을 구분한다', () => {
  const baseline = {
    minimumEffectPass: false,
    metrics: {
      substantiveEditRatio: 0.08,
      substantiveChangedSentenceCount: 3,
      targetChangedCount: 2,
      effectiveStructuralChangedSentenceCount: 1
    }
  };
  const marginal = humanizeEngine.measureConservativeRecoveryProgress(baseline, {
    minimumEffectPass: false,
    metrics: {
      substantiveEditRatio: 0.0825,
      substantiveChangedSentenceCount: 3,
      targetChangedCount: 2,
      effectiveStructuralChangedSentenceCount: 1
    }
  });
  const meaningful = humanizeEngine.measureConservativeRecoveryProgress(baseline, {
    minimumEffectPass: false,
    metrics: {
      substantiveEditRatio: 0.083,
      substantiveChangedSentenceCount: 4,
      targetChangedCount: 3,
      effectiveStructuralChangedSentenceCount: 2
    }
  });

  assert.equal(marginal.meaningful, false);
  assert.equal(marginal.substantiveEditGain, 0.0025);
  assert.equal(meaningful.meaningful, true);
  assert.equal(meaningful.changedSentenceGain, 1);

  const remediation = humanizeEngine.measureConservativeRecoveryProgress({
    ...baseline,
    metrics: { ...baseline.metrics, remediation: { coverage: 0 } }
  }, {
    minimumEffectPass: false,
    metrics: { ...baseline.metrics, substantiveEditRatio: 0.082, remediation: { coverage: 0.5 } }
  });
  assert.equal(remediation.meaningful, true);
  assert.equal(remediation.remediationGain, 0.5);
});

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
