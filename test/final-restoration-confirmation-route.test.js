'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const receipts = require('../engine-gpt-prod/semanticSegmentReceipts');
const provenance = require('../engine-gpt-prod/semanticProvenance');
const { extractPromptDataSection } = require('../engine-gpt-prod/promptEnvelope');

// Execute the real audit scheduler, judge router, grounding and provenance.
// Only model transport is replaced; all text and verdicts are synthetic.
const config = { models: { judge: 'gpt-6-luna', judgeEscalation: 'gpt-6.1-sol', repair: 'gpt-6-luna' },
  reasoning: { judge: 'medium', escalation: 'high', repair: 'medium' } };
const short = '조사팀은 지역별 자료를 검토했다. 결과 보고서는 기록실에 보관했다.';
const long = [1, 2, 3, 4].map(n => `## 구역 ${n}\n` + Array.from({ length: 65 }, (_, i) =>
  `구역 ${n}의 합성 문장 ${i + 1}번은 검사용으로 만든 설명입니다.`).join(' ') + '\n\n').join('');

function load(verdict = () => ({ violations: [] })) {
  const calls = [];
  const loadModule = (name, overrides) => {
    const file = require.resolve(name), req = createRequire(file), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      module, exports: module.exports, require: name => overrides[name] || req(name),
      AbortSignal, Date, setTimeout, clearTimeout, Buffer, process
    }, { filename: file });
    return module.exports;
  };
  const judge = loadModule('../engine-gpt-prod/judge', { './openaiClient': {
    completeJson: async options => {
      calls.push(options);
      assert.equal(options.meta.task, 'judge', 'verification must never start a repair');
      return { json: require('./helpers/semantic-review-fixture.cjs')(verdict(options), options.user),
        model: options.model, usage: { inputTokens: 10, outputTokens: 10, estimatedUsd: 0.01 } };
    }
  } });
  const quality = loadModule('../engine-gpt-prod/finalQualityV2', { './judge': judge });
  const run = (text, extra = {}) => quality.runSemanticDocumentAudit({ source: text, outputText: text,
    config, allowRepair: false, ...extra });
  return { calls, run };
}

for (const text of [short, long]) test(`restoration verification retains confirming tier across ${text === short ? 'one' : 'multiple'} sections`, async () => {
  const { calls, run } = load();
  const options = { auditStage: 'final_relation_restoration_verification',
    discourseSignals: ['final_confirmed_relation_restoration'], allowRepair: true,
    deadlineMs: Date.now() + 120000 };
  const result = await run(text, options);
  assert.equal(result.pass, true);
  assert.equal(result.verificationCompleted, true);
  assert.equal(result.outputText, text);
  assert.equal(result.repairRoundBudget, 0);
  assert.equal(result.repairCount, 0);
  assert.equal(calls.length, result.sectionCount);
  if (text === long) assert.ok(calls.length > 1);
  for (const call of calls) {
    assert.equal(call.model, config.models.judgeEscalation);
    assert.equal(call.reasoningEffort, config.reasoning.escalation);
    const signals = extractPromptDataSection(call.user, 'DETERMINISTIC_DISCOURSE_SIGNALS');
    assert.match(signals, /final_semantic_revalidation/);
    assert.match(signals, /prior_failed_semantic_confirmation/);
  }
  assert.equal(provenance.verifySemanticValidation(result, { source: text, candidate: text,
    requireDigest: true }).status, 'pass');
  assert.equal(options.allowRepair, true, 'caller options remain untouched');
  assert.deepEqual(options.discourseSignals, ['final_confirmed_relation_restoration']);
});

test('restoration verification never consumes a matching primary-only receipt', async () => {
  const { calls, run } = load();
  const receiptStore = receipts.createReceiptStore();
  const diagnostic = ['final_confirmed_relation_restoration'];
  await run(short, { receiptStore, discourseSignals: diagnostic });
  assert.equal(calls[0].model, config.models.judge);
  const restored = await run(short, { receiptStore, discourseSignals: diagnostic,
    auditStage: 'final_relation_restoration_verification' });
  assert.equal(restored.progress.reusedSections, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].model, config.models.judgeEscalation);
  const again = await run(short, { receiptStore, discourseSignals: diagnostic,
    auditStage: 'final_relation_restoration_verification' });
  assert.equal(again.progress.reusedSections, 1);
  assert.equal(calls.length, 2, 'exact confirming receipt is still reusable');
});

test('a failed confirming restoration verdict stays failed with no weaker retry', async () => {
  const { calls, run } = load(options => {
    const candidate = extractPromptDataSection(options.user, 'REWRITE');
    return { violations: [{ type: 'distortion', origin: 'introduced', relation: 'other',
      sourceSpan: short, candidateSpan: candidate, span: candidate,
      detail: '합성 검증 사례에서 확인한 미해결 문제를 그대로 유지한다.' }] };
  });
  const result = await run(short, { auditStage: 'final_relation_restoration_verification' });
  assert.equal(result.pass, false);
  assert.equal(result.verificationCompleted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, config.models.judgeEscalation);
  assert.equal(result.outputText, short);
  assert.equal(provenance.verifySemanticValidation(result, { source: short, candidate: short,
    requireDigest: true }).status, 'fail');
});

test('ordinary verdict-only audits keep their original primary route', async () => {
  const { calls, run } = load();
  await run(short, { discourseSignals: ['final_semantic_revalidation'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, config.models.judge);
  assert.equal(calls[0].reasoningEffort, config.reasoning.judge);
});
