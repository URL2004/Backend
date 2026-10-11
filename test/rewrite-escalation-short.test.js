'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../lib/gptRuntimeConfig');
const effort = require('../engine-gpt-prod/rewriteEffort');
const { capture } = require('./helpers/judge-effort-capture.cjs');

const ENV = ['OPENAI_REASONING_REWRITE_ESCALATION_SHORT', 'GPT_ESCALATION_SHORT_REWRITE_CHARS', 'OPENAI_REASONING_ESCALATION'];
const dbFor = data => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: data != null, data: () => data }) }) }) });
function withEnv(t, values) {
  const old = ENV.map(name => process.env[name]);
  t.after(() => {
    ENV.forEach((name, i) => (old[i] === undefined ? delete process.env[name] : process.env[name] = old[i]));
    runtime.clearRuntimeConfigCache();
  });
  for (const name of ENV) delete process.env[name];
  Object.assign(process.env, values);
  runtime.clearRuntimeConfigCache();
}

test('production default: short documents rewrite at medium below 4,000 characters', async t => {
  withEnv(t, {});
  const cfg = await runtime.getRuntimeConfig({ force: true });
  assert.equal(cfg.reasoning.rewriteEscalationShort, 'medium');
  assert.equal(cfg.escalation.shortRewriteChars, 4000);
  assert.equal(cfg.reasoning.escalation, 'high');
  assert.equal(Object.hasOwn(cfg.reasoning, 'rewriteEscalation'), false, 'the per-job value is never a default');
});

test('environment can restore the previous effort or switch the rule off', async t => {
  for (const [values, short, chars] of [
    [{ OPENAI_REASONING_REWRITE_ESCALATION_SHORT: 'high' }, 'high', 4000],
    [{ OPENAI_REASONING_REWRITE_ESCALATION_SHORT: 'inherit' }, undefined, 4000],
    [{ GPT_ESCALATION_SHORT_REWRITE_CHARS: '0' }, 'medium', 0],
    [{ GPT_ESCALATION_SHORT_REWRITE_CHARS: '2500' }, 'medium', 2500],
    [{ GPT_ESCALATION_SHORT_REWRITE_CHARS: 'many' }, 'medium', 4000]
  ]) {
    withEnv(t, values);
    const cfg = await runtime.getRuntimeConfig({ force: true });
    assert.equal(cfg.reasoning.rewriteEscalationShort, short);
    assert.equal(cfg.escalation.shortRewriteChars, chars);
    const resolved = effort.rewriteEscalationEffort(effort.withRewriteEscalation(cfg, '가'.repeat(100)));
    assert.equal(resolved, short && chars > 0 ? short : 'high');
  }
});

test('stored settings win; settings without the keys keep the environment values', async t => {
  withEnv(t, {});
  const stored = { reasoning: { escalation: 'xhigh' }, escalation: { longTextChars: 9000 } };
  let cfg = await runtime.getRuntimeConfig({ db: dbFor(stored), force: true });
  assert.equal(cfg.reasoning.rewriteEscalationShort, 'medium');
  assert.equal(cfg.escalation.shortRewriteChars, 4000);
  assert.equal(cfg.reasoning.escalation, 'xhigh');
  cfg = await runtime.getRuntimeConfig({ force: true,
    db: dbFor({ reasoning: { rewriteEscalationShort: ' LOW ' }, escalation: { shortRewriteChars: '1500' } }) });
  assert.equal(cfg.reasoning.rewriteEscalationShort, 'low');
  assert.equal(cfg.escalation.shortRewriteChars, 1500);
});

test('inline and saved configs never gain the optional keys; invalid values are dropped', () => {
  const plain = runtime.sanitizeConfig({ reasoning: { escalation: 'high' } });
  for (const key of ['rewriteEscalationShort', 'rewriteEscalation']) assert.equal(Object.hasOwn(plain.reasoning, key), false, key);
  assert.equal(Object.hasOwn(plain.escalation, 'shortRewriteChars'), false);
  assert.equal(Object.hasOwn(runtime.DEFAULT_CONFIG.reasoning, 'rewriteEscalationShort'), false);
  assert.equal(Object.hasOwn(runtime.DEFAULT_CONFIG.escalation, 'shortRewriteChars'), false);
  for (const value of ['', 'ultra', null, {}, false]) {
    const cfg = runtime.sanitizeConfig({ reasoning: { rewriteEscalationShort: value, rewriteEscalation: value },
      escalation: { shortRewriteChars: value === false ? 'x' : value } });
    assert.equal(Object.hasOwn(cfg.reasoning, 'rewriteEscalationShort'), false);
    assert.equal(Object.hasOwn(cfg.reasoning, 'rewriteEscalation'), false);
    assert.equal(Object.hasOwn(cfg.escalation, 'shortRewriteChars'), false);
  }
  const bounded = runtime.sanitizeConfig({ escalation: { shortRewriteChars: -5 } });
  assert.equal(bounded.escalation.shortRewriteChars, 0);
  assert.equal(runtime.sanitizeConfig({ escalation: { shortRewriteChars: 9e9 } }).escalation.shortRewriteChars, 100000);
  assert.equal(runtime.sanitizeConfig({ escalation: { shortRewriteChars: 3999.6 } }).escalation.shortRewriteChars, 4000);
});

test('the rule is decided once per job from the submitted length and survives re-sanitizing', () => {
  const base = runtime.sanitizeConfig({ reasoning: { escalation: 'high', rewriteEscalationShort: 'medium' },
    escalation: { shortRewriteChars: 4000 } });
  const frozen = JSON.stringify(base);
  const short = effort.withRewriteEscalation(base, '가'.repeat(3999));
  const long = effort.withRewriteEscalation(base, '가'.repeat(4000));
  assert.equal(JSON.stringify(base), frozen, 'shared config object is not mutated');
  assert.equal(short.reasoning.rewriteEscalation, 'medium');
  assert.equal(effort.rewriteEscalationEffort(short), 'medium');
  assert.equal(Object.hasOwn(long.reasoning, 'rewriteEscalation'), false);
  assert.equal(effort.rewriteEscalationEffort(long), 'high');
  // judge.js re-sanitizes the config it is handed; the per-job value must pass through.
  assert.equal(runtime.publicConfig(short, 'inline').reasoning.rewriteEscalation, 'medium');
  // A stale per-job value on the incoming config never leaks into a long document.
  const stale = effort.withRewriteEscalation({ ...base, reasoning: { ...base.reasoning, rewriteEscalation: 'low' } }, '가'.repeat(9000));
  assert.equal(effort.rewriteEscalationEffort(stale), 'high');
  // Without the short effort or with a zero limit the previous effort applies at any length.
  for (const cfg of [runtime.sanitizeConfig({ reasoning: { escalation: 'high' }, escalation: { shortRewriteChars: 4000 } }),
    runtime.sanitizeConfig({ reasoning: { escalation: 'high', rewriteEscalationShort: 'medium' }, escalation: { shortRewriteChars: 0 } }),
    runtime.sanitizeConfig({ reasoning: { escalation: 'high', rewriteEscalationShort: 'medium' } })]) {
    assert.equal(effort.rewriteEscalationEffort(effort.withRewriteEscalation(cfg, '짧은 글')), 'high');
  }
});

test('only expensive-model drafts and repairs change; verdicts, detection and evidence search keep their effort', async () => {
  const before = await capture();
  const after = await capture({ rewriteEscalation: 'medium' });
  assert.equal(after.requests.length, before.requests.length);
  const changed = [];
  for (let i = 0; i < before.requests.length; i++) {
    const a = before.requests[i], b = after.requests[i];
    const name = a.body.text.format.name;
    const sol = a.body.model === 'gpt-6.1-sol';
    const rewrite = sol && ((a.scenario === 'draft-escalation' && name === 'gpt_prod_humanize_result')
      || (name === 'gpt_prod_relation_patch' && a.body.reasoning.effort === 'high'));
    if (rewrite) {
      assert.equal(a.body.reasoning.effort, 'high', a.scenario);
      assert.equal(b.body.reasoning.effort, 'medium', a.scenario);
      assert.deepEqual(b, { ...a, body: { ...a.body, reasoning: { effort: 'medium' } } });
      changed.push(`${a.scenario}:${name}`);
    } else {
      assert.deepEqual(b, a, `${a.scenario}:${name}`);
    }
  }
  assert.ok(changed.includes('draft-escalation:gpt_prod_humanize_result'), changed.join(','));
  assert.ok(changed.some(item => item.endsWith(':gpt_prod_relation_patch')), changed.join(','));
  for (const scenario of ['confirmation', 'escalation', 'final-revalidation', 'compat-confirmation', 'detect-escalation', 'evidence-escalation']) {
    assert.ok(!changed.some(item => item.startsWith(`${scenario}:`)), scenario);
  }
});

test('the job wiring and the stored record use the same resolved effort', () => {
  const fs = require('node:fs');
  const engine = fs.readFileSync(require.resolve('../engine-gpt-prod/index.js'), 'utf8');
  assert.match(engine, /const cfg = rewriteEffort\.withRewriteEscalation\(await loadConfig\(config\), submittedSource\);/u);
  assert.equal((engine.match(/rewriteEffort\.rewriteEscalationEffort\(cfg\)/gu) || []).length, 5);
  // Detection and evidence search escalate with their own, unchanged effort.
  assert.equal((engine.match(/reasoningEffort: cfg\.reasoning\.escalation/gu) || []).length, 3);
  const history = require('../lib/historyService').compactHistoryEngineMeta({ rewriteEscalationEffort: 'medium' });
  assert.equal(history.rewriteEscalationEffort, 'medium');
  assert.equal(Object.hasOwn(require('../lib/historyService').compactHistoryEngineMeta({}), 'rewriteEscalationEffort'), false);
});

// 엔진 전체 실행 경로. 모델 호출은 전부 가짜 응답이고, 가벼운 모델의 초안을 빈 출력으로
// 실패시켜 비싼 모델의 초안 보강이 실제로 나가게 한다.
async function runWholeEngine(text, reasoning, escalation) {
  const { load } = require('./helpers/judge-effort-capture.cjs');
  const requests = [];
  const local = load('lib/gptRuntimeConfig.js');
  const config = local.sanitizeConfig({ reasoning, escalation });
  const ledger = load('engine-gpt-prod/callLedger.js');
  const client = load('engine-gpt-prod/openaiClient.js', {
    './callLedger': ledger,
    '../lib/logger': { logger: { info() {}, warn() {}, error() {} } },
    '../lib/outboundPolicy': { outboundFetch: async (_provider, _url, init) => {
      const body = JSON.parse(init.body);
      const name = body.text?.format?.name || '';
      requests.push({ model: body.model, name, effort: body.reasoning?.effort });
      const json = name === 'gpt_prod_humanize_result'
        ? { outputText: body.model === 'gpt-6-luna' ? '' : text.split('\n\n')[0] }
        : { outputText: text, safeChangeFound: false, notes: [], violations: [], pass: true };
      return Response.json({ status: 'completed', output_text: JSON.stringify(json),
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } });
    } }
  });
  const judge = load('engine-gpt-prod/judge.js', { './openaiClient': client, '../lib/gptRuntimeConfig': local });
  const quality = load('engine-gpt-prod/finalQualityV2.js', { './judge': judge, './openaiClient': client });
  const engine = load('engine-gpt-prod/index.js', { './openaiClient': client, '../lib/gptRuntimeConfig': local, './finalQualityV2': quality });
  const out = await engine.run({ text, mode: 'assignment', lang: 'ko', config });
  const drafts = requests.filter(r => r.model === 'gpt-6.1-sol' && r.name === 'gpt_prod_humanize_result');
  return { drafts, meta: out.engineMeta || out.result?.engineMeta || {} };
}

test('whole engine run: short text escalates drafts at medium, long text and a disabled rule at high', async t => {
  const names = ['OPENAI_API_KEY', 'OPENAI_SAFETY_SALT'];
  const old = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => (old[i] === undefined ? delete process.env[name] : process.env[name] = old[i])));
  process.env.OPENAI_API_KEY = 'offline-test-key';
  process.env.OPENAI_SAFETY_SALT = 'x'.repeat(40);
  const paragraph = '조사팀은 지역별 자료를 검토했다. 결과 보고서는 기록실에 보관했다. 담당자는 조사 과정을 문서로 정리했다. 관련 자료는 다음 조사에 활용했다.';
  const short = Array.from({ length: 4 }, () => paragraph).join('\n\n');
  // 기준 글자 수를 500으로 낮춰 두 경우를 짧은 합성 글로 가른다(4,000자 기본값은 위 테스트가 본다).
  const long = Array.from({ length: 8 }, () => paragraph).join('\n\n');
  assert.ok(short.length < 500 && long.length >= 500);
  const rule = [{ escalation: 'high', rewriteEscalationShort: 'medium', judgeEscalation: 'medium' }, { shortRewriteChars: 500 }];
  for (const [text, args, expected] of [
    [short, rule, 'medium'], [long, rule, 'high'], [short, [{ escalation: 'high', judgeEscalation: 'medium' }, {}], 'high']
  ]) {
    const { drafts, meta } = await runWholeEngine(text, ...args);
    assert.ok(drafts.length >= 1, 'an expensive-model draft was requested');
    assert.deepEqual([...new Set(drafts.map(r => r.effort))], [expected]);
    assert.equal(meta.rewriteEscalationEffort, expected);
  }
});
