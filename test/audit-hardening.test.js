'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createExecutionCoordinator, keyOf } = require('../lib/transformExecution');
const { createReadiness } = require('../lib/readiness');
const { sourceSentences, groundSignals } = require('../lib/detectGrounding');
const { isUnsupportedHumanizeInput } = require('../engine/inputrouting');
const { gradeSource } = require('../engine/evidencereview');
const { looksLikePromptLeak } = require('../engine-gpt-prod/promptSecurity');

function database() {
  const rows = new Map();
  let chain = Promise.resolve();
  return { rows, collection: collection => ({ doc: id => `${collection}/${id}` }),
    runTransaction(fn) {
      const operation = chain.then(() => fn({
        get: async ref => ({ exists: rows.has(ref), data: () => structuredClone(rows.get(ref)) }),
        set: (ref, value, options) => rows.set(ref, options?.merge ? { ...rows.get(ref), ...structuredClone(value) } : structuredClone(value))
      }));
      chain = operation.catch(() => {}); return operation;
    } };
}

test('cross-instance leases serialize an owner, enforce pool capacity and fence expired owners', async () => {
  const db = database(); let now = 100;
  const options = { db, caps: { formal: 1, short: 2 }, clock: () => now };
  const a = createExecutionCoordinator(options), b = createExecutionCoordinator(options);
  const first = { id: 'a', uid: 'same', status: 'done', mode: 'blog' };
  const second = { ...first, id: 'b' };
  const third = { ...first, id: 'c', uid: 'other' };
  const fourth = { ...first, id: 'd', uid: 'another' };
  [first, second, third, fourth].forEach(job => db.rows.set(`transformJobs/${job.id}`, job));
  const [lease, rejected] = await Promise.all([a.acquire(first, 'refine'), b.acquire(second, 'refine')]);
  assert.ok(lease); assert.equal(rejected, null);
  assert.ok(await b.acquire(third, 'refine'));
  assert.equal(await a.acquire(fourth, 'refine'), null);
  now += 90001;
  const replacement = await b.acquire(first, 'refine');
  assert.ok(replacement);
  assert.equal(await a.renew(lease), false);
  await a.release(lease);
  assert.equal(db.rows.get('transformExecutionLeases/active').slots[keyOf(first.id)].token, replacement.token);
});

test('lease rejects an account under deletion and stale terminal state', async () => {
  const db = database();
  const coordinator = createExecutionCoordinator({ db, caps: { formal: 1, short: 1 } });
  const job = { id: 'x', uid: 'u', status: 'done', mode: 'blog' };
  db.rows.set('transformJobs/x', job);
  assert.equal(await coordinator.acquire(job, 'main'), null);
  db.rows.set('accountDeletionJobs/u', { status: 'processing' });
  assert.equal(await coordinator.acquire(job, 'refine'), null);
});

test('readiness bounds dependency hangs, coalesces probes and recovers configuration failures', async () => {
  let now = 0, enabled = false, calls = 0;
  const check = createReadiness({ configured: () => enabled, probe: async () => { calls++; }, clock: () => now, cacheMs: 10 });
  assert.equal((await check()).ok, false);
  enabled = true; now = 11;
  assert.deepEqual((await Promise.all([check(), check()])).map(row => row.ok), [true, true]);
  assert.equal(calls, 1);
  const hung = createReadiness({ configured: () => true, probe: () => new Promise(() => {}), timeoutMs: 10 });
  assert.equal((await hung()).ok, false);
});

test('grounding exposes exact offsets without copying source and downgrades fabricated locations', () => {
  const source = '첫 문장을 기록했다. 다음 문장도 확인했다. 마지막 결과를 비교했다.';
  const sentences = sourceSentences(source);
  assert.equal(sentences.length, 3);
  const [valid, bad] = groundSignals([
    { category: 'sentence_uniformity', strength: 'strong', scope: 'recurring', evidenceSentences: [0, 1, 1, 999] },
    { category: 'generic_abstraction', strength: 'strong', scope: 'pervasive', evidenceSentences: [-1, 999] }
  ], source);
  assert.equal(valid.locations.length, 2);
  assert.equal(source.slice(valid.locations[1].start, valid.locations[1].end), sentences[1].text);
  assert.equal(bad.scope, 'isolated'); assert.equal(bad.strength, 'weak');
  assert.equal(JSON.stringify(valid).includes('첫 문장'), false);
});

test('Korean-only admission, source trust and prompt-leak false positives', () => {
  assert.equal(isUnsupportedHumanizeInput('これは日本語の文章です。入力した文章を何度も繰り返して説明しています。'), true);
  assert.equal(isUnsupportedHumanizeInput('这是一个中文段落，我们记录研究结果并解释观察过程中发生的事情。'), true);
  assert.equal(isUnsupportedHumanizeInput('연구 결과를 검토하고 API 응답 시간과 HTTP 상태를 비교했습니다.'), false);
  assert.notEqual(gradeSource('https://news.example.test/story'), 'A');
  assert.notEqual(gradeSource('https://ilbo.example.test/story'), 'A');
  assert.notEqual(gradeSource('https://who.com/story'), 'A');
  assert.notEqual(gradeSource('https://nature.org/story'), 'A');
  assert.equal(gradeSource('https://www.yna.co.kr/story'), 'A');
  assert.equal(looksLikePromptLeak('앞 문맥을 살피고 작업 위치를 정했다.'), false);
  assert.equal(looksLikePromptLeak('[작업 위치]'), true);
});

function completionContext(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../routes/transform.js'), 'utf8');
  const start = source.indexOf('async function finishRefinement(');
  const end = source.indexOf('async function commitRefineBilling(', start);
  const context = { classifyBillingDisposition: () => 'charged', commitJobBilling: async () => {},
    commitRefineBilling: async () => true, persistJob: async () => ({ ok: true }),
    attachRefineTargets() {}, measurePreservation: () => ({ total: 3 }), saveJobHistory: async () => {}, ...overrides };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  return context;
}

test('completion cannot bill before durable staging and never exposes a failed final write', async () => {
  let charged = 0;
  const ctx = completionContext({ persistJob: async () => ({ ok: false }), commitJobBilling: async () => { charged++; } });
  const job = { id: 'job', mode: 'blog', needed: 10, status: 'running' };
  await assert.rejects(ctx.stageCompletion(job, { outputText: 'candidate' }));
  assert.equal(charged, 0); assert.equal(job.result, undefined);
  await assert.rejects(ctx.recoverCompletion(job));
  assert.equal(charged, 1); assert.equal(job.result, undefined); assert.ok(job.pendingCompletion);
  ctx.persistJob = async () => ({ ok: true });
  await ctx.recoverCompletion(job);
  assert.equal(job.result.outputText, 'candidate'); assert.equal(job.status, 'done');
});

test('failed refinement billing/persistence preserves the old result and recovery publishes a new audit version', async () => {
  const job = { result: { outputText: 'old', qualityWarnings: [], metrics: { novelty: 0 } },
    pendingRefinement: { outputText: 'new', outputVersion: 2, n: 3, needed: 10, paraLen: 100, paragraphIndex: 0, memoLength: 20 } };
  const ctx = completionContext({ commitRefineBilling: async () => { throw new Error('billing'); } });
  await assert.rejects(ctx.finishRefinement(job)); assert.equal(job.result.outputText, 'old');
  ctx.commitRefineBilling = async () => true; ctx.persistJob = async () => ({ ok: false });
  await assert.rejects(ctx.finishRefinement(job)); assert.equal(job.result.outputText, 'old');
  ctx.persistJob = async () => ({ ok: true });
  await ctx.finishRefinement(job);
  assert.equal(job.result.outputText, 'new'); assert.equal(job.result.outputVersion, 2);
  assert.equal(job.result.metrics, null); assert.equal(job.result.qualityStatus, 'needs_review');
});

test('CSP reports cannot log paths, queries or script samples', () => {
  const report = require('../lib/cspReport').summarizeReport({ 'csp-report': {
    'blocked-uri': 'https://example.test/private?token=secret', 'document-uri': 'https://app.test/user/private',
    'script-sample': 'private content', 'effective-directive': 'script-src-elem'
  } });
  assert.equal(report.blockedOrigin, 'https://example.test');
  assert.equal(JSON.stringify(report).includes('private'), false);
});

test('refinement rejects a trivial edit without a review call and requires both review contracts', async () => {
  const { validateRefinement } = require('../lib/refinementValidation');
  const source = '연구팀은 여러 조건에서 자료를 수집했다. 효과를 입증할 수 없으므로 추가 관찰이 필요하다.';
  const config = { models: { judge: 'synthetic' } };
  let calls = 0;
  const review = async () => { calls++; return { json: { preservesMeaning: false, integratesMemo: true } }; };
  assert.equal((await validateRefinement({ source, candidate: source, memo: '경험', config }, review)).pass, false);
  assert.equal(calls, 0);
  const candidate = '나는 현장에서 자료를 정리하며 여러 조건을 비교했다. 효과를 입증했으므로 추가 관찰은 필요 없다.';
  assert.equal((await validateRefinement({ source, candidate, memo: '현장에서 자료를 정리했다.', config }, review)).pass, false);
  assert.equal(calls, 1);
  assert.equal((await validateRefinement({ source, candidate, memo: '경험', config }, async () => ({ json: { preservesMeaning: true, integratesMemo: false } }))).pass, false);
});

test('semantic sections run with bounded concurrency, preserve order and share one repair budget', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../engine-gpt-prod/finalQualityV2.js'), 'utf8');
  const start = source.indexOf('async function runSemanticDocumentAudit(');
  const end = source.indexOf('function restoreReviewPairBoundaryWhitespace', start);
  let active = 0, maximum = 0, repaired = 0;
  const context = { require, buildReviewPairs: () => Array.from({ length: 6 }, (_, index) => ({ index, output: `${index}`, sourceContext: 'source' })),
    discourse: { compareDiscourse: () => ({ codes: [] }) }, restoreReviewPairBoundaryWhitespace: (_before, after) => after,
    addUsageLocal: () => null, safeMessage: error => error.message,
    judgeAndRepair: async (_source, output, options) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setImmediate(resolve));
      const rounds = options.reserveRepair() ? 1 : 0; repaired += rounds; active--;
      return { pass: true, outputText: output, rounds };
    } };
  context.require = name => name === './concurrency' ? require('../engine-gpt-prod/concurrency') : require(name);
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const result = await context.runSemanticDocumentAudit({ source: 'source', outputText: 'output' });
  assert.equal(maximum, 2); assert.equal(repaired, 3); assert.equal(result.outputText, '012345');
});

test('engine worker propagates Korean-only errors before any model call', async () => {
  await assert.rejects(require('../lib/humanizeWorkerPool').runHumanize({
    text: 'This synthetic English paragraph must be rejected by the Korean engine before requesting any model.'
  }), error => error.code === 'HUMANIZE_KOREAN_ONLY');
});

test('real admission persistence rejects simultaneous same-owner jobs and stale execution writes', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/transform.js'), 'utf8');
  const claims = require('../lib/accountActivityClaims');
  const db = database();
  const context = { db, normalizeCompletedJobState() {}, ensureTerminalTimestamp() {},
    PERSIST_FIELDS: ['id', 'uid', 'status', 'executionToken'], pruneUndefinedForFirestore: value => value,
    buildArchiveDocument: () => ({}), jobPersistChains: new Map(), JOB_ARCHIVE_COLLECTION: 'archive',
    ACCOUNT_ACTIVITY_COLLECTION: claims.COLLECTION, TRANSFORM_LANE: claims.TRANSFORM_LANE,
    TRANSFORM_CLAIM_TTL_MS: claims.TRANSFORM_CLAIM_TTL_MS,
    activeLane: claims.activeLane, laneWithClaim: claims.laneWithClaim, laneWithoutClaim: claims.laneWithoutClaim,
    accountDeletionBlocksWrites: claims.accountDeletionBlocksWrites,
    executionPolicy: require('../lib/transformExecution'), logger: { warn() {} } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function persistJob('), source.indexOf('function resultLength(')), context);
  const jobs = [{ id: 'first', uid: 'owner', status: 'queued' }, { id: 'second', uid: 'owner', status: 'queued' }];
  const result = await Promise.all(jobs.map(job => context.persistJob(job, { requireClaim: true })));
  assert.equal(result.filter(row => row.ok).length, 1);
  assert.equal(result.find(row => !row.ok).code, 'USER_TRANSFORM_ACTIVE');
  db.rows.set('transformExecutionLeases/active', { slots: { [keyOf('first')]: {
    jobId: 'first', uid: 'owner', token: 'new-owner', expiresAtMs: Date.now() + 60000
  } } });
  const stale = await context.persistJob({ ...jobs[0], status: 'done', executionToken: 'old-owner' });
  assert.equal(stale.ok, false); assert.equal(db.rows.get('transformJobs/first').status, 'queued');
});
