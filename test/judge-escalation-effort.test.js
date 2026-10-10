'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../lib/gptRuntimeConfig');
const { capture, load } = require('./helpers/judge-effort-capture.cjs');
const dbFor = data => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: data != null, data: () => data }) }) }) });

test('admin read/write handlers accept the optional key and never materialize an unspecified value', async t => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../routes/payment'), 'utf8');
  const start = source.indexOf("router.post('/admin/gpt-runtime-config'");
  const end = source.indexOf("router.post('/admin/test-gpt-runtime-config'", start);
  assert.ok(start > 0 && end > start);
  const handlers = {}, writes = [];
  let stored = {};
  const db = { collection: () => ({ doc: () => ({
    get: async () => ({ exists: true, data: () => stored }),
    set: async (data, options) => {
      assert.equal(options.merge, true); writes.push(data);
      stored = { ...stored, ...data, reasoning: { ...stored.reasoning, ...data.reasoning } };
    }
  }) }) };
  vm.runInNewContext(source.slice(start, end), {
    router: { post: (path, fn) => { handlers[path] = fn; } }, gptRuntimeConfig: runtime, db,
    requireAdmin: async () => 'synthetic-admin', logger: { info() {}, warn() {}, error() {} },
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'synthetic-time' } } }, Date
  });
  t.after(() => runtime.clearRuntimeConfigCache());
  const invoke = async (path, config) => {
    let response;
    await handlers[path]({ body: { config } }, { json: value => { response = value; },
      status: code => { assert.fail(`unexpected status ${code}`); } });
    assert.equal(response.ok, true); return response.config;
  };
  for (const value of [undefined, '', 'invalid']) {
    await invoke('/admin/update-gpt-runtime-config', { reasoning: { escalation: 'xhigh', judgeEscalation: value } });
    assert.equal(Object.hasOwn(writes.at(-1).reasoning, 'judgeEscalation'), false);
  }
  await invoke('/admin/update-gpt-runtime-config', { reasoning: { escalation: 'xhigh', judgeEscalation: ' MeDIum ' } });
  assert.equal(writes.at(-1).reasoning.judgeEscalation, 'medium');
  assert.equal((await invoke('/admin/gpt-runtime-config')).reasoning.judgeEscalation, 'medium');
  await invoke('/admin/update-gpt-runtime-config', { reasoning: { escalation: 'high' } });
  assert.equal(Object.hasOwn(writes.at(-1).reasoning, 'judgeEscalation'), false);
  assert.equal(stored.reasoning.judgeEscalation, 'medium', 'existing merge semantics preserve omitted overrides');
});

test('optional judge effort is omitted on read/save until valid; same normalization as other efforts', () => {
  for (const value of [undefined, null, '', '  ', 'ultra', false, {}, 'high private text']) {
    const cfg = runtime.publicConfig({ reasoning: { escalation: 'xhigh', judgeEscalation: value } });
    assert.equal(Object.hasOwn(cfg.reasoning, 'judgeEscalation'), false);
    assert.equal(cfg.reasoning.escalation, 'xhigh');
    assert.equal(Object.hasOwn(runtime.sanitizeConfig(cfg).reasoning, 'judgeEscalation'), false);
  }
  for (const value of ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'default', 'minimal', ' MeDIum ']) {
    const cfg = runtime.sanitizeConfig({ reasoning: { judge: value, judgeEscalation: value } });
    assert.equal(cfg.reasoning.judgeEscalation, cfg.reasoning.judge);
    assert.equal(runtime.sanitizeConfig(cfg).reasoning.judgeEscalation, cfg.reasoning.judge);
  }
});

test('Firestore overrides env; missing optional key takes the env value or the production default', async t => {
  const names = ['OPENAI_REASONING_JUDGE_ESCALATION', 'OPENAI_REASONING_ESCALATION'];
  const old = names.map(n => process.env[n]);
  t.after(() => { names.forEach((n, i) => old[i] === undefined ? delete process.env[n] : process.env[n] = old[i]); runtime.clearRuntimeConfigCache(); });
  process.env.OPENAI_REASONING_ESCALATION = 'low';
  const cases = [
    // 환경변수가 없으면 운영 기본값 medium(2026-10-11 결정). escalation을 따르지 않는다.
    [undefined, {}, 'medium', 'low'],
    [undefined, { escalation: 'xhigh' }, 'medium', 'xhigh'],
    // 허용되지 않는 값을 주면 키가 빠지고 escalation을 따른다(이전 동작으로 돌아가는 방법).
    ['inherit', {}, undefined, 'low'],
    ['inherit', { escalation: 'xhigh' }, undefined, 'xhigh'],
    ['high', {}, 'high', 'low'],
    ['medium', { escalation: 'xhigh' }, 'medium', 'xhigh'],
    ['medium', { judgeEscalation: 'high' }, 'high', 'low'],
    ['high', { judgeEscalation: ' MINIMAL ' }, 'low', 'low'],
    ['medium', { escalation: 'max', judgeEscalation: '' }, undefined, 'max'],
    ['medium', { escalation: 'max', judgeEscalation: 'bad' }, undefined, 'max'],
    ['bad', { escalation: 'xhigh' }, undefined, 'xhigh']
  ];
  for (const [env, stored, expected, escalation] of cases) {
    if (env === undefined) delete process.env[names[0]]; else process.env[names[0]] = env;
    const cfg = await runtime.getRuntimeConfig({ db: dbFor({ reasoning: stored }), force: true });
    assert.equal(cfg.reasoning.judgeEscalation, expected);
    assert.equal(cfg.reasoning.escalation, escalation);
  }
  process.env[names[0]] = 'medium';
  for (const db of [undefined, dbFor(null), { collection() { throw Error('offline'); } }]) {
    assert.equal((await runtime.getRuntimeConfig({ db, force: true })).reasoning.judgeEscalation, 'medium');
  }
});

test('only confirming verdict request bodies change; repairs, generation and cache routing are preserved', async () => {
  const inherited = await capture();
  const medium = await capture({ judgeEscalation: 'medium' });
  assert.equal(medium.requests.length, inherited.requests.length);
  const changed = [];
  for (let i = 0; i < inherited.requests.length; i++) {
    const before = inherited.requests[i], after = medium.requests[i];
    const confirming = before.body.model === 'gpt-6.1-sol'
      && (before.body.text.format.name.includes('judge') || before.scenario === 'compat-confirmation');
    if (confirming) {
      assert.equal(before.body.reasoning.effort, 'high');
      assert.equal(after.body.reasoning.effort, 'medium');
      changed.push(after.scenario);
    }
    assert.deepEqual(after, confirming ? { ...before, body: { ...before.body, reasoning: { effort: 'medium' } } } : before);
  }
  for (const name of ['confirmation', 'escalation', 'confirmation-repair', 'escalation-repair',
    'final-revalidation', 'restoration-verification', 'staging-sweep', 'compat-confirmation']) assert.ok(changed.includes(name), name);
  for (const name of ['confirmation-repair', 'escalation-repair']) {
    const repair = medium.requests.find(r => r.scenario === name && r.body.text.format.name === 'gpt_prod_relation_patch');
    assert.ok(repair, name); assert.equal(repair.body.reasoning.effort, 'high');
    assert.ok(medium.requests.filter(r => r.scenario === name).length >= 3, 'repair is followed by verification');
  }
  assert.ok(medium.requests.some(r => r.scenario === 'draft-escalation' && r.body.model === 'gpt-6.1-sol'));
  assert.equal(medium.logs.length, medium.requests.length);
  assert.equal(medium.callLedger.entries.length, medium.requests.length);
  medium.requests.forEach((r, i) => {
    assert.equal(medium.logs[i].reasoningEffort, r.body.reasoning.effort);
    assert.equal(medium.callLedger.entries[i].reasoningEffort, r.body.reasoning.effort);
  });
});

test('unset judge effort follows a nondefault escalation even after public config round trips', async () => {
  const result = await capture({ escalation: 'xhigh' });
  for (const r of result.requests.filter(r => ['confirmation', 'escalation', 'final-revalidation', 'restoration-verification'].includes(r.scenario))) {
    assert.equal(r.body.reasoning.effort, r.body.model === 'gpt-6.1-sol' ? 'xhigh' : 'medium');
  }
});

test('failed usage logs and ledger retain normalized actual effort, default means provider-selected', async t => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'offline-test-key';
  t.after(() => old === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = old);
  const ledger = require('../engine-gpt-prod/callLedger'), logs = [], bodies = [];
  const client = load('engine-gpt-prod/openaiClient.js', {
    '../lib/logger': { logger: { info: (event, data) => logs.push({ event, ...data }) } },
    '../lib/outboundPolicy': { outboundFetch: async (_provider, _url, init) => {
      bodies.push(JSON.parse(init.body)); return Response.json({ error: { message: 'synthetic refusal' } }, { status: 400 });
    } }
  });
  for (const [input, expected] of [['minimal', 'low'], [' MEDIUM ', 'medium'], ['bad', 'medium'], ['default', 'default']]) {
    await assert.rejects(ledger.run(() => client.completeJson({ model: 'gpt-6.1-sol', reasoningEffort: input,
      schema: { type: 'object', properties: {}, required: [], additionalProperties: false }, meta: { task: 'judge' } })), error => {
      assert.equal(error.callLedger.entries[0].reasoningEffort, expected); return true;
    });
    assert.equal(logs.at(-1).reasoningEffort, expected);
    assert.equal(logs.at(-1).failed, true);
    assert.equal(bodies.at(-1).reasoning?.effort, expected === 'default' ? undefined : expected);
  }
});
