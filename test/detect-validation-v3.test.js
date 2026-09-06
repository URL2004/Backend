'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const v = require('../lib/detectValidation'), registry = require('../lib/detectDatasetRegistry'), b = require('../lib/detectBenchmark');
const quality = require('../lib/humanizeQualityEvaluation'), classifier = require('../lib/detectStyleClassifier');
const row = (id, extra = {}) => ({ id, group: id, text: 'Source paragraph with independent topic ' + id, source: 'fixture', genre: 'explainer', authorship: 'human_reference', labelQuality: 'source_backed', permissions: { train: true, evaluate: true, derive: true }, license: 'CC0', ...extra });
test('small samples cannot certify 1 percent FPR from zero errors', () => {
  assert(Math.abs(v.upperFpr(0, 20) - .13910834066826516) < 1e-10);
  assert(v.upperFpr(0, 57) > .05); assert(v.upperFpr(0, 299) < .01);
  assert(v.upperFpr(1, 115) > v.upperFpr(0, 115));
  assert.throws(() => v.upperFpr(-1, 10)); assert.throws(() => v.upperFpr(2, 1));
});
test('fast AUC keeps ties and label direction, bootstrap keeps document families paired', () => {
  const rows = [10, 20, 20, 30].map((s, i) => ({ group: 'group' + (i % 2), authorship: i < 2 ? 'human_reference' : 'ai', before: s, after: s + 5 }));
  assert.equal(v.fastAuc(rows, 'before'), .875);
  const ci = v.pairedInterval(rows, 'before', 'after', { iterations: 100 });
  assert.equal(ci.groups, 2); assert.deepEqual(ci.intervals95.auc, [0, 0]);
});

test('calibration diagnostics and family uncertainty retain their distinct populations', () => {
  const rows = [row('h1', { group: 'same', score: 0 }), row('h2', { group: 'same', score: 0 }), row('a', { authorship: 'ai', score: 100 })];
  const r = v.reliability(rows, 'score');
  assert.equal(r.brier, 0); assert.equal(r.ece, 0); assert.equal(r.bins[9].observedAiFraction, 1);
  const t = v.atThreshold(rows, 'score', 50);
  assert.equal(t.humanN, 2); assert.equal(t.familyExposure.n, 1);
  assert(t.familyExposure.upperOneSided95 > t.fprUpperOneSided95);
  assert.throws(() => v.reliability([{ score: NaN }], 'score'));
});
test('authorship process cannot relabel assisted text as human and missing evidence stays unknown', () => {
  assert.equal(registry.processMetadata(row('a')).writingProcess, 'unknown');
  assert.throws(() => registry.processMetadata(row('a', { writingProcess: 'human_ai_light_edit' })), /not_human_control/);
  assert.throws(() => registry.processMetadata(row('a', { writingProcess: 'human_original' })), /unverified/);
  const m = registry.processMetadata(row('a', { writingProcess: 'human_original', processEvidence: 'study-method', labelQuality: 'verified_process' }));
  assert.equal(m.publicationDate, null); assert.equal(m.writingProcess, 'human_original');
});
test('renamed IDs and newly added derivatives cannot reopen exposed source families', () => {
  const prior = registry.buildResearchManifest([row('old', { familyId: 'stable-original', priorExposure: true })], { seed: 'prior', screenNearDuplicates: false });
  const next = registry.buildResearchManifest([row('renamed', { familyId: 'stable-original' }), row('derived', { parentId: 'renamed' })], { seed: 'next', priorManifests: [prior], screenNearDuplicates: false });
  assert(next.records.every(r => r.priorExposure && r.split === 'development'));
  assert.throws(() => registry.assertNoTrainingLeakage({ trainingLineageKeys: prior.records[0].lineageKeys }, next.records), /training_leakage/);
});
test('author holdout and near-duplicate containment join distinct document IDs', () => {
  const text = '도서관 이용 시간과 자료 검색 절차를 설명한다. 먼저 필요한 자료의 제목을 찾은 뒤 서가 번호를 확인한다. 이후 자료 대출 조건과 반납 일자를 기록한다. 방문 계획은 이용자의 일정에 따라 정한다. '.repeat(3);
  const rows = [row('a', { text, authorGroup: 'writer' }), row('b', { text: text + '교통편을 미리 확인한다.' }), row('c', { authorGroup: 'writer' })];
  const m = registry.buildResearchManifest(rows, { seed: 'joined', holdoutBy: ['authorGroup'] });
  assert(m.nearDuplicates.links.length >= 1); assert.equal(new Set(m.records.map(r => r.group)).size, 1);
});
test('blind quality is invariant to A/B ordering and ignores invented quotations', () => {
  const item = { id: 'pair', original: '원문 문장이다.', transformed: '다듬은 문장이다.', genre: 'essay' };
  const a = quality.makeBlindPair(item, 'seed'), z = quality.makeBlindPair(item, 'seed', true);
  assert.notEqual(a.key.transformedIsA, z.key.transformedIsA);
  const response = pair => ({ dimensions: quality.DIMENSIONS.map(d => ({ dimension: d, winner: pair.key.transformedIsA ? 'A' : 'B', quoteA: pair.request.A, quoteB: pair.request.B })) });
  const first = quality.verifyQuality(response(a), a), second = quality.verifyQuality(response(z), z);
  assert.deepEqual(first.dimensions, second.dimensions);
  const bad = response(a); bad.dimensions[0].quoteA = '없는 인용'; assert.throws(() => quality.verifyQuality(bad, a), /ungrounded/);
});
test('number changes cannot pass fidelity on model approval alone', () => {
  const response = { checks: quality.FIDELITY.map(d => ({ dimension: d, status: 'preserved', originalQuote: '', transformedQuote: '' })) };
  assert.equal(quality.verifyFidelity(response, '37도에서 3분', '37도에서 5분').contentPreserved, false);
  assert.equal(quality.verifyFidelity(response, '37도에서 3분', '3분 동안 37도에서').contentPreserved, true);
});
test('character baseline learns without LLM values and rejects invalid model artifacts', () => {
  const rows = Array.from({ length: 120 }, (_, i) => row(String(i), { text: (i % 2 ? '반복된 구조와 추상적인 설명으로 결론을 정리한다. ' : '어제 골목 끝에서 만난 친구와 서로 다른 이야기를 했다. ').repeat(6) + i, split: 'development', authorship: i % 2 ? 'ai' : 'human_reference', normalizedSha256: b.sha(String(i)) }));
  const result = classifier.train(rows, { lambdas: [.01], vocabularySize: 500 });
  assert(classifier.validateModel(result.model)); assert.equal(result.model.fitGroups.some(g => result.model.calibrationGroups.includes(g)), false);
  const h = classifier.predict(rows[0].text, result.model), ai = classifier.predict(rows[1].text, result.model);
  assert(ai.score > h.score); assert.equal(classifier.predict(rows[0].text, { ...result.model, idf: [] }), null);
  assert.equal(result.model.tokens.includes('modelScore'), false);
});

test('unknown coverage and missing core controls block validation, frozen thresholds cannot be edited', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i), group: String(i), split: 'holdout', genre: 'explainer', authorship: i < 10 ? 'human_reference' : 'ai', baselineScore: i < 10 ? 5 : 15, candidateScore: i < 10 ? 4 : 65 }));
  const report = v.evaluateValidation(rows, { iterations: 100 });
  assert(report.reasons.includes('candidate_coverage_unknown')); assert(report.reasons.includes('verified_human_process_missing:report_assignment'));
  assert(!report.reasons.includes('genre_fpr_increased:report_assignment'));
  assert.equal(report.releaseEligible, false);
  const policy = { selectedOn: 'development_calibration', byGenre: { explainer: { '0.05': 60 } }, calibrationGroups: [] };
  policy.digest = b.sha(JSON.stringify(policy)); policy.byGenre.explainer['0.05'] = 50;
  assert.throws(() => v.evaluateValidation(rows, { thresholdPolicy: policy, iterations: 100 }), /threshold_policy_changed/);
});

test('observed core-genre false-positive increases still block promotion', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i), group: String(i), split: 'holdout', genre: 'report_assignment',
    authorship: i < 10 ? 'human_reference' : 'ai', baselineScore: 5, candidateScore: i === 0 || i >= 10 ? 65 : 5 }));
  const report = v.evaluateValidation(rows, { iterations: 100 });
  assert(report.reasons.includes('genre_fpr_increased:report_assignment')); assert.equal(report.releaseEligible, false);
});
