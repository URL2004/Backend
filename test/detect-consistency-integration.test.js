'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const text = ['회의를 마친 뒤 기록을 읽었다.', '자료의 순서를 바꾸었다.', '누락된 날짜를 확인했다.', '다른 항목과 대조했다.',
  '담당자에게 확인을 요청했다.', '답변을 별도로 정리했다.', '근거가 없는 부분을 표시했다.', '다음 회의에서 함께 검토했다.'].join('\n\n');
const signals = ['generic_abstraction', 'formulaic_transition'].map(category => ({ category,
  strength: 'moderate', scope: 'recurring', evidenceSentences: [0, 2, 4, 6] }));
const json = probability => ({ probability, signals, confidence: 'high' });

test('real detector wiring preserves selected evidence, total usage, cache identity and off-mode behavior', async t => {
  const old = process.env.DETECT_CONSISTENCY_ENABLED;
  const oldCriteria = process.env.DETECT_EVIDENCE_CRITERIA_ENABLED;
  t.after(() => { if (old === undefined) delete process.env.DETECT_CONSISTENCY_ENABLED; else process.env.DETECT_CONSISTENCY_ENABLED = old; });
  t.after(() => { if (oldCriteria === undefined) delete process.env.DETECT_EVIDENCE_CRITERIA_ENABLED; else process.env.DETECT_EVIDENCE_CRITERIA_ENABLED = oldCriteria; });
  const client = require('../engine-gpt-prod/openaiClient'); const original = client.completeJson;
  const calls = []; let responses = [];
  client.completeJson = async options => {
    calls.push(options); const next = responses.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, 'unexpected fourth or duplicate model call');
    return { json: next, model: options.model, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedUsd: .001 } };
  };
  const filename = require.resolve('../engine-gpt-prod'); delete require.cache[filename];
  const engine = require('../engine-gpt-prod'); client.completeJson = original;
  const cache = require('../lib/detectResultStability');
  const config = { models: { detect: 'same-test-model', detectEscalation: 'same-test-model' }, reasoning: { detect: 'low', escalation: 'low' } };
  process.env.DETECT_CONSISTENCY_ENABLED = '0';
  process.env.DETECT_EVIDENCE_CRITERIA_ENABLED = '0';
  const baselineKey = cache.variantForConfig(config);
  responses = [json(58)];
  const baseline = await engine.detect({ text, config, allowLocalFallback: false });
  assert.equal(baseline.probability, 58); assert.equal(calls.length, 1);
  assert.equal(baseline.detectDiagnostics.consistency, undefined);

  calls.length = 0; process.env.DETECT_CONSISTENCY_ENABLED = '1';
  const reviewOnlyKey = cache.variantForConfig(config);
  process.env.DETECT_EVIDENCE_CRITERIA_ENABLED = '1';
  assert.notEqual(cache.variantForConfig(config), reviewOnlyKey);
  assert.notEqual(cache.variantForConfig(config), baselineKey);
  responses = [json(58), json(46), json(45)];
  const checked = await engine.detect({ text, config, allowLocalFallback: false });
  assert.equal(checked.probability, 46);
  assert.equal(checked.detectDiagnostics.selectedPhase, 'recheck', 'selected phase is not the last call');
  assert.equal(checked.detectDiagnostics.selectedModelScore, 46);
  assert.equal(checked.detectDiagnostics.consistency.status, 'reviewed_agreement');
  assert.deepEqual(checked.detectDiagnostics.attempts.map(row => row.phase), ['primary', 'recheck', 'tiebreak']);
  assert.equal(checked.gptMeta.usage.totalTokens, 45); assert.equal(checked.gptMeta.estimatedUsd, .003);
  assert.equal(checked.gptMeta.detectPromptVersion, 'detect-prompt-v7-consistency-candidate');
  assert.deepEqual(cache.cleanResult(checked).detectDiagnostics, checked.detectDiagnostics);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(call => call.deadlineMs)).size, 1);
  assert.equal(new Set(calls.map(call => call.system)).size, 1);
  for (const call of calls) {
    assert.match(call.user, /GPT_PROD_DATA/);
    assert.ok(!call.user.includes('"probability"'), 'previous scores cannot anchor independent reviewers');
    assert.equal(call.model, 'same-test-model', 'consistency review must work without a distinct escalation model');
  }

  calls.length = 0; responses = [json(58), json(36), Object.assign(new Error('PRIVATE_provider_failure'), {
    usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, estimatedUsd: .0001 }
  })];
  const failure = await engine.detect({ text, config, allowLocalFallback: false });
  assert.equal(failure.probability, 58);
  assert.equal(failure.detectDiagnostics.selectedPhase, 'primary');
  assert.equal(failure.detectDiagnostics.recheckFailed, true);
  assert.equal(failure.gptMeta.usage.totalTokens, 33, 'discarded rechecks and known failed-response usage are counted');
  assert.equal(failure.detectDiagnostics.consistency.usageMayBeIncomplete, true);
  assert.equal(failure.detectDiagnostics.consistency.failedCalls, 1);
  assert.equal(JSON.stringify(failure.detectDiagnostics).includes('PRIVATE'), false);
  assert.equal(calls.length, 3);

  calls.length = 0; responses = [new Error('primary_failed'), json(43)];
  const recovery = await engine.detect({ text, config, allowLocalFallback: false });
  assert.equal(recovery.probability, 43); assert.equal(calls.length, 2);
  assert.equal(recovery.detectDiagnostics.recheckReason, 'primary_failed');
  assert.equal(recovery.detectDiagnostics.consistency, undefined, 'failure recovery is not followed by extra consistency calls');

  calls.length = 0; process.env.DETECT_CONSISTENCY_ENABLED = '0'; responses = [json(36)];
  process.env.DETECT_EVIDENCE_CRITERIA_ENABLED = '0';
  assert.equal((await engine.detect({ text, config, allowLocalFallback: false })).probability, 36);
  assert.equal(calls.length, 1); assert.equal(cache.variantForConfig(config), baselineKey);

  calls.length = 0; process.env.DETECT_CONSISTENCY_ENABLED = '1'; responses = [json(42), json(43)];
  const reviewOnly = await engine.detect({ text, config, allowLocalFallback: false });
  assert.equal(calls.length, 2);
  assert.equal(reviewOnly.gptMeta.detectPromptVersion, 'detect-prompt-v6-document-scope');
  assert.equal(reviewOnly.detectDiagnostics.consistency.status, 'agreement');

  calls.length = 0; process.env.DETECT_CONSISTENCY_ENABLED = '0';
  process.env.DETECT_EVIDENCE_CRITERIA_ENABLED = '1'; responses = [json(42)];
  const criteriaOnly = await engine.detect({ text, config, allowLocalFallback: false });
  assert.equal(calls.length, 1);
  assert.equal(criteriaOnly.gptMeta.detectPromptVersion, 'detect-prompt-v7-consistency-candidate');
  assert.equal(criteriaOnly.detectDiagnostics.consistency, undefined);
});
