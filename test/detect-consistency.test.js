'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/detectConsistency');
const text = ['회의를 마친 뒤 기록을 읽었다.', '자료의 순서를 바꾸었다.', '누락된 날짜를 확인했다.', '다른 항목과 대조했다.',
  '담당자에게 확인을 요청했다.', '답변을 별도로 정리했다.', '근거가 없는 부분을 표시했다.', '다음 회의에서 함께 검토했다.'].join('\n\n');
const signal = category => ({ category, strength: 'moderate', scope: 'recurring',
  locations: [{ sentenceIndex: 0, start: 0, end: 5 }, { sentenceIndex: 2, start: 20, end: 25 }] });
const result = (probability, signalEvidence = [signal('generic_abstraction'), signal('formulaic_transition')]) => ({
  probability, signalEvidence, confidence: 'high', signalContractVersion: 'model-signals-v2-grounded'
});
const opts = primary => ({ primary, source: text, deadlineMs: 60000, now: () => 0 });

test('consistency candidate is explicitly opt-in, not truthy-string enabled', () => {
  for (const value of ['', '0', 'false', 'true', 'yes', '2']) assert.equal(policy.enabled(value), false);
  assert.equal(policy.enabled('1'), true);
});

test('high evidence sufficiency cannot hide uncertain subjective signals', () => {
  for (const score of [36, 42, 43, 46, 55, 58]) assert.notEqual(policy.reviewReason(result(score), text), 'none');
  assert.equal(policy.reviewReason(result(12, []), text), 'none');
  assert.equal(policy.reviewReason(result(88), text), 'band_boundary', 'unsupported high raw score is capped before uncertainty routing');
  assert.equal(policy.reviewReason(result(88, ['generic_abstraction', 'formulaic_transition', 'sentence_uniformity']
    .map(category => ({ ...signal(category), strength: 'strong' }))), text), 'none');
  assert.equal(policy.reviewReason(result(46), '짧은 기록이다.'), 'none');
  assert.equal(policy.reviewReason(result(46), text, 'no_distinct_model'), 'band_boundary');
  assert.equal(policy.reviewReason(result(65), text, 'cause_mismatch'), 'cause_mismatch');
});

test('agreement requires score band and cause strength as well as numeric proximity', () => {
  assert.equal(policy.agrees(result(42), result(46)), true);
  assert.equal(policy.agrees(result(49), result(50)), false);
  const changed = result(43); changed.signalEvidence[0].strength = 'strong';
  assert.equal(policy.agrees(result(43), changed), false);
  assert.equal(policy.agrees(result(43), result(43, [signal('voice_instability')])), false);
});

test('three-pass selection is symmetric median, never minimum or an invented score', () => {
  for (const values of [[58, 46, 36], [36, 58, 46], [36, 46, 58], [43, 42, 55], [42, 55, 43]]) {
    const rows = values.map(n => result(n));
    assert.equal(rows[policy.selectMedianResult(rows)].probability, [...values].sort((a, b) => a - b)[1]);
  }
  const rows = [result(88, [signal('generic_abstraction')]), result(43), result(45)];
  assert.equal(policy.selectMedianResult(rows), 2, 'compare server-aligned scores, not an unsupported raw 88');
});

test('unambiguous input uses one call; agreement uses two, retaining one complete pair', async () => {
  const primary = result(12, []);
  assert.equal((await policy.review({ ...opts(primary), invoke: () => assert.fail('unexpected call') })).selected, primary);
  let calls = 0;
  const other = result(43);
  const start = result(42);
  const checked = await policy.review({ ...opts(start), invoke: async phase => { calls++; assert.equal(phase, 'recheck'); return other; } });
  assert.equal(calls, 1); assert.equal(checked.selected, start);
  assert.equal(checked.diagnostics.status, 'agreement');
});

test('disagreement is bounded to three logical calls and never presented as agreement', async () => {
  const rows = [result(58), result(46), result(36)];
  const phases = [];
  const checked = await policy.review({ ...opts(rows[0]), invoke: async phase => { phases.push(phase); return rows[phases.length]; } });
  assert.deepEqual(phases, ['recheck', 'tiebreak']);
  assert.equal(checked.selected, rows[1]);
  assert.equal(checked.diagnostics.attemptedCalls, 3);
  assert.equal(checked.diagnostics.selectedIndex, 1);
  assert.equal(checked.diagnostics.scoreRange, 22);
  assert.equal(checked.diagnostics.status, 'reviewed_disagreement');
});

test('third result can establish a nearby agreeing pair without averaging their evidence', async () => {
  const rows = [result(58), result(46), result(45)]; let i = 1;
  const checked = await policy.review({ ...opts(rows[0]), invoke: async () => rows[i++] });
  assert.equal(checked.selected, rows[1]);
  assert.equal(checked.diagnostics.status, 'reviewed_agreement');
});

test('failed second or third pass keeps the primary without new whole-chain retries', async () => {
  for (const failAt of [1, 2]) {
    let n = 0; const primary = result(58);
    const checked = await policy.review({ ...opts(primary), invoke: async () => {
      n++; if (n === failAt) throw Error('PRIVATE_TEXT'); return result(36);
    } });
    assert.equal(n, failAt); assert.equal(checked.selected, primary);
    assert.equal(checked.diagnostics.failedCalls, 1);
    assert.equal(checked.diagnostics.status, 'review_failed');
    assert.equal(JSON.stringify(checked.diagnostics).includes('PRIVATE'), false);
  }
});

test('time budget is absolute and checked again before the third pass', async () => {
  let now = 0, calls = 0; const primary = result(58);
  const checked = await policy.review({ ...opts(primary), deadlineMs: 20000, now: () => now,
    invoke: async () => { calls++; now = 15000; return result(36); } });
  assert.equal(calls, 1); assert.equal(checked.selected, primary);
  assert.equal(checked.diagnostics.status, 'budget_exhausted');
  for (const deadlineMs of [0, 5000, undefined, Infinity]) {
    assert.equal((await policy.review({ ...opts(primary), deadlineMs, invoke: () => assert.fail('no budget') })).diagnostics.status, 'budget_exhausted');
  }
});

test('abort is propagated before and during review, not turned into a valid fallback', async () => {
  const controller = new AbortController(); const reason = new Error('user_cancelled');
  await assert.rejects(policy.review({ ...opts(result(58)), signal: controller.signal, invoke: async () => {
    controller.abort(reason); throw reason;
  } }), /user_cancelled/);
  await assert.rejects(policy.review({ ...opts(result(58)), signal: controller.signal, invoke: () => assert.fail('aborted') }), /user_cancelled/);
});

test('diagnostics contain only bounded counters/enums, never input or model prose', () => {
  const projected = policy.sanitize({ version: policy.VERSION, reason: 'PRIVATE', status: 'PRIVATE',
    selectedIndex: 9999, attemptedCalls: 9999, successfulCalls: -1, scoreRange: Infinity, text: 'PRIVATE' });
  assert.equal(projected.attemptedCalls, 3); assert.equal(projected.selectedIndex, 2);
  assert.equal(projected.successfulCalls, 0); assert.equal(projected.scoreRange, 0);
  assert.equal(JSON.stringify(projected).includes('PRIVATE'), false);
});

test('candidate prompt has genre-safe intensity anchors; baseline and security contract remain unchanged', () => {
  const prompts = require('../engine-gpt-prod/prompts/detect');
  for (const lang of ['ko', 'en']) {
    const baseline = prompts.buildDetectPrompt(lang);
    const candidate = prompts.buildDetectPrompt(lang, { consistency: true });
    assert.ok(candidate.includes(policy.PROMPT_VERSION));
    assert.ok(!baseline.includes(policy.PROMPT_VERSION));
    assert.match(candidate, /sampleUnitIndex/); assert.match(candidate, /moderate/);
  }
  const ko = prompts.buildDetectPrompt('ko', { consistency: true });
  assert.match(ko, /confidence는 표본 충분성/);
  assert.match(ko, /의미 변화까지 같은 점수로 강제하지 않는다/);
  assert.match(ko, /동일 가중치 합산은 하지 않는다/);
  assert.match(ko, /학술문에 개인 경험이 없다는 뜻이 아니다/);
});
