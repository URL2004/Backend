'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const prompts = require('../engine-gpt-prod/prompts/humanize');
const voice = require('../engine-gpt-prod/voiceProfile');
const korean = require('../engine-gpt-prod/koreanRefinement');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const discourse = require('../engine-gpt-prod/discourseAudit');
const depth = require('../engine-gpt-prod/humanizationDepth');
const structure = require('../engine-gpt-prod/structureChunk');

const ESSAY_PROFILE = {
  profile: 'personal_essay',
  group: 'essay_application',
  targetRegister: 'personal_formal'
};

test('v2.5.38: 고급 개인 에세이는 사실 순서를 지키면서 반복 평가와 문단 역할을 재구성한다', () => {
  const prompt = prompts.buildHumanizePrompt('assignment', 'ko', {
    requestStrength: 'advanced',
    register: 'plain',
    documentProfile: ESSAY_PROFILE
  }).stable;

  assert.match(prompt, /사건의 시간 순서와 인과 방향/u);
  assert.match(prompt, /서사·줄거리·감상·제목 해석·결론/u);
  assert.match(prompt, /반복되는 평가나 교훈/u);
  assert.match(prompt, /같은 담화 역할 문단 정리는 검증 가능한 최종 레이아웃 단계/u);
  assert.match(prompt, /모델 편집 단계에서는 원문 문단 경계를 그대로 유지/u);
  assert.doesNotMatch(prompt, /문단 나눔과 결합도 실질 재구성/u);

  for (const documentProfile of [
    { profile: 'general', group: 'general' },
    { profile: 'review_blog', group: 'blog_social' }
  ]) {
    const genrePrompt = prompts.buildHumanizePrompt('assignment', 'ko', {
      requestStrength: 'advanced',
      register: 'plain',
      documentProfile
    }).stable;
    assert.match(genrePrompt, /모델 편집 단계에서는 원문 문단 경계를 그대로 유지/u, documentProfile.profile);
  }
});

test('v2.5.38: 반복된 작품명 인용 개수 감소는 직접 인용 손실로 오탐하지 않는다', () => {
  const source = '‘훌훌’이라는 책을 읽었다. 작가는 “털어 내라”고 썼다. 다시 ‘훌훌’의 의미를 생각했다.';
  const output = '‘훌훌’이라는 책을 읽었다. 작가는 “털어 내라”고 썼다. 제목의 의미를 다시 생각했다.';
  const audit = voice.auditDirectQuoteIntegrity(source, output);

  assert.equal(audit.pass, true, JSON.stringify(audit));
  assert.equal(audit.benignDuplicateReduction, true, JSON.stringify(audit));
  assert.equal(audit.missingUniqueCount, 0, JSON.stringify(audit));

  const missingUnique = voice.auditDirectQuoteIntegrity(source, '‘훌훌’이라는 책을 읽었다. 제목의 의미를 다시 생각했다.');
  assert.equal(missingUnique.pass, false, JSON.stringify(missingUnique));
  assert.equal(missingUnique.missingUniqueCount, 1, JSON.stringify(missingUnique));

  const repeatedSpeech = voice.auditDirectQuoteIntegrity(
    '친구가 “가자”라고 말했다. 잠시 뒤 다시 “가자”라고 재촉했다.',
    '친구가 “가자”라고 말했다.'
  );
  assert.equal(repeatedSpeech.pass, false, JSON.stringify(repeatedSpeech));
  assert.equal(repeatedSpeech.benignDuplicateReduction, false, JSON.stringify(repeatedSpeech));
});

test('v2.5.38: 닫는 인용부호 뒤 보조사와 문장부호 앞 공백을 결정론적으로 고친다', () => {
  const source = '‘먼지를 훌훌 털어내다’나 ‘옷을 훌훌 벗다’처럼 쓴다. 제2장.';
  const broken = '‘먼지를 훌훌 털어내다’ 나 ‘옷을 훌훌 벗다’처럼 쓴다. 제2장 .';
  const result = korean.applySafeFormattingRepairs({
    source,
    outputText: broken,
    documentProfile: ESSAY_PROFILE
  });

  assert.equal(result.text, source);
  assert.ok(result.changeCodes.includes('closed_quote_particle_spacing'), JSON.stringify(result));
  assert.ok(result.changeCodes.includes('sentence_punctuation_spacing'), JSON.stringify(result));
});

test('v2.5.38: 원문에 붙거나 띄어진 근거가 있는 중간 줄바꿈만 복원한다', () => {
  const source = '디지털 기기에 익숙해졌고, 단순한 기술을 넘어 일상생활의 일부가 되었다.';
  const broken = '디지털 기\n기에 익숙해졌고, 단순한\n\n기술을 넘어 일상\n생활의 일부가 되었다.';
  const result = korean.applySafeFormattingRepairs({
    source,
    outputText: broken,
    documentProfile: { profile: 'general_essay' }
  });

  assert.equal(result.text, source);
  assert.ok(result.brokenLineBreakRepairCount >= 3, JSON.stringify(result));

  const intentional = '첫번째 문단은 여기서 끝난다.\n\n두번째 문단은 새 주제를 시작한다.';
  assert.equal(korean.applySafeFormattingRepairs({ source: intentional, outputText: intentional }).text, intentional);

  const sameWordsElsewhere = '보고서에서는 기술 발전을 설명한다.\n\n다음 문단은 정책 방향을 다룬다.';
  const semanticBoundary = '첫 문단은 새로운 기술\n\n발전 방향은 별도의 정책 관점에서 다룬다.';
  assert.equal(
    korean.applySafeFormattingRepairs({ source: sameWordsElsewhere, outputText: semanticBoundary }).text,
    semanticBoundary
  );
});

test('v2.5.38: 원문부터 있던 호응·논리 결함을 표면 윤문으로 숨기지 않는다', () => {
  const source = [
    '찾아본 책의 내용은 입양 가족의 갈등을 다룬 소설이었다.',
    '요즘 사회에는 입양 가족에 대한 편견과 시선이 남아 있다.',
    '훌훌이 없는 사회가 아니라 훌훌이 있을 수밖에 없는 사회에 헌신하고 싶다.',
    '유리의 마음도 자신도 모르게 열리기 시작했다.',
    '이 책은 내 인생에 손에 꼽는 책이다.'
  ].join(' ');
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: source,
    documentProfile: ESSAY_PROFILE,
    mode: 'assignment'
  });
  const codes = new Set(audit.issueCodes);

  for (const code of [
    'content_identity_predicate_mismatch',
    'prejudiced_gaze_collocation',
    'negative_goal_commitment',
    'reflexive_subject_attachment',
    'locative_handpicked_collocation'
  ]) assert.equal(codes.has(code), true, `${code}: ${JSON.stringify(audit)}`);

  const repaired = korean.applySafeDeterministicRepairs({
    source,
    outputText: source,
    documentProfile: ESSAY_PROFILE
  });
  assert.match(repaired.text, /내 인생에서 손에 꼽는/u);

  const genericContradiction = korean.analyzeKoreanRefinement({
    source: '차별이 없는 조직이 아니라 차별이 만연한 조직에 기여하고 싶다.',
    outputText: '차별이 없는 조직이 아니라 차별이 만연한 조직에 기여하고 싶다.',
    documentProfile: ESSAY_PROFILE,
    mode: 'assignment'
  });
  assert.ok(genericContradiction.issueCodes.includes('negative_goal_commitment'), JSON.stringify(genericContradiction));

  const safeRemediation = korean.analyzeKoreanRefinement({
    source: '차별이 만연한 조직을 개선하는 데 기여하고 싶다.',
    outputText: '차별이 만연한 조직을 개선하는 데 기여하고 싶다.',
    documentProfile: ESSAY_PROFILE,
    mode: 'assignment'
  });
  assert.equal(safeRemediation.issueCodes.includes('negative_goal_commitment'), false, JSON.stringify(safeRemediation));
});

test('v2.5.38: 표기 오류가 많아도 원문의 논리 방향 결함을 1차 프롬프트에서 누락하지 않는다', () => {
  const source = [
    '친구에계 메세지를 보내며 내용을 깊게 이해했습니다 .',
    '실습수업에서 착,유 모드와 내부성적서를 확인했습니다.',
    '인생에 손에 꼽는 경험이라고 적었습니다.',
    '편견이 없는 사회가 아니라 편견이 있을 수밖에 없는 사회에 헌신하고 싶습니다.'
  ].join(' ');
  const hints = korean.buildSourcePromptHints(source, {
    documentProfile: ESSAY_PROFILE,
    mode: 'assignment'
  });

  assert.match(hints, /negative_goal_commitment/u, hints);
  assert.match(hints, /locative_handpicked_collocation/u, hints);
});

test('v2.5.38: 완성본에 남으면 안 되는 템플릿 표시는 삭제하지 않고 원문 확인 알림으로 분리한다', () => {
  const source = '지원 동기: [본인의 경험을 구체적으로 작성]\n관심 프로그램: [예: 재학생 멘토링]';
  const result = preflight.auditAndSanitizeSource(source);

  assert.equal(result.text, source);
  assert.equal(result.issueCodes.includes('source_template_placeholder'), true, JSON.stringify(result));
  assert.equal(result.warnings.some(item => item.code === 'source_template_placeholder'), true);
});

test('v2.5.38: 인접한 문장에 새로 복제된 추상 주제·서술핵 반복을 잡는다', () => {
  const source = '한 획에는 글쓴이의 관점이 놓인다.';
  const output = '한 획에는 글쓴이의 관점이 놓인다. 이러한 관점은 한 획 안에 그대로 놓여 있다.';
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'general_essay' },
    mode: 'assignment'
  });
  const issue = audit.issues.find(item => item.code === 'adjacent_semantic_repetition');
  assert.equal(Number(issue?.introducedCount || 0), 1, JSON.stringify(audit));
});

test('v2.5.38: 거시 담화 지표를 문장 편집률과 분리해 고급 후보 선택에 반영한다', () => {
  const source = [
    '책을 고른 이유와 첫인상을 설명했다.',
    '주인공이 겪는 사건을 시간 순서대로 정리했다.',
    '가족의 의미를 다시 느꼈다. 관계의 중요성도 다시 느꼈다.',
    '제목의 의미를 살펴보며 작가의 의도를 생각했다.'
  ].join('\n\n');
  const output = [
    '왜 이 책을 골랐는지와 처음 받은 느낌을 함께 풀었다.',
    '시간의 흐름을 따라 주인공의 사건을 정리했다.',
    '가족과 관계에 대한 생각은 한 문단에서 겹치지 않게 정리했다.',
    '마지막에는 제목에 담긴 의미와 작가의 의도를 살펴보았다.'
  ].join('\n\n');

  const macro = discourse.compareMacroDiscourse(source, output);
  assert.equal(macro.applicable, true, JSON.stringify(macro));
  assert.ok(macro.repeatedEvaluationReduction >= 1, JSON.stringify(macro));
  assert.ok(macro.score > 0, JSON.stringify(macro));

  const plan = depth.buildHumanizationPlan(source, {
    requestStrength: 'advanced',
    documentProfile: ESSAY_PROFILE,
    inputRisk: { abstractRiskRatio: 0.4 }
  });
  const report = depth.evaluateHumanizationDepth(source, output, plan);
  assert.equal(report.plan.macroDiscourseApplicable, true, JSON.stringify(report));
  assert.equal(typeof report.metrics.macroDiscourse.score, 'number', JSON.stringify(report));

  const candidateReport = macroScore => ({
    applicable: true,
    pass: false,
    plan: {
      minSubstantiveEditRatio: 0.2,
      requiredChangedSentenceCount: 5,
      requiredTargetChangedCount: 0,
      requiredStructuralChangedSentenceCount: 0,
      paragraphCoverageApplicable: false,
      minRemediationCoverage: 0,
      carryoverApplicable: false,
      macroDiscourseApplicable: true,
      macroDiscourseMinimumScore: 0.25
    },
    metrics: {
      substantiveEditRatio: 0.18,
      substantiveChangedSentenceCount: 4,
      structurallyChangedSentenceCount: 1,
      targetChangedParagraphCount: 1,
      targetChangedCount: 1,
      remediation: { coverage: 0 },
      macroDiscourse: { score: macroScore }
    }
  });
  const weak = candidateReport(0);
  const macroImproved = candidateReport(0.3);
  assert.ok(depth.humanizationCandidateScore(macroImproved) > depth.humanizationCandidateScore(weak));
  assert.equal(depth.isBetterHumanizationCandidate(weak, macroImproved), true);
});

test('v2.5.38: 고급 서사형 글의 안전한 문단 재구성을 최종 레이아웃이 원문으로 되돌리지 않는다', () => {
  const source = [
    '평소 청소년 소설을 읽으며 새 책을 고르는 이유를 설명했다. 첫인상도 함께 적었다.',
    '주인공이 가족과 갈등을 겪는 사건을 시간 순서대로 정리했다. 사건의 원인은 바꾸지 않았다.',
    '그 장면에서 가족의 의미를 생각했다. 관계의 중요성도 비슷한 말로 다시 평가했다.',
    '마지막에는 제목의 뜻을 해석했다. 이 책을 읽고 얻은 생각으로 글을 마쳤다.'
  ].join('\n\n');
  const output = [
    '평소 청소년 소설을 읽으며 새 책을 고르는 이유와 첫인상을 함께 설명했다.',
    '주인공이 가족과 갈등을 겪는 사건은 시간 순서대로 정리했고 사건의 원인도 그대로 두었다.',
    '가족과 관계에 대한 평가는 한 문단에 모아 겹치지 않게 정리했다.',
    '제목의 뜻은 별도 문단에서 해석했다.',
    '끝에는 이 책을 읽고 얻은 생각을 남겼다.'
  ].join('\n\n');
  const restored = structure.restoreParagraphLayout({
    source,
    outputText: output,
    chunks: [],
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: { ...ESSAY_PROFILE, confidence: 0.93, formatProfile: { flags: [] } },
    profileConfidence: 0.93
  });

  assert.notEqual(restored.policy, 'source_paragraph_roles', JSON.stringify(restored));
  assert.equal(restored.text.split(/\n\s*\n/u).length, 5, restored.text);
  assert.equal(restored.text.replace(/\s+/gu, ''), output.replace(/\s+/gu, ''));
});

test('v2.5.38: 문서 거시 담화 목표를 달성 불가능한 짧은 청크마다 중복 부과하지 않는다', () => {
  const chunks = [
    {
      index: 0,
      text: '책을 고른 이유를 적었다. 첫인상이 오래 남았다고 느꼈다.\n\n주인공의 첫 사건을 시간 순서대로 정리했다.'
    },
    {
      index: 1,
      text: '가족의 의미를 다시 느꼈다. 관계의 중요성도 다시 느꼈다.\n\n제목의 뜻을 해석하며 생각을 마무리했다.'
    }
  ];
  const source = chunks.map(chunk => chunk.text).join('\n\n');
  const options = {
    requestStrength: 'advanced',
    documentProfile: ESSAY_PROFILE,
    inputRisk: { abstractRiskRatio: 0.4 }
  };
  const documentPlan = depth.buildHumanizationPlan(source, options);
  const distributed = depth.buildDistributedHumanizationPlans(chunks, documentPlan, options);

  assert.equal(documentPlan.macroDiscoursePlan.applicable, true, JSON.stringify(documentPlan));
  assert.equal(distributed.plans.get(0).macroDiscoursePlan.applicable, false);
  assert.equal(distributed.plans.get(1).macroDiscoursePlan.applicable, false);

  for (const profile of ['general', 'review_blog']) {
    const aliasPlan = depth.buildHumanizationPlan(source, {
      ...options,
      documentProfile: { profile }
    });
    assert.equal(aliasPlan.macroDiscoursePlan.applicable, true, profile);
  }
});
