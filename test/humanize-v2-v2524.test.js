'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const inputRouting = require('../engine/inputrouting');
const {
  detectDocumentProfile,
  applyDocumentProfileOverride
} = require('../engine-gpt-prod/documentProfile');
const humanizationDepth = require('../engine-gpt-prod/humanizationDepth');
const discourse = require('../engine-gpt-prod/discourseAudit');
const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const structure = require('../engine-gpt-prod/structureChunk');
const prompts = require('../engine-gpt-prod/prompts/humanize');
const { sentenceDistributionShift } = require('../engine-gpt-prod/voiceProfile');

test('v2.5.24: 일본어·중국어 본문은 허용하고 영어 위주 입력만 기존 정책대로 막는다', () => {
  const japanese = 'この授業では文学作品の背景を調べ、登場人物の考え方について自分の意見をまとめました。発表のあとで友人の質問にも答えました。';
  const chinese = '本研究分析数字平台的信息结构和消费者选择之间的关系，并讨论制度设计和用户保护的主要条件。研究结果表明信息顺序会影响判断。';
  const english = 'This document explains how the research team compared multiple design alternatives and recorded the final findings for review.';
  const koreanTechnical = 'RF PLL 모듈의 PCB artwork와 Gerber file을 대조했습니다. MCU 레지스터 설정을 검증한 뒤 결과를 기술 문서에 기록했습니다.';

  assert.equal(inputRouting.isEnglishInput(japanese), false);
  assert.equal(inputRouting.isEnglishInput(chinese), false);
  assert.equal(inputRouting.isEnglishInput(english), true);
  assert.equal(inputRouting.isEnglishInput(koreanTechnical), false);
});

test('v2.5.24: 1인칭이 생략된 기술 경력 요약도 지원서 전문 문체로 라우팅한다', () => {
  const source = [
    '방산 레이더 장비와 RF PLL 모듈의 하드웨어 설계·검토 및 기능시험을 수행했습니다.',
    '단계별 설계검토에서 고객 요구사항을 분석하고 시스템 블록도와 회로도에 반영했습니다.',
    'PCB artwork와 Gerber file을 대조해 회로 일치 여부를 검토했습니다.',
    '지정된 PIC 계열 MCU와 RF PLL IC를 바탕으로 모듈 회로를 설계했습니다.',
    '레지스터 설정과 출력 주파수, PLL lock 상태를 검증했습니다.',
    '검증 절차를 시험 문서로 작성해 인수인계했습니다.'
  ].join(' ');
  const profile = detectDocumentProfile(source);

  assert.equal(profile.profile, 'resume_application', JSON.stringify(profile.candidateProfiles));
  assert.ok(profile.confidence >= 0.75);
  assert.equal(profile.signals.technicalCareerFrame, true);
});

test('v2.5.24: 고신뢰 감지와 같은 장르군의 사용자 세부 선택은 보존 규칙을 유지하며 적용한다', () => {
  const detected = {
    profile: 'long_explainer',
    contentGenre: 'long_explainer',
    confidence: 0.97,
    group: 'academic_report_explainer',
    safetyProfiles: [],
    profileDecisionSource: 'content_only'
  };
  const resolved = applyDocumentProfileOverride(detected, 'academic_paper');

  assert.equal(resolved.profile, 'academic_paper');
  assert.equal(resolved.profileOverrideApplied, true);
  assert.equal(resolved.profileDecisionSource, 'user_same_group_override');
  assert.ok(resolved.safetyProfiles.includes('academic_paper'));

  const crossGroup = applyDocumentProfileOverride({ ...detected, profile: 'creative', group: 'creative' }, 'academic_paper');
  assert.equal(crossGroup.profile, 'creative');
  assert.equal(crossGroup.profileOverrideIgnoredReason, 'high_confidence_content');
});

test('v2.5.24: 기술 경력서의 잘못된 4+2 문단 경계를 업무 묶음 기준 3+3으로 옮긴다', () => {
  const rows = [
    '레이더 장비의 하드웨어 설계와 기능시험을 수행했습니다.',
    '단계별 설계검토에서는 고객 요구사항을 분석해 회로도에 반영했습니다.',
    'PCB artwork와 Gerber file을 대조해 회로 일치 여부를 확인했습니다.',
    '지정된 PIC 계열 MCU와 RF PLL IC를 바탕으로 모듈 회로를 작성했습니다.',
    '출력 주파수와 PLL lock 상태를 확인해 레지스터 검증값을 펌웨어에 반영했습니다.',
    '레지스터 변경부터 출력 확인까지의 절차를 기술 문서로 작성해 인수인계했습니다.'
  ];
  const source = rows.join(' ');
  const misplaced = `${rows.slice(0, 4).join(' ')}\n\n${rows.slice(4).join(' ')}`;
  const profile = {
    profile: 'resume_application',
    confidence: 0.95,
    formatProfile: { primary: 'plain', flags: [] }
  };
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: misplaced,
    chunks: structure.splitChunksForGpt(source, { coalesceEditable: true }).chunks,
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: profile,
    profileConfidence: 0.95
  });
  const counts = restored.text.split(/\n\s*\n/u).map(paragraph => (
    paragraph.match(/[.!?。！？](?:\s|$)/gu) || []
  ).length);

  assert.equal(restored.paragraphs.policy, 'semantic_prose_roles');
  assert.deepEqual(counts, [3, 3]);
  assert.equal(restored.text.replace(/\s+/gu, ''), source.replace(/\s+/gu, ''));
});

test('v2.5.24: 읽기 한도 때문에 더 합칠 수 없는 구조 문단을 레이아웃 실패로 오인하지 않는다', () => {
  const context = Array.from({ length: 4 }, (_, index) => `개요 문장 ${index + 1}은 과제의 배경과 범위를 구체적으로 설명합니다.`).join(' ');
  const methodRows = Array.from({ length: 8 }, (_, index) => `방법 문장 ${index + 1}은 자료 검토 절차와 판단 기준을 단계별로 기록합니다.`);
  const result = Array.from({ length: 5 }, (_, index) => `결과 문장 ${index + 1}은 확인된 내용과 남은 한계를 함께 정리합니다.`).join(' ');
  const source = [`개요: ${context}`, methodRows.join(' '), result, '참고: 별도 자료 없음'].join('\n');
  const output = [
    `개요: ${context}`,
    methodRows.slice(0, 4).join(' '),
    methodRows.slice(4).join(' '),
    result,
    '참고: 별도 자료 없음'
  ].join('\n\n');
  const profile = {
    profile: 'report_assignment',
    confidence: 0.96,
    formatProfile: { primary: 'label_heavy', flags: ['label_heavy'] }
  };
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: output,
    chunks: structure.splitChunksForGpt(source, {
      coalesceEditable: true,
      formatProfile: profile.formatProfile
    }).chunks,
    mode: 'assignment',
    requestStrength: 'basic',
    documentProfile: profile,
    profileConfidence: profile.confidence
  });

  assert.equal(restored.paragraphs.pass, true, JSON.stringify(restored.paragraphs));
  assert.equal(restored.paragraphs.targetConstrained, true, JSON.stringify(restored.paragraphs));
  assert.equal(restored.text.replace(/\s+/gu, ''), source.replace(/\s+/gu, ''));
});

test('v2.5.24: 문장 간 단계·인과·지시 대상 변화와 신규 연어 오류를 한 감사에서 잡는다', () => {
  const source = [
    '본 연구는 자료를 분석하였다.',
    '이때 각 조건의 차이를 확인했으며, 이는 독립된 검증이 필요하다는 점을 시사한다.',
    '회로 설계 후 출력값을 확인했다.',
    '업무의 우선순위를 판단하고 손발이 빠른 구성원과 역할을 나누었다.',
    '아이들이 안심할 수 있는 환경을 만들며, 믿고 맡길 수 있는 선생님이 되겠습니다.'
  ].join(' ');
  const output = [
    '본 연구는 자료를 분석 대상으로 삼았다.',
    '따라서 각 조건의 차이를 확인했다.',
    '전체적으로 독립된 검증이 필요하다는 점을 시사한다.',
    '회로 설계가 완료된 뒤 출력값을 확인했다.',
    '업무의 우선순위를 먼저 판단하고 손과 발이 빠른 구성원과 역할을 나누었다.',
    '아이들이 믿고 맡길 수 있는 선생님이 되겠습니다.'
  ].join(' ');
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'academic_paper', targetRegister: 'academic_formal' },
    mode: 'assignment'
  });
  const codes = new Set(audit.issues.filter(item => item.introducedCount > 0).map(item => item.code));

  for (const code of [
    'analysis_stage_weakened',
    'causal_connector_strengthening',
    'dangling_inference_predicate',
    'completion_scope_strengthening',
    'priority_first_redundancy',
    'hands_feet_speed_collocation',
    'trust_entrust_subject_collocation'
  ]) assert.ok(codes.has(code), `${code}: ${JSON.stringify(audit.issues)}`);

  const deterministic = koreanRefinement.applySafeDeterministicRepairs({
    source,
    outputText: output,
    documentProfile: { profile: 'academic_paper' }
  });
  assert.doesNotMatch(deterministic.text, /우선순위를\s+먼저/u);
  assert.doesNotMatch(deterministic.text, /손과\s*발이\s*빠/u);

  const restored = koreanRefinement.restoreIntroducedIntegritySentences({
    source,
    outputText: deterministic.text,
    audit: koreanRefinement.analyzeKoreanRefinement({
      source,
      outputText: deterministic.text,
      documentProfile: { profile: 'academic_paper', targetRegister: 'academic_formal' },
      mode: 'assignment'
    })
  });
  assert.equal(restored.applied, true, JSON.stringify(restored));
  const after = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: restored.text,
    documentProfile: { profile: 'academic_paper', targetRegister: 'academic_formal' },
    mode: 'assignment'
  });
  assert.equal(after.introducedIssueCount, 0, JSON.stringify({
    text: restored.text,
    restoredCodes: restored.restoredCodes,
    restoredSentenceOrdinals: restored.restoredSentenceOrdinals,
    issues: after.issues
  }));
});

test('v2.5.24: 순차 접속어와 종결어미만 바꾼 결과는 실질 편집률을 부풀리지 않는다', () => {
  const source = '설계 후 회로를 확인했습니다. 또한 결과를 검토했습니다.';
  const output = '설계가 완료된 뒤 회로를 확인하였습니다. 아울러 결과를 검토하였습니다.';
  const metrics = humanizationDepth.measureSubstantiveEdit(source, output);

  assert.ok(metrics.literalNormalizedEditRatio > 0);
  assert.equal(metrics.substantiveEditRatio, 0);
  assert.equal(metrics.substantiveChangedSentenceCount, 0);
  assert.equal(metrics.surfaceOnlySentenceCount, 2);
});

test('v2.5.24: 기술 경력서의 회로 작성 범위와 학술문의 됐다 축약형을 원문 단계부터 교정 대상으로 보낸다', () => {
  const technical = '지정된 RF PLL IC를 기반으로 모듈 회로를 작성하고 레지스터 설정값을 검증했습니다.';
  const technicalProfile = { profile: 'resume_application', targetRegister: 'professional' };
  const technicalAudit = koreanRefinement.analyzeKoreanRefinement({
    source: technical,
    outputText: technical,
    documentProfile: technicalProfile,
    mode: 'assignment'
  });
  assert.ok(technicalAudit.repairableCodes.includes('technical_circuit_action_collocation'));
  assert.match(
    koreanRefinement.buildSourcePromptHints(technical, { documentProfile: technicalProfile, mode: 'assignment' }),
    /technical_circuit_action_collocation/u
  );

  const academic = '치매 환자의 수면 연구 비중은 2020년대에 확대됐다.';
  const academicAudit = koreanRefinement.analyzeKoreanRefinement({
    source: academic,
    outputText: academic,
    documentProfile: { profile: 'academic_paper', targetRegister: 'academic_formal' },
    mode: 'assignment'
  });
  const formal = academicAudit.issues.find(item => item.code === 'formal_register_residual');
  assert.ok(formal?.details?.families?.includes('academic_contracted_doeda'), JSON.stringify(academicAudit.issues));
});

test('v2.5.24: 장르 프롬프트는 문장 분리 지시 대상과 기계적 순차 접속어를 함께 방지한다', () => {
  const academic = prompts.buildHumanizePrompt('assignment', 'ko', {
    register: 'plain',
    requestStrength: 'advanced',
    documentProfile: {
      profile: 'academic_paper',
      group: 'academic_report_explainer',
      targetRegister: 'academic_formal'
    }
  });
  const resume = prompts.buildHumanizePrompt('assignment', 'ko', {
    register: 'polite',
    requestStrength: 'advanced',
    documentProfile: {
      profile: 'resume_application',
      group: 'essay_application',
      targetRegister: 'professional'
    }
  });

  assert.match(academic.stable, /본 연구와 인용 연구/u);
  assert.match(academic.stable, /분석 대상으로 삼았다/u);
  assert.match(resume.stable, /완료된 뒤·검토한 후·확인한 다음/u);
  assert.match(resume.stable, /우선순위를 먼저 판단/u);
});

test('v2.5.24: 충분히 불균일한 문장 분포의 작은 감소는 평탄화로 오인하지 않는다', () => {
  const longDocument = {
    count: 18,
    mean: 53.833,
    cv: 0.4114,
    min: 14,
    max: 100,
    lengthSequence: [30, 56, 28, 65, 49, 84, 57, 54, 89, 14, 29, 100, 46, 64, 34, 71, 55, 44]
  };
  const naturalRecast = {
    count: 21,
    mean: 47.524,
    cv: 0.364,
    min: 14,
    max: 83,
    lengthSequence: []
  };
  const genuinelyFlat = {
    count: 18,
    mean: 50,
    cv: 0.18,
    min: 34,
    max: 66,
    lengthSequence: []
  };
  assert.equal(sentenceDistributionShift(longDocument, naturalRecast).shift, false);
  assert.equal(sentenceDistributionShift(longDocument, genuinelyFlat).shift, true);
});

test('v2.5.24: 원문에 없던 강한 수식은 대응 문장만 원문으로 안전 복원한다', () => {
  const source = '설계 과정에서 전원 노이즈가 기능에 영향을 줄 수 있음을 확인했습니다. 이후 필터 조건을 비교했습니다.';
  const output = '설계 과정에서 심각한 전원 노이즈가 기능에 영향을 줄 수 있음을 확인했습니다. 이후 필터 조건을 비교했습니다.';
  const audit = discourse.compareDiscourse(source, output);
  assert.ok(audit.codes.includes('intensity_amplification'));
  assert.deepEqual(
    audit.violations.find(item => item.code === 'intensity_amplification').sentenceOrdinals,
    [1]
  );
  const restored = discourse.restoreIntroducedIntensitySentences(source, output, audit);
  assert.equal(restored.applied, true);
  assert.equal(restored.text, source);
  assert.equal(discourse.compareDiscourse(source, restored.text).pass, true);
});
