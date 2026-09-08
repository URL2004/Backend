'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const c = require('../lib/engineCorpusRegistry');
const { sha } = require('../lib/detectBenchmark');
const { buildResearchManifest } = require('../lib/detectDatasetRegistry');
const { FIDELITY, DIMENSIONS, makeBlindPair } = require('../lib/humanizeQualityEvaluation');
function fixture(t, pairs = [['원문에서 철수는 영희에게 책을 주었다.', '철수는 책을 영희에게 건넸다.']]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-corpus-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = pairs.map(([inputText, outputText]) => ({ inputText, outputText }));
  fs.writeFileSync(path.join(root, 'pairs.json'), JSON.stringify(data));
  const occurrences = data.map((r, i) => ({ file: 'pairs.json', locator: '$[' + i + ']', schema: 'inputText->outputText', original_hash: c.corpusHash(r.inputText), humanized_hash: c.corpusHash(r.outputText) }));
  return { root, data, occurrences, result: c.buildCorpus(occurrences, { root, seed: 'frozen', reviewSampleSize: 2 }) };
}
test('existing duplicate and transformation chains form one exposed family and never human gold', t => {
  const f = fixture(t, [['시작 문장이다.', '수정한 문장이다.'], ['수정한 문장이다.', '마지막 문장이다.'], ['시작 문장이다.', '수정한 문장이다.']]);
  assert.equal(f.result.manifest.pairs.length, 2);
  assert.equal(f.result.manifest.documents.length, 3);
  assert.equal(new Set(f.result.manifest.documents.map(d => d.group)).size, 1);
  assert(f.result.manifest.documents.every(d => d.split === 'development' && d.priorExposure && !d.authorshipGoldEligible && !d.permissions.train));
  assert(f.result.manifest.documents.some(d => d.writingProcess === 'humanized_origin_unknown'));
  assert.equal(f.result.reviewForms.length, 1);
});
test('NFKC aliases and existing registry stop renamed corpus documents reopening holdout', t => {
  const f = fixture(t, [['ＦＵＬＬ 문장', '결과 문장']]);
  const manifest = buildResearchManifest([{ id: 'renamed', text: 'FULL 문장', group: 'new', source: 'new-source', genre: 'explainer', authorship: 'human_reference', labelQuality: 'source_backed', license: 'CC0', permissions: { train: true, evaluate: true, derive: true } }], { seed: 'new-seed', registry: f.result.registry, screenNearDuplicates: false });
  assert.equal(manifest.records[0].split, 'development'); assert.equal(manifest.records[0].priorExposure, true);
});
test('embedded BOM is retained to match Python audit; Unicode compatibility and whitespace are normalized', () => {
  assert.equal(c.normalize('Ａ\u0085B\u001cC'), 'A B C');
  assert.equal(c.normalize('a\ufeffb'), 'a\ufeffb');
  assert.notEqual(c.corpusHash('a\ufeffb'), c.corpusHash('ab'));
});
test('unknown schema, tampered source text and parent path escape fail closed', t => {
  const f = fixture(t);
  assert.throws(() => c.buildCorpus([{ ...f.occurrences[0], schema: 'unknown->result' }], { root: f.root }), /unknown_pair_schema/);
  assert.throws(() => c.buildCorpus([{ ...f.occurrences[0], original_hash: '0'.repeat(64) }], { root: f.root }), /source_hash_mismatch/);
  assert.throws(() => c.atLocator(f.data, '$.__proto__'), /missing_locator/);
  assert.throws(() => c.sourcePath(f.root, '../not-present'), /ENOENT|path_escape/);
});
test('file signatures separate RTF HTML OLE and temporary Office locks', () => {
  assert.equal(c.fileSignature(Buffer.from('{\\rtf1\\ansi'), 'legacy.doc').format, 'rtf');
  assert.equal(c.fileSignature(Buffer.from('<!doctype html>'), 'legacy.doc').format, 'html');
  assert.equal(c.fileSignature(Buffer.from('d0cf11e0a1b11ae1', 'hex'), 'legacy.doc').format, 'ole');
  assert.equal(c.fileSignature(Buffer.from('PK'), '~$work.docx').exclude, 'office_temporary_lock_file');
});
test('CSV preserves quoted multiline text and UTF16 sources; malformed JSON does not disclose input', t => {
  const f = fixture(t);
  assert.deepEqual(c.parseDelimited('a,b\r\n"x,y","line1\r\nline2"\r\n'), [{ a: 'x,y', b: 'line1\r\nline2' }]);
  assert.equal(c.decode(Buffer.concat([Buffer.from([255, 254]), Buffer.from('안녕', 'utf16le')])), '안녕');
  assert.throws(() => c.parseDelimited('same,same\nx,y'), /invalid_csv_header/);
  fs.writeFileSync(path.join(f.root, 'bad.json'), '{SECRET PERSONAL CONTENT');
  assert.throws(() => c.readStructured(path.join(f.root, 'bad.json')), { message: 'corpus_json_parse_failed' });
});
test('output guard resolves directory junctions and refuses repository descendants', t => {
  const f = fixture(t), repo = path.join(f.root, 'repository'); fs.mkdirSync(repo);
  assert.throws(() => c.assertExternalOutput(path.join(repo, 'raw.json'), [repo]), /inside_repository/);
  const link = path.join(f.root, 'alias'); fs.symlinkSync(repo, link, 'junction');
  assert.throws(() => c.assertExternalOutput(path.join(link, 'raw.json'), [repo]), /inside_repository/);
  assert.equal(c.assertExternalOutput(path.join(f.root, 'outside', 'raw.json'), [repo]), path.join(f.root, 'outside', 'raw.json'));
});
test('CopyKiller linking verifies time and source existence without becoming authorship or plagiarism', t => {
  const f = fixture(t);
  for (const name of ['orig.pdf', 'hum.pdf', 'orig.doc', 'hum.doc']) fs.writeFileSync(path.join(f.root, name), name.endsWith('.pdf') ? '%PDF-1.7 fixture' : 'fixture');
  const ms = Date.parse('2026-06-12T15:03:58Z');
  const link = { pair_key: '0001_06130003-58', orig: 20, human: 80, original_pdf: 'orig.pdf', humanized_pdf: 'hum.pdf', original_source_files: ['orig.doc'], humanized_source_files: ['hum.doc'] };
  const result = c.buildCorpus(f.occurrences, { root: f.root, externalLinks: [link], operationalRows: [{ ...f.data[0], createdAtMs: ms }] });
  assert.equal(result.manifest.externalEvidence[0].plagiarismRate, null);
  assert.equal(result.manifest.externalEvidence[0].bodyExactMatchVerified, false);
  assert.equal(result.manifest.externalEvidence[0].authorshipGoldEligible, false);
  assert.throws(() => c.buildCorpus(f.occurrences, { root: f.root, externalLinks: [link], operationalRows: [{ ...f.data[0], createdAtMs: ms + 1000 }] }), /time_mismatch/);
  fs.writeFileSync(path.join(f.root, 'orig.pdf'), 'not a PDF');
  assert.throws(() => c.buildCorpus(f.occurrences, { root: f.root, externalLinks: [link], operationalRows: [{ ...f.data[0], createdAtMs: ms }] }), /pdf_signature_invalid/);
});
test('engine and displayed changes remain distinct and incomplete scores are rejected', t => {
  const { result } = fixture(t), manifest = result.manifest;
  const score = { pairId: manifest.pairs[0].id, manifestDigest: manifest.digest, detectorVersion: 'fixture-v1', historyCalibrationApplied: true, beforeEngineScore: 90, afterEngineScore: 80, beforeDisplayScore: 90, afterDisplayScore: 12 };
  const report = c.evaluateCorpus(manifest, { scoreRows: [score] });
  assert.equal(report.scores.engineDelta, -10); assert.equal(report.scores.displayDelta, -78);
  assert.equal(report.releaseEligible, false); assert.equal(report.authorshipGold, 0);
  assert.throws(() => c.evaluateCorpus(manifest, { scoreRows: [{ ...score, afterEngineScore: null }] }), /incomplete_score/);
  assert.throws(() => c.evaluateCorpus(manifest, { scoreRows: [score, score] }), /duplicate_or_unknown_score/);
  assert.throws(() => c.evaluateCorpus({ ...manifest, freshHoldoutCount: 9 }), /manifest_changed/);
});
test('known transformed documents cannot be promoted even with a newly sealed manifest', t => {
  const { result } = fixture(t), { digest, ...body } = result.manifest;
  body.documents[0].authorship = 'human_reference';
  assert.throws(() => c.evaluateCorpus(c.seal(body)), /invalid_legacy_label/);
});
test('human sentence evidence requires exact spans, two reviewer decisions, and explicit disagreements', t => {
  const { result } = fixture(t), manifest = result.manifest, p = manifest.pairs[0];
  const dimensions = [...FIDELITY, 'agent_patient_relation', 'negation', 'modality', 'quantity_range', 'causality'];
  const review = { pairId: p.id, manifestDigest: manifest.digest, reviewers: ['reviewer-a', 'reviewer-b'], dimensions: dimensions.map(dimension => ({ dimension, verdict: 'preserved', originalSpan: null, transformedSpan: null, reviewerVerdicts: [{ reviewerId: 'reviewer-a', verdict: 'preserved' }, { reviewerId: 'reviewer-b', verdict: 'preserved' }] })) };
  assert.equal(c.evaluateCorpus(manifest, { texts: result.texts, evidenceReviews: [review] }).evidenceGold.adjudicated, 1);
  review.dimensions[0].reviewerVerdicts[1].verdict = 'changed';
  assert.throws(() => c.evaluateCorpus(manifest, { texts: result.texts, evidenceReviews: [review] }), /disagreement_hidden/);
  review.dimensions[0].verdict = 'uncertain'; review.dimensions[0].originalSpan = { start: 0, end: 2, quote: result.texts[p.originalId].slice(0, 2) };
  assert.equal(c.evaluateCorpus(manifest, { texts: result.texts, evidenceReviews: [review] }).evidenceGold.uncertainOrDisagreement, 1);
  review.dimensions[0].originalSpan.quote = '없는 근거';
  assert.throws(() => c.evaluateCorpus(manifest, { texts: result.texts, evidenceReviews: [review] }), /ungrounded_span/);
});
test('blind quality totals preserve reviewer disagreement and verify exact quotations', t => {
  const { result } = fixture(t), manifest = result.manifest, p = manifest.pairs[0];
  const pair = makeBlindPair({ id: p.id, original: result.texts[p.originalId], transformed: result.texts[p.transformedId], genre: 'unknown' }, manifest.seed);
  const judgment = winner => DIMENSIONS.map(dimension => ({ dimension, winner, quoteA: pair.request.A, quoteB: pair.request.B }));
  const review = { pairId: p.id, manifestDigest: manifest.digest, reviewers: [{ reviewerId: 'a', dimensions: judgment('A') }, { reviewerId: 'b', dimensions: judgment('B') }] };
  assert.equal(c.evaluateCorpus(manifest, { texts: result.texts, qualityReviews: [review] }).qualityReview.dimensions.naturalness.reviewerDisagreement, 1);
  review.reviewers[0].dimensions[0].quoteA = 'not in either text';
  assert.throws(() => c.evaluateCorpus(manifest, { texts: result.texts, qualityReviews: [review] }), /ungrounded_judgment/);
});
test('existing training lineage checker diagnoses overlaps with historical corpus', t => {
  const { result } = fixture(t), manifest = result.manifest;
  const report = c.evaluateCorpus(manifest, { candidate: { trainingTextHashes: [manifest.documents[0].normalizedSha256] } });
  assert.equal(report.leakage.overlaps, true); assert.equal(report.releaseEligible, false);
});
