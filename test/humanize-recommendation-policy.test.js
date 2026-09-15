'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectRecommendation, buildRecommendationSignals, RECOMMENDATION_VERSION } = require('../engine-gpt-prod/humanizeRecommendation');
const { resolveAdvancedRouting } = require('../engine-gpt-prod/advancedRouting');
const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');

function choose(overrides = {}, signals = {}) {
  return selectRecommendation({ advancedEligible: true, profile: 'long_explainer', confidence: 0.9,
    personalSafety: false, academicStructure: false, ...overrides,
    signals: { sourceLength: 2500, editableLength: 2200, sourceSentenceCount: 20,
      targetSentenceCount: 10, targetSentenceRatio: 0.5, targetParagraphCount: 3,
      riskLevel: 'high', effectExpectation: 'normal', additionalCredits: 50, ...signals }
  });
}

test('a long explainer with substantive editable prose gets advanced at the length boundary', () => {
  assert.equal(choose({}, {sourceLength:1999}).recommendedMode, 'blog');
  const result = choose({}, {sourceLength:2000});
  assert.equal(result.recommendedMode, 'formal');
  assert.equal(result.recommendationCode, 'long_explainer_rewrite');
  assert.equal(result.recommendationVersion, RECOMMENDATION_VERSION);
  for (const signals of [{editableLength:1199},{sourceSentenceCount:5},{targetSentenceCount:2},{targetSentenceRatio:0.2499},{riskLevel:'low'}]) {
    assert.equal(choose({}, signals).recommendedMode, 'blog');
  }
});

test('wide rewrite needs distributed targets and trusted non-sensitive content', () => {
  assert.equal(choose({profile:'general'}).recommendationCode, 'widespread_rewrite');
  assert.equal(choose({profile:'general',confidence:0.6}).recommendationCode, 'widespread_rewrite');
  for (const signals of [{targetParagraphCount:1},{targetSentenceCount:5},{targetSentenceRatio:0.49},{riskLevel:'medium'}]) {
    assert.equal(choose({profile:'general'}, signals).recommendedMode, 'blog');
  }
  for (const profile of ['resume_application','personal_essay','student_record_teacher','student_self_assessment','creative']) {
    assert.equal(choose({profile,personalSafety:true,academicStructure:true}).recommendedMode, 'blog');
  }
  for (const profile of ['clinical_record','legal_contract','mail_notice']) {
    assert.equal(choose({profile}).recommendedMode, 'blog');
  }
});

test('a small price gap supports a moderate long-document need, never replaces that need', () => {
  const signals = { sourceLength:5000, additionalCredits:30, riskLevel:'medium', targetSentenceCount:4, targetSentenceRatio:0.25 };
  assert.equal(choose({profile:'general'},signals).recommendationCode, 'long_document_value');
  for (const changed of [{additionalCredits:31},{targetParagraphCount:1},{targetSentenceCount:3},{targetSentenceRatio:0.24},{sourceLength:4999},{riskLevel:'low'}]) {
    assert.equal(choose({profile:'general'},{...signals,...changed}).recommendedMode, 'blog');
  }
});

test('uncertainty has no badge; limited benefit and insufficient editable content never upsell', () => {
  assert.equal(choose({profile:'unknown'}).recommendedMode, null);
  assert.equal(choose({confidence:0.54}).recommendedMode, null);
  assert.equal(choose({confidence:0.74}).recommendedMode, 'blog');
  assert.equal(choose({advancedEligible:false}).recommendedMode, null);
  assert.equal(choose({academicStructure:true},{effectExpectation:'limited'}).recommendationCode,'limited_rewrite_benefit');
  assert.equal(choose({academicStructure:true},{editableLength:100}).recommendedMode,'blog');
});

test('protected tables and citations do not increase editable prose volume', () => {
  const text = ['표 1. 측정 결과','항목 | 측정값 | 날짜',...Array.from({length:100},(_,i)=>`자료 ${i+1} | ${i+1}건 | 2026년`),'','참고 문헌',...Array.from({length:30},(_,i)=>`연구자${i}. (2024). 자료 분석. https://example.org/${i}`)].join('\n');
  const signals = buildRecommendationSignals(text,detectDocumentProfile(text),{grade:'C',abstractRiskRatio:0.9});
  assert.ok(text.length>=2000);
  assert.ok(signals.editableLength<120,JSON.stringify(signals));
  assert.notEqual(resolveAdvancedRouting(text,{grade:'C',abstractRiskRatio:0.9}).recommendedMode,'formal');
});

test('an English input remains ineligible while Korean personal writing remains selectable', () => {
  const english = resolveAdvancedRouting('This is an English document describing a research process and its findings in considerable detail.');
  assert.equal(english.advancedEligible,false);
  assert.equal(english.recommendedMode,null);
  const personal = resolveAdvancedRouting('자기소개서\n저는 동아리에서 팀원들과 실험을 진행했습니다. 실패한 기록을 비교하고 직접 발표한 경험을 바탕으로 지원했습니다.');
  assert.equal(personal.advancedEligible,true);
  assert.notEqual(personal.recommendedMode,'formal');
});

test('the complete routing pipeline recommends a long explainer and keeps a single paragraph intact', () => {
  const paragraph = '청소년의 성장 과정에서 수면은 기억의 구조와 학습 기능에 영향을 준다. 연구원들은 수면 시간과 인지 능력의 관계를 조사하고 결과를 분석했다. 이 과정은 뇌의 기능과 정서 조절 원리를 설명하는 중요한 사례이다.';
  const text = Array.from({length:20},()=>paragraph).join('\n\n');
  const routing = resolveAdvancedRouting(text,{grade:'B',abstractRiskRatio:0.2});
  assert.equal(routing.profile,'long_explainer');
  assert.equal(routing.recommendedMode,'formal');
  assert.equal(routing.recommendationCode,'long_explainer_rewrite');
  const oneParagraph = text.replace(/\n+/g,' ');
  const signals = buildRecommendationSignals(oneParagraph,detectDocumentProfile(oneParagraph),{grade:'B',abstractRiskRatio:0.2});
  assert.equal(signals.targetParagraphCount,1,'chunk splits must not manufacture multiple target paragraphs');
});
