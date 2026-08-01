'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const engine = require('../engine-gpt-prod');
const candidateIntegrity = require('../engine-gpt-prod/candidateIntegrity');
const humanizationDepth = require('../engine-gpt-prod/humanizationDepth');
const { assessRepairCandidate } = require('../engine-gpt-prod/judge');
const prompts = require('../engine-gpt-prod/prompts/humanize');
const { buildBoundaryMarkerInstructions } = require('../engine-gpt-prod/prompts/humanize/userBlock');
const { createRecoveryBudget } = require('../engine-gpt-prod/recoveryBudget');
const resumeCoverage = require('../engine-gpt-prod/resumeCoverage');
const { canonicalPriceKey, priceFor } = require('../engine-gpt-prod/usageCost');
const { sentenceDistributionShift } = require('../engine-gpt-prod/voiceProfile');
const { buildContract } = require('../engine/contract');

test('의미 수리 후보가 문서 전체를 원문으로 되돌리면 항상 거부한다', () => {
  const source = '연구팀은 자료를 비교해 차이의 원인을 분석했습니다. 결과는 보고서에 정리했습니다.';
  const before = '차이가 생긴 원인을 찾기 위해 연구팀은 자료부터 비교했습니다. 분석 결과는 보고서에 따로 정리했습니다.';
  const report = assessRepairCandidate(source, before, source, {
    mode: 'assignment',
    documentProfile: { profile: 'report_assignment' }
  });
  assert.equal(report.pass, false);
  assert.ok(report.reasons.includes('repair_erased_transform'));
});

test('길이 축약·절단 승격은 누락 복원을 지시하고 일반 보존 문구로 빠지지 않는다', () => {
  for (const reason of ['length_collapse', 'sentence_truncated', 'empty_or_meta_output']) {
    const instruction = prompts.buildEscalationInstruction(reason);
    assert.match(instruction, /누락된 문장과 끝부분을 모두 복원/u, reason);
    assert.match(instruction, /완결된 전체 청크/u, reason);
    assert.doesNotMatch(instruction, /실패 구간만 고친다/u, reason);
  }
});

test('프롬프트는 공통 규칙과 장르 규칙을 분리하고 긍정 재구성 예를 포함한다', () => {
  const blog = prompts.buildHumanizePrompt('blog', 'ko', {
    register: 'haeyo',
    requestStrength: 'basic',
    documentProfile: {
      profile: 'review_blog',
      group: 'blog_social',
      targetRegister: 'conversational'
    }
  });
  const academic = prompts.buildHumanizePrompt('assignment', 'ko', {
    register: 'polite',
    requestStrength: 'advanced',
    documentProfile: {
      profile: 'academic_paper',
      group: 'academic_report_explainer',
      targetRegister: 'academic_formal'
    }
  });
  assert.equal(prompts.validateHumanizePrompt(blog.stable).pass, true);
  assert.equal(prompts.validateHumanizePrompt(academic.stable).pass, true);
  assert.match(blog.stable, /실질 재구성 예:/u);
  assert.match(blog.stable, /가짜 체험담/u);
  assert.doesNotMatch(blog.stable, /최적화·상관관계·원인 분석·재현성 검증/u);
  assert.match(academic.stable, /최적화·상관관계·원인 분석·재현성 검증/u);
  assert.ok(blog.stable.length < academic.stable.length);
});

test('polish 문장 경계는 교정 범위만 허용하고 실질 재작성을 요구하지 않는다', () => {
  const instruction = buildBoundaryMarkerInstructions({
    sentenceBoundaryMarkers: ['[[[V2_SENTENCE_0001]]]']
  }, { mode: 'polish' });
  assert.match(instruction, /비문·띄어쓰기·조사·접속·실제 중복만/u);
  assert.doesNotMatch(instruction, /실질적으로 재구성/u);
});

test('정상적인 절 재배치 수준의 작은 리듬 변화는 기본·고급 모두 평탄화로 오인하지 않는다', () => {
  const before = {
    count: 4,
    mean: 50,
    cv: 0.4,
    min: 10,
    max: 90,
    lengthSequence: [10, 30, 70, 90]
  };
  const after = {
    count: 4,
    mean: 50,
    cv: 0.385,
    min: 10.75,
    max: 89.25,
    lengthSequence: [11, 31, 69, 89]
  };
  assert.equal(sentenceDistributionShift(before, after).shift, false);
  assert.equal(sentenceDistributionShift(before, after, { toleranceMultiplier: 1.75 }).shift, false);
});

test('기본 모드도 세 문단 이상이면 모델 대상 문장을 둘 이상의 문단에 배분한다', () => {
  const source = [
    '첫 문단에서는 여러 자료를 비교하고 핵심 내용을 순서대로 정리했습니다.',
    '둘째 문단에서는 발표 흐름을 구성하고 친구들의 질문에 답했습니다.',
    '마지막 문단에서는 결과를 다시 검토하고 다음 활동 계획을 기록했습니다.'
  ].join('\n\n');
  const plan = humanizationDepth.buildHumanizationPlan(source, {
    requestStrength: 'basic',
    documentProfile: { profile: 'general' }
  });
  const mapping = humanizationDepth.buildSentenceParagraphMap(source);
  const targetParagraphs = new Set(plan.targetIndices.map(index => mapping.sentenceParagraphIndices[index]));
  assert.equal(plan.paragraphCoverageApplicable, true);
  assert.ok(targetParagraphs.size >= 2);
  assert.ok(plan.requiredTargetChangedParagraphCount >= 2);
  assert.ok(plan.targetReasonCounts.basic_paragraph_distribution >= 1);
});

test('저신뢰 자소서와 안전 프로필에서도 핵심 주장 누락 감사를 끄지 않는다', () => {
  const source = '프로젝트에서 회로를 설계하고 검증을 완료해 소비 전력을 12% 줄였습니다. 이 경험을 개발 직무에 활용하고 싶습니다.';
  const output = '프로젝트에 참여했습니다. 이 경험을 개발 직무에 활용하고 싶습니다.';
  const lowConfidence = resumeCoverage.auditResumeCoverage(source, output, {
    profile: 'resume_application',
    confidence: 0.41
  });
  const safetyProfile = resumeCoverage.auditResumeCoverage(source, output, {
    profile: 'unknown',
    confidence: 0.31,
    safetyProfiles: ['resume_application']
  });
  assert.equal(lowConfidence.applicable, true);
  assert.equal(lowConfidence.pass, false);
  assert.equal(safetyProfile.applicable, true);
  assert.equal(safetyProfile.pass, false);
});

test('짧은 학술 문단의 숫자 6개만으로 상위 reasoning 경로를 강제하지 않는다', () => {
  const source = '본 연구는 2023년부터 2025년까지 3개 기관의 데이터를 분석하였다. 응답률은 62.4%였으며 유효 표본은 1,200명이다. 이는 선행연구와 유사한 수준이다.';
  const config = { escalation: { protectedTermThreshold: 40, patchTargetThreshold: 12 } };
  assert.equal(engine.isHighRiskChunk(
    source,
    [],
    [],
    config,
    null,
    { profile: 'academic_paper' }
  ), false);
  assert.equal(engine.isHighRiskChunk(
    `${source} ${source}`,
    [],
    [],
    config,
    null,
    { profile: 'academic_paper' }
  ), true);
});

test('날짜 접미 모델과 알 수 없는 모델의 비용을 Luna로 과소계산하지 않는다', () => {
  assert.equal(canonicalPriceKey('gpt-5.6-terra-2026-07-30'), 'gpt-5.6-terra');
  assert.deepEqual(priceFor('gpt-5.6-terra-2026-07-30'), priceFor('gpt-5.6-terra'));
  assert.equal(priceFor('gpt-5.6-unknown').output, priceFor('gpt-5.6-terra').output);
});

test('후보 무결성은 위험 총량이 줄 때 비수리 알림 1건만 허용한다', () => {
  const before = { weightedRisk: 3, repairableIssueCount: 0, introducedIssueCount: 2, issues: [] };
  const candidate = {
    weightedRisk: 1,
    repairableIssueCount: 0,
    introducedIssueCount: 1,
    issues: [{ code: 'review_notice', introducedCount: 1, repairable: false, weight: 1 }]
  };
  assert.equal(candidateIntegrity.koreanIntegrityWorsened({
    before,
    candidate,
    beforeCounts: new Map(),
    candidateCounts: new Map([['review_notice', 1]])
  }), false);
  assert.equal(candidateIntegrity.koreanIntegrityWorsened({
    before,
    candidate: {
      ...candidate,
      issues: [{ code: 'review_notice', introducedCount: 2, repairable: false, weight: 1 }]
    },
    beforeCounts: new Map(),
    candidateCounts: new Map([['review_notice', 2]])
  }), true);
});

test('회복 예산은 USD와 별개로 호출 수와 경과 시간을 원자적으로 제한한다', () => {
  let now = 0;
  const callBudget = createRecoveryBudget(1, { maxCalls: 2, maxElapsedMs: 30000, clock: () => now });
  assert.equal(callBudget.tryStart(), true);
  assert.equal(callBudget.tryStart(), true);
  assert.equal(callBudget.tryStart(), false);
  assert.equal(callBudget.snapshot().lastDeniedReason, 'recovery_call_limit_exhausted');

  const timeBudget = createRecoveryBudget(1, { maxCalls: 5, maxElapsedMs: 30000, clock: () => now });
  now = 30000;
  assert.equal(timeBudget.tryStart(), false);
  assert.equal(timeBudget.snapshot().lastDeniedReason, 'recovery_time_limit_exhausted');
});

test('청크 보존 실패는 안전한 문장 편집만 누적하고 보호 사실 손실은 버린다', () => {
  const source = '한국대학교 연구팀은 학생 20명을 조사했습니다. 연구팀은 설문과 면담 기록을 분석해 보고서로 정리했습니다.';
  const candidate = '한 대학 연구팀은 여러 학생을 조사했습니다. 설문과 면담 기록은 연구팀이 함께 분석해 보고서로 정리했습니다.';
  const contract = buildContract(source, {
    mode: 'assignment',
    documentProfile: { profile: 'report_assignment' }
  });
  const plan = humanizationDepth.buildHumanizationPlan(source, {
    requestStrength: 'basic',
    documentProfile: { profile: 'report_assignment' }
  });
  const result = engine.tryAccumulateFailedChunkEdits({
    original: source,
    attempts: [{
      outputText: candidate,
      record: { hardFailReason: 'lost_facts', floorViolations: [{ gate: 'lost_facts' }] }
    }],
    contract,
    mode: 'assignment',
    requestStrength: 'basic',
    documentProfile: { profile: 'report_assignment' },
    chunkHumanizationPlan: plan
  });
  assert.equal(result.applied, true, JSON.stringify(result));
  assert.match(result.outputText, /한국대학교/u);
  assert.match(result.outputText, /20명/u);
  assert.doesNotMatch(result.outputText, /한 대학 연구팀은 여러 학생/u);
  assert.match(result.outputText, /설문과 면담 기록은 연구팀이/u);
});

test('과도하게 길어진 청크도 안전한 문장 편집만 골라 살린다', () => {
  const source = '한국대학교 연구팀은 학생 20명을 조사했습니다. 연구팀은 설문과 면담 기록을 분석해 보고서로 정리했습니다.';
  const candidate = '한 대학 연구팀은 여러 학생을 조사했고 이 과정은 연구의 의미를 더욱 폭넓게 보여 주며 앞으로도 중요한 기반이 될 수 있다고 판단했습니다. 설문과 면담 기록은 연구팀이 함께 분석해 보고서로 정리했습니다.';
  const documentProfile = { profile: 'report_assignment' };
  const contract = buildContract(source, { mode: 'assignment', documentProfile });
  const plan = humanizationDepth.buildHumanizationPlan(source, {
    requestStrength: 'basic',
    documentProfile
  });
  const result = engine.tryAccumulateFailedChunkEdits({
    original: source,
    attempts: [{
      outputText: candidate,
      record: { hardFailReason: 'length_overrun', floorViolations: [{ gate: 'length_overrun' }] }
    }],
    contract,
    mode: 'assignment',
    requestStrength: 'basic',
    documentProfile,
    chunkHumanizationPlan: plan
  });
  assert.equal(result.applied, true, JSON.stringify(result));
  assert.doesNotMatch(result.outputText, /앞으로도 중요한 기반/u);
  assert.match(result.outputText, /설문과 면담 기록은 연구팀이/u);
});

test('장문 학술문의 단일 1인칭 표식은 문서 전체를 개인 화자로 바꾸지 않는다', () => {
  const academic = `나는 이 표현을 인용 사례로 한 번 언급했다. ${'자료의 조건과 분석 결과를 객관적으로 정리하였다. '.repeat(500)}`;
  const academicContract = buildContract(academic, {
    documentProfile: { profile: 'academic_paper' }
  });
  const resumeContract = buildContract('저는 회로 설계와 검증을 담당했습니다.', {
    documentProfile: { profile: 'resume_application' }
  });
  const organizationContract = buildContract('본 연구는 자료의 범위와 분석 절차를 설명한다.', {
    documentProfile: { profile: 'academic_paper' }
  });
  assert.equal(academicContract.povSeed.fp_singular, 1);
  assert.equal(academicContract.speakerType, 'impersonal');
  assert.equal(resumeContract.speakerType, 'individual');
  assert.equal(organizationContract.speakerType, 'impersonal');
  assert.deepEqual(organizationContract.allowedPronouns, []);
});
