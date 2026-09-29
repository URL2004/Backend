'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { restoreConfirmedRelations } = require('../engine-gpt-prod/confirmedRelationRestore');

// Invented documents only. Distinct findings can share a paired window while
// requiring different bounded repair routes; a pair is not a finding ID.
const tail = Array.from({ length: 20 }, (_, i) => `관측 기록 ${i + 1}번은 별도 문서에 보관하며 장비 점검 결과와 구별하여 검토했다.`).join(' ');
const a = '담당자는 도면이나 배치도를 검토했다. 검사 항목을 기록했다. 창고의 온도를 측정했다. 마지막으로 보고서를 제출했다.';
const b = a.replace('도면이나 배치도', '도면과 배치도');
const source = a + ' ' + tail, output = b + ' ' + tail;
const finding = (relation, span = b) => groundViolation({ type: 'distortion', origin: 'introduced',
  relation, sourceSpan: a, candidateSpan: b, span }, source, output);
const report = violations => ({ pass: false, verificationCompleted: true, uncertain: false, violations });

test('same-window residual cannot erase an initial finding with a usable minimal repair', () => {
  const usable = finding('modality_negation_causality');
  const other = finding('genre_naturalness');
  assert.equal(restoreConfirmedRelations(source, output, report([other])).applied, false);
  assert.equal(restoreConfirmedRelations(source, output, report([usable])).text, source);
  const current = { ...report([other]), initialViolations: [usable] };
  const before = JSON.stringify(current);
  const actual = restoreConfirmedRelations(source, output, current);
  assert.equal(actual.text, source);
  assert.equal(actual.restoredCount, 1);
  assert.equal(actual.pass, undefined);
  assert.equal(JSON.stringify(current), before);
});

test('same relation with another problem span must not suppress the grounded operator', () => {
  const unrelated = finding('modality_negation_causality', '마지막으로 보고서를 제출했다.');
  const usable = finding('modality_negation_causality');
  assert.equal(restoreConfirmedRelations(source, output, report([unrelated])).applied, false);
  const actual = restoreConfirmedRelations(source, output, report([unrelated]), { priorReports: [report([usable])] });
  assert.equal(actual.text, source);
  assert.equal(actual.restoredCount, 1);
});

test('duplicate exact finding variants never cause repeated or overlapping repairs', () => {
  const usable = finding('modality_negation_causality');
  const current = report([usable, { ...usable, detail: 'The same finding described differently.' }, usable]);
  const actual = restoreConfirmedRelations(source, output, current, { priorReports: [current] });
  assert.equal(actual.text, source);
  assert.equal(actual.restoredCount, 1);
});
