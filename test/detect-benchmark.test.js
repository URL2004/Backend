'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const b = require('../lib/detectBenchmark');
const permission = { train: true, evaluate: true, derive: true };
const row = (id, extra = {}) => ({ id, text: 'Synthetic original ' + id, group: id, genre: 'explainer', authorship: 'human_reference',
  source: 'synthetic-test', license: 'CC0', permissions: permission, labelQuality: 'source_backed', ...extra });
test('document, topic and derivative links form transitive split groups', () => {
  const rows = [row('a', { topicGroup: 'shared' }), row('b', { topicGroup: 'shared' }), row('c', { parentId: 'b', priorExposure: true }), row('d')];
  const m = b.buildManifest(rows, { seed: 'test' });
  const abc = m.records.filter(r => r.id !== 'd');
  assert.equal(new Set(abc.map(r => r.group)).size, 1); assert(abc.every(r => r.split === 'development'));
  assert.equal(m.coverage.complete, false); assert.equal(JSON.stringify(m).includes('Synthetic original'), false);
  assert(b.assertManifest(m, rows));
  const changed = structuredClone(rows); changed[0].text += ' changed';
  assert.throws(() => b.assertManifest(m, changed), /text_changed/);
});
test('deduplicates normalized text and rejects missing parents and cycles', () => {
  assert.throws(() => b.buildManifest([row('a'), row('b', { text: 'Synthetic   original a' })], { seed: 'x' }), /duplicate_text/);
  assert.throws(() => b.buildManifest([row('a', { parentId: 'missing' })], { seed: 'x' }), /parent_missing/);
  assert.throws(() => b.buildManifest([row('a', { parentId: 'b' }), row('b', { parentId: 'a' })], { seed: 'x' }), /parent_cycle/);
  assert.throws(() => b.buildManifest([row('a', { authorship: 'ai' })], { seed: 'x' }), /generation_provenance/);
});
test('evaluation-only and external-detector labels never enter classifier training', () => {
  for (const extra of [{ permissions: { ...permission, train: false } }, { authorship: 'external_detector' }, { split: 'holdout' }, { license: 'CC-BY-ND-2.0-KR' }]) {
    assert.throws(() => b.assertTrainingRows([{ ...row('a'), split: 'development', ...extra }]), /training_not_permitted/);
  }
});
test('unreviewed restricted licenses and parent derivation permissions cannot be bypassed', () => {
  assert.throws(() => b.buildManifest([row('a', { license: 'CC-BY-NC-SA-4.0' })], { seed: 'x' }), /commercial_permission/);
  assert.throws(() => b.buildManifest([row('a', { permissions: { ...permission, derive: false } }), row('b', { parentId: 'a' })], { seed: 'x' }), /derivation_not_permitted/);
});
test('holdout consumption is exclusive across candidates', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-benchmark-'));
  const file = path.join(directory, 'receipt.json');
  try {
    const manifest = b.buildManifest(Array.from({ length: 20 }, (_, i) => row(String(i))), { seed: 'test' });
    b.consumeHoldout(file, { manifest, candidateHash: 'a'.repeat(64) });
    assert.throws(() => b.consumeHoldout(file, { manifest, candidateHash: 'b'.repeat(64) }), { code: 'EEXIST' });
  } finally { fs.unlinkSync(file); fs.rmdirSync(directory); }
});
