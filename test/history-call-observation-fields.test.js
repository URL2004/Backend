'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compactHistoryEngineMeta: compact } = require('../lib/historyService');

const NUMBERS = [
  'callWindowCompletedCount', 'callWindowOverrunMs', 'callWindowMaxOverrunMs',
  'callHttpCeilingTimeoutCount', 'callAdmissionSkippedCount',
  'contrastRelationDetectedSentenceCount', 'contrastRelationRetryResolvedSentenceCount',
  'contrastRelationResidualSentenceCount', 'contrastRelationSourceRestoreSentenceCount'
];
const MAPS = ['callAdmissionSkippedReasonCounts', 'contrastRelationPatternCounts'];

test('v2.5.107 call-window and contrast-relation counters reach history, including zero', () => {
  const meta = Object.fromEntries(NUMBERS.map((name, index) => [name, index]));
  const stored = compact(meta);
  for (const [index, name] of NUMBERS.entries()) assert.equal(stored[name], index, name);
});

test('counters are clamped and never invented for jobs that did not report them', () => {
  const stored = compact({ callWindowOverrunMs: -5, callHttpCeilingTimeoutCount: 'not-a-number', callAdmissionSkippedCount: '2' });
  assert.equal(stored.callWindowOverrunMs, 0);
  assert.equal(stored.callHttpCeilingTimeoutCount, null);
  assert.equal(stored.callAdmissionSkippedCount, 2);
  const legacy = compact({});
  for (const name of [...NUMBERS, ...MAPS]) assert.equal(Object.hasOwn(legacy, name), false, name);
});

test('reason and pattern count maps keep only safe codes with positive counts', () => {
  const stored = compact({
    callAdmissionSkippedReasonCounts: { recovery_deadline: 1, job_deadline: 0, 'bad key!': 2 },
    contrastRelationPatternCounts: { limitative_additive: 1, recharacterizing_comparison: 1, action_comparison: 0, nominal_comparison: 0 }
  });
  assert.deepEqual(stored.callAdmissionSkippedReasonCounts, { recovery_deadline: 1, bad_key_: 2 });
  assert.deepEqual(stored.contrastRelationPatternCounts, { limitative_additive: 1, recharacterizing_comparison: 1 });
  for (const value of [[], 'text', 7]) {
    assert.deepEqual(compact({ contrastRelationPatternCounts: value }).contrastRelationPatternCounts, {});
  }
  assert.deepEqual(compact({ callAdmissionSkippedReasonCounts: {} }).callAdmissionSkippedReasonCounts, {});
});

test('the engine emits every counter name the history keeps', () => {
  // 호출 창 계수는 index.js가, 배제 약화 계수는 fingerprintAudit.js의 snapshot()이 낸다.
  const fs = require('node:fs');
  const source = ['../engine-gpt-prod/index.js', '../engine-gpt-prod/fingerprintAudit.js']
    .map(file => fs.readFileSync(require.resolve(file), 'utf8')).join('\n');
  for (const name of [...NUMBERS, ...MAPS]) assert.ok(source.includes(`${name}:`), name);
});
