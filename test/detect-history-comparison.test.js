'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { signHistoryComparison, verifiedBackupHistoryComparison, boundedHistoryComparison } = require('../lib/detectHistoryComparison');
const { buildHistoryComparison } = require('../lib/detectCalibration');
const { sanitizeHistoryEntry, createClientWriteService } = require('../lib/clientWriteService');

const KEY = 'synthetic-history-comparison-secret-at-least-32-characters';
const TEXT = '\r\n  합성 검증용 문장입니다. 실제 사용자 자료가 아닙니다.  \r\n';
function comparison(before = 72, raw = 80, after = 68) {
  return buildHistoryComparison({ reason: 'own_humanized_history_match', sourceProbability: before,
    rawProbability: raw, calibratedProbability: after, applied: after < raw, match: 'exact_normalized' });
}
function entry(info = comparison()) {
  return { type: 'detect', inputText: TEXT, probability: info.probability, historyComparison: info,
    historyComparisonProof: signHistoryComparison('synthetic-user', TEXT, info.probability, info, KEY), credits: 1 };
}

test('history comparison proof binds owner, exact source, public score and every comparison claim', () => {
  const original = entry();
  assert.match(original.historyComparisonProof, /^detect-history-comparison-proof-v1\.[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(verifiedBackupHistoryComparison('synthetic-user', original, KEY), original.historyComparison);
  const reordered = { ...original, historyComparison: Object.fromEntries(Object.entries(original.historyComparison).reverse()) };
  assert.deepEqual(verifiedBackupHistoryComparison('synthetic-user', reordered, KEY), original.historyComparison);
  for (const [name, uid, value, key = KEY] of [
    ['other-user', 'another-user', original],
    ['source-bytes', 'synthetic-user', { ...original, inputText: TEXT.replace(/\r/g, '') }],
    ['trimmed-source', 'synthetic-user', { ...original, inputText: TEXT.trim() }],
    ['score', 'synthetic-user', { ...original, probability: 67 }],
    ['claims', 'synthetic-user', { ...original, historyComparison: comparison(75) }],
    ['unsigned', 'synthetic-user', { ...original, historyComparisonProof: undefined }],
    ['object-proof', 'synthetic-user', { ...original, historyComparisonProof: { signature: original.historyComparisonProof } }],
    ['wrong-version', 'synthetic-user', { ...original, historyComparisonProof: original.historyComparisonProof.replace('-v1.', '-v2.') }],
    ['trailing-proof', 'synthetic-user', { ...original, historyComparisonProof: original.historyComparisonProof + '.extra' }],
    ['missing-key', 'synthetic-user', original, ''],
    ['wrong-key', 'synthetic-user', original, KEY + 'x']
  ]) assert.equal(verifiedBackupHistoryComparison(uid, value, key), null, name);
});

test('comparison schema rejects contradictory, nonnumeric, extra and out-of-range claims', () => {
  const base = comparison();
  for (const patch of [{ probability: '68' }, { sourceProbability: 101 }, { rawProbability: NaN },
    { rawProbability: 80.5 }, { sourceProbability: false }, { rawDelta: 100 }, { adjustedDelta: 20 },
    { adjustment: 0 }, { status: 'unchanged' }, { calibrationApplied: false }, { extra: 'untrusted' },
    { match: 'client_claim' }, { basis: 'human_authorship' }, { sourceProbability: null }]) {
    const bad = { ...base, ...patch };
    assert.equal(boundedHistoryComparison(bad, bad.probability), null);
    assert.equal(signHistoryComparison('synthetic-user', TEXT, bad.probability, bad, KEY), null);
  }
  for (const info of [comparison(null), comparison(0, 0, 0), comparison(100, 100, 100), comparison(50, 80, 68)]) {
    assert.deepEqual(boundedHistoryComparison(info, info.probability), info);
    assert.deepEqual(verifiedBackupHistoryComparison('synthetic-user', entry(info), KEY), info);
  }
  assert.equal(signHistoryComparison('synthetic-user', TEXT, 68, base, ''), null);
});

test('v3 and v4 calibration backup schemas accept source-cap fields and reject invalid ranges', () => {
  const meta = { version: 'history-calibration-v4-linked-comparison', applied: true,
    sourceProbability: 72, sourceCapApplied: true, rawProbability: 80, calibratedProbability: 68,
    matchSimilarity: 1, matchLengthRatio: 1, maxReduction: 12, floor: 0, factor: 0.15 };
  for (const version of ['history-calibration-v3', meta.version]) {
    const value = { ...meta, version };
    assert.deepEqual(sanitizeHistoryEntry({ type: 'detect', inputText: TEXT, probabilityCalibration: value }).probabilityCalibration, value);
  }
  assert.equal(sanitizeHistoryEntry({ probabilityCalibration: { sourceProbability: null, sourceCapApplied: false } }).probabilityCalibration.sourceProbability, null);
  for (const patch of [{ sourceProbability: -1 }, { sourceProbability: 101 }, { sourceProbability: '72' },
    { sourceCapApplied: 1 }, { rawProbability: Infinity }, { calibratedProbability: -1 },
    { matchSimilarity: 1.01 }, { matchLengthRatio: -0.1 }, { factor: 2 }, { floor: 101 },
    { maxReduction: -1 }, { unrecognized: 0 }]) {
    assert.throws(() => sanitizeHistoryEntry({ probabilityCalibration: { ...meta, ...patch } }), error => error.code === 'INVALID_INPUT');
  }
});

function localStore() {
  const rows = new Map([['users/synthetic-user', {}], ['users/another-user', {}]]);
  const collection = path => ({ doc: id => ({ path: `${path}/${id}`, collection: name => collection(`${path}/${id}/${name}`) }) });
  const db = { collection, runTransaction: callback => callback({
    get: async ref => ({ exists: rows.has(ref.path), data: () => structuredClone(rows.get(ref.path)) }),
    set: (ref, value) => rows.set(ref.path, structuredClone(value))
  }) };
  const admin = { firestore: { FieldValue: { serverTimestamp: () => ({ syntheticTimestamp: true }) } } };
  return { rows, service: createClientWriteService({ db, admin }) };
}

test('backup stores only verified comparisons and cannot turn client data into server history', async t => {
  const previous = process.env.OPENAI_SAFETY_SALT;
  process.env.OPENAI_SAFETY_SALT = KEY;
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_SAFETY_SALT; else process.env.OPENAI_SAFETY_SALT = previous; });
  const { rows, service } = localStore();
  const original = { ...entry(), savedBy: 'server', serverTrusted: true, rawProbability: 2,
    historyLinkIntegrity: { version: 'forged' }, probabilityCalibration: { sourceProbability: 72, sourceCapApplied: true } };
  const saved = await service.backupHistory({ uid: 'synthetic-user', requestId: 'comparison-backup-valid', entry: original });
  const result = rows.get(`users/synthetic-user/history/${saved.id}`);
  assert.deepEqual(result.historyComparison, original.historyComparison);
  assert.equal(result.rawProbability, 80, 'raw engine score comes from the verified comparison');
  assert.equal(result.inputText, TEXT, 'valid proof preserves exact CRLF bytes');
  assert.equal(result.savedBy, 'client_backup_api');
  assert.equal(result.serverTrusted, false);
  assert.equal(result.historyComparisonProof, undefined);
  assert.equal(result.historyLinkIntegrity, undefined);
  assert.equal(result.interpretation.status, 'unavailable', 'comparison proof cannot fabricate evidence');
  for (const [name, uid, value] of [
    ['unsigned', 'synthetic-user', { ...original, historyComparisonProof: undefined }],
    ['changed', 'synthetic-user', { ...original, historyComparison: comparison(99) }],
    ['owner', 'another-user', original],
    ['text', 'synthetic-user', { ...original, inputText: TEXT + '변경' }],
    ['score', 'synthetic-user', { ...original, probability: 66 }]
  ]) {
    const out = await service.backupHistory({ uid, requestId: `comparison-backup-${name}`, entry: value });
    const row = rows.get(`users/${uid}/history/${out.id}`);
    assert.equal(row.historyComparison, undefined, name);
    assert.equal(row.savedBy, 'client_backup_api', name);
    assert.equal(row.serverTrusted, false, name);
  }
});
