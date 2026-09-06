'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const diagnostics = require('../lib/detectDiagnostics');
const text = '지역 도서관 안내문을 읽었다. 준비물 설명의 위치를 확인했다. 신청 방법도 살펴보았다.';
const signal = { category: 'formulaic_transition', strength: 'moderate', scope: 'recurring', evidenceSentences: [0, 1] };

test('diagnostics distinguish missing grounding from weak model evidence without storing source', () => {
  const attempt = diagnostics.summarizeAttempt({ probability: 65, confidence: 'high', signals: [{ ...signal, evidenceSentences: [0, 999] }] }, text, 'primary');
  assert.equal(attempt.modelScore, 65);
  assert.equal(attempt.qualifyingBefore, 1);
  assert.equal(attempt.qualifyingAfter, 0);
  assert.equal(attempt.ceilingBefore, 49);
  assert.equal(attempt.ceilingAfter, 20);
  assert.equal(JSON.stringify(attempt).includes('도서관'), false);
});

test('diagnostic projection strips untrusted fields and preserves missing score as null', () => {
  const clean = diagnostics.sanitizeDiagnostics({ version: diagnostics.VERSION, attempts: [{ phase: 'primary', modelScore: null, signalsBefore: Infinity, source: 'secret' }], recheckReason: 'secret', selectedModelScore: '9', evidenceAlignedScore: 0, secret: 'secret' });
  assert.equal(clean.attempts[0].modelScore, null);
  assert.equal(clean.attempts[0].signalsBefore, 0);
  assert.equal(clean.selectedModelScore, null);
  assert.equal(clean.evidenceAlignedScore, 0);
  assert.equal(JSON.stringify(clean).includes('secret'), false);
  assert.equal(diagnostics.sanitizeDiagnostics({ attempts: [] }), null);
});

test('actual detect chain records both model scores and final cap; cache retains only safe diagnostics', async () => {
  const client = require('../engine-gpt-prod/openaiClient');
  const original = client.completeJson;
  let responses = [];
  client.completeJson = async options => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert(next, 'unexpected additional model call');
    return { json: next, model: options.model, usage: {} };
  };
  const filename = require.resolve('../engine-gpt-prod');
  delete require.cache[filename];
  const engine = require('../engine-gpt-prod');
  client.completeJson = original;
  const config = { models: { detect: 'primary-test', detectEscalation: 'recheck-test' }, reasoning: { detect: 'low', escalation: 'high' } };
  responses = [{ probability: 65, confidence: 'high', signals: [signal] }, { probability: 72, confidence: 'high', signals: [signal, { ...signal, category: 'lexical_template' }] }];
  const result = await engine.detect({ text, config, allowLocalFallback: false });
  assert.equal(result.probability, 72, 'recheck can raise score');
  assert.deepEqual(result.detectDiagnostics.attempts.map(x => x.modelScore), [65, 72]);
  assert.equal(result.detectDiagnostics.recheckReason, 'cause_mismatch');
  const cached = require('../lib/detectResultStability').cleanResult(result);
  assert.deepEqual(cached.detectDiagnostics, result.detectDiagnostics);
  responses = [{ probability: 65, confidence: 'high', signals: [signal] }, new Error('provider secret')];
  const fallback = await engine.detect({ text, config, allowLocalFallback: false });
  assert.equal(fallback.probability, 49);
  assert.equal(fallback.detectDiagnostics.attempts.length, 1);
  assert.equal(fallback.detectDiagnostics.recheckFailed, true);
  assert.equal(fallback.detectDiagnostics.selectedModelScore, 65);
  assert.equal(fallback.detectDiagnostics.evidenceAlignedScore, 49);
  assert.equal(JSON.stringify(fallback.detectDiagnostics).includes('secret'), false);
  responses = [{ probability: 12, confidence: 'high', signals: [] }];
  const low = await engine.detect({ text, config, allowLocalFallback: false });
  assert.equal(low.probability, 12);
  assert.equal(low.detectDiagnostics.recheckReason, 'none');
  assert.equal(responses.length, 0);
});
