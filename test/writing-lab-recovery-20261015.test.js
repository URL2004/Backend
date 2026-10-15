'use strict';

// engine-deep-audit-20261015 W1 / W2 / W4: writing-lab repair outages,
// deterministic-violation repair on the real default path, and verifier
// outage vs semantic rejection. Synthetic inputs; the provider is stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.WRITING_LAB_CONTEXT_SECRET ||= 'writing-lab-test-secret-with-enough-entropy';
const { logger } = require('../lib/logger');
logger.info = () => {};
logger.warn = () => {};

const engine = require('../engine-writing-v1');
const {
  repairDeterministicViolations,
  immutableLedger,
  isDeterministicViolation
} = require('../engine-writing-v1/writingRepair');
const { installOpenAIStub, failure, writerResult, jsonAfter } = require('./helpers/writing-openai-stub.cjs');

function reviewInput(overrides = {}) {
  return {
    genre: 'review_blog',
    subtype: 'place_visit',
    answers: {
      subject: '원종동의 카페를 방문했어요.',
      spending: '총 30,000원을 결제했어요.',
      ...(overrides.answers || {})
    },
    targetChars: overrides.targetChars ?? 800,
    charLimitMode: overrides.charLimitMode || 'with_space',
    tone: 'friendly'
  };
}

const SAFE = '원종동의 카페를 방문했어요. 이번 방문에서 결제한 금액은 총 30,000원이었어요.';
const SHORT = '원종동 카페에서 3만원 결제.';
const RELATION_FINDING = {
  type: 'distortion', span: '이번 방문에서', detail: '방문 범위를 새로 한정했어요.',
  sourceSpan: '총 30,000원을 결제했어요.', candidateSpan: '이번 방문에서 결제한 금액은 총 30,000원이었어요.',
  relation: 'other', origin: 'introduced'
};
const structured = text => writerResult(text);

function finalizeContext(overrides = {}) {
  const prepared = engine.prepare(reviewInput({ targetChars: 60 }));
  return {
    prepared,
    context: {
      input: prepared.input, ledger: prepared.ledger, policy: prepared.policy,
      usedFactIds: prepared.ledger.facts.map(fact => fact.id), targetChars: 60,
      safeDraft: '원종동의 한 카페를 방문해 카페를 이용했으며, 해당 방문에서 결제한 전체 금액은 모두 합해 3만원이었어요.',
      safeDraftRelease: 'semantic_consensus_v1',
      ...overrides
    }
  };
}

// ── W1 ───────────────────────────────────────────────────────────────

for (const [label, error, failureClass] of [
  ['503', Object.assign(new Error('OpenAI Responses API 503: busy'), { status: 503 }), 'openai_server_error'],
  ['429', Object.assign(new Error('OpenAI Responses API 429: Rate limit'), { status: 429 }), 'openai_rate_limited'],
  ['timeout', Object.assign(new Error('OpenAI Responses API request timed out after 60000ms'), { code: 'ETIMEDOUT' }), 'openai_timeout']
]) {
  test(`W1: a ${label} semantic-repair failure in generate continues to the safe deterministic projection`, async () => {
    let writerCalls = 0;
    const result = await engine.generate(reviewInput(), {
      shortMode: true,
      callWriter: async () => { writerCalls += 1; return structured(SAFE); },
      semanticVerify: async () => ({ pass: false, violations: [{ type: 'distortion', span: '이번 방문에서', spanVerified: true }] }),
      semanticRepair: async () => { throw error; }
    });
    assert.equal(result.release.pass, true);
    assert.equal(result.semantic.deterministicProjection, true);
    assert.equal(writerCalls, 2, 'the remaining writer attempt is still used');
    const outage = result.attempts.find(item => item.stage === 'semantic_repair_1_1_unavailable');
    assert.ok(outage, 'the outage is recorded, not thrown');
    assert.deepEqual(outage.reasons, ['repair_unavailable']);
    assert.equal(outage.failureClass, failureClass);
    assert.equal(result.attempts.at(-1).stage, 'deterministic_projection');
  });
}

test('W1: after a repair outage the next writer attempt can still deliver a model-verified draft', async () => {
  let writerCalls = 0;
  const result = await engine.generate(reviewInput(), {
    shortMode: true,
    callWriter: async () => structured(++writerCalls === 1 ? SAFE.replace('이번 방문에서', '그날') : SAFE),
    semanticVerify: async ({ text }) => text.includes('그날')
      ? { pass: false, violations: [{ type: 'distortion', span: '그날', spanVerified: true }] }
      : { pass: true, violations: [] },
    semanticRepair: async () => { throw Object.assign(new Error('busy'), { status: 503 }); }
  });
  assert.equal(result.release.pass, true);
  assert.notEqual(result.semantic.deterministicProjection, true);
  assert.deepEqual(result.attempts.map(item => item.stage), ['draft', 'semantic_repair_1_1_unavailable', 'repair_1']);
});

test('W1: when no safe alternative passes, generate fails closed with a controlled no-charge error', async () => {
  await assert.rejects(engine.generate(reviewInput(), {
    shortMode: true,
    deterministicProjection: false,
    callWriter: async () => structured(SAFE),
    semanticVerify: async () => ({ pass: false, violations: [{ type: 'distortion', span: '이번 방문에서', spanVerified: true }] }),
    semanticRepair: async () => { throw Object.assign(new Error('busy'), { status: 503 }); }
  }), error => {
    assert.ok(error instanceof engine.WritingEngineError);
    assert.equal(error.code, 'DRAFT_VERIFICATION_FAILED');
    assert.equal(error.status, 422);
    assert.equal(error.details.fallbackReason, 'semantic_rejected');
    assert.ok(error.details.attempts.some(item => item.stage.endsWith('_unavailable')));
    return true;
  });
});

test('W1: quota exhaustion stops further model steps and keeps the quota message when no projection exists', async () => {
  let writerCalls = 0;
  const quota = Object.assign(new Error('You exceeded your current quota'), { code: 'OPENAI_QUOTA_EXHAUSTED', status: 429 });
  const options = {
    shortMode: true,
    callWriter: async () => { writerCalls += 1; return structured(SAFE); },
    semanticVerify: async () => ({ pass: false, violations: [{ type: 'distortion', span: '이번 방문에서', spanVerified: true }] }),
    semanticRepair: async () => { throw quota; }
  };
  const projected = await engine.generate(reviewInput(), options);
  assert.equal(writerCalls, 1, 'no second writer call after quota exhaustion');
  assert.equal(projected.semantic.deterministicProjection, true);

  await assert.rejects(engine.generate(reviewInput(), { ...options, deterministicProjection: false }), error => {
    assert.ok(error instanceof engine.WritingEngineError);
    assert.equal(error.code, 'OPENAI_QUOTA_EXHAUSTED');
    return true;
  });
});

test('W1: the real default semantic repair path survives a provider 5xx inside generate', async t => {
  const stub = installOpenAIStub(t, {
    writing_engine_v1_result: () => structured(SAFE),
    gpt_prod_semantic_judge: () => ({ violations: [RELATION_FINDING] }),
    gpt_prod_relation_patch: () => failure(503, 'busy')
  });
  const result = await engine.generate(reviewInput(), { shortMode: true });
  assert.equal(result.release.pass, true);
  assert.equal(result.semantic.deterministicProjection, true);
  const outages = result.attempts.filter(item => item.stage.endsWith('_unavailable'));
  assert.equal(outages.length, 2);
  assert.ok(outages.every(item => item.failureClass === 'openai_server_error'));
  // The grounded finding reached the real relation-patch request (1 + 2 server retries per attempt).
  assert.equal(stub.bySchema('gpt_prod_relation_patch').length, 6);
});

// ── W2 ───────────────────────────────────────────────────────────────

test('W2: a length-only violation reaches the writing repair on the real default generate path and is re-validated', async t => {
  const stub = installOpenAIStub(t, {
    writing_engine_v1_result: () => structured(SHORT),
    writing_engine_v1_repair: () => ({ outputText: SAFE, notes: ['length'] })
  });
  const result = await engine.generate(reviewInput(), { shortMode: true });
  assert.equal(result.release.pass, true);
  assert.notEqual(result.semantic.deterministicProjection, true);
  assert.equal(result.draft, SAFE);
  assert.deepEqual(result.attempts.map(item => item.stage), ['draft', 'semantic_repair_1_1']);
  assert.deepEqual(stub.calls.map(call => call.schemaName),
    ['writing_engine_v1_result', 'writing_engine_v1_repair', 'gpt_prod_semantic_judge', 'gpt_prod_semantic_judge']);
  const repairRequest = stub.bySchema('writing_engine_v1_repair')[0].userText;
  assert.match(repairRequest, /FACT_LEDGER/u);
  assert.match(repairRequest, /30,000원/u);
  assert.equal(jsonAfter(repairRequest, '[REPAIR_TARGETS]').length.direction, 'expand');
});

test('W2: finalize repairs over-length humanized text through the default repair and re-verifies it', async t => {
  const { context } = finalizeContext();
  const tooLong = `${context.safeDraft} 원종동의 카페를 방문했고 해당 방문에서 결제한 금액은 모두 합해 3만원이었어요.`;
  const repaired = '원종동의 한 카페를 방문해 카페를 이용했으며, 이번 방문에서 결제한 전체 금액은 모두 합해 3만원이었어요.';
  const stub = installOpenAIStub(t, {
    writing_engine_v1_repair: () => ({ outputText: repaired, notes: ['shorten'] })
  });
  const result = await engine.finalizeExisting(tooLong, context);
  assert.equal(result.delivery.source, 'humanized_repaired');
  assert.equal(result.text, repaired);
  assert.equal(result.release.pass, true);
  assert.equal(jsonAfter(stub.bySchema('writing_engine_v1_repair')[0].userText, '[REPAIR_TARGETS]').length.direction, 'shorten');
  assert.equal(stub.bySchema('gpt_prod_semantic_judge').length, 2, 'repaired text receives verdict + confirmation');
});

for (const token of ['3억원', '1,234,567원']) {
  test(`W2: unsupported number ${token} reaches the same writing repair regardless of token length`, async t => {
    const { context } = finalizeContext();
    const humanized = `원종동의 한 카페를 방문해 카페를 이용했으며, 그날 결제한 전체 금액은 모두 합해 ${token}이었어요.`;
    const fixed = '원종동의 한 카페를 방문해 카페를 이용했으며, 그날 결제한 전체 금액은 모두 합해 3만원이었어요.';
    const stub = installOpenAIStub(t, { writing_engine_v1_repair: () => ({ outputText: fixed, notes: ['number'] }) });
    const result = await engine.finalizeExisting(humanized, context);
    assert.equal(result.delivery.source, 'humanized_repaired');
    assert.equal(result.text, fixed);
    assert.equal(stub.bySchema('gpt_prod_judge_repair').length, 0, 'not routed to the legacy whole-text judge repair');
    const request = jsonAfter(stub.bySchema('writing_engine_v1_repair')[0].userText, '[REPAIR_TARGETS]');
    assert.deepEqual(request.removeNumbers, [token]);
  });
}

test('W2: the local guard rejects a repair that adds a number or drops a supported quantity, before any verdict call', async t => {
  const { context } = finalizeContext();
  const humanized = '원종동의 한 카페를 방문해 카페를 이용했으며, 그날 결제한 전체 금액은 모두 합해 3억원이었어요.';
  const outputs = [
    '원종동의 한 카페를 방문해 카페를 이용했으며, 그날 결제한 전체 금액은 모두 합해 5만원이었어요.',
    '원종동의 한 카페를 방문해 카페를 이용했으며, 그날 결제한 전체 금액은 생각보다 컸던 기억이 남아 있어요.'
  ];
  const stub = installOpenAIStub(t, { writing_engine_v1_repair: request => ({ outputText: outputs[request.index] || outputs[1], notes: [] }) });
  const result = await engine.finalizeExisting(humanized, context);
  assert.equal(result.delivery.source, 'verified_generation_fallback');
  assert.equal(result.text, context.safeDraft);
  assert.equal(result.delivery.fallbackReason, 'deterministic_checks_failed');
  assert.equal(stub.bySchema('gpt_prod_semantic_judge').length, 0, 'guarded rejection spends no verdict call');

  const prepared = context;
  const added = await repairDeterministicViolations({
    input: prepared.input, ledger: prepared.ledger, factIds: prepared.usedFactIds, text: humanized,
    context: { targetChars: 60, charLimitMode: 'with_space', policy: prepared.policy },
    callModel: async () => ({ outputText: outputs[0] })
  });
  assert.equal(added.repaired, false);
  assert.equal(added.reason, 'repair_added_unsupported_number');

  const kept = '원종동의 한 카페를 방문해 카페를 이용했으며, 해당 방문에서 결제한 전체 금액은 모두 합해 3만원이었어요. 메모 정보가 부족해요.';
  const dropped = await repairDeterministicViolations({
    input: prepared.input, ledger: prepared.ledger, factIds: prepared.usedFactIds, text: kept,
    context: { targetChars: 60, charLimitMode: 'with_space', policy: prepared.policy },
    callModel: async () => ({ outputText: '원종동의 한 카페를 방문해 카페를 이용했으며, 해당 방문에서 결제한 금액은 기억에 남을 만큼 컸어요.' })
  });
  assert.equal(dropped.repaired, false);
  assert.equal(dropped.reason, 'repair_dropped_supported_quantity');
});

test('W2: meta-filler and policy findings enter the repair contract with an immutable fact ledger', async () => {
  const prepared = engine.prepare(reviewInput({ targetChars: 60, answers: { sponsorship: 'provided' } }));
  const ledgerBefore = JSON.stringify(prepared.ledger);
  let seen = null;
  const text = '원종동의 카페를 방문했고 총 30,000원을 결제했어요. 정보가 부족해 더 자세히 쓰기는 어려웠어요.';
  const result = await repairDeterministicViolations({
    input: prepared.input, ledger: prepared.ledger, factIds: prepared.ledger.facts.map(fact => fact.id), text,
    context: { targetChars: 60, charLimitMode: 'with_space', policy: prepared.policy },
    callModel: async request => { seen = request; return { outputText: text }; }
  });
  assert.ok(seen, 'a meta/policy violation reaches the model');
  const targets = jsonAfter(seen.userText, '[REPAIR_TARGETS]');
  assert.ok(targets.removePhrases.some(phrase => /정보가\s*부족/u.test(phrase)));
  assert.ok(targets.policy.length >= 1, 'missing sponsorship disclosure is a repair target');
  assert.equal(result.repaired, false, 'an unchanged reply is not accepted as a repair');
  assert.equal(JSON.stringify(prepared.ledger), ledgerBefore);

  const frozen = immutableLedger(prepared.ledger, ['F01']);
  assert.equal(Object.isFrozen(frozen.facts[0]), true);
  assert.deepEqual(frozen.factIds, ['F01']);
  assert.throws(() => { frozen.facts[0].value = '변조'; }, TypeError);
  assert.equal(isDeterministicViolation({ type: 'length_under' }), true);
  assert.equal(isDeterministicViolation({ type: 'distortion' }), false);
});

// ── W4 ───────────────────────────────────────────────────────────────

test('W4: a verifier outage keeps the safe draft but reports verification_unavailable with a retry, distinct from rejection', async () => {
  const { context } = finalizeContext();
  const humanized = '원종동의 한 카페에 들러 시간을 보냈고, 그날 결제한 금액은 모두 합해 3만원이었어요. 다녀온 기록이에요.';

  const outage = await engine.finalizeExisting(humanized, context, {
    semanticVerify: async () => ({ pass: false, error: 'OpenAI Responses API 503: busy', violations: [] })
  });
  assert.equal(outage.delivery.source, 'verified_generation_fallback');
  assert.equal(outage.text, context.safeDraft);
  assert.equal(outage.delivery.fallbackReason, 'verification_unavailable');
  assert.equal(outage.delivery.retryable, true);
  assert.equal(outage.rejectedReport.release.verification, 'unavailable');
  assert.ok(outage.rejectedReport.release.reasons.includes('verification_unavailable'));
  assert.equal(outage.rejectedReport.release.reasons.includes('semantic_grounding'), false);

  const rejected = await engine.finalizeExisting(humanized, context, {
    semanticVerify: async () => ({ pass: false, violations: [{ type: 'added_claim', span: '다녀온 기록이에요.', spanVerified: true }] }),
    semanticRepair: async () => ''
  });
  assert.equal(rejected.delivery.source, 'verified_generation_fallback');
  assert.equal(rejected.delivery.fallbackReason, 'semantic_rejected');
  assert.equal(rejected.delivery.retryable, false);
  assert.equal(rejected.rejectedReport.release.verification, 'rejected');

  const retried = await engine.finalizeExisting(humanized, context, {
    semanticVerify: async () => ({ pass: true, violations: [] })
  });
  assert.equal(retried.delivery.source, 'humanized');
  assert.equal(retried.text, humanized);
  assert.equal(retried.delivery.fallbackReason, undefined);
});

test('W4: a thrown verifier is an outage, not a raw failure, and the default verifier hides provider messages', async t => {
  const { context } = finalizeContext();
  const humanized = '원종동의 한 카페에 들러 시간을 보냈고, 그날 결제한 금액은 모두 합해 3만원이었어요. 다녀온 기록이에요.';
  const thrown = await engine.finalizeExisting(humanized, context, {
    semanticVerify: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }
  });
  assert.equal(thrown.delivery.fallbackReason, 'verification_unavailable');

  installOpenAIStub(t, { gpt_prod_semantic_judge: () => failure(503, 'upstream secret detail') });
  const report = await engine.defaultSemanticVerify({
    input: context.input, ledger: context.ledger, factIds: context.usedFactIds, text: humanized, phase: 'final'
  });
  assert.equal(report.pass, false);
  assert.equal(report.unavailable, true);
  assert.equal(report.failureClass, 'openai_server_error');
  assert.equal(JSON.stringify(report).includes('upstream secret detail'), false);

  const check = await engine.verifyExisting(humanized, context, { semanticVerify: async () => report });
  assert.equal(check.release.verification, 'unavailable');
  assert.ok(check.release.reasons.includes('verification_unavailable'));
});

test('W4: a blocked finalize without a safe draft still distinguishes an outage', async () => {
  const { context } = finalizeContext({ safeDraft: '' });
  const result = await engine.finalizeExisting('원종동의 한 카페에 들러 시간을 보냈고, 그날 결제한 금액은 모두 합해 3만원이었어요. 다녀온 기록이에요.', context, {
    semanticVerify: async () => ({ pass: false, error: 'busy', violations: [] })
  });
  assert.equal(result.delivery.source, 'blocked');
  assert.equal(result.delivery.fallbackReason, 'verification_unavailable');
  assert.equal(result.delivery.retryable, true);
});

test('W4: generation with only verifier outages and no projection returns a retryable VERIFICATION_UNAVAILABLE', async () => {
  await assert.rejects(engine.generate(reviewInput(), {
    shortMode: true,
    deterministicProjection: false,
    callWriter: async () => structured(SAFE),
    semanticVerify: async () => ({ pass: false, error: 'busy', violations: [] })
  }), error => {
    assert.equal(error.code, 'VERIFICATION_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.equal(error.details.retryable, true);
    assert.equal(error.details.fallbackReason, 'verification_unavailable');
    return true;
  });
});
