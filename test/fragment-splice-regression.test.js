'use strict';
// Synthetic regression fixtures only. These splices are constructed mutations;
// the biography pair that motivated the review did NOT contain them, and no
// real document or historical fact is asserted or verified here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');
const { auditParentheticalAliasOwners, CODE } = require('../engine-gpt-prod/entityParentheticalIntegrity');

const source = [
  '관측소의 첫 기록은 한도윤 레인(Dorian Lane)이 남긴 것으로 정리되어 있다.',
  '이후의 보정 작업은 한서윤 레인(Selene Lane)이 맡았다고 적혀 있다.',
  '두 사람의 기록은 같은 장비를 썼지만 서로 다른 기준으로 작성되었다.'
].join(' ');

test('spliced sentence that moves an alias to the sibling owner is nominated, not repaired', () => {
  const spliced = [
    '관측소의 첫 기록은 한서윤 레인(Dorian Lane)이 남긴 것으로 정리되어 있다.',
    '이후의 보정 작업은 한서윤 레인(Selene Lane)이 맡았다고 적혀 있다.',
    '두 사람의 기록은 같은 장비를 썼지만 서로 다른 기준으로 작성되었다.'
  ].join(' ');
  const result = auditParentheticalAliasOwners(source, spliced);
  assert.equal(result.candidateOnly, true);
  assert.equal(result.candidates.length, 1);
  const [row] = result.candidates;
  assert.equal(row.code, CODE);
  assert.equal(row.kind, 'owner_swap');
  assert.equal(row.sourceSpan, '관측소의 첫 기록은 한도윤 레인(Dorian Lane)이 남긴 것으로 정리되어 있다.');
  assert.equal(row.outputSpan, '관측소의 첫 기록은 한서윤 레인(Dorian Lane)이 남긴 것으로 정리되어 있다.');
  // The detector returns evidence only; it has no repaired text or verdict.
  assert.ok(!('text' in result) && !('pass' in result) && !('repaired' in row));
});

test('merged sentences that keep both bindings stay clean', () => {
  const merged = '관측소의 첫 기록은 한도윤 레인(Dorian Lane)이 남겼고, 이후의 보정 작업은 한서윤 레인(Selene Lane)이 맡았다고 적혀 있다. '
    + '두 사람의 기록은 같은 장비를 썼지만 서로 다른 기준으로 작성되었다.';
  assert.deepEqual(auditParentheticalAliasOwners(source, merged).candidates, []);
  assert.ok(!auditRelationCandidates(source, merged).codes.includes(CODE));
});

test('splice inside one merged sentence is still bound to the owner directly before each alias', () => {
  const merged = '관측소의 첫 기록은 한서윤 레인(Dorian Lane)이 남겼고, 이후의 보정 작업은 한도윤 레인(Selene Lane)이 맡았다고 적혀 있다. '
    + '두 사람의 기록은 같은 장비를 썼지만 서로 다른 기준으로 작성되었다.';
  const found = auditParentheticalAliasOwners(source, merged).candidates;
  assert.deepEqual(found.map(row => row.kind), ['owner_swap', 'owner_swap']);
  assert.deepEqual([...new Set(found.map(row => row.outputSpan))].length, 1);
  assert.deepEqual(found.map(row => row.sourceOrdinal), [1, 2]);
});

test('relation audit output for an unchanged text is unaffected by the alias hook', () => {
  assert.deepEqual(auditRelationCandidates(source, source, { documentSource: source }).candidates, []);
  const audit = auditRelationCandidates(source, source);
  assert.equal(audit.semanticRequired, false);
  assert.deepEqual(audit.candidates, []);
  assert.match(audit.version, /^relation-candidates-v\d+/u);
});

test('sectioned audit: the sibling owner bound in another section is supplied by documentSource', () => {
  const sections = source.split(/(?<=있다\.) /u);
  const sectionSource = sections[0];
  const sectionOutput = '관측소의 첫 기록은 한서윤 레인(Dorian Lane)이 남긴 것으로 정리되어 있다.';
  // Alone, the section has no second owner to compare against.
  assert.deepEqual(auditParentheticalAliasOwners(sectionSource, sectionOutput).candidates, []);
  const found = auditParentheticalAliasOwners(sectionSource, sectionOutput, { documentSource: source }).candidates;
  assert.deepEqual(found.map(row => [row.kind, row.sourceSpan, row.outputSpan]),
    [['owner_swap', sectionSource, sectionOutput]]);
  assert.ok(auditRelationCandidates(sectionSource, sectionOutput, { documentSource: source }).codes.includes(CODE));
  // Document context never invents a nomination for a preserved section.
  assert.deepEqual(auditParentheticalAliasOwners(sectionSource, sectionSource.replace('남긴', '적은'),
    { documentSource: source }).candidates, []);
  // An alias that is ambiguous anywhere in the document is skipped.
  const ambiguousDocument = `${source} 별도의 부록은 한서윤 레인(Dorian Lane)이 정리했다고 적혀 있다.`;
  assert.deepEqual(auditParentheticalAliasOwners(sectionSource, sectionOutput,
    { documentSource: ambiguousDocument }).candidates, []);
});

test('alias hook never turns a paraphrase without parentheticals into a required review', () => {
  const plainSource = '두 사람의 기록은 같은 장비를 사용해 작성되었다.';
  const plainOutput = '두 사람의 기록은 같은 장비를 써서 작성되었다.';
  assert.deepEqual(auditParentheticalAliasOwners(plainSource, plainOutput).candidates, []);
  assert.ok(!auditRelationCandidates(plainSource, plainOutput).codes.includes(CODE));
});
