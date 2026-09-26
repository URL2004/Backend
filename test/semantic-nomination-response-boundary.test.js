'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../engine-gpt-prod/index.js'), 'utf8');
const body = source.match(/  function serializeSemanticAudit\(report\) \{[\s\S]*?\r?\n  \}/u)?.[0];
assert.ok(body, 'response boundary must retain its explicit serializer');
const serialize = vm.runInNewContext(`(${body.trim()})`);
const plain = value => JSON.parse(JSON.stringify(value));

test('public semantic audit strips nomination reports at document and nested section levels', () => {
  const internal = {
    pass: false, uncertain: false, verificationCompleted: true,
    violations: [{ type: 'omission', span: 'existing official evidence' }],
    initialViolations: [], usage: { estimatedUsd: 0.01 },
    restorationNominationReports: [{ candidateSpan: 'PRIVATE_NOMINATION_ONLY' }],
    reports: [{ index: 0, pass: false, violations: [],
      restorationNominationReports: [{ sourceSpan: 'PRIVATE_NOMINATION_ONLY' }],
      reports: [{ pass: false, restorationNominationReports: [{ span: 'PRIVATE_NOMINATION_ONLY' }] }]
    }]
  };
  const before = JSON.stringify(internal);
  const actual = serialize(internal);
  assert.equal(JSON.stringify(actual).includes('PRIVATE_NOMINATION_ONLY'), false);
  assert.equal(JSON.stringify(actual).includes('restorationNominationReports'), false);
  assert.deepEqual(plain(actual), {
    pass: false, uncertain: false, verificationCompleted: true,
    violations: [{ type: 'omission', span: 'existing official evidence' }],
    initialViolations: [], usage: { estimatedUsd: 0.01 },
    reports: [{ index: 0, pass: false, violations: [], reports: [{ pass: false }] }]
  });
  assert.equal(JSON.stringify(internal), before, 'request-local nomination evidence remains intact');
  assert.match(source, /result\.semanticAudit = serializeSemanticAudit\(semanticReport\);/u);
  assert.doesNotMatch(source, /result\.semanticAudit = semanticReport;/u);
});

test('missing, legacy and normal public audit fields retain their existing values', () => {
  assert.equal(serialize(null), null);
  assert.equal(serialize(undefined), undefined);
  for (const report of [{ pass: true }, { pass: false, reports: [], validation: { status: 'fail' } }]) {
    assert.deepEqual(plain(serialize(report)), report);
  }
});
