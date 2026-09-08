'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const relation = require('../engine-gpt-prod/relationAudit');
const measurement = require('../scripts/measure-relation-audit');

const FIXTURE_PATH = path.join(__dirname, 'fixtures/relation-minimal-pairs.json');
const SCRIPT_PATH = path.join(__dirname, '../scripts/measure-relation-audit.js');
const TYPES = ['certainty_scope', 'temporal_sequence', 'temporal_to_causal', 'numeric_attribution',
  'subject_object_swap', 'claim_strength', 'omitted_speaker_experience'];
const GENRES = new Set(['explainer', 'self_intro', 'assignment', 'review']);
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

test('minimal-pair fixture is a balanced synthetic set covering every relation type', () => {
  assert.deepEqual(fixture.types, TYPES);
  assert.ok(fixture.pairs.length >= 80 && fixture.pairs.length <= 120, `pairs=${fixture.pairs.length}`);
  assert.equal(new Set(fixture.pairs.map(pair => pair.id)).size, fixture.pairs.length);
  for (const pair of fixture.pairs) {
    assert.ok(TYPES.includes(pair.type), pair.id);
    assert.ok(['changed', 'preserved'].includes(pair.polarity), pair.id);
    assert.ok(GENRES.has(pair.genre), pair.id);
    assert.ok(pair.source && pair.candidate && pair.note, pair.id);
    assert.notEqual(pair.source, pair.candidate, pair.id);
    if (pair.obvious) assert.equal(pair.polarity, 'preserved', `${pair.id}: obvious only marks preserved pairs`);
  }
  for (const type of TYPES) {
    const rows = fixture.pairs.filter(pair => pair.type === type);
    assert.ok(rows.filter(pair => pair.polarity === 'changed').length >= 8, `${type} changed`);
    assert.ok(rows.filter(pair => pair.polarity === 'preserved').length >= 8, `${type} preserved`);
    assert.ok(rows.some(pair => pair.obvious), `${type} needs an obvious paraphrase`);
  }
});

test('measurement reports recall and false-positive rate for every type without flagging obvious paraphrases', () => {
  const report = measurement.measure(fixture);
  assert.equal(report.synthetic, true);
  assert.equal(report.pairCount, fixture.pairs.length);
  assert.deepEqual(Object.keys(report.types), TYPES);
  for (const type of TYPES) {
    const row = report.types[type];
    assert.equal(typeof row.recall, 'number', type);
    assert.equal(typeof row.recallByExpectedCode, 'number', type);
    assert.equal(typeof row.falsePositiveRate, 'number', type);
    assert.equal(row.changedFlagged + row.missedIds.length, row.changed, type);
    assert.equal(row.falsePositiveIds.length, row.preservedFlagged, type);
  }
  assert.ok(report.obviousParaphraseSubset.count >= 15);
  assert.equal(report.obviousParaphraseSubset.flagged, 0, `obvious paraphrases flagged: ${report.obviousParaphraseSubset.flaggedIds}`);
  assert.ok(report.rows.every(row => typeof row.flagged === 'boolean'));
});

test('measurement script runs from the command line and writes JSON to --out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relation-audit-'));
  try {
    const out = path.join(dir, 'report.json');
    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--out', out, '--quiet'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(report.version, measurement.VERSION);
    assert.deepEqual(Object.keys(report.types), TYPES);
    assert.match(measurement.renderTable(report), /obvious paraphrase subset/u);
    const bad = spawnSync(process.execPath, [SCRIPT_PATH, '--unknown'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('certainty scope and temporal sequence candidates are review triggers, never gates', () => {
  const scope = relation.auditRelationCandidates('이 방법은 비용을 줄이는 것으로 보인다.', '이 방법은 비용을 줄인다.');
  assert.ok(scope.codes.includes('certainty_scope_candidate'));
  assert.equal(scope.candidateOnly, true);
  assert.equal(relation.auditRelationCandidates('이 방법은 비용을 줄이는 것으로 보인다.', '이 방법이 비용을 줄이는 것처럼 보인다.').semanticRequired, false);
  const narrowed = relation.auditRelationCandidates(
    '낮은 밀도는 이 구조가 압축되지 않았고 내부에 빈 공간이 있을 가능성을 시사한다.',
    '이 구조는 압축되지 않았으며, 낮은 밀도는 내부에 빈 공간이 있을 가능성을 시사하는 수치다.');
  assert.ok(narrowed.codes.includes('certainty_scope_candidate'));
  const order = relation.auditRelationCandidates('회사는 기존 건물을 개보수하고 새 공장을 착공할 계획이다.', '회사는 기존 건물을 개보수한 뒤 새 공장을 착공할 계획이다.');
  assert.ok(order.codes.includes('temporal_sequence_candidate'));
  assert.equal(relation.auditRelationCandidates('연구진은 시료를 건조한 뒤 무게를 측정했다.', '연구진은 시료를 건조하고 나서 무게를 측정했다.').semanticRequired, false);
  assert.equal(relation.auditRelationCandidates('이 앱은 사진을 정리하고 백업도 해 준다.', '이 앱은 백업도 해 주고 사진도 정리해 준다.').semanticRequired, false);
});

test('number ownership follows the topic across an attribute noun and keeps a modifier word', () => {
  assert.equal(relation.auditRelationCandidates('A사는 매출이 12% 늘었고 B사는 5% 줄었다.', 'B사는 매출이 5% 줄었고 A사는 12% 늘었다.').semanticRequired, false);
  assert.ok(relation.auditRelationCandidates('A사는 매출이 12% 늘었고 B사는 5% 줄었다.', 'A사는 매출이 5% 늘었고 B사는 12% 줄었다.').codes.includes('number_ownership_candidate'));
  assert.ok(relation.auditRelationCandidates('서울 지점은 직원이 40명이고 부산 지점은 25명이다.', '서울 지점은 직원이 25명이고 부산 지점은 40명이다.').codes.includes('number_ownership_candidate'));
  assert.equal(relation.auditRelationCandidates('서울 지점은 직원이 40명이고 부산 지점은 25명이다.', '서울 지점 직원은 40명, 부산 지점 직원은 25명이다.').semanticRequired, false);
});
