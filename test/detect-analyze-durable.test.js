'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// Exercise the production debit, coupon, request-store and history code. Only
// Firestore transport, authentication and the paid model are local substitutes.
delete process.env.DEV_NO_AUTH;
const rows = new Map();
let serial = Promise.resolve(), autoId = 0;
const clone = value => structuredClone(value);
const apply = (existing, patch) => {
  const result = clone(existing || {});
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split('.'); let owner = result;
    for (const part of parts.slice(0, -1)) owner = owner[part] ||= {};
    const field = parts.at(-1);
    if (value?.deleteField) delete owner[field];
    else if (Number.isFinite(value?.increment)) owner[field] = (owner[field] || 0) + value.increment;
    else owner[field] = clone(value);
  }
  return result;
};
function ref(path) {
  return { path, id: path.split('/').at(-1), collection: name => collection(`${path}/${name}`),
    get: async () => snapshot({ path }) };
}
function collection(path) {
  return { doc: id => ref(`${path}/${id || `auto-${++autoId}`}`),
    where: () => ({ query: true, path, limit() { return this; } }) };
}
function snapshot(target) {
  return { exists: rows.has(target.path), id: target.path.split('/').at(-1), ref: target,
    data: () => clone(rows.get(target.path)) };
}
const db = { collection, runTransaction(callback) {
  const run = serial.then(async () => {
    const writes = [];
    const result = await callback({
      get: async target => target.query ? { docs: [] } : snapshot(target),
      getAll: async (...targets) => targets.map(snapshot),
      set: (target, value, options) => writes.push(() => rows.set(target.path, apply(options?.merge ? rows.get(target.path) : {}, value))),
      update: (target, value) => writes.push(() => rows.set(target.path, apply(rows.get(target.path), value))),
      delete: target => writes.push(() => rows.delete(target.path))
    });
    writes.forEach(write => write());
    return result;
  });
  serial = run.catch(() => {}); return run;
} };
const configPath = require.resolve('../config');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: {
  db, ADMIN_UIDS: [], admin: { auth: () => ({ verifyIdToken: async token => ({ uid: token }) }),
    firestore: { Timestamp: { fromMillis: value => value }, FieldValue: {
      serverTimestamp: () => Date.now(), increment: value => ({ increment: value }), delete: () => ({ deleteField: true })
    } } }
} };
const billing = require('../lib/usageBilling');
const requests = require('../lib/detectRequestStore');
const stability = require('../lib/detectResultStability');
const history = require('../lib/historyService');
const runtime = require('../lib/gptRuntimeConfig');
runtime.getRuntimeConfig = async () => ({ activeProvider: 'gpt', models: { detect: 'offline', detectEscalation: 'offline' }, reasoning: { detect: 'low', escalation: 'low' } });
runtime.isGptActive = () => true;
require('../lib/detectCalibration').applyHistoryCalibration = async ({ probability }) => ({ probability, rawProbability: probability, applied: false });
require('../lib/publicMetrics').trackDeliveredMetric = () => {};
const gpt = require('../routes/analyze-gpt');
let calls = 0, modelFailure = false, onModel = null;
gpt.runDetect = async text => {
  calls++;
  if (onModel) await onModel();
  if (modelFailure) throw new Error('synthetic model failure');
  return { probability: 35, summary: '문체 관찰 결과', detail: '본문의 문장 구조를 확인했다.', confidence: 'medium',
    signalContractVersion: 'model-signals-v2-grounded',
    signalEvidence: require('../lib/detectGrounding').groundSignals([{ category: 'generic_abstraction', strength: 'moderate', scope: 'recurring', evidenceSentences: [0, 1] }], text.trim()), gptMeta: {} };
};
const router = require('../routes/analyze');
const handle = router.stack.find(row => row.route?.path === '/analyze').route.stack[0].handle;
const source = '지역 도서관에서 안내문을 확인했다. 접수 기간과 준비물을 별도의 수첩에 적었다. 필요한 서류를 준비한 뒤 신청 절차를 진행했다. 확인되지 않은 사항은 담당자에게 다시 문의했다.';
const cost = Math.ceil(source.length / 100);
const uid = 'durable-user';
async function invoke(extra = {}, observe) {
  const response = new EventEmitter();
  response.statusCode = 200; response.writableEnded = false; response.getHeader = () => '';
  response.status = status => { response.statusCode = status; return response; };
  response.json = body => { response.body = body; response.writableEnded = true; return response; };
  if (observe) observe(response);
  await handle({ body: { mode: 'detect', text: source, requestId: 'durable-request-001', ...extra }, headers: { authorization: `Bearer ${uid}` } }, response);
  return response;
}
test.beforeEach(() => {
  rows.clear(); rows.set(`users/${uid}`, { credits: 20, creditLotV1Balance: 0, plan: 'free' });
  stability.resetForTests(); calls = 0; modelFailure = false; onModel = null;
});

test('same ID replays exact paid result after balance is exhausted, including durable history recovery', async () => {
  rows.get(`users/${uid}`).credits = cost;
  const first = await invoke();
  assert.equal(first.statusCode, 200); assert.equal(first.body.charged, cost); assert.equal(first.body.historySaved, true);
  assert.equal(rows.get(`users/${uid}`).credits, 0);
  const replay = await invoke();
  assert.equal(replay.statusCode, 200); assert.equal(replay.body.charged, 0); assert.equal(replay.body.idempotentReplay, true);
  assert.deepEqual(replay.body.result, first.body.result); assert.equal(calls, 1);
  for (const key of rows.keys()) if (key.startsWith('analyzeRequests/')) rows.delete(key);
  stability.resetForTests();
  const restored = await invoke();
  assert.deepEqual(restored.body.result, first.body.result); assert.equal(calls, 1); assert.equal(rows.get(`users/${uid}`).credits, 0);
});

test('same ID cannot change text, exact source whitespace, context, language, or billing mode', async () => {
  const first = await invoke(); assert.equal(first.statusCode, 200);
  const balance = rows.get(`users/${uid}`).credits;
  for (const changed of [{ text: source.replace('도서관', '박물관') }, { text: ' ' + source }, { prevContext: '새로운 문맥이다.' }, { lang: 'en' }, { billingMode: 'coupon' }]) {
    const response = await invoke(changed);
    assert.equal(response.statusCode, 409, JSON.stringify(changed)); assert.equal(response.body.code, 'IDEMPOTENCY_KEY_REUSED');
  }
  assert.equal(calls, 1); assert.equal(rows.get(`users/${uid}`).credits, balance);
  const distinct = await invoke({ requestId: 'durable-request-002' });
  assert.equal(distinct.statusCode, 200); assert.equal(distinct.body.charged, cost);
  assert.equal(rows.get(`users/${uid}`).credits, balance - cost, 'new request owns its own debit, even when raw computation is cached');
});

test('disconnect after debit leaves a recoverable exact result and never restores another delivered debit', async t => {
  const original = billing.commitCreditDeduct;
  let activeResponse;
  billing.commitCreditDeduct = async (...args) => { const receipt = await original(...args); activeResponse.emit('close'); return receipt; };
  t.after(() => { billing.commitCreditDeduct = original; });
  const abandoned = await invoke({}, response => { activeResponse = response; });
  assert.equal(abandoned.writableEnded, false); assert.equal(abandoned.body, undefined);
  assert.equal(rows.get(`users/${uid}`).credits, 20 - cost);
  billing.commitCreditDeduct = original;
  const replay = await invoke(); assert.equal(replay.statusCode, 200); assert.equal(replay.body.charged, 0); assert.equal(calls, 1);
  assert.equal(rows.get(`users/${uid}`).credits, 20 - cost);
  assert.equal([...rows.keys()].some(key => key.includes('restore_req_')), false);
});

test('an ambiguous successful debit is verified against the real ledger and never repeated', async t => {
  const original = billing.commitCreditDeduct, retry = billing.retryAsync;
  billing.retryAsync = operation => operation();
  billing.commitCreditDeduct = async (...args) => { await original(...args); throw new Error('connection lost after commit'); };
  t.after(() => { billing.commitCreditDeduct = original; billing.retryAsync = retry; });
  const response = await invoke(); assert.equal(response.statusCode, 200);
  assert.equal(rows.get(`users/${uid}`).credits, 20 - cost);
  assert.equal((await invoke()).statusCode, 200); assert.equal(calls, 1);
});

test('coupon replay works after the last coupon is consumed and binds its payload', async () => {
  Object.assign(rows.get(`users/${uid}`), { subscription: { status: 'active', tier: '1000' }, coupon: { remaining: 1, used: 0 } });
  const first = await invoke({ billingMode: 'coupon' });
  assert.equal(first.statusCode, 200); assert.equal(first.body.charged, 1);
  assert.deepEqual(rows.get(`users/${uid}`).coupon, { remaining: 0, used: 1 });
  const replay = await invoke({ billingMode: 'coupon' });
  assert.equal(replay.statusCode, 200); assert.equal(replay.body.charged, 0); assert.deepEqual(replay.body.result, first.body.result);
  const mismatch = await invoke({ billingMode: 'coupon', text: source.replace('도서관', '박물관') });
  assert.equal(mismatch.statusCode, 409); assert.equal(calls, 1);
  assert.equal((await invoke({ billingMode: 'coupon', requestId: 'durable-request-002' })).statusCode, 402);
});

test('paid missing or malformed IDs reject before model; unlimited legacy no-ID calls remain usable', async () => {
  for (const requestId of [undefined, '', 'bad/id', 'x'.repeat(81)]) {
    const response = await invoke({ requestId }); assert.equal(response.statusCode, 400); assert.equal(response.body.charged, 0);
  }
  assert.equal(calls, 0); assert.equal(rows.get(`users/${uid}`).credits, 20);
  rows.get(`users/${uid}`).plan = 'unlimited';
  const response = await invoke({ requestId: undefined });
  assert.equal(response.statusCode, 200); assert.equal(response.body.charged, 0); assert.equal(rows.get(`users/${uid}`).credits, 20);
});

test('new model failure releases the request; stage failure does not debit and a later retry can compute', async t => {
  modelFailure = true;
  assert.equal((await invoke()).statusCode, 500); assert.equal(rows.get(`users/${uid}`).credits, 20);
  modelFailure = false;
  const original = requests.stageResult;
  requests.stageResult = async () => ({ state: 'UNAVAILABLE' });
  t.after(() => { requests.stageResult = original; });
  assert.equal((await invoke()).statusCode, 503); assert.equal(rows.get(`users/${uid}`).credits, 20);
  requests.stageResult = original;
  assert.equal((await invoke()).statusCode, 200); assert.equal(rows.get(`users/${uid}`).credits, 20 - cost);
});

test('stage exceptions release the claim and an oversized result is a nonretryable precharge error', async t => {
  const original = requests.stageResult;
  t.after(() => { requests.stageResult = original; });
  requests.stageResult = async () => { throw new Error('stage transport failed'); };
  const failed = await invoke(); assert.equal(failed.statusCode, 503); assert.equal(failed.body.code, 'IDEMPOTENCY_CACHE_UNAVAILABLE');
  assert.equal([...rows.keys()].some(key => key.startsWith('analyzeRequests/')), false);
  requests.stageResult = async () => ({ state: 'TOO_LARGE' });
  const oversized = await invoke(); assert.equal(oversized.statusCode, 422); assert.equal(oversized.body.code, 'DETECT_RESULT_TOO_LARGE');
  assert.equal(oversized.body.retryable, false); assert.equal(oversized.body.charged, 0);
  assert.equal(rows.get(`users/${uid}`).credits, 20);
});

test('in-progress ID is returned before a second model call and a vanished paid artifact never recomputes', async () => {
  let resume;
  onModel = () => new Promise(resolve => { resume = resolve; });
  const first = invoke();
  while (!resume) await new Promise(resolve => setImmediate(resolve));
  const pending = await invoke(); assert.equal(pending.statusCode, 202); assert.equal(pending.body.code, 'DETECT_REQUEST_PROCESSING');
  resume(); await first; onModel = null;
  for (const key of rows.keys()) if (key.startsWith('analyzeRequests/') || key.includes('/history/')) rows.delete(key);
  const lost = await invoke(); assert.equal(lost.statusCode, 410); assert.equal(lost.body.billingCommitted, true); assert.equal(calls, 1);
});

test('no eligible prose and fragmented source reject before provider work or any debit', async () => {
  rows.get(`users/${uid}`).credits = 1000;
  const noProse = '| 항목 | 기록 |\n' + Array.from({ length: 20 }, (_, i) => `| 구분${i} | 보관함${i} |`).join('\n');
  for (const [text, code] of [[noProse, 'DETECT_NO_ELIGIBLE_PROSE'], [Array.from({ length: 1200 }, (_, i) => `${i}번이다.`).join(' '), 'DETECT_INPUT_TOO_FRAGMENTED']]) {
    const response = await invoke({ text });
    assert.equal(response.statusCode, 422); assert.equal(response.body.code, code); assert.equal(response.body.charged, 0);
  }
  assert.equal(calls, 0); assert.equal(rows.get(`users/${uid}`).credits, 1000);
});

test('public evidence is translated to the exact leading-whitespace source before history persistence', async () => {
  const text = ' \r\n\t' + source;
  const response = await invoke({ text }); assert.equal(response.statusCode, 200);
  const location = response.body.result.signalEvidence[0].locations[0];
  assert.equal(location.start, text.indexOf('지역'));
  assert.equal(text.slice(location.start, location.end), source.slice(0, source.indexOf('.') + 1));
  const saved = rows.get(`users/${uid}/history/durable-request-001`);
  assert.equal(saved.inputText, text); assert.equal(saved.detectCauseEvidence[0].locations[0].start, location.start);
  assert.deepEqual((await invoke({ text })).body.result.signalEvidence, response.body.result.signalEvidence);
});
