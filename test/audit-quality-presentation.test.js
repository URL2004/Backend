'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { buildDetectReportView, buildSentenceMap, resolveConversionCandidates } = require('../lib/detectReportView');
const { contentPresentation, filterContentCoach } = require('../lib/detectPresentation');

function view(profile, extras = {}) {
  return buildDetectReportView({ probability: 11, probSource: 'llm', confidence: 'high', textLength: 1000,
    documentProfile: { profile, confidence: .9, profileMargin: 1 },
    measurements: { genericness: { total: 10, count: 0 }, detail: [{ sents: 10, lived: 0, specific: 0, grounded: 0 }] },
    ...extras });
}

test('off and sparse content assessments agree with title, grade, paragraphs and coaching', () => {
  for (const report of [view('general'), view('creative'), view('mail_notice'),
    view('report_assignment', { measurements: { genericness: { total: 4 }, detail: [{ sents: 4 }] } })]) {
    const display = contentPresentation(report, [{ sents: 4, kind: 'thin' }]);
    assert.equal(display.grade, null);
    assert.equal(display.paragraphs[0].kind, 'not_assessed');
    assert.doesNotMatch(JSON.stringify(display), /근거가 부족|일반론 비중|보강해/);
    assert.equal(filterContentCoach([{ tag: '구체적 근거 부족' }, { tag: '무견해, 판단 회피적 성향' }], report, { sentenceCount: 4 }), null);
    assert.equal(report.styleSignal.score, 11);
  }
});

test('assessed content uses the radar threshold and paragraph sample limits', () => {
  const report = view('report_assignment', { measurements: { genericness: { total: 10 },
    detail: [{ sents: 10, lived: 0, specific: 2, grounded: 2 }] } });
  const display = contentPresentation(report, [{ sents: 10, specific: 2, grounded: 2 }, { sents: 1, specific: 0 }]);
  assert.equal(display.grade, 'A');
  assert.match(display.title, /기준 충족/);
  assert.equal(display.paragraphs[0].kind, 'concrete');
  assert.equal(display.paragraphs[1].kind, 'not_assessed');
  assert.equal(filterContentCoach([{ tag: '구체적 근거 부족' }], report, { sentenceCount: 10 }), null);
  const weak = view('report_assignment');
  assert.equal(filterContentCoach([{ tag: '구체적 근거 부족' }, { tag: '주관성의 지나친 배제' }], weak,
    { sentenceCount: 10 }).length, 1);
});

function candidateView(source, indexes) {
  const map = buildSentenceMap([source], [], { sourceParagraphs: [source], source });
  const evidence = [{ category: 'other_observed_style', strength: 'weak', scope: 'isolated',
    locationStatus: 'source_range_verified', locations: indexes.map(i => {
      const loc = map.sourceLocations[i]; return { ...loc, sentenceIndex: i };
    }) }];
  return view('general', { sourceText: source, textLength: source.length, sentenceMap: map, signalEvidence: evidence });
}

test('an isolated ending becomes an input notice rather than a paid rewrite candidate', () => {
  const source = '첫 자료는 도서관에서 수집했다. 두 번째 자료와 조건을 비교했다. 😀 확인할 부분을 따로 기록했다. 입니다.';
  const report = candidateView(source, [3]);
  assert.equal(report.conversion.candidateSentences, 0);
  assert.equal(report.conversion.recommend, false);
  assert.equal(report.conversion.access, true);
  const issue = report.conversion.inputReview.issues[0];
  assert.equal(source.slice(issue.start, issue.end), '입니다.');
  assert.equal(issue.purpose, 'input_review');
  assert.match(report.interpretation.nextSteps[0], /문장 조각/);
});

test('real located sentences survive regardless of the legacy target count', () => {
  const source = '공통된 기준에 따라 자료를 검토했다. 같은 기준을 적용해 결과를 비교했다. 이전 기준과 차이를 확인했다. 입니다.';
  const report = candidateView(source, [0, 1, 2, 3]);
  assert.equal(report.conversion.candidateSentences, 3);
  assert.equal(report.conversion.recommend, true);
  assert.equal(report.conversion.inputReview.issues.length, 1);
  const noCandidates = candidateView(source, []);
  assert.equal(noCandidates.conversion.recommend, false);
});

test('a short full answer and an ending inside its complete sentence stay editable', () => {
  const source = '네. 이 자료는 이번에 수집한 것입니다.';
  const map = buildSentenceMap([source], [], { sourceParagraphs: [source], source });
  const evidence = [{ category: 'other_observed_style', locationStatus: 'source_range_verified',
    locations: [{ sentenceIndex: 0, start: 0, end: 2 },
      { sentenceIndex: 1, start: source.length - 4, end: source.length }] }];
  assert.equal(resolveConversionCandidates(evidence, map, { sourceText: source }).candidateSentences, 2);
});
