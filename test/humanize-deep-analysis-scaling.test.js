'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const redundancy = require('../engine-gpt-prod/sourceRedundancy');
const refinement = require('../engine-gpt-prod/koreanRefinement');
const layout = require('../engine-gpt-prod/layoutStructure');
const { withTextAnalysisCache, textAnalysisCacheStats } = require('../engine/textAnalysisCache');
const { sentenceSimilarity } = require('../engine-gpt-prod/sentenceAlignment');

const block = [
  '지역 조사단은 주민의 이동 경로와 시설 이용 시간을 자세히 기록하고 여러 지역의 자료를 비교하여 생활환경 개선 계획을 마련했다.',
  '학교 도서관은 학생들의 독서 활동을 지원하기 위해 자료를 분류하고 안내문을 게시하여 원하는 책을 쉽게 찾을 수 있도록 했다.',
  '연구팀은 측정 장비를 반복해서 점검하고 관찰 자료의 변화를 확인하여 기존 가설의 설명 범위와 새로운 연구 방향을 정리했다.'
];

test('redundancy plan preserves the complete repeated run and source coordinates', () => {
  const plan = redundancy.buildSourceRedundancyPlan([...block, ...block].join(' '));
  assert.deepEqual(plan.targetIndices, [3, 4, 5]);
  assert.deepEqual(plan.runs, [{ originalStart: 0, duplicateStart: 3, length: 3, averageSimilarity: 1 }]);
  const differentFacts = block.map((sentence, i) => sentence.replace('했다.', `${i + 1}회 실시했다.`));
  assert.equal(redundancy.buildSourceRedundancyPlan([...block, ...differentFacts].join(' ')).applicable, false);
});

test('source-derived plan reuse is exact, profile-sensitive and mutation-isolated', () => {
  const profile = { profile: 'report_assignment' }, source = [...block, ...block].join(' ');
  const first = redundancy.buildSourceRedundancyPlan(source, profile);
  first.targetIndices.length = 0;
  first.runs[0].length = 999;
  const second = redundancy.buildSourceRedundancyPlan(source, profile);
  assert.deepEqual(second.targetIndices, [3, 4, 5]);
  assert.equal(second.runs[0].length, 3);
  assert.equal(redundancy.buildSourceRedundancyPlan(block.join(' '), profile).applicable, false);
  profile.profile = 'creative';
  assert.equal(redundancy.buildSourceRedundancyPlan(source, profile).applicable, false);
});

test('precomputed run scores follow the shared alignment formula and protected facts', () => {
  const cases = [
    [block[0], block[0].replace('자세히', '세밀히')],
    [block[0] + ' 총 12개 지역을 포함했다.', block[0].replace('자세히', '세밀히') + ' 총 12개 지역을 포함했다.'],
    [block[0] + ' 기록에는 “잠정 자료”라고 썼다.', block[0].replace('자세히', '세밀히') + ' 기록에는 “잠정 자료”라고 썼다.'],
    [block[0] + ' 개인정보는 포함하지 않았다.', block[0].replace('자세히', '세밀히') + ' 개인정보는 포함하지 않았다.']
  ];
  for (const [left, right] of cases) {
    const runs = redundancy.detectRepeatedRuns([left, left, left, right, right, right]);
    const score = sentenceSimilarity(left, right);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].averageSimilarity, (score + score + score) / 3);
  }
  for (const [left, right] of [
    [cases[1][0], cases[1][1].replace('12개', '13개')],
    [cases[2][0], cases[2][1].replace('잠정 자료', '확정 자료')],
    [cases[3][0], cases[3][1].replace('포함하지 않았다', '포함했다')]
  ]) assert.deepEqual(redundancy.detectRepeatedRuns([left, left, left, right, right, right]), []);
});

test('retained adjacent observations do not reparse every source sentence per pair', () => {
  const sentences = Array.from({ length: 160 }, (_, i) => `연구진은 시료 ${i + 1}번의 온도와 무게를 관찰한 뒤 결과를 기록했다.`);
  const source = sentences.join(' '), keys = new Set(sentences);
  const original = layout.buildLineRecords;
  let sentenceParses = 0;
  layout.buildLineRecords = function (value, ...args) {
    if (keys.has(value)) sentenceParses += 1;
    return original.call(this, value, ...args);
  };
  try {
    let distanceCalls;
    const audit = withTextAnalysisCache(() => {
      const result = refinement.analyzeKoreanRefinement({ source, outputText: source, mode: 'assignment' });
      distanceCalls = textAnalysisCacheStats().distance.calls;
      return result;
    });
    assert.equal(audit.issueCodes.includes('adjacent_semantic_repetition'), false);
    assert.ok(sentenceParses < sentences.length * 12, `${sentenceParses} repeated sentence parses`);
    assert.ok(distanceCalls < sentences.length * 30, `${distanceCalls} comparisons of retained observations`);
  } finally { layout.buildLineRecords = original; }
});

test('demonstrative source indexing retains unique loss detection and generic ambiguity', () => {
  const sentence = '이러한 관찰은 생활환경의 차이와 주민들의 시설 이용 방식을 구체적으로 보여 준다.';
  const generic = sentence.replace('이러한 ', '');
  const missing = refinement.analyzeKoreanRefinement({ source: sentence, outputText: generic });
  assert.ok(missing.issueCodes.includes('introduced_demonstrative_loss'));
  const retained = refinement.analyzeKoreanRefinement({ source: sentence + ' ' + generic, outputText: generic });
  assert.equal(retained.issueCodes.includes('introduced_demonstrative_loss'), false);
  const unrelatedSubject = '그러한 경험은 학생들의 성장을 지원하는 중요한 계기가 되었다.';
  const source = unrelatedSubject + ' ' + generic;
  const rewritten = refinement.analyzeKoreanRefinement({ source, outputText: source.replace('구체적으로', '자세하게') });
  assert.equal(rewritten.issueCodes.includes('introduced_demonstrative_loss'), false);
});

test('source-backed clause splitting still requires a unique tail witness', () => {
  const source = '연구진은 계측 장비를 점검했으며 실험 자료의 저장 위치와 접근 권한을 구체적으로 확인했다.';
  const output = '연구진은 계측 장비를 점검했다. 실험 자료의 저장 위치와 접근 권한을 구체적으로 확인했다.';
  const audit = refinement.analyzeKoreanRefinement({ source, outputText: output, mode: 'assignment' });
  assert.equal(audit.issueCodes.includes('adjacent_semantic_repetition'), false);
});
