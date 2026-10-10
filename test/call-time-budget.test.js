'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { callTimeBudget, admitCall } = require('../engine-gpt-prod/callTimeBudget');
const { completeJson } = require('../engine-gpt-prod/openaiClient');
const ledger = require('../engine-gpt-prod/callLedger');
const { createRecoveryBudget } = require('../engine-gpt-prod/recoveryBudget');
const schedule = require('../engine-gpt-prod/semanticAuditSchedule');
const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
const options = { model: 'gpt-6.1-sol', system: 'synthetic', user: 'synthetic', schema,
  maxOutputTokens: 10000, meta: { task: 'judge', phase: 'primary:semantic' } };
const payload = { status: 'completed', output_text: '{"value":"ok"}',
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
const response = (body = payload, status = 200) => ({ ok: status === 200, status,
  headers: { get: () => '0' }, json: async () => body });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup(t) {
  const fetch = global.fetch;
  const keys = ['OPENAI_API_KEY', 'OPENAI_API_TIMEOUT_MS', 'OPENAI_CHUNK_TOTAL_TIMEOUT_MS'];
  const old = keys.map(key => process.env[key]);
  keys.forEach(key => delete process.env[key]); process.env.OPENAI_API_KEY = 'test-key';
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 });
  t.after(() => { global.fetch = fetch; keys.forEach((key, i) => {
    if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i];
  }); t.mock.timers.reset(); });
}

test('allowance covers complete output including reasoning, with measured model rates and HTTP ceiling', () => {
  assert.equal(callTimeBudget(options).requiredMs, 240000);
  assert.equal(callTimeBudget({ ...options, maxOutputTokens: 12000 }).requiredMs, 284000);
  assert.equal(callTimeBudget({ ...options, maxOutputTokens: 12500 }).fitsHttpLimit, false);
  assert.equal(callTimeBudget({ ...options, model: 'gpt-6-luna', maxOutputTokens: 16000 }).requiredMs, 222000);
  for (const meta of [{ task: 'judge' }, { task: 'humanize', phase: 'escalation' },
    { task: 'repair', phase: 'section_depth_escalation' }, { task: 'repair', phase: 'post_semantic_noop_escalation' }]) {
    assert.equal(callTimeBudget({ ...options, meta }).protectedCall, true);
  }
  assert.equal(callTimeBudget({ ...options, maxOutputTokens: 4000, meta: { task: 'humanize', phase: 'primary' } }).protectedCall, false);
});

test('only the job reserves full output; HTTP and open windows never deny a start', () => {
  const plan = callTimeBudget(options), now = 1000;
  assert.equal(admitCall(plan, { job_deadline: now + 240999 }, now).admitted, false);
  assert.equal(admitCall(plan, { job_deadline: now + 241000 }, now).admitted, true);
  assert.equal(admitCall(callTimeBudget({ ...options, maxOutputTokens: 16000 }), { request_deadline: now + 1 }, now).admitted, true);
  assert.equal(admitCall(plan, { request_deadline: now }, now).admitted, false);
});

for (const boundary of ['request_deadline', 'job_deadline', 'recovery_deadline'])
test(`insufficient ${boundary}: zero sends, zero cost, one numeric ledger skip`, async t => {
  setup(t); let calls = 0; global.fetch = async () => { calls++; return response(); };
  await ledger.run(async () => {
    const budget = createRecoveryBudget(10, { maxElapsedMs: 900000 }); ledger.setRecoveryBudget(budget);
    if (boundary === 'recovery_deadline') budget.deadlineMs = () => Date.now();
    await ledger.withPolicy({ optional: true,
      ...(boundary === 'job_deadline' ? { jobDeadlineMs: Date.now() + 200000 } : {}) }, async () => {
      await assert.rejects(completeJson({ ...options,
        maxOutputTokens: 10000,
        deadlineMs: Date.now() + (boundary === 'request_deadline' ? -1 : 900000) }), error => {
        assert.equal(error.code, 'OPENAI_CHUNK_TIMEOUT'); assert.equal(error.admissionReason, boundary);
        assert.equal(error.httpAttemptCount, 0); assert.equal(error.unknownUsageCount, 0);
        assert.equal(error.retryCounts.timeout, 0); return true;
      });
    });
    const snap = ledger.snapshot();
    assert.equal(snap.admissionSkippedCallCount, 1);
    assert.deepEqual(snap.admissionSkippedReasonCounts, { [boundary]: 1 });
    assert.equal(snap.unknownEstimatedUsd, 0); assert.equal(budget.snapshot().attemptedCallCount, 0);
  });
  assert.equal(calls, 0);
});

test('admitted judge completes beyond old 180s including body consumption before outer/job timers', async t => {
  setup(t); let transportSignal, calls = 0;
  global.fetch = async (_url, init) => { calls++; transportSignal = init.signal;
    return { ...response(), json: () => new Promise(resolve => setTimeout(() => resolve(payload), 239000)) }; };
  const outer = new AbortController(); setTimeout(() => outer.abort(), 241000);
  const pending = ledger.run(() => ledger.withPolicy({ deadlineMs: Date.now() + 241000,
    jobDeadlineMs: Date.now() + 241000 }, () => completeJson({ ...options, signal: outer.signal })));
  await flush(); t.mock.timers.tick(180001); await flush(); assert.equal(transportSignal.aborted, false);
  t.mock.timers.tick(58999); const result = await pending;
  assert.equal(result.json.value, 'ok'); assert.equal(result.unknownUsageCount, 0);
  assert.equal(outer.signal.aborted, false); assert.equal(calls, 1);
});

test('high-output repair gets its full allowance, low timeout env cannot discard it at 100s', async t => {
  setup(t); process.env.OPENAI_API_TIMEOUT_MS = '5000'; let signal;
  global.fetch = async (_url, init) => { signal = init.signal;
    await new Promise(resolve => setTimeout(resolve, 283000)); return response(); };
  const pending = completeJson({ ...options, maxOutputTokens: 12000,
    meta: { task: 'repair', phase: 'section_depth_escalation' }, deadlineMs: Date.now() + 285000 });
  await flush(); t.mock.timers.tick(100001); await flush(); assert.equal(signal.aborted, false);
  t.mock.timers.tick(182999); assert.equal((await pending).json.value, 'ok');
});

test('hung admitted call stops before hard job deadline and is never retried', async t => {
  setup(t); let calls = 0; global.fetch = async () => { calls++; return new Promise(() => {}); };
  const start = Date.now();
  const pending = ledger.run(() => ledger.withPolicy({ jobDeadlineMs: start + 241000 },
    () => completeJson({ ...options, deadlineMs: start + 900000 }))).catch(error => error);
  await flush(); t.mock.timers.tick(240000); const error = await pending;
  assert.equal(error.code, 'ETIMEDOUT'); assert.equal(error.retryCounts.timeout, 0);
  assert.equal(error.httpAttemptCount, 1); assert.equal(calls, 1); assert.ok(Date.now() < start + 241000);
});

test('explicit user/lease cancellation still aborts an admitted call', async t => {
  setup(t); global.fetch = async () => new Promise(() => {});
  const controller = new AbortController();
  const pending = completeJson({ ...options, signal: controller.signal }).catch(error => error);
  await flush(); controller.abort(new Error('user cancelled'));
  assert.equal((await pending).name, 'AbortError');
});

for (const kind of ['server', 'schema', 'truncation']) test(`${kind} retry must pass admission again`, async t => {
  setup(t); let calls = 0;
  global.fetch = async () => {
    calls++;
    if (kind !== 'truncation') t.mock.timers.tick(30000);
    if (kind === 'server') return response({ error: { message: 'unavailable' }, usage: payload.usage }, 503);
    if (kind === 'schema') return response({ ...payload, output_text: '{"value":1}' });
    return response({ ...payload, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
  };
  const pending = ledger.run(() => ledger.withPolicy({ jobDeadlineMs: Date.now() + 250000 }, () => completeJson({ ...options, deadlineMs: Date.now() + 250000,
    meta: kind === 'truncation' ? { task: 'repair', phase: 'section_depth_escalation' } : options.meta }))).catch(error => error);
  await flush(); t.mock.timers.tick(1); await flush();
  const error = await pending;
  assert.equal(error.admissionSkipped, true); assert.equal(calls, 1);
  assert.equal(error.httpAttemptCount, 1); assert.equal(error.unknownUsageCount, 0);
  assert.equal(error.usage.outputTokens, 5);
  assert.equal(error.admissionReason, 'job_deadline');
});

test('nested policy cannot renew enclosing audit or absolute job deadline', async () => {
  await ledger.run(() => ledger.withPolicy({ deadlineMs: 10000, jobDeadlineMs: 20000 },
    () => ledger.withPolicy({ deadlineMs: 30000, jobDeadlineMs: 40000 }, () => {
      assert.equal(ledger.current().policy.deadlineMs, 10000);
      assert.equal(ledger.current().policy.jobDeadlineMs, 20000);
    })));
});

test('F-01 keeps 270s sections, concurrency two, only unfinished sections retry once', async t => {
  setup(t); const attempts = [0, 0, 0], passed = new Set(); let active = 0, peak = 0;
  global.fetch = async () => { active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 200000)); active--; return response(); };
  const pending = ledger.run(() => ledger.withPolicy({ deadlineMs: Date.now() + 1000000,
    jobDeadlineMs: Date.now() + 1000000 }, () => schedule.runSectionSchedule({
    schedule: attempts.map((_, index) => ({ index })), allowRepair: false,
    policy: schedule.finalVerdictBudget(20000).policy.verdictSchedule,
    isUnfinished: index => !passed.has(index)
  }, async ({ index }, signal) => {
    attempts[index]++;
    if (index === 1 && attempts[index] === 1) return; // one unavailable section
    await completeJson({ ...options, signal }); passed.add(index);
  })));
  await flush(); for (let i = 0; i < 4; i++) { t.mock.timers.tick(200000); await flush(); }
  const result = await pending;
  assert.deepEqual(result, { sectionLimitMs: 270000, retriedSections: 1 });
  assert.deepEqual(attempts, [1, 2, 1]); assert.equal(peak, 2); assert.equal(passed.size, 3);
});

for (const boundary of ['request', 'recovery']) test(`${boundary} window closes during response body: result and cost survive; next send is denied`, async t => {
  setup(t); let calls=0;
  global.fetch=async()=>{ calls++;return {...response(),json:()=>new Promise(resolve=>setTimeout(()=>resolve(payload),150000))}; };
  const pending=ledger.run(async()=>{
    const start=Date.now(),budget=createRecoveryBudget(10,{maxElapsedMs:120000});
    if(boundary==='recovery')ledger.setRecoveryBudget(budget);
    const opts={...options,deadlineMs:start+(boundary==='request'?120000:900000)};
    const result=await completeJson(opts);
    assert.equal(result.json.value,'ok');assert.equal(result.windowCompletedCallCount,1);
    // Normal recovery retains 30s for late work, so its start window is 90s.
    assert.equal(result.windowOverrunMs,boundary==='request'?30000:60000);
    assert.equal(result.usage.outputTokens,5);assert.equal(result.unknownUsageCount,0);
    await assert.rejects(completeJson(opts),e=>e.httpAttemptCount===0&&e.admissionSkipped===true);
    const s=ledger.snapshot();assert.equal(s.windowCompletedCallCount,1);
    assert.equal(s.windowOverrunMs,result.windowOverrunMs);assert.equal(s.windowMaxOverrunMs,result.windowOverrunMs);
    if(boundary==='recovery')assert.equal(budget.snapshot().reservedUsd,0);
  });
  await flush();t.mock.timers.tick(150000);await pending;assert.equal(calls,1);
});

for (const kind of ['server','schema','truncation']) test(`${kind} cannot start another physical attempt after the window closes`, async t=>{
  setup(t);let calls=0;
  global.fetch=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,130000));
    if(kind==='server')return response({error:{message:'unavailable'},usage:payload.usage},503);
    if(kind==='schema')return response({...payload,output_text:'{"value":1}'});
    return response({...payload,status:'incomplete',incomplete_details:{reason:'max_output_tokens'}});
  };
  const pending=completeJson({...options,deadlineMs:Date.now()+120000,
    meta:kind==='truncation'?{task:'repair',phase:'section_depth_escalation'}:options.meta}).catch(e=>e);
  await flush();t.mock.timers.tick(130000);const error=await pending;
  assert.equal(calls,1);assert.equal(error.httpAttemptCount,1);assert.equal(error.usage.outputTokens,5);
  assert.equal(error.unknownUsageCount,0);
});

for (const finish of [true,false]) test(`HTTP-incompatible 16000-token verdict is sent and ${finish?'received after 270s':'counted once at the 290s ceiling'}`,async t=>{
  setup(t);let calls=0,transportSignal;
  global.fetch=async(_url,init)=>{calls++;transportSignal=init.signal;
    if(!finish)return new Promise(()=>{});
    await new Promise(resolve=>setTimeout(resolve,280000));return response();
  };
  const pending=ledger.run(()=>ledger.withPolicy({jobDeadlineMs:Date.now()+900000},()=>schedule.runSectionSchedule({
    schedule:[{index:0}],allowRepair:false,policy:schedule.finalVerdictBudget(3000).policy.verdictSchedule
  },async(_item,signal)=>completeJson({...options,maxOutputTokens:16000,signal}))),(_out,s)=>{
    assert.equal(s.httpCeilingTimeoutCount,0);assert.equal(s.windowCompletedCallCount,1);assert.equal(s.windowOverrunMs,10000);
  }).catch(e=>e);
  await flush();t.mock.timers.tick(270001);await flush();assert.equal(transportSignal.aborted,false);
  t.mock.timers.tick(finish?9999:19999);const out=await pending;
  assert.equal(calls,1);
  if(!finish){assert.equal(out.code,'ETIMEDOUT');assert.equal(out.httpCeilingTimeoutCount,1);
    assert.equal(out.callLedger.httpCeilingTimeoutCount,1);assert.equal(out.retryCounts.timeout,0);assert.equal(out.unknownUsageCount,1);}
});

test('HTTP ceiling does not reduce the absolute job admission reservation',async t=>{
  setup(t);let calls=0;global.fetch=async()=>{calls++;return response();};
  await assert.rejects(ledger.run(()=>ledger.withPolicy({jobDeadlineMs:Date.now()+300000},()=>
    completeJson({...options,maxOutputTokens:16000}))),e=>e.admissionReason==='job_deadline'&&e.requiredAttemptMs===372000);
  assert.equal(calls,0);
});

test('absolute job timer still wins over a larger configured protected-call timer',async t=>{
  setup(t);process.env.OPENAI_API_TIMEOUT_MS='290000';let signal;
  global.fetch=async(_url,init)=>{signal=init.signal;return new Promise(()=>{});};
  const pending=ledger.run(()=>ledger.withPolicy({jobDeadlineMs:Date.now()+241000},()=>completeJson(options))).catch(e=>e);
  await flush();t.mock.timers.tick(240000);const error=await pending;
  assert.equal(error.code,'ETIMEDOUT');assert.equal(signal.aborted,true);assert.equal(error.httpCeilingTimeoutCount,0);
});
