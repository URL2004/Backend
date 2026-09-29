'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { preparationRelationDigest, relationDigest } = require('../engine-gpt-prod/layoutRelations');
const { buildLineRecords } = require('../engine-gpt-prod/layoutStructure');

test('preparation binds tabular cell ownership even when flat text and cell counts agree', () => {
  const before = '항목\t수치\n서울 부산\t10\n대구 울산\t20';
  const moved = '항목\t수치\n서울\t부산 10\n대구\t울산 20';
  for (const text of [before, moved]) {
    assert.deepEqual(buildLineRecords(text).map(row => [row.role, row.cellCount]),
      [['table', 2], ['table', 2], ['table', 2]]);
  }
  assert.equal(before.replace(/\s/gu, ''), moved.replace(/\s/gu, ''));
  assert.notEqual(preparationRelationDigest(before), preparationRelationDigest(moved));
  assert.notEqual(relationDigest(before), relationDigest(moved));
});

test('a passed verdict cannot be reused for changed table ownership through whitespace projection', () => {
  const { bindSemanticValidation, verifySemanticValidation } = require('../engine-gpt-prod/semanticProvenance');
  const before = '항목\t수치\n서울 부산\t10\n대구 울산\t20';
  const moved = '항목\t수치\n서울\t부산 10\n대구\t울산 20';
  const report = bindSemanticValidation({ ran: true, pass: true, verificationCompleted: true }, before, before);
  assert.equal(verifySemanticValidation(report, { source: before, candidate: before, requireDigest: true }).status, 'pass');
  assert.equal(verifySemanticValidation(report, { source: before, candidate: moved, requireDigest: true }).status, 'stale');
  assert.equal(verifySemanticValidation(report, { source: moved, candidate: before, requireDigest: true }).status, 'stale');
});

test('preparation still permits harmless prose reflow around an exact table', () => {
  const before = '## 관찰\n결과를 다시확인했다. 다음 단계도 기록했다.\n\n항목\t수치\n서울 부산\t10\n대구 울산\t20';
  const prepared = before.replace('다시확인', '다시 확인').replace(' 다음 단계', '\n\n다음 단계');
  assert.equal(preparationRelationDigest(before), preparationRelationDigest(prepared));
  assert.notEqual(relationDigest(before), relationDigest(prepared));
});

test('preparation conservatively rejects table-only whitespace changes', () => {
  const before = '| 항목 | 수치 |\n| 서울 | 10 |\n| 대구 | 20 |';
  const prepared = before.replace('| 서울 |', '|  서울 |');
  assert.notEqual(preparationRelationDigest(before), preparationRelationDigest(prepared));
});

test('canonical preparation never forwards cell relocation as an adoption baseline', async () => {
  const { createCanonicalAudit, runCanonicalSemanticAudit } = require('../engine-gpt-prod/semanticCanonicalAudit');
  const { bindSemanticValidation } = require('../engine-gpt-prod/semanticProvenance');
  const heading = '## 관찰';
  const source = heading + '\n항목\t수치\n서울 부산\t10\n대구 울산\t20';
  const token = 'ZXQLOCK0000QXZ';
  const frozen = source.replace(heading, token);
  const canonical = createCanonicalAudit({ rawSource: source, frozenSource: frozen,
    lockedBlocks: [{ token, value: heading }] });
  assert.equal(canonical.ok, true);
  let baselines = 0;
  let audits = 0;
  const report = await runCanonicalSemanticAudit({ canonical,
    options: { source: frozen, outputText: frozen,
      prepareCandidateText: async (_raw, text) => text.replace('서울 부산\t10', '서울\t부산 10') },
    onPreparedCandidate: () => { baselines += 1; },
    runAudit: async options => {
      audits += 1;
      options.onPreparedCandidate(options.outputText);
      return bindSemanticValidation({ pass: false, uncertain: true, outputText: options.outputText },
        options.source, options.outputText);
    } });
  assert.equal(audits, 1, 'fresh semantic judgment remains mandatory');
  assert.equal(baselines, 0);
  assert.equal(report.pass, false);
  assert.equal(report.uncertain, true);
});
