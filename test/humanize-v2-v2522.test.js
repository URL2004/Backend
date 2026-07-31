'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const candidateIntegrity = require('../engine-gpt-prod/candidateIntegrity');
const { buildHumanizePrompt } = require('../engine-gpt-prod/prompts/humanize');

const academicProfile = {
  profile: 'academic_paper',
  group: 'academic_report_explainer',
  confidence: 0.94,
  targetRegister: 'academic_formal'
};

test('v2.5.22: 학술 원문에 남은 과장 반응과 구어적 결합을 원문 기원이어도 수리 대상으로 잡는다', () => {
  const source = [
    "본 연구는 아트 콜라보레이션에서 브랜드와 예술 간의 핏(Fit)이 극단적으로 맞지 않는 '불일치' 상황에서도 소비자가 폭발적인 긍정적 반응을 보일 수 있는 메커니즘을 규명하는 데 목적이 있습니다.",
    "특히, 뜬금없는 결합으로 인한 인지적 부조화를 해소하는 핵심 단서(Cue)로 '협업 깊이(진정성)'와 '기능적 적합성'을 제시하고, 이러한 스키마 불일치 해소 과정이 실제 브랜드의 '콜라보레이션 방향성(상향 vs 하향)'에 따라 어떻게 비대칭적으로 나타나는지 실증하고자 합니다."
  ].join(' ');
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: source,
    documentProfile: academicProfile,
    mode: 'assignment'
  });
  const formal = audit.issues.find(item => item.code === 'formal_register_residual');
  assert.ok(formal?.details?.families?.includes('academic_hyperbolic_response'), JSON.stringify(audit));
  assert.ok(formal?.details?.families?.includes('academic_colloquial_unexpected_combination'), JSON.stringify(audit));
  assert.equal(formal.introducedCount, 0);
  assert.equal(audit.repairableCodes.includes('formal_register_residual'), true);

  const quoted = koreanRefinement.analyzeKoreanRefinement({
    source: '참여자는 “뜬금없는 결합이 폭발적인 반응을 만들었다”고 답했다.',
    outputText: '참여자는 “뜬금없는 결합이 폭발적인 반응을 만들었다”고 답했다.',
    documentProfile: academicProfile,
    mode: 'assignment'
  });
  assert.equal(quoted.issueCodes.includes('formal_register_residual'), false, JSON.stringify(quoted));
});

test('v2.5.22: 목적·단서·작동 과정·조건 검증이 겹친 긴 학술 목적문만 분리 대상으로 잡는다', () => {
  const source = "특히, 비전형적인 결합으로 인한 인지적 부조화를 해소하는 핵심 단서(Cue)로 '협업 깊이(진정성)'와 '기능적 적합성'을 제시하고, 이러한 스키마 불일치 해소 과정이 실제 브랜드의 '콜라보레이션 방향성(상향 vs 하향)'에 따라 어떻게 비대칭적으로 나타나는지 실증하고자 합니다.";
  const overloaded = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: source,
    documentProfile: academicProfile,
    mode: 'assignment'
  });
  assert.equal(overloaded.repairableCodes.includes('academic_purpose_chain_overloaded'), true, JSON.stringify(overloaded));

  const split = [
    '본 연구는 아트 콜라보레이션의 불일치 상황에서도 매우 강한 긍정적 반응이 나타나는 메커니즘을 규명하고자 합니다.',
    "협업 깊이에서 지각되는 진정성과 기능적 적합성을 비전형적인 결합으로 발생한 인지적 부조화를 해소하는 핵심 단서(Cue)로 제시합니다.",
    "스키마 불일치 해소 과정이 '콜라보레이션 방향성(상향 vs 하향)'에 따라 비대칭적으로 나타나는지는 별도로 실증하고자 합니다."
  ].join(' ');
  const cleaned = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: split,
    documentProfile: academicProfile,
    mode: 'assignment'
  });
  assert.equal(cleaned.issueCodes.includes('academic_purpose_chain_overloaded'), false, JSON.stringify(cleaned));
  assert.match(split, /협업 깊이/u);
  assert.match(split, /기능적 적합성/u);
  assert.match(split, /스키마 불일치 해소 과정/u);
});

test('v2.5.22: 신규 기준 조사와 목표-방향 지시어 연어 오류를 잡아 원문 문장으로 안전 복원한다', () => {
  const source = '타인의 기준으로 나를 평가하면 나의 노력을 제대로 보기 어렵다. 나만의 목표를 정하고 그 목표를 향해 꾸준히 노력하는 일이 중요하다.';
  const outputText = '타인의 기준을 가져와 나를 평가하면 나의 노력을 제대로 보기 어렵다. 나만의 목표를 정하고 그 방향을 향해 꾸준히 노력하는 일이 중요하다.';
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText,
    documentProfile: { profile: 'personal_essay', confidence: 0.9 },
    mode: 'assignment'
  });
  assert.equal(audit.repairableCodes.includes('borrowed_standard_case_frame'), true);
  assert.equal(audit.repairableCodes.includes('goal_direction_reference_mismatch'), true);
  const restored = koreanRefinement.restoreIntroducedIntegritySentences({ source, outputText, audit });
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.equal(restored.text, source);
});

test('v2.5.22: 성찰문의 인정 욕구를 일반 교훈으로 압축하면 감정 앵커 누락으로 잡는다', () => {
  const source = [
    '처음에는 작은 평가 결과에도 민감하게 반응했고, ‘왜 나는 인정받지 못할까?’라는 생각을 하며 스스로를 의심하기도 했다.',
    '그때 느낀 감정은 단순히 친구와 경쟁하고 싶다는 마음보다, 나 역시 노력한 만큼 인정받고 싶다는 마음에서 비롯된 것이었다.',
    '이후에는 다른 사람의 등급보다 어제의 나와 비교하려고 했다.'
  ].join(' ');
  const flattened = [
    '초기에는 작은 평가 결과에도 민감하게 반응해 ‘왜 나는 인정받지 못할까?’라는 생각으로 스스로를 의심했다.',
    '이 경험은 타인의 평가보다 자신의 성장에 집중해야 한다는 점을 보여 주었다.',
    '이후에는 다른 사람의 등급보다 어제의 나와 비교하려고 했다.'
  ].join(' ');
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: flattened,
    documentProfile: { profile: 'personal_essay', confidence: 0.91 },
    mode: 'assignment'
  });
  const issue = audit.issues.find(item => item.code === 'affective_anchor_omission');
  assert.equal(issue?.introducedCount, 1, JSON.stringify(audit));
  assert.ok(issue?.details?.omissions?.[0]?.families.includes('recognition_desire'));
  assert.equal(
    audit.residualWarnings.some(item => item.code === 'korean_affective_anchor_omission'),
    true
  );
  const restored = koreanRefinement.restoreIntroducedIntegritySentences({
    source,
    outputText: flattened,
    audit
  });
  assert.equal(restored.applied, true, JSON.stringify(restored));
  const restoredAudit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: restored.text,
    documentProfile: { profile: 'personal_essay', confidence: 0.91 },
    mode: 'assignment'
  });
  assert.equal(restoredAudit.issueCodes.includes('affective_anchor_omission'), false, JSON.stringify(restoredAudit));

  const preserved = [
    '초기에는 작은 평가 결과에도 민감하게 반응해 ‘왜 나는 인정받지 못할까?’라는 생각으로 스스로를 의심했다.',
    '그 감정에는 친구와 경쟁하려는 마음보다 노력한 만큼 인정받고 싶은 바람이 더 크게 담겨 있었다.',
    '이후에는 다른 사람의 등급보다 어제의 나와 비교하려고 했다.'
  ].join(' ');
  const safeAudit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: preserved,
    documentProfile: { profile: 'personal_essay', confidence: 0.91 },
    mode: 'assignment'
  });
  assert.equal(safeAudit.issueCodes.includes('affective_anchor_omission'), false, JSON.stringify(safeAudit));

  const integrity = candidateIntegrity.auditCandidateIntegrity({
    source,
    before: preserved,
    candidate: flattened,
    documentProfile: { profile: 'personal_essay', confidence: 0.91 },
    mode: 'assignment'
  });
  assert.equal(integrity.pass, false, JSON.stringify(integrity));
  assert.ok(integrity.reasons.includes('korean_integrity_worsened'));
});

test('v2.5.22: 장르 프롬프트가 학술 목적문과 성찰 감정을 서로 다른 보존 규칙으로 지시한다', () => {
  const academic = buildHumanizePrompt('assignment', 'ko', {
    register: 'academic_formal',
    requestStrength: 'advanced',
    documentProfile: academicProfile
  });
  assert.match(academic.stable, /연구 목적 한 문장에 목적·핵심 단서·작동 과정·검증 조건/u);
  assert.match(academic.stable, /이론 용어를 추정해 다른 개념으로 바꾸지 않는다/u);

  const reflection = buildHumanizePrompt('assignment', 'ko', {
    register: 'mixed',
    requestStrength: 'advanced',
    documentProfile: { profile: 'personal_essay', group: 'essay_application', confidence: 0.91 }
  });
  assert.match(reflection.stable, /인정받고 싶은 마음/u);
  assert.match(reflection.stable, /모범답안식 교훈으로 축약하지 않는다/u);
});
