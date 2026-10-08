'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { paragraphContext, sentenceContext } = require('../lib/detectContentContext');
const { buildDetectReportView, buildSentenceMap, resolveConversionCandidates, pickAiSentence } = require('../lib/detectReportView');
const { contentPresentation, filterContentCoach } = require('../lib/detectPresentation');

function reportFor(text, profile = 'report_assignment') {
  const paragraphs = text.split('\n\n');
  const detail = paragraphs.map(paragraph => ({ sents: require('../engine/koreanText').splitSentenceSpans(paragraph).length,
    lived: 0, specific: 0, grounded: 0, generic: 0, kind: 'thin' }));
  const measurements = { detail, stance: { ratio: 0 } };
  return { detail, measurements, report: buildDetectReportView({ probability: 37, probSource: 'llm',
    sourceText: text, sourceParagraphs: paragraphs, textLength: text.length,
    documentProfile: { profile, confidence: .9, profileMargin: 1 }, measurements }) };
}
const NEUTRAL = '다음 항목을 읽었다. 기준의 차이를 살폈다. 관련 부분을 표시했다. 내용을 다시 읽었다. 마지막 부분을 확인했다.';

test('existing activity and a concrete future plan are found without manufacturing lived experience', () => {
  for (const sentence of [
    '수업에서 시각 가이드를 제작해 참가자들에게 배포했다.',
    '실험에서 분주 오류를 발견해 시료를 다른 웰에 재분주했다.',
    '매주 금요일마다 이메일을 정리할 계획이다.',
    '매월 첫날에 임시 파일 삭제, 작업 목록 정리 등 작은 실천을 이어가고 싶습니다.'
  ]) {
    const { report, detail, measurements } = reportFor(`${sentence} ${NEUTRAL}`);
    assert.equal(report.contentEvidence.findingStatus, 'present');
    assert.ok(report.contentEvidence.grounded >= 1);
    assert.equal(report.contentEvidence.lived, 0, 'presentation must not turn a plan into personal experience');
    assert.equal(report.styleSignal.score, 37);
    assert.equal(measurements.detail[0].grounded, 0, 'raw detector measurements remain untouched');
    assert.equal(contentPresentation(report, detail).paragraphs[0].findingStatus, 'present');
    assert.equal(filterContentCoach([{ tag: '구체적 근거 부족' }], report, { sentenceCount: 6 }), null);
  }
  assert.equal(sentenceContext('매주 금요일마다 이메일을 정리할 계획이다.').concretePlan, true);
  assert.equal(sentenceContext('앞으로 더욱 열심히 노력할 계획이다.').concretePlan, false);
});

test('presentation unions overlapping concreteness signals once per sentence', () => {
  const text = '실험에서 시료 12개를 측정하고 결과표를 작성했다.';
  assert.equal(paragraphContext(text).grounded, 1);
  assert.equal(pickAiSentence([text], [{ kind: 'thin' }]), null);
});

test('not assessed, not found and a proven deficiency are distinct coaching states', () => {
  const { report, detail } = reportFor(NEUTRAL + ' 전체를 읽었다.');
  assert.equal(report.contentEvidence.findingStatus, 'not_found');
  const display = contentPresentation(report, detail);
  assert.equal(display.grade, null);
  assert.match(display.title, /찾지 못함/);
  assert.match(display.paragraphs[0].reason, /부족하다고 판단하지 않/);
  assert.equal(filterContentCoach([{ tag: '구체적 근거 부족' }], report, { sentenceCount: 6 }), null);
  assert.equal(filterContentCoach([{ tag: '구체적 근거 부족' }], report,
    { sentenceCount: 6, findingStatus: 'deficient' }).length, 1);
  assert.equal(reportFor(NEUTRAL + ' 전체를 읽었다.', 'creative').report.contentEvidence.findingStatus, 'not_assessed');
});

test('definition, procedure, observation and cautious argument do not require personal assertions', () => {
  const examples = [
    ['definition', '확산이란 입자가 농도 차이에 따라 이동하는 현상을 의미한다.'],
    ['procedure', '먼저 시료를 분주하고 다음으로 용액을 혼합한다.'],
    ['observation', '측정 결과는 실험 조건에 따라 다르게 나타났다.'],
    ['argument', '따라서 이 결과를 모든 상황에 일반화할 수 없다.']
  ];
  for (const [role, sentence] of examples) {
    const { report, detail } = reportFor(Array(6).fill(sentence).join(' '), 'personal_essay');
    const display = contentPresentation(report, detail);
    assert.equal(display.paragraphs[0].role, role);
    const coach = [{ tag: '주관성의 지나친 배제' }, { tag: '무견해, 판단 회피적 성향' }, { tag: '간접 화법, 비인칭 서술' }];
    assert.equal(filterContentCoach(coach, report, { sentenceCount: 6 }), null);
    assert.equal(filterContentCoach(coach, report, { sentenceCount: 6,
      contentContext: display.paragraphs[0].contentContext }), null);
  }
});

function candidates(source, targets) {
  const map = buildSentenceMap([source], [], { source });
  const evidence = [{ category: 'other_observed_style', locationStatus: 'source_range_verified',
    locations: targets(map) }];
  return resolveConversionCandidates(evidence, map, { sourceText: source });
}

test('candidate contract binds purpose, source evidence, UTF16 target and protected context', () => {
  const source = '😀 필자는 “이 자료는 그대로 유지한다.”라고 인용한 뒤 자신의 설명을 덧붙였다.';
  const start = source.indexOf('자신의');
  const result = candidates(source, map => [{ sentenceIndex: map.sentences.at(-1).index, start, end: source.length }]);
  assert.equal(result.candidateSentences, 1);
  const target = result.targets[0];
  assert.equal(target.purpose, 'style_review');
  assert.equal(source.slice(target.targetSpan.start, target.targetSpan.end), '자신의 설명을 덧붙였다.');
  assert.equal(target.targetSpan.coordinateSystem, 'utf16');
  assert.ok(target.evidenceIds[0].startsWith(result.sourceId));
  assert.equal(target.expectedScope.preserveOutsideTarget, true);
  assert.equal(target.expectedScope.preserveFactsAndAttribution, true);
});

test('quoted/code spans and a dangling input tail cannot become style rewrite targets', () => {
  for (const source of ['“인용된 문장은 유지해야 한다.”', '`const sample = value;`',
    '자료를 비교한 결과 차이가 확인되었지만']) {
    const result = candidates(source, map => map.sourceLocations.map(loc => ({ ...loc, sentenceIndex: loc.index })));
    assert.equal(result.candidateSentences, 0, source);
    assert.equal(result.targets.length, 0);
    if (source.endsWith('지만')) assert.equal(result.inputIssues[0].code, 'incomplete_input_tail');
    else assert.equal(result.preservation[0].purpose, 'preserve');
  }
});

test('evidence coordinates outside their display sentence fail closed', () => {
  const source = '첫 번째 문장이다. 두 번째 문장이다.';
  const result = candidates(source, map => [{ sentenceIndex: 0,
    start: map.sourceLocations[1].start, end: map.sourceLocations[1].end }]);
  assert.equal(result.candidateSentences, 0);
});
