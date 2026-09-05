'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const state = {
  billingPlan: 'free',
  forceModelFailure: false,
  modelProbability: 72,
  modelCalls: 0,
  deductCalls: 0,
  actualDeducts: 0,
  balance: 100,
  forcedCommitError: null,
  forceDuplicateCommit: false,
  precheckBarrier: null,
  historyCalls: [],
  metricRegistrations: 0,
  creditBindings: new Map(),
  historyDocs: new Map(),
  requestJobs: new Map(),
  stabilityResult: null,
  logs: []
};

function stub(relativePath, exports) {
  const filename = require.resolve(path.join(ROOT, relativePath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function log(level) {
  return (event, fields) => state.logs.push({ level, event, fields: fields || {} });
}

function fingerprint({ opType, needed, text }) {
  return crypto.createHash('sha256')
    .update(`${opType}\0${needed}\0${text}`, 'utf8')
    .digest('hex');
}

function reusedError() {
  return Object.assign(new Error('IDEMPOTENCY_KEY_REUSED'), {
    code: 'IDEMPOTENCY_KEY_REUSED',
    status: 409
  });
}

function bindingMatches(row, opType, amount, payloadFingerprint) {
  return row
    && row.opType === opType
    && row.amount === amount
    && row.payloadFingerprint === payloadFingerprint;
}

stub('config.js', {
  db: {},
  ADMIN_UIDS: [],
  verifyToken: async () => 'detect-policy-user'
});

stub('lib/logger.js', {
  logger: {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error')
  },
  setLogContext() {}
});

stub('lib/usageBilling.js', {
  getCreditAccountState: async () => ({
    uid: 'detect-policy-user',
    plan: state.billingPlan,
    credits: state.balance
  }),
  precheckCredits: async (_token, amount) => {
    const hasEnoughCredits = state.billingPlan === 'unlimited' || state.balance >= amount;
    const barrier = state.precheckBarrier;
    if (barrier) {
      barrier.arrived += 1;
      if (barrier.arrived >= barrier.expected) barrier.resolve();
      await barrier.promise;
    }
    if (!hasEnoughCredits) {
      throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 });
    }
    return { uid: 'detect-policy-user', plan: state.billingPlan };
  },
  creditRequestPayloadFingerprint: fingerprint,
  precheckCreditDeductIdempotency: async (_uid, amount, opType, requestId, payloadFingerprint) => {
    const existing = state.creditBindings.get(requestId);
    if (!existing) return { state: 'NEW', remainingCredits: state.balance };
    if (!bindingMatches(existing, opType, amount, payloadFingerprint)) throw reusedError();
    return {
      state: 'DUPLICATE',
      remainingCredits: state.balance,
      chargedCredits: existing.amount
    };
  },
  commitCreditDeduct: async (_uid, amount, opType, requestId, meta = {}) => {
    state.deductCalls += 1;
    const existing = state.creditBindings.get(requestId);
    if (existing) {
      if (!bindingMatches(existing, opType, amount, meta.requestPayloadFingerprint)) throw reusedError();
      return { duplicate: true, current: state.balance, next: state.balance };
    }
    if (state.forceDuplicateCommit) {
      state.creditBindings.set(requestId, {
        opType,
        amount,
        payloadFingerprint: meta.requestPayloadFingerprint
      });
      return { duplicate: true, current: state.balance, next: state.balance };
    }
    if (state.forcedCommitError) throw state.forcedCommitError;
    if (state.balance < amount) {
      throw Object.assign(new Error('INSUFFICIENT_CREDITS'), {
        code: 'INSUFFICIENT_CREDITS',
        status: 402
      });
    }
    const current = state.balance;
    state.balance -= amount;
    state.creditBindings.set(requestId, {
      opType,
      amount,
      payloadFingerprint: meta.requestPayloadFingerprint
    });
    state.actualDeducts += 1;
    return { current, next: state.balance };
  },
  retryAsync: async (fn, attempts = 3) => {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  },
  authErrorMessage: code => code
});

stub('lib/detectCalibration.js', {
  applyHistoryCalibration: async ({ probability }) => ({
    probability: Math.round(probability),
    rawProbability: Math.round(probability),
    applied: false,
    meta: null
  })
});

stub('lib/historyService.js', {
  getDetectHistoryIdempotency: async ({ requestId, needed, requestPayloadFingerprint }) => {
    const existing = state.historyDocs.get(requestId);
    if (!existing) return { state: 'NOT_FOUND' };
    if (existing.needed !== needed || existing.requestPayloadFingerprint !== requestPayloadFingerprint) {
      return { state: 'MISMATCH' };
    }
    return { state: 'READY', response: existing.response };
  },
  saveAnalyzeHistory: async input => {
    const existing = state.historyDocs.get(input.requestId);
    if (existing) {
      if (existing.needed !== input.needed
        || existing.requestPayloadFingerprint !== input.requestPayloadFingerprint) throw reusedError();
      return { saved: true, id: input.requestId, duplicate: true, response: existing.response };
    }
    state.historyCalls.push(input);
    state.historyDocs.set(input.requestId, {
      needed: input.needed,
      requestPayloadFingerprint: input.requestPayloadFingerprint,
      response: input.detectResponseCache
    });
    return { saved: true, id: input.requestId };
  }
});

stub('lib/detectRequestStore.js', {
  begin: async binding => {
    const existing = state.requestJobs.get(binding.requestId);
    if (!existing) {
      state.requestJobs.set(binding.requestId, { binding, state: 'PROCESSING', response: null });
      return { state: 'NEW' };
    }
    if (existing.binding.payloadFingerprint !== binding.payloadFingerprint
      || existing.binding.cost !== binding.cost) return { state: 'MISMATCH' };
    return { state: existing.state, response: existing.response };
  },
  stageResult: async (binding, response) => {
    const existing = state.requestJobs.get(binding.requestId);
    if (!existing || existing.binding.payloadFingerprint !== binding.payloadFingerprint) {
      return { state: 'MISMATCH' };
    }
    if (['RESULT_READY', 'COMPLETE'].includes(existing.state) && existing.response) {
      return { state: existing.state, response: existing.response };
    }
    existing.state = 'RESULT_READY';
    existing.response = response;
    return { state: 'RESULT_READY', response };
  },
  complete: async (binding, response) => {
    const existing = state.requestJobs.get(binding.requestId);
    if (!existing || existing.binding.payloadFingerprint !== binding.payloadFingerprint) {
      return { state: 'MISMATCH' };
    }
    existing.state = 'COMPLETE';
    existing.response = response;
    return { state: 'COMPLETE', response };
  },
  recordBillingFailure: async () => {},
  releaseAfterModelFailure: async binding => {
    const existing = state.requestJobs.get(binding.requestId);
    if (existing?.state === 'PROCESSING') state.requestJobs.delete(binding.requestId);
  }
});

stub('lib/detectResultStability.js', {
  variantForConfig: () => 'detect-result-stability-v1:test',
  getOrCompute: async (_input, compute) => {
    if (state.stabilityResult) {
      return {
        result: state.stabilityResult,
        cacheHit: true,
        source: 'firestore'
      };
    }
    return { result: await compute(), cacheHit: false, source: 'live' };
  }
});

stub('lib/gptRuntimeConfig.js', {
  getRuntimeConfig: async () => ({
    activeProvider: 'gpt',
    models: { detect: 'gpt-test' },
    reasoning: { detect: 'low' }
  }),
  isGptActive: config => config?.activeProvider === 'gpt'
});

stub('routes/analyze-gpt.js', {
  DETECT_VERSION: 'detect-test-v1',
  DETECT_PROMPT_VERSION: 'detect-prompt-test-v1',
  runDetect: async text => {
    state.modelCalls += 1;
    if (state.forceModelFailure || String(text).startsWith('FAIL ')) {
      throw Object.assign(new Error('provider unavailable'), { code: 'OPENAI_UNAVAILABLE' });
    }
    if (String(text).startsWith('INCOMPLETE ')) return { summary: 'missing probability' };
    return {
      probability: state.modelProbability,
      summary: '문체 신호가 관찰됐습니다.',
      detail: '정형적인 문장 구조가 관찰됐습니다.',
      signals: ['정형적인 문장 구조'],
      confidence: 'medium',
      gptMeta: {
        selectedModel: 'gpt-test',
        engine: 'detect-test-v1',
        escalated: false
      }
    };
  },
  rewriteSentence: async () => ({ rewritten: '' })
});

stub('lib/publicMetrics.js', {
  trackDeliveredMetric: () => {
    state.metricRegistrations += 1;
    return true;
  }
});

const report = require('../routes/detectreport');
const app = express();
app.use(express.json());
app.use('/', report);

let server;
let baseUrl;
test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (!server) return;
  await new Promise(resolve => server.close(resolve));
});

async function post(text, requestId) {
  const response = await fetch(`${baseUrl}/detect-report`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ text, requestId })
  });
  return { status: response.status, body: await response.json() };
}

const BASE_TEXT = (
  '지난 학기 팀 프로젝트에서 학생 네 명과 설문 자료를 정리했습니다. '
  + '저는 결과표의 오류 세 건을 직접 찾아 수정했고, 회의에서 확인 순서를 다시 정했습니다. '
).repeat(2);

test('차감 대상 요청은 유효한 client requestId 없이는 모델 호출 전에 400으로 거절한다', { concurrency: false }, async () => {
  const missing = await post(BASE_TEXT);
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'REQUEST_ID_REQUIRED');
  assert.equal(missing.body.retryable, false);
  assert.equal(missing.body.charged, 0);
  assert.equal(missing.body.cost, Math.ceil(BASE_TEXT.length / 100));

  const invalid = await post(BASE_TEXT, 'detect/invalid/request');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'INVALID_REQUEST_ID');
  assert.equal(invalid.body.retryable, false);
  assert.equal(invalid.body.charged, 0);

  assert.equal(state.modelCalls, 0);
  assert.equal(state.deductCalls, 0);
  assert.equal(state.historyCalls.length, 0);
  assert.equal(state.metricRegistrations, 0);
});

test('모델 실패와 불완전 응답은 엔진 숫자 없이 503 무차감으로 닫는다', { concurrency: false }, async () => {
  const failed = await post(`FAIL ${BASE_TEXT}`, 'detect-fail-1');
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, 'DETECT_MODEL_UNAVAILABLE');
  assert.equal(failed.body.retryable, true);
  assert.equal(failed.body.charged, 0);
  assert.equal(Object.hasOwn(failed.body, 'probability'), false);
  assert.equal(Object.hasOwn(failed.body, 'probSource'), false);
  assert.equal(state.modelCalls, 1, '라우트는 엔진 전체를 중첩 재시도하지 않아야 한다');
  assert.equal(state.deductCalls, 0);
  assert.equal(state.historyCalls.length, 0);
  assert.equal(state.metricRegistrations, 0);

  const incomplete = await post(`INCOMPLETE ${BASE_TEXT}`, 'detect-incomplete-1');
  assert.equal(incomplete.status, 503);
  assert.equal(incomplete.body.code, 'DETECT_MODEL_UNAVAILABLE');
  assert.equal(Object.hasOwn(incomplete.body, 'probability'), false);
  assert.equal(state.modelCalls, 2, '불완전 응답도 라우트에서 한 번만 실행해야 한다');
  assert.equal(state.deductCalls, 0);
  assert.equal(state.historyCalls.length, 0);

  const blocked = state.logs.find(item => item.event === 'detect_report.score_outcome'
    && item.fields.outcome === 'blocked');
  assert.ok(blocked);
  assert.equal(blocked.fields.scoreSource, 'none');
  assert.equal(blocked.fields.uid, undefined);
  assert.equal(blocked.fields.requestId, 'detect-fail-1');
  assert.equal(blocked.fields.upstreamCode, 'OPENAI_UNAVAILABLE');
  assert.match(blocked.fields.lengthBucket, /^\d+-\d+$/u);
  assert.ok(Number.isFinite(blocked.fields.latencyMs));
  for (const forbidden of ['text', 'inputText', 'inputHash', 'textHash']) {
    assert.equal(Object.hasOwn(blocked.fields, forbidden), false, `${forbidden} 기록 금지`);
  }
  const unavailableEvent = state.logs.find(item => item.event === 'detect_report.scoring_unavailable');
  assert.ok(unavailableEvent);
  assert.equal(unavailableEvent.fields.requestId, 'detect-fail-1');
  assert.equal(unavailableEvent.fields.upstreamCode, 'OPENAI_UNAVAILABLE');
  assert.equal(unavailableEvent.fields.lengthBucket, blocked.fields.lengthBucket);
  for (const forbidden of ['uid', 'text', 'inputHash', 'textHash', 'textLength', 'upstreamErrorCode', 'scoreLatencyMs']) {
    assert.equal(unavailableEvent.fields[forbidden], undefined, `${forbidden} 기록 금지`);
  }
});

test('성공 결과만 LLM 출처로 전달·저장하고 권위 측정 이벤트를 남긴다', { concurrency: false }, async t => {
  const previousSalt = process.env.OPENAI_SAFETY_SALT;
  process.env.OPENAI_SAFETY_SALT = 'detect-public-proof-test-secret-at-least-thirty-two-characters';
  t.after(() => { if (previousSalt === undefined) delete process.env.OPENAI_SAFETY_SALT; else process.env.OPENAI_SAFETY_SALT = previousSalt; });
  const requestId = 'detect-success-1';
  const result = await post(BASE_TEXT, requestId);
  const cost = Math.ceil(BASE_TEXT.length / 100);

  assert.equal(result.status, 200);
  assert.equal(result.body.probability, 72);
  assert.equal(result.body.probSource, 'llm');
  assert.equal(typeof result.body.interpretationProof, 'string');
  assert.match(result.body.interpretationProof, /^detect-interpretation-proof-v1\.[A-Za-z0-9_-]{43}$/u);
  // The browser forwards only string proofs; exercise that actual wire
  // contract before validating the server-produced payload for backup.
  const browserBackup = { inputText: BASE_TEXT, probability: result.body.probability, interpretation: result.body.interpretation };
  if (typeof result.body.interpretationProof === 'string') browserBackup.interpretationProof = result.body.interpretationProof;
  assert.deepEqual(require('../lib/detectHistoryPresentation').verifiedBackupInterpretation('detect-policy-user', browserBackup), result.body.interpretation);
  assert.equal(result.body.charged, cost);
  assert.equal(result.body.remainingCredits, 100 - cost);
  assert.equal(state.actualDeducts, 1);
  assert.equal(state.historyCalls.length, 1);
  assert.equal(state.historyCalls[0].result.probSource, 'llm');
  assert.equal(state.historyCalls[0].result.rawProbability, 72);
  assert.equal(state.historyCalls[0].result.gptMeta.detectPromptVersion, 'detect-prompt-test-v1');
  assert.equal(state.historyCalls[0].result.gptMeta.detectCacheHit, false);
  assert.equal(state.metricRegistrations, 1);

  const delivered = state.logs.find(item => item.event === 'detect_report.score_outcome'
    && item.fields.outcome === 'delivered');
  assert.ok(delivered);
  assert.equal(delivered.fields.scoreSource, 'llm');
  assert.equal(delivered.fields.probability, 72);
  assert.equal(delivered.fields.selectedModel, 'gpt-test');
  assert.equal(delivered.fields.detectorVersion, 'detect-test-v1');
  assert.equal(delivered.fields.uid, undefined);
  assert.equal(Object.hasOwn(delivered.fields, 'text'), false);
});

test('새 requestId의 동일 입력은 안정화 캐시 원점수를 재사용하고 캐시 출처를 기록한다', { concurrency: false }, async () => {
  const modelCallsBefore = state.modelCalls;
  const historyCallsBefore = state.historyCalls.length;
  state.billingPlan = 'unlimited';
  state.stabilityResult = {
    probability: 61,
    summary: '캐시된 문체 신호',
    detail: '캐시된 상세',
    signals: ['반복되는 문장 구조'],
    confidence: 'high',
    gptMeta: {
      selectedModel: 'gpt-test',
      engine: 'detect-test-v1',
      detectPromptVersion: 'detect-prompt-test-v1',
      escalated: false
    }
  };
  let result;
  try {
    result = await post(BASE_TEXT, 'detect-stability-hit-1');
  } finally {
    state.stabilityResult = null;
    state.billingPlan = 'free';
  }

  assert.equal(result.status, 200);
  assert.equal(result.body.probability, 61);
  assert.equal(result.body.probSource, 'llm');
  assert.equal(result.body.charged, 0);
  assert.equal(state.modelCalls, modelCallsBefore);
  assert.equal(state.historyCalls.length, historyCallsBefore + 1);
  assert.equal(state.historyCalls.at(-1).result.rawProbability, 61);
  assert.equal(state.historyCalls.at(-1).result.gptMeta.detectCacheHit, true);
  assert.equal(state.historyCalls.at(-1).result.gptMeta.detectCacheSource, 'firestore');
  const delivered = [...state.logs].reverse().find(item => item.event === 'detect_report.score_outcome'
    && item.fields.outcome === 'delivered');
  assert.equal(delivered.fields.scoreSource, 'cached_llm');
  assert.equal(delivered.fields.detectCacheHit, true);
  assert.equal(delivered.fields.detectCacheSource, 'firestore');
});

test('동일 payload 재요청은 모델·원장·이력을 다시 호출하지 않고 권위 잔액을 재전송한다', { concurrency: false }, async () => {
  const modelCallsBefore = state.modelCalls;
  const deductCallsBefore = state.deductCalls;
  const historiesBefore = state.historyCalls.length;
  const metricsBefore = state.metricRegistrations;
  const duplicate = await post(BASE_TEXT, 'detect-success-1');
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.probability, 72);
  assert.equal(duplicate.body.probSource, 'llm');
  assert.equal(duplicate.body.charged, 0);
  assert.equal(duplicate.body.remainingCredits, state.balance);
  assert.equal(duplicate.body.idempotentReplay, true);
  assert.equal(state.modelCalls, modelCallsBefore);
  assert.equal(state.deductCalls, deductCallsBefore);
  assert.equal(state.actualDeducts, 1, '실제 잔액 변경은 한 번이어야 한다');
  assert.equal(state.historyCalls.length, historiesBefore);
  assert.equal(state.metricRegistrations, metricsBefore, '재전송은 신규 delivered 사용량으로 집계하지 않는다');
});

test('같은 requestId를 다른 text 또는 cost에 재사용하면 모델 전에 409로 닫고 기존 결과를 보존한다', { concurrency: false }, async () => {
  const modelCallsBefore = state.modelCalls;
  const deductCallsBefore = state.deductCalls;
  const historiesBefore = state.historyCalls.length;
  const metricsBefore = state.metricRegistrations;
  const sameLengthDifferentText = `X${BASE_TEXT.slice(1)}`;
  assert.equal(sameLengthDifferentText.length, BASE_TEXT.length);

  const changedText = await post(sameLengthDifferentText, 'detect-success-1');
  assert.equal(changedText.status, 409);
  assert.equal(changedText.body.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(changedText.body.retryable, false);
  assert.equal(changedText.body.charged, 0);

  const changedCost = await post(`${BASE_TEXT}${BASE_TEXT}`, 'detect-success-1');
  assert.equal(changedCost.status, 409);
  assert.equal(changedCost.body.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(changedCost.body.charged, 0);
  assert.equal(state.modelCalls, modelCallsBefore);
  assert.equal(state.deductCalls, deductCallsBefore);
  assert.equal(state.historyCalls.length, historiesBefore);
  assert.equal(state.metricRegistrations, metricsBefore);
  assert.equal(state.historyDocs.get('detect-success-1').response.probability, 72);
});

test('정확한 잔액을 모두 쓴 응답 유실 재시도도 잔액 검사 전에 최초 결과를 회수한다', { concurrency: false }, async () => {
  const requestId = 'detect-exact-balance-replay-1';
  const cost = Math.ceil(BASE_TEXT.length / 100);
  state.balance = cost;
  state.modelProbability = 68;
  const first = await post(BASE_TEXT, requestId);
  assert.equal(first.status, 200);
  assert.equal(first.body.charged, cost);
  assert.equal(first.body.remainingCredits, 0);
  assert.equal(state.balance, 0);

  const modelCallsAfterFirst = state.modelCalls;
  const deductCallsAfterFirst = state.deductCalls;
  const historiesAfterFirst = state.historyCalls.length;
  state.modelProbability = 22;
  state.forceModelFailure = true;
  const replay = await post(BASE_TEXT, requestId);
  state.forceModelFailure = false;

  assert.equal(replay.status, 200);
  assert.equal(replay.body.probability, first.body.probability);
  assert.equal(replay.body.probSource, first.body.probSource);
  assert.equal(replay.body.summary, first.body.summary);
  assert.equal(replay.body.detail, first.body.detail);
  assert.equal(replay.body.charged, 0);
  assert.equal(replay.body.remainingCredits, 0);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(state.modelCalls, modelCallsAfterFirst, 'response-loss retry는 모델 호출이 0회여야 한다');
  assert.equal(state.deductCalls, deductCallsAfterFirst);
  assert.equal(state.historyCalls.length, historiesAfterFirst);
  state.balance = 100;
  state.modelProbability = 72;
});

test('모델 결과 고정 뒤 과금 commit 실패는 결과를 숨기고 같은 ID 재시도에서 모델 없이 복구한다', { concurrency: false }, async () => {
  const requestId = 'detect-billing-recovery-1';
  const historiesBefore = state.historyCalls.length;
  const metricsBefore = state.metricRegistrations;
  const deductsBefore = state.actualDeducts;
  state.forcedCommitError = Object.assign(new Error('database unavailable'), {
    code: 'FIRESTORE_UNAVAILABLE',
    status: 503
  });
  const failed = await post(BASE_TEXT, requestId);
  state.forcedCommitError = null;

  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, 'DETECT_BILLING_UNAVAILABLE');
  assert.equal(failed.body.retryable, true);
  assert.equal(failed.body.charged, 0);
  assert.equal(Object.hasOwn(failed.body, 'probability'), false);
  assert.equal(state.actualDeducts, deductsBefore);
  assert.equal(state.historyCalls.length, historiesBefore);
  assert.equal(state.metricRegistrations, metricsBefore);

  const modelCallsAfterFailure = state.modelCalls;
  const recovered = await post(BASE_TEXT, requestId);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.probability, 72);
  assert.equal(recovered.body.probSource, 'llm');
  assert.equal(recovered.body.charged, Math.ceil(BASE_TEXT.length / 100));
  assert.equal(recovered.body.idempotentReplay, true);
  assert.equal(state.modelCalls, modelCallsAfterFailure, '고정된 staged 결과를 사용해야 한다');
  assert.equal(state.actualDeducts, deductsBefore + 1);
});

test('precheck 뒤 동시 완료로 commit이 duplicate를 반환하면 charged를 0으로 정정한다', { concurrency: false }, async () => {
  const requestId = 'detect-stale-precheck-duplicate';
  const balanceBefore = state.balance;
  const deductsBefore = state.actualDeducts;
  state.forceDuplicateCommit = true;
  let result;
  try {
    result = await post(BASE_TEXT, requestId);
  } finally {
    state.forceDuplicateCommit = false;
  }
  assert.equal(result.status, 200);
  assert.equal(result.body.probability, 72);
  assert.equal(result.body.charged, 0);
  assert.equal(result.body.remainingCredits, balanceBefore);
  assert.equal(state.balance, balanceBefore);
  assert.equal(state.actualDeducts, deductsBefore);
});

test('동일 잔액의 distinct requestId 동시 요청은 한 건만 과금·전달하고 나머지는 402로 닫는다', { concurrency: false }, async () => {
  const cost = Math.ceil(BASE_TEXT.length / 100);
  state.balance = cost;
  let releaseBarrier;
  const barrierPromise = new Promise(resolve => { releaseBarrier = resolve; });
  state.precheckBarrier = {
    expected: 2,
    arrived: 0,
    promise: barrierPromise,
    resolve: releaseBarrier
  };
  const modelCallsBefore = state.modelCalls;
  const deductsBefore = state.actualDeducts;
  const historiesBefore = state.historyCalls.length;
  const metricsBefore = state.metricRegistrations;
  let results;
  try {
    results = await Promise.all([
      post(BASE_TEXT, 'detect-concurrent-a'),
      post(`Y${BASE_TEXT.slice(1)}`, 'detect-concurrent-b')
    ]);
  } finally {
    state.precheckBarrier = null;
  }

  const success = results.find(result => result.status === 200);
  const rejected = results.find(result => result.status === 402);
  assert.ok(success);
  assert.ok(rejected);
  assert.equal(success.body.charged, cost);
  assert.equal(success.body.remainingCredits, 0);
  assert.equal(rejected.body.code, 'INSUFFICIENT_CREDITS');
  assert.equal(rejected.body.retryable, true);
  assert.equal(rejected.body.charged, 0);
  assert.equal(Object.hasOwn(rejected.body, 'probability'), false);
  assert.equal(state.modelCalls, modelCallsBefore + 2, '두 요청 모두 precheck 이후 모델 단계에 진입한다');
  assert.equal(state.actualDeducts, deductsBefore + 1);
  assert.equal(state.historyCalls.length, historiesBefore + 1);
  assert.equal(state.metricRegistrations, metricsBefore + 1);
  state.balance = 100;
});

test('같은 글의 후속 모델 장애도 shadow 22~92 숫자로 대체하지 않는다', { concurrency: false }, async () => {
  const deductsBefore = state.actualDeducts;
  const historiesBefore = state.historyCalls.length;
  state.forceModelFailure = true;
  const failedRepeat = await post(BASE_TEXT, 'detect-fail-after-success');
  state.forceModelFailure = false;

  assert.equal(failedRepeat.status, 503);
  assert.equal(failedRepeat.body.code, 'DETECT_MODEL_UNAVAILABLE');
  assert.equal(Object.hasOwn(failedRepeat.body, 'probability'), false);
  assert.equal(state.actualDeducts, deductsBefore);
  assert.equal(state.historyCalls.length, historiesBefore);
});

test('차감이 없는 unlimited 내부 호환 요청은 requestId 없이도 처리한다', { concurrency: false }, async () => {
  const deductCallsBefore = state.deductCalls;
  const historiesBefore = state.historyCalls.length;
  state.billingPlan = 'unlimited';
  try {
    const result = await post(BASE_TEXT);
    assert.equal(result.status, 200);
    assert.equal(result.body.probSource, 'llm');
    assert.equal(result.body.charged, 0);
  } finally {
    state.billingPlan = 'free';
  }
  assert.equal(state.deductCalls, deductCallsBefore);
  assert.equal(state.historyCalls.length, historiesBefore + 1);
});
