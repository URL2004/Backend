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
  applyHistoryCalibration: async ({ probability }) => state.comparisonCalibration || ({
    probability: Math.round(probability),
    rawProbability: Math.round(probability),
    applied: false,
    meta: null
  })
});

stub('lib/historyService.js', {
  getDetectHistoryIdempotency: async ({ requestId, needed, requestPayloadFingerprint }) => {
    const forced = state.historyCheckHook && state.historyCheckHook(requestId);
    if (forced) return forced;
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

function readRequestJob(binding, claim) {
  const forced = state.requestReadHook && state.requestReadHook(binding.requestId);
  if (forced) return forced;
  const existing = state.requestJobs.get(binding.requestId);
  if (!existing) {
    if (!claim) return { state: 'ABSENT' };
    state.requestJobs.set(binding.requestId, { binding, state: 'PROCESSING', response: null });
    return { state: 'NEW' };
  }
  if (existing.binding.payloadFingerprint !== binding.payloadFingerprint
    || existing.binding.cost !== binding.cost) return { state: 'MISMATCH' };
  return { state: existing.state, response: existing.response,
    ...(existing.state === 'PROCESSING' ? { retryAfterMs: 4 * 60 * 1000 + 1 } : {}) };
}

stub('lib/detectRequestStore.js', {
  begin: async binding => readRequestJob(binding, true),
  lookup: async binding => readRequestJob(binding, false),
  stageResult: async (binding, response) => {
    if (state.stageHook) {
      const forced = await state.stageHook(binding, response);
      if (forced) return forced;
    }
    const existing = state.requestJobs.get(binding.requestId);
    if (!existing || existing.binding.payloadFingerprint !== binding.payloadFingerprint) {
      return { state: 'MISMATCH' };
    }
    if (['RESULT_READY', 'COMPLETE'].includes(existing.state) && existing.response) {
      return { state: existing.state, response: structuredClone(existing.response), reused: true };
    }
    existing.state = 'RESULT_READY';
    existing.response = structuredClone(response);
    return { state: 'RESULT_READY', response: structuredClone(response), reused: false };
  },
  complete: async (binding, response) => {
    if (state.completeHook) await state.completeHook(binding, response);
    const existing = state.requestJobs.get(binding.requestId);
    if (!existing || existing.binding.payloadFingerprint !== binding.payloadFingerprint) {
      return { state: 'MISMATCH' };
    }
    existing.state = 'COMPLETE';
    existing.response = response;
    return { state: 'COMPLETE', response };
  },
  recordBillingFailure: async () => {},
  STALE_PROCESSING_MS: 10 * 60 * 1000,
  releaseAfterModelFailure: async binding => {
    if (state.releaseFails) return false;
    const existing = state.requestJobs.get(binding.requestId);
    if (existing?.state === 'PROCESSING') state.requestJobs.delete(binding.requestId);
    return true;
  }
});

const rawPayloadFingerprint = require('../lib/detectResultStability').payloadFingerprint;
stub('lib/detectResultStability.js', {
  payloadFingerprint: rawPayloadFingerprint,
  variantForConfig: () => 'detect-result-stability-v1:test',
  getOrCompute: async (_input, compute) => {
    state.lastStabilityInput = _input;
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
      detectDiagnostics: {
        version: 'detect-score-diagnostics-v1',
        attempts: [{ phase: 'primary', modelScore: state.modelProbability, confidence: 'medium' }],
        recheckReason: 'none', selectedModelScore: state.modelProbability,
        evidenceAlignedScore: state.modelProbability, forbiddenText: 'diagnostic-private-sentinel'
      },
      summary: '문체 신호가 관찰됐습니다.',
      detail: '정형적인 문장 구조가 관찰됐습니다.',
      signals: ['정형적인 문장 구조'],
      ...(state.modelEvidence ? { signalEvidence: state.modelEvidence } : {}),
      confidence: 'medium',
      gptMeta: {
        selectedModel: 'gpt-test',
        engine: 'detect-test-v1',
        escalated: false
      }
    };
  },
  rewriteSentence: async opts => state.rewritePreview ? state.rewritePreview(opts) : ({ rewritten: '' })
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
  return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() };
}

const BASE_TEXT = (
  '지난 학기 팀 프로젝트에서 학생 네 명과 설문 자료를 정리했습니다. '
  + '저는 결과표의 오류 세 건을 직접 찾아 수정했고, 회의에서 확인 순서를 다시 정했습니다. '
).repeat(2);

test('report API, history input and replay retain optional statistical provenance', { concurrency: false }, async t => {
  const oldPlan = state.billingPlan;
  state.billingPlan = 'unlimited';
  t.after(() => { state.billingPlan = oldPlan; state.stabilityResult = null; });
  const assist = require('../lib/detectStatisticalAssist');
  const classifier = require('../lib/detectAssignmentClassifier');
  const first = assist.sanitizeSupport({ version: assist.VERSION, applied: true,
    originalScore: 37, score: 52, margin: 0.1, features: 300, profile: 'general' });
  const last = classifier.sanitizeAssignmentSupport({ version: classifier.VERSION, modelVersion: classifier.MODEL_VERSION,
    applied: true, basis: 'independent_statistics', originalScore: 52, score: 54, margin: 0.3,
    features: 640, profile: 'general', classifierScore: 58.4, rawClassifierScore: 58.4, threshold: 50 });
  const reference = classifier.sanitizeClassifierReference({ version: classifier.VERSION, modelVersion: classifier.MODEL_VERSION,
    basis: 'independent_statistics', scoreApplied: false, classifierScore: 50, rawClassifierScore: 49.95,
    threshold: 50, margin: -0.001, features: 640, profile: 'general' });
  for (const [suffix, metadata] of [['stages', { statisticalSupport: last, statisticalStages: [first, last] }],
    ['reference', { classifierReference: reference }]]) {
    state.stabilityResult = { probability: 54, confidence: 'medium', signalEvidence: [], ...metadata };
    const requestId = `detect-statistical-provenance-${suffix}`;
    const response = await post(BASE_TEXT, requestId);
    assert.equal(response.status, 200);
    const projected = assist.projectProvenance(metadata);
    const historyInput = state.historyCalls.find(item => item.requestId === requestId);
    for (const [key, value] of Object.entries(projected)) {
      assert.deepEqual(response.body[key], value);
      assert.deepEqual(historyInput.result[key], value);
    }
    const replay = await post(BASE_TEXT, requestId);
    assert.equal(replay.status, 200);
    for (const [key, value] of Object.entries(projected)) assert.deepEqual(replay.body[key], value);
  }
  // Other legacy tests below assert absolute mock counters.
  state.historyCalls.length = 0;
  state.historyDocs.clear();
  state.requestJobs.clear();
  state.metricRegistrations = 0;
  state.logs.length = 0;
});

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
  assert.equal(failed.retryAfter, '5');
  assert.equal(failed.body.retryAfterSeconds, 5);
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
  assert.equal(state.lastStabilityInput.payloadFingerprint, rawPayloadFingerprint({ text: BASE_TEXT, lang: 'ko', referenceContext: '' }));
  assert.notEqual(state.lastStabilityInput.payloadFingerprint, fingerprint({ opType: 'detect', needed: cost, text: BASE_TEXT }));
  assert.notEqual(result.body.idempotentReplay, true, 'fresh serialized result must not masquerade as replay');
  assert.equal(result.body.probSource, 'llm');
  assert.equal(result.body.detectorVersion, 'detect-test-v1', 'public response forwards the selected detector version');
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
  assert.equal(state.historyCalls[0].result.detectDiagnostics.attempts[0].modelScore, 72);
  assert.equal(JSON.stringify(state.historyCalls[0].result.detectDiagnostics).includes('diagnostic-private-sentinel'), false);
  assert.equal(Object.hasOwn(result.body, 'detectDiagnostics'), false);
  assert.equal(state.historyCalls[0].result.gptMeta.detectPromptVersion, 'detect-prompt-test-v1');
  assert.equal(state.historyCalls[0].result.gptMeta.detectCacheHit, false);
  assert.equal(state.metricRegistrations, 1);

  const delivered = state.logs.find(item => item.event === 'detect_report.score_outcome'
    && item.fields.outcome === 'delivered');
  assert.ok(delivered);
  assert.equal(delivered.fields.scoreSource, 'llm');
  assert.equal(delivered.fields.probability, 72);
  assert.equal(delivered.fields.detectDiagnostics.attempts[0].modelScore, 72);
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
    statisticalSupport: {
      version: 'statistical-assist-v1', applied: true, originalScore: 32, score: 61,
      margin: 0.45, features: 300, profile: 'general', rawText: 'statistics-private-sentinel'
    },
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
  assert.equal(Object.hasOwn(result.body, 'statisticalSupport'), false);
  assert.match(result.body.reportView.styleSignal.sourceLabel, /문체 통계/);
  assert.equal(state.historyCalls.at(-1).result.statisticalSupport.originalScore, 32);
  assert.equal(JSON.stringify(state.historyCalls.at(-1).result.statisticalSupport).includes('statistics-private-sentinel'), false);
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
  assert.equal(delivered.fields.statisticalSupport.originalScore, 32);
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
  assert.equal(failed.retryAfter, '5');
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

test('fast scoring does not drop a slower valid before/after conversion preview', { concurrency: false }, async () => {
  state.rewritePreview=async ({text})=>{await new Promise(resolve=>setTimeout(resolve,30));return {rewritten:text.replace('핵심 요소라고 할 수 있습니다','핵심 요소로 꼽힙니다')};};
  try {
    const response=await post('현대 사회에서 협업의 중요성은 조직의 지속적인 성장과 안정적인 운영을 위해 반드시 고려해야 하는 핵심 요소라고 할 수 있습니다. '+BASE_TEXT,'detect-preview-after-fast-score');
    assert.equal(response.status,200);assert.equal(response.body.exampleStatus,'ready');
    assert.equal(response.body.example.meaningfulChange,true);
    assert.equal(response.body.example.afterAnchor,'changed');
  } finally {delete state.rewritePreview;}
});

test('report HTTP response signs the final comparison for exact-source backup and replay', { concurrency: false }, async t => {
  const previousSalt = process.env.OPENAI_SAFETY_SALT, previousPlan = state.billingPlan;
  process.env.OPENAI_SAFETY_SALT = 'synthetic-report-comparison-proof-key-long-enough';
  const comparison = { version: 'humanize-comparison-v1', basis: 'history_adjusted_style', sourceProbability: 70,
    rawProbability: 72, probability: 61, rawDelta: 2, adjustedDelta: -9, adjustment: -11,
    calibrationApplied: true, match: 'exact_normalized', status: 'improved' };
  state.comparisonCalibration = { probability: 61, rawProbability: 72, applied: true,
    meta: { applied: true, sourceProbability: 70, sourceCapApplied: false }, comparison };
  state.billingPlan = 'unlimited';
  t.after(() => {
    delete state.comparisonCalibration; state.billingPlan = previousPlan;
    if (previousSalt === undefined) delete process.env.OPENAI_SAFETY_SALT; else process.env.OPENAI_SAFETY_SALT = previousSalt;
  });
  const inputText = `\r\n ${BASE_TEXT} \r\n`, requestId = 'detect-signed-comparison-report';
  const response = await post(inputText, requestId);
  assert.equal(response.status, 200);
  assert.equal(response.body.probability, 61);
  assert.deepEqual(response.body.historyComparison, comparison);
  const { verifiedBackupHistoryComparison } = require('../lib/detectHistoryComparison');
  const backup = { inputText, probability: response.body.probability,
    historyComparison: response.body.historyComparison, historyComparisonProof: response.body.historyComparisonProof };
  assert.deepEqual(verifiedBackupHistoryComparison('detect-policy-user', backup), comparison);
  assert.equal(verifiedBackupHistoryComparison('other-user', backup), null);
  assert.equal(verifiedBackupHistoryComparison('detect-policy-user', { ...backup, inputText: inputText.trim() }), null);
  const replay = await post(inputText, requestId);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.historyComparisonProof, response.body.historyComparisonProof);
});

test('report HTTP and paid replay keep cause clicks in the display namespace', { concurrency: false }, async t => {
  const previousPlan = state.billingPlan, previousScore = state.modelProbability;
  state.billingPlan = 'unlimited'; state.modelProbability = 32;
  t.after(() => { delete state.modelEvidence; state.billingPlan = previousPlan; state.modelProbability = previousScore; });
  const text = '"기록을 바탕으로 점검하는 사람"\n작은 변화도 기록하는 습관이 저의 장점입니다.\n지난 실습에서는 매일 관측 결과를 기록하고 담당자와 비교했습니다.\n동료들에게 확인 순서를 설명하고 다음 실습에도 같은 점검 절차를 적용했습니다.';
  state.modelEvidence = require('../lib/detectGrounding').groundSignals([
    {category:'formulaic_transition',strength:'moderate',scope:'recurring',evidenceSentences:[1,2]}
  ], text.trim());
  const modelIds = state.modelEvidence[0].locations.map(l => l.sentenceIndex);
  const response = await post(text, 'detect-display-locations-http');
  assert.equal(response.status, 200);
  assert.equal(response.body.probability, 32);
  const locations = response.body.reportView.causeAnalysis.items[0].locations;
  assert.ok(locations.length);
  assert.notDeepEqual(locations.map(l => l.sentenceIndex), modelIds, 'heading split changes UI IDs');
  for (const loc of locations) {
    const mark = response.body.sentenceMap.sentences.find(m => m.index === loc.sentenceIndex);
    assert.equal(loc.paragraphIndex, mark.paragraph);
    assert.ok(loc.start >= mark.start && loc.end <= mark.end);
  }
  assert.equal(Object.hasOwn(response.body.sentenceMap, 'sourceLocations'), false);
  const replay = await post(text, 'detect-display-locations-http');
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.reportView.causeAnalysis.items[0].locations, locations);
});

test('report and replay separate an isolated ending from rewriting while retaining the calibrated score', { concurrency: false }, async t => {
  const previousPlan = state.billingPlan, previousScore = state.modelProbability;
  state.billingPlan = 'unlimited'; state.modelProbability = 18; state.stabilityResult = null;
  state.comparisonCalibration = { probability: 11, rawProbability: 18, applied: true,
    meta: { applied: true, rawProbability: 18, calibratedProbability: 11, match: 'exact_normalized' } };
  t.after(() => { delete state.modelEvidence; delete state.comparisonCalibration;
    state.billingPlan = previousPlan; state.modelProbability = previousScore; state.stabilityResult = null; });
  const text = '자료실에서 제공한 첫 기록을 차례로 읽었다. 서로 다른 분류 기준을 옆에 적었다. '
    + '다음 기록에서도 같은 항목이 있는지 확인했다. 종이에 표시한 부분을 다시 비교했다. '
    + '마지막으로 확인할 질문을 별도 문서에 정리했다. 입니다.';
  const doc = require('../lib/detectInputDocument').buildDetectInputDocument(text);
  const index = doc.sentences.findIndex(s => s.text === '입니다.');
  const fragment = doc.sentences[index];
  assert.ok(index >= 0);
  state.modelEvidence = [{ category: 'other_observed_style', strength: 'weak', scope: 'isolated',
    description: '문체 관찰', locationStatus: 'source_range_verified',
    locations: [{ sentenceIndex: index, start: fragment.start, end: fragment.end }] }];
  const response = await post(text, 'audit-fragment-response');
  assert.equal(response.status, 200);
  assert.equal(response.body.probability, 11);
  assert.equal(response.body.rawProbability, 18);
  assert.equal(response.body.reportView.conversion.candidateSentences, 0);
  assert.equal(response.body.reportView.conversion.recommend, false);
  assert.match(response.body.interpretation.nextSteps[0], /문장 조각/);
  const replay = await post(text, 'audit-fragment-response');
  assert.equal(replay.body.probability, 11);
  assert.deepEqual(replay.body.reportView.conversion, response.body.reportView.conversion);
});

test('결과 고정 단계가 예외를 던져도 즉시 미차감 503으로 끝내고 PROCESSING claim을 푼다', { concurrency: false }, async () => {
  const requestId = 'detect-stage-throws-1';
  const deductsBefore = state.actualDeducts;
  const historiesBefore = state.historyCalls.length;
  state.stageHook = async () => { throw new Error('synthetic stage failure'); };
  let failed;
  try {
    failed = await post(BASE_TEXT, requestId);
  } finally {
    state.stageHook = null;
  }
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, 'DETECT_REPORT_UNAVAILABLE');
  assert.equal(failed.body.retryable, true);
  assert.equal(failed.body.charged, 0);
  assert.equal(Object.hasOwn(failed.body, 'probability'), false);
  assert.equal(state.actualDeducts, deductsBefore);
  assert.equal(state.historyCalls.length, historiesBefore);
  assert.equal(state.requestJobs.has(requestId), false, 'PROCESSING claim이 남으면 재시도가 202에 갇힌다');
  assert.ok(state.logs.some(row => row.event === 'detect_report.unhandled_failure' && row.fields.billed === false));

  const recovered = await post(BASE_TEXT, requestId);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.charged, Math.ceil(BASE_TEXT.length / 100));
  assert.equal(state.actualDeducts, deductsBefore + 1);
});

test('저장 한도를 넘는 결과는 재시도 불가 422로 닫고 차감·이력·claim을 남기지 않는다', { concurrency: false }, async () => {
  const requestId = 'detect-stage-too-large-1';
  const deductsBefore = state.actualDeducts;
  const historiesBefore = state.historyCalls.length;
  state.stageHook = async () => ({ state: 'TOO_LARGE', code: 'DETECT_RESPONSE_CACHE_TOO_LARGE' });
  let failed;
  try {
    failed = await post(BASE_TEXT, requestId);
  } finally {
    state.stageHook = null;
  }
  assert.equal(failed.status, 422);
  assert.equal(failed.body.code, 'DETECT_RESULT_TOO_LARGE');
  assert.equal(failed.body.retryable, false);
  assert.equal(failed.body.charged, 0);
  assert.equal(Object.hasOwn(failed.body, 'probability'), false);
  assert.equal(state.actualDeducts, deductsBefore);
  assert.equal(state.historyCalls.length, historiesBefore);
  assert.equal(state.requestJobs.has(requestId), false);
});

test('차감 뒤 완료 기록이 예외를 던져도 결제된 결과를 전달하고 재시도는 추가 차감 없이 같은 결과다', { concurrency: false }, async () => {
  const requestId = 'detect-complete-throws-1';
  const cost = Math.ceil(BASE_TEXT.length / 100);
  const deductsBefore = state.actualDeducts;
  const balanceBefore = state.balance;
  state.completeHook = async () => { throw new Error('synthetic complete failure'); };
  let delivered;
  try {
    delivered = await post(BASE_TEXT, requestId);
  } finally {
    state.completeHook = null;
  }
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.ok, true);
  assert.equal(delivered.body.probability, 72);
  assert.equal(delivered.body.charged, cost);
  assert.equal(delivered.body.remainingCredits, balanceBefore - cost);
  assert.equal(state.actualDeducts, deductsBefore + 1);
  assert.ok(state.logs.some(row => row.event === 'detect_report.unhandled_failure' && row.fields.billed === true));

  const modelCalls = state.modelCalls;
  const replay = await post(BASE_TEXT, requestId);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.probability, delivered.body.probability);
  assert.equal(replay.body.charged, 0);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.remainingCredits, balanceBefore - cost);
  assert.deepEqual(replay.body.reportView, delivered.body.reportView);
  assert.equal(state.actualDeducts, deductsBefore + 1, '재시도가 다시 차감하면 안 된다');
  assert.equal(state.modelCalls, modelCalls);
});

test('차감 뒤 이력 저장이 예외여도 결과를 전달하고 완료 상태를 남긴다', { concurrency: false }, async () => {
  const requestId = 'detect-history-throws-1';
  const cost = Math.ceil(BASE_TEXT.length / 100);
  const deductsBefore = state.actualDeducts;
  const historyService = require('../lib/historyService');
  const originalSave = historyService.saveAnalyzeHistory;
  historyService.saveAnalyzeHistory = async () => {
    throw Object.assign(new Error('DETECT_RESPONSE_CACHE_TOO_LARGE'), { code: 'DETECT_RESPONSE_CACHE_TOO_LARGE' });
  };
  let delivered;
  try {
    delivered = await post(BASE_TEXT, requestId);
  } finally {
    historyService.saveAnalyzeHistory = originalSave;
  }
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.charged, cost);
  assert.equal(delivered.body.historySaved, false);
  assert.equal(state.actualDeducts, deductsBefore + 1);
  assert.equal(state.requestJobs.get(requestId).state, 'COMPLETE');

  const replay = await post(BASE_TEXT, requestId);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.charged, 0);
  assert.equal(state.actualDeducts, deductsBefore + 1);
});

test('저장소 장애로 claim도 못 풀면 남는 처리 상태와 대기 시간을 알리고 이후 202와 일관되게 답한다', { concurrency: false }, async () => {
  const requestId = 'detect-stage-db-outage-1';
  const deductsBefore = state.actualDeducts;
  state.stageHook = async () => ({ state: 'UNAVAILABLE' });
  state.releaseFails = true;
  let failed;
  let raw;
  try {
    raw = await fetch(`${baseUrl}/detect-report`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ text: BASE_TEXT, requestId })
    });
    failed = { status: raw.status, body: await raw.json() };
  } finally {
    state.stageHook = null;
    state.releaseFails = false;
  }
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, 'IDEMPOTENCY_CACHE_UNAVAILABLE');
  assert.equal(failed.body.claimReleased, false);
  assert.equal(failed.body.retryAfterSeconds, 600);
  assert.equal(raw.headers.get('retry-after'), '600');
  assert.equal(failed.body.charged, 0);
  assert.match(failed.body.error, /처리 상태도 정리하지 못했어요/u);
  assert.equal(state.actualDeducts, deductsBefore);

  const modelCalls = state.modelCalls;
  const pending = await post(BASE_TEXT, requestId);
  assert.equal(pending.status, 202);
  assert.equal(pending.body.code, 'DETECT_REQUEST_PROCESSING');
  assert.equal(pending.body.retryAfterSeconds, 241);
  assert.equal(pending.body.charged, 0);
  assert.equal(state.modelCalls, modelCalls);
  assert.equal(state.actualDeducts, deductsBefore);
  state.requestJobs.delete(requestId);
});

test('30,000자 초과 입력은 모델·차감 전에 INPUT_TOO_LONG으로 닫는다', { concurrency: false }, async () => {
  const modelCalls = state.modelCalls;
  const deductsBefore = state.actualDeducts;
  const result = await post('가'.repeat(30001), 'detect-input-too-long-1');
  assert.equal(result.status, 400);
  assert.deepEqual({ ok: result.body.ok, code: result.body.code, limit: result.body.limit,
    actual: result.body.actual, charged: result.body.charged },
  { ok: false, code: 'INPUT_TOO_LONG', limit: 30000, actual: 30001, charged: 0 });
  assert.equal(state.modelCalls, modelCalls);
  assert.equal(state.actualDeducts, deductsBefore);
});

test('차감이 확정됐는데 전달할 결과가 없으면 차감이 없었다고 말하지 않는다', { concurrency: false }, async () => {
  const sent = {};
  const res = { headersSent: false, set(name, value) { sent[name] = value; }, status(code) { sent.status = code; return this; }, json(body) { sent.body = body; return this; } };
  await report.failDetectReportSafely(res, {
    uid: 'detect-policy-user', requestId: 'detect-billed-no-body-1', cost: 3, billed: true, claimed: true,
    requestBinding: { requestId: 'detect-billed-no-body-1' }, deliverable: () => null
  }, new Error('synthetic post-billing failure'));
  assert.equal(sent.status, 503);
  assert.equal(sent.body.code, 'DETECT_DELIVERY_UNCONFIRMED');
  assert.equal(sent.body.billingCommitted, true);
  assert.equal(sent.body.retryable, true);
  assert.equal(sent['Retry-After'], '5');
  assert.equal(Object.hasOwn(sent.body, 'charged'), false);
  assert.doesNotMatch(sent.body.error, /차감되지 않았/u);

  const already = { headersSent: true, json() { throw new Error('must not write twice'); } };
  await report.failDetectReportSafely(already, { billed: false }, new Error('late'));
});

// ── 재시도 경로: 확정 상태와 일시 장애의 구분 ──

async function chargedOnce(requestId) {
  const first = await post(BASE_TEXT, requestId);
  assert.equal(first.status, 200);
  assert.equal(first.body.charged, Math.ceil(BASE_TEXT.length / 100));
  return first;
}

function counters() {
  return { model: state.modelCalls, deducts: state.actualDeducts, deductCalls: state.deductCalls,
    histories: state.historyCalls.length, balance: state.balance, metrics: state.metricRegistrations };
}

test('차감이 확정됐는데 요청 캐시와 이력 보관본이 모두 없으면 재분석·재차감 없이 재시도 불가로 닫는다', { concurrency: false }, async () => {
  const requestId = 'detect-charged-expired-1';
  await chargedOnce(requestId);
  // 요청 캐시 TTL 삭제 + 이력 미저장(또는 사용자 삭제) 상태.
  state.requestJobs.delete(requestId);
  state.historyDocs.delete(requestId);
  const before = counters();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const gone = await post(BASE_TEXT, requestId);
    assert.equal(gone.status, 410);
    assert.deepEqual(gone.body, {
      ok: false,
      code: 'DETECT_RESULT_NO_LONGER_AVAILABLE',
      error: '이 작업 번호의 감지는 이미 크레딧이 차감됐지만, 보관된 결과를 더 이상 읽을 수 없어 다시 전달할 수 없어요. '
        + '같은 작업 번호로 다시 시도해도 결과는 돌아오지 않고 추가 차감도 없어요. '
        + '다시 분석하려면 새 작업으로 시작해 주세요. 새 분석은 크레딧이 차감돼요.',
      retryable: false,
      billingCommitted: true,
      charged: 0,
      cost: Math.ceil(BASE_TEXT.length / 100)
    });
    assert.equal(gone.retryAfter, null, '재시도 불가 응답에 대기 시간을 싣지 않는다');
    assert.equal(state.requestJobs.has(requestId), false, '처리 상태를 새로 잡으면 다음 재시도가 202에 갇힌다');
  }
  assert.deepEqual(counters(), before, '모델·원장·이력·사용량 어느 것도 다시 호출하지 않는다');
  const logged = state.logs.filter(row => row.event === 'detect_report.charged_result_unrecoverable'
    && row.fields.requestId === requestId);
  assert.equal(logged.length, 2);
  assert.deepEqual([logged[0].fields.historyState, logged[0].fields.requestState], ['NOT_FOUND', 'ABSENT']);
});

test('같은 차감 확정 상태라도 저장소 일시 장애는 재시도 가능 503이고, 복구 뒤 같은 결과를 추가 차감 없이 받는다', { concurrency: false }, async () => {
  const requestId = 'detect-charged-outage-1';
  const first = await chargedOnce(requestId);
  const savedHistory = state.historyDocs.get(requestId);
  const before = counters();

  // 이력 저장소 읽기 실패: 결과가 없는지 알 수 없으므로 확정 상태로 닫지 않는다.
  state.historyCheckHook = () => ({ state: 'UNAVAILABLE', error: new Error('synthetic history outage') });
  let outage;
  try { outage = await post(BASE_TEXT, requestId); } finally { state.historyCheckHook = null; }
  assert.equal(outage.status, 503);
  assert.equal(outage.body.code, 'IDEMPOTENCY_CHECK_UNAVAILABLE');
  assert.equal(outage.body.retryable, true);
  assert.equal(outage.retryAfter, '5');
  assert.equal(outage.body.retryAfterSeconds, 5);

  // 이력에는 없고 요청 캐시 저장소를 읽지 못한 경우도 같다.
  state.historyDocs.delete(requestId);
  state.requestReadHook = () => ({ state: 'UNAVAILABLE' });
  try { outage = await post(BASE_TEXT, requestId); } finally { state.requestReadHook = null; }
  assert.equal(outage.status, 503);
  assert.equal(outage.body.code, 'IDEMPOTENCY_CHECK_UNAVAILABLE');
  assert.equal(outage.body.retryable, true);
  assert.equal(outage.retryAfter, '5');
  assert.deepEqual(counters(), before);
  assert.equal(state.logs.some(row => row.event === 'detect_report.charged_result_unrecoverable'
    && row.fields.requestId === requestId), false);

  state.historyDocs.set(requestId, savedHistory);
  const recovered = await post(BASE_TEXT, requestId);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.probability, first.body.probability);
  assert.deepEqual(recovered.body.reportView, first.body.reportView);
  assert.equal(recovered.body.charged, 0);
  assert.equal(state.actualDeducts, before.deducts);
  assert.equal(state.modelCalls, before.model);
});

test('손상된 이력 보관본은 온전한 요청 캐시 replay를 막지 않고, 캐시도 없을 때만 확정 상태로 닫는다', { concurrency: false }, async () => {
  const requestId = 'detect-history-corrupt-1';
  const first = await chargedOnce(requestId);
  assert.equal(first.body.historySaved, true);
  const before = counters();
  const unreadable = () => ({ state: 'UNREADABLE', error: Object.assign(new Error('x'), { code: 'DETECT_RESPONSE_CACHE_INVALID' }) });

  // 이력 row는 있지만 보관본을 읽을 수 없다. 저장 단계는 같은 결과로 보관본을 다시 채운다.
  state.historyDocs.delete(requestId);
  state.historyCheckHook = unreadable;
  let replay;
  try { replay = await post(BASE_TEXT, requestId); } finally { state.historyCheckHook = null; }
  assert.equal(replay.status, 200);
  assert.equal(replay.body.probability, first.body.probability);
  assert.equal(replay.body.summary, first.body.summary);
  assert.deepEqual(replay.body.reportView, first.body.reportView);
  assert.deepEqual(replay.body.sentenceMap, first.body.sentenceMap);
  assert.equal(replay.body.charged, 0);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.historySaved, true);
  assert.equal(state.modelCalls, before.model);
  assert.equal(state.actualDeducts, before.deducts);
  assert.equal(state.historyDocs.get(requestId).response.probability, first.body.probability);

  // 응답 형태가 아닌 READY 보관본도 같은 취급이다(이전에는 영구 503).
  state.historyCheckHook = () => ({ state: 'READY', response: { ok: true, probability: 'not-a-number' } });
  try { replay = await post(BASE_TEXT, requestId); } finally { state.historyCheckHook = null; }
  assert.equal(replay.status, 200);
  assert.equal(replay.body.probability, first.body.probability);
  assert.equal(replay.body.charged, 0);

  // 요청 캐시까지 없으면 다시 시도해도 달라지지 않는다.
  state.requestJobs.delete(requestId);
  state.historyCheckHook = unreadable;
  let gone;
  try { gone = await post(BASE_TEXT, requestId); } finally { state.historyCheckHook = null; }
  assert.equal(gone.status, 410);
  assert.equal(gone.body.code, 'DETECT_RESULT_NO_LONGER_AVAILABLE');
  assert.equal(gone.body.retryable, false);
  assert.equal(state.modelCalls, before.model);
  assert.equal(state.actualDeducts, before.deducts);
});

test('읽을 수 없는 요청 캐시는 저장소 장애가 아니라 재시도 불가로 닫고 차감 여부를 사실대로 말한다', { concurrency: false }, async () => {
  const corrupt = () => ({ state: 'CORRUPT' });
  const before = counters();

  state.requestReadHook = corrupt;
  let unbilled;
  try { unbilled = await post(BASE_TEXT, 'detect-cache-corrupt-unbilled-1'); } finally { state.requestReadHook = null; }
  assert.equal(unbilled.status, 409);
  assert.equal(unbilled.body.code, 'DETECT_REQUEST_UNRECOVERABLE');
  assert.equal(unbilled.body.retryable, false);
  assert.equal(unbilled.body.charged, 0);
  assert.match(unbilled.body.error, /차감되지 않았어요/u);
  assert.equal(Object.hasOwn(unbilled.body, 'billingCommitted'), false);
  assert.deepEqual(counters(), before);

  // 형태가 맞지 않는 고정 결과도 같다.
  const requestId = 'detect-cache-corrupt-billed-1';
  await chargedOnce(requestId);
  state.historyDocs.delete(requestId);
  state.requestJobs.get(requestId).response = { publicResponse: { ok: true } };
  const billed = await post(BASE_TEXT, requestId);
  assert.equal(billed.status, 410);
  assert.equal(billed.body.code, 'DETECT_RESULT_NO_LONGER_AVAILABLE');
  assert.equal(billed.body.billingCommitted, true);
  assert.doesNotMatch(billed.body.error, /차감되지 않았/u);
  assert.equal(state.actualDeducts, before.deducts + 1);
  state.requestJobs.delete(requestId);
});

test('요청 캐시 replay의 historySaved는 그 시점의 실제 이력 저장 결과이고 점수·보고서는 그대로다', { concurrency: false }, async () => {
  const requestId = 'detect-replay-history-truth-1';
  const historyService = require('../lib/historyService');
  const originalSave = historyService.saveAnalyzeHistory;
  const failingSave = async () => { throw new Error('synthetic history outage'); };

  historyService.saveAnalyzeHistory = failingSave;
  let first;
  let stillFailing;
  try {
    first = await post(BASE_TEXT, requestId);
    stillFailing = await post(BASE_TEXT, requestId);
  } finally {
    historyService.saveAnalyzeHistory = originalSave;
  }
  assert.equal(first.status, 200);
  assert.equal(first.body.historySaved, false);
  assert.equal(stillFailing.status, 200);
  assert.equal(stillFailing.body.historySaved, false, '저장되지 않았는데 저장됐다고 답하면 안 된다');
  assert.equal(state.historyDocs.has(requestId), false);
  const after = counters();

  // 완료 row에는 historySaved:false가 고정돼 있지만, replay는 이번에 실제로 저장된 사실을 말한다.
  const saved = await post(BASE_TEXT, requestId);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.historySaved, true);
  assert.equal(saved.body.charged, 0);
  assert.equal(saved.body.idempotentReplay, true);
  assert.equal(state.historyDocs.get(requestId).response.historySaved, true);
  for (const reply of [stillFailing, saved]) {
    const { historySaved, charged, idempotentReplay, remainingCredits, activation, ...rest } = reply.body;
    const { historySaved: h0, charged: c0, idempotentReplay: i0, remainingCredits: r0, activation: a0, ...original } = first.body;
    assert.deepEqual(rest, original, '저장 여부 외의 점수·문구·좌표는 최초 응답과 같아야 한다');
  }

  const fromHistory = await post(BASE_TEXT, requestId);
  assert.equal(fromHistory.body.historySaved, true);
  assert.equal(fromHistory.body.probability, first.body.probability);
  assert.equal(state.modelCalls, after.model);
  assert.equal(state.actualDeducts, after.deducts);
});
