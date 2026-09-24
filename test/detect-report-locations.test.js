'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const sg = require('../engine/surfaceguard');
const { buildDetectSurfaceInput } = require('../lib/detectSurfaceInput');
const { buildSentenceMap, buildDetectReportView } = require('../lib/detectReportView');
const { buildDetectInputDocument, locatePublicEvidence } = require('../lib/detectInputDocument');
const { groundSignals } = require('../lib/detectGrounding');
const { reportSourceOffsets, projectReportEvidence } = require('../lib/detectReportLocations');

function replay(source) {
  const paras = sg.splitParagraphsForReport(source), surface = buildDetectSurfaceInput(paras);
  const map = buildSentenceMap(surface.analysisParagraphs, surface.detail, { sourceParagraphs: paras, source });
  const ids = buildDetectInputDocument(source.trim()).sentences.filter(s => s.eligibleForDetection).map(s => s.index);
  const evidence = groundSignals([{ category: 'ending_repetition', strength: 'moderate', scope: 'recurring', evidenceSentences: ids }], source.trim());
  return { map, evidence: projectReportEvidence(locatePublicEvidence(evidence, source), map) };
}

test('single-line headings and soft wraps project model IDs to UI sentence/paragraph IDs', () => {
  const source = '"꾸준히 기록하는 사람"\n제 장점은 작은 변화를 관찰하는 것입니다.\n지난 실습에서는 매일 기록을 남겼습니다.\n동료들과 결과를 비교했습니다.';
  const { map, evidence } = replay(source);
  assert.ok(evidence[0].locations.some(loc => loc.paragraphIndex > 0));
  for (const loc of evidence[0].locations) {
    const mark = map.sentences.find(m => m.index === loc.sentenceIndex);
    assert.equal(loc.paragraphIndex, mark.paragraph);
    assert.ok(loc.start >= mark.start && loc.end <= mark.end);
    assert.ok(source.slice(loc.start, loc.end).trim());
  }
});

test('CRLF, repeated passages and protected quotes retain exact source provenance', () => {
  for (const source of [
    '  같은 문장입니다.\r\n같은 문장입니다.\r\n다른 문장입니다.  ',
    '관찰을 시작했다.\n\n그는 “첫 보고입니다. 둘째 보고입니다.”라고 말했다.\n\n결과를 비교했다.',
    '관찰을 시작했다.\n```js\nconst n = 2;\n```\n결과를 비교했다.'
  ]) {
    const { map, evidence } = replay(source);
    for (const mark of map.sentences) assert.equal(source.slice(mark.start, mark.end), mark.text);
    for (const loc of evidence[0].locations) {
      const mark = map.sentences.find(m => m.index === loc.sentenceIndex);
      assert.equal(loc.paragraphIndex, mark.paragraph);
      assert.ok(loc.start >= mark.start && loc.end <= mark.end);
    }
  }
});

test('normalized long-report grouping maps sequentially and refuses changed content', () => {
  const source = ('관측 대상의 상태를 자세히 기록하고 담당자와 함께 결과를 비교했습니다.  ').repeat(40);
  const { map } = replay(source);
  assert.ok(map.paragraphs.length > 1);
  assert.equal(map.sourceLocations.length, map.total);
  assert.equal(reportSourceOffsets('다른 내용입니다.', ['같은 내용입니다.']), null);
  assert.equal(reportSourceOffsets('앞 문장입니다. 누락된 뒷문장입니다.', ['앞 문장입니다.']), null);
  assert.deepEqual(projectReportEvidence([{ locationStatus: 'source_range_verified', locations: [{ start: 0, end: 3 }] }], null)[0].locations, []);
});

test('capped excerpts still have coordinates for all source sentences', () => {
  const source = Array.from({ length: 250 }, (_, i) => `관측 ${i}의 상태를 점검했습니다.`).join('\n\n');
  const { map } = replay(source);
  assert.equal(map.capped, true);
  assert.equal(map.sourceLocations.length, 250);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(map)), 'sourceLocations'), false, 'full lookup is request-local, not an unbounded API/history payload');
  const loc = map.sourceLocations[249];
  const out = projectReportEvidence([{ locationStatus: 'source_range_verified', locations: [{ start: loc.start, end: loc.end }] }], map);
  assert.equal(out[0].locations[0].paragraphIndex, 249);
});

test('statistics-backed points do not claim fully aligned sentence explanations', () => {
  const input = { probability: 49, probSource: 'llm', confidence: 'high', textLength: 600,
    documentProfile: { profile: 'general', confidence: .7 },
    measurements: { genericness: { total: 8 }, detail: [{ sents: 8 }] },
    statisticalSupport: { version: 'statistical-assist-v5-whitespace-stable', applied: true,
      originalScore: 9, score: 49, margin: .5, features: 200, profile: 'general', basis: 'independent_statistics' } };
  const v = buildDetectReportView(input);
  assert.equal(v.styleSignal.score, 49);
  assert.equal(v.causeAnalysis.status, 'aligned', 'numeric support is still valid');
  assert.equal(v.causeAnalysis.explanationStatus, 'partial');
  assert.equal(v.status, 'partial');
  assert.equal(v.alignment.status, 'partial');
  assert.match(v.synthesis.headline, /통계/);
  assert.doesNotMatch(v.synthesis.headline, /패턴이 정형/);
  const stale = buildDetectReportView({ ...input, probability: 9 });
  assert.equal(stale.styleSignal.sourceLabel, 'AI 모델 분석');
  assert.equal(stale.causeAnalysis.statisticalIndependentSignals, 0);
});

test('low confidence and unlocated causes cannot claim complete explanation elsewhere', () => {
  const input = { probability: 60, probSource: 'llm', confidence: 'low', textLength: 900,
    measurements: { genericness: { total: 10 }, detail: [{ sents: 10 }] },
    signalEvidence: [{ category: 'ending_repetition', strength: 'strong', scope: 'recurring' },
      { category: 'formulaic_transition', strength: 'moderate', scope: 'recurring' }] };
  const low = buildDetectReportView(input);
  assert.equal(low.status, 'limited');
  assert.equal(low.synthesis.headline, low.interpretation.headline);
  const missing = buildDetectReportView({ ...input, confidence: 'high' });
  assert.equal(missing.status, 'partial');
  assert.match(missing.causeAnalysis.label, /일부/);
  assert.equal(missing.styleSignal.score, 60);
});
