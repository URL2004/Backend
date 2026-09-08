'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const integrity = require('../lib/historyLinkIntegrity');
const sourceScores = require('../lib/detectSourceScore');
const { lookupHash } = require('../lib/detectCalibration');
const { buildHistoryLookupFields } = require('../lib/detectHistoryIndex');
const { parseArgs, runBackfill } = require('../scripts/backfill-detect-history-index');
const UID = 'synthetic-owner';
const KEY = 'history-index-test-key-longer-than-32-bytes';
const priorKey = process.env.OPENAI_SAFETY_SALT;
test.before(() => { process.env.OPENAI_SAFETY_SALT = KEY; });
test.after(() => { if (priorKey === undefined) delete process.env.OPENAI_SAFETY_SALT; else process.env.OPENAI_SAFETY_SALT = priorKey; });

const detect = extra => ({ type: 'detect', savedBy: 'server', probSource: 'llm', inputText: '합성 원문이다.\r\n두 번째 문장이다.', probability: 0, ...extra });
function humanize(extra = {}, uid = UID) {
  const record = { type: 'humanize', savedBy: 'server', mode: 'blog', qualityStatus: 'clean', billingDisposition: 'charged',
    outputText: '합성 휴머나이징 출력이다.', engineMeta: { deliveryDecision: 'deliver_clean', effectStatus: 'normal',
      approvedModelChunkCount: 1, modelFailureChunkCount: 0, substantiveEditRatio: .2, structureSignaturePass: true }, ...extra };
  return { ...record, historyLinkIntegrity: integrity.sign(uid, record.outputText, record, KEY) };
}

test('index fields retain source normalization and require server provenance, score validity or existing HMAC', () => {
  const original = detect(), copy = structuredClone(original);
  assert.deepEqual(buildHistoryLookupFields(UID, original), { detectInputHash: sourceScores.inputHash(original.inputText) });
  assert.deepEqual(original, copy);
  assert.deepEqual(buildHistoryLookupFields(UID, detect({ probSource: 'cached_llm', probabilityCalibration: { applied: true } })),
    { detectInputHash: sourceScores.inputHash(original.inputText) }, 'index preserves latest-match ordering; runtime still rejects calibrated source caps');
  for (const invalid of [null, undefined, '', ' ', true, false, [], {}, -1, 101, Infinity]) {
    assert.deepEqual(buildHistoryLookupFields(UID, detect({ probability: invalid })), {});
  }
  for (const changed of [{ savedBy: 'client' }, { savedBy: undefined }, { probSource: 'local_fallback' }, { inputText: '' }, { inputText: 42 }, { type: 'other' }]) {
    assert.deepEqual(buildHistoryLookupFields(UID, detect(changed)), {});
  }
  const signed = humanize();
  assert.deepEqual(buildHistoryLookupFields(UID, signed), { calibrationTextHash: lookupHash(signed.outputText) });
  for (const record of [{ ...signed, historyLinkIntegrity: null }, { ...signed, savedBy: 'client' },
    { ...signed, outputText: '변조 출력이다.' }, { ...signed, qualityStatus: 'rejected' }, humanize({}, 'another-owner')]) {
    assert.deepEqual(buildHistoryLookupFields(UID, record), {});
  }
  const legacy = { ...signed, historyLinkIntegrity: { version: integrity.LEGACY_V2_VERSION,
    signature: crypto.createHmac('sha256', KEY).update(integrity.message(UID, signed.outputText, signed, integrity.LEGACY_V2_VERSION)).digest('base64url') } };
  assert.equal(Object.hasOwn(buildHistoryLookupFields(UID, legacy), 'calibrationTextHash'), true);
  assert.deepEqual(buildHistoryLookupFields(UID, { ...legacy, savedBy: 'client' }), {}, 'legacy signatures cannot upgrade client backups');
  assert.deepEqual(buildHistoryLookupFields('', signed), {});
});

function database(records, { beforeTransaction } = {}) {
  const prefix = `users/${UID}/history/`;
  const rows = new Map([[`users/${UID}`, { value: { exists: true }, version: 1 }]]);
  for (const [id, value] of Object.entries(records)) rows.set(prefix + id, { value: structuredClone(value), version: 1 });
  const writes = [], reads = [];
  const stamp = version => ({ version, isEqual: other => other?.version === version });
  const snapshot = target => {
    const row = rows.get(target.path), data = row ? structuredClone(row.value) : undefined;
    return { id: target.id, ref: target, exists: !!row, updateTime: row && stamp(row.version), data: () => data };
  };
  const ref = pathname => ({ path: pathname, id: pathname.split('/').at(-1),
    async get() { reads.push(pathname); return snapshot(this); },
    collection(name) { assert.equal(name, 'history'); assert.equal(pathname, `users/${UID}`); return history(); }
  });
  function history() {
    return { doc: id => ref(prefix + id), orderBy(field) {
      assert.equal(field, '__name__');
      let count = 100, after = '';
      const query = { limit(value) { count = value; return this; }, startAfter(value) { after = value.id; return this; },
        async get() {
          const docs = [...rows.keys()].filter(key => key.startsWith(prefix)).sort()
            .filter(key => key.slice(prefix.length) > after).slice(0, count).map(key => snapshot(ref(key)));
          return { docs };
        } };
      return query;
    } };
  }
  let transactions = 0;
  const db = { collection(name) {
    assert(['users', 'accountDeletionJobs'].includes(name));
    return { doc(uid) { assert.equal(uid, UID); return ref(`${name}/${uid}`); } };
  }, async runTransaction(callback) {
    transactions++;
    if (beforeTransaction) beforeTransaction({ rows, prefix, transactionNumber: transactions });
    const pending = [];
    const result = await callback({ get: async target => snapshot(target), update: (target, fields) => pending.push({ path: target.path, fields }) });
    for (const update of pending) {
      assert(rows.has(update.path), 'update must not recreate a deleted document');
      assert(Object.keys(update.fields).every(key => ['detectInputHash', 'calibrationTextHash'].includes(key)));
      const row = rows.get(update.path);
      rows.set(update.path, { value: { ...row.value, ...update.fields }, version: row.version + 1 }); writes.push(update);
    }
    return result;
  } };
  return { db, rows, writes, reads, prefix, get transactions() { return transactions; } };
}

test('default dry run pages past 200 records without writes and reports only counts', async () => {
  const records = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [String(i).padStart(4, '0'), detect({ note: 'private-marker' })]));
  records.signed = humanize(); records.unsigned = { ...humanize(), historyLinkIntegrity: null };
  records.backup = detect({ savedBy: 'client' });
  const fake = database(records), progress = [];
  const result = await runBackfill({ db: fake.db, uid: UID, pageSize: 17, onProgress: event => progress.push(event) });
  assert.equal(result.scanned, 208); assert.equal(result.eligible, 206); assert.equal(result.planned, 206);
  assert.equal(result.pages, 13); assert.equal(result.updated, 0); assert.equal(fake.transactions, 0); assert.equal(fake.writes.length, 0);
  assert.equal(result.mode, 'dry_run');
  const logged = JSON.stringify(progress);
  for (const value of [UID, 'private-marker', '합성 원문', 'inputText', 'detectInputHash']) assert.equal(logged.includes(value), false);
});

test('apply updates only verified lookup fields and repeats idempotently', async () => {
  const originals = { a: detect({ extra: { keep: true }, createdAt: 'unchanged-date' }), b: humanize(), c: detect({ savedBy: 'client' }) };
  const fake = database(originals);
  const first = await runBackfill({ db: fake.db, uid: UID, apply: true, pageSize: 1 });
  assert.equal(first.updated, 2); assert.equal(first.skipped, 1);
  for (const id of ['a', 'b', 'c']) {
    const { detectInputHash, calibrationTextHash, ...rest } = fake.rows.get(fake.prefix + id).value;
    assert.deepEqual(rest, originals[id]);
  }
  const repeated = await runBackfill({ db: fake.db, uid: UID, apply: true });
  assert.equal(repeated.updated, 0); assert.equal(repeated.unchanged, 2); assert.equal(fake.writes.length, 2);
});

test('current transaction snapshots prevent overwriting edited or deleted history', async () => {
  const fake = database({ a: detect(), b: humanize() }, { beforeTransaction({ rows, prefix, transactionNumber }) {
    if (transactionNumber === 1) rows.set(prefix + 'a', { value: detect({ inputText: '동시에 수정한 본문' }), version: 2 });
    else rows.delete(prefix + 'b');
  } });
  const result = await runBackfill({ db: fake.db, uid: UID, apply: true });
  assert.equal(result.changedDuringScan, 1); assert.equal(result.deletedDuringScan, 1); assert.equal(result.updated, 0);
  assert.equal(fake.rows.get(fake.prefix + 'a').value.inputText, '동시에 수정한 본문'); assert.equal(fake.writes.length, 0);
});

test('missing users and deletion states block before scanning or within the write transaction', async () => {
  const missing = database({ a: detect() }); missing.rows.delete(`users/${UID}`);
  await assert.rejects(runBackfill({ db: missing.db, uid: UID }), { code: 'USER_MISSING' });
  for (const deletion of [{ status: 'processing' }, { status: 'retry_pending' }, { status: 'manual_review' }, { status: 'completed', protectUntilMs: Date.now() + 60000 }]) {
    const fake = database({ a: detect() }); fake.rows.set(`accountDeletionJobs/${UID}`, { value: deletion, version: 1 });
    await assert.rejects(runBackfill({ db: fake.db, uid: UID, apply: true }), { code: 'ACCOUNT_DELETION_IN_PROGRESS' });
    assert.equal(fake.writes.length, 0);
  }
  for (const missingUser of [false, true]) {
    const fake = database({ a: detect() }, { beforeTransaction({ rows }) {
      if (missingUser) rows.delete(`users/${UID}`);
      else rows.set(`accountDeletionJobs/${UID}`, { value: { status: 'processing' }, version: 1 });
    } });
    await assert.rejects(runBackfill({ db: fake.db, uid: UID, apply: true }), { code: missingUser ? 'USER_MISSING' : 'ACCOUNT_DELETION_IN_PROGRESS' });
    assert.equal(fake.writes.length, 0);
  }
});

test('CLI requires one explicit UID, defaults to dry run, and never prints rejected raw arguments', () => {
  assert.deepEqual(parseArgs(['--uid', UID]), { uid: UID, apply: false, pageSize: 100 });
  assert.deepEqual(parseArgs([`--uid=${UID}`, '--apply', '--page-size=25']), { uid: UID, apply: true, pageSize: 25 });
  for (const args of [[], ['--apply'], ['--uid', '../bad'], ['--uid', UID, '--uid', 'another'], ['--uid', UID, '--all'], ['--uid', UID, '--page-size', '501']]) {
    assert.throws(() => parseArgs(args));
  }
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/backfill-detect-history-index.js'), '--uid', 'private/forbidden-value'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { phase: 'failed', code: 'EXPLICIT_UID_REQUIRED' });
});
