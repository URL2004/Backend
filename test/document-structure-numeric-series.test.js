'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const structure = require('../engine-gpt-prod/documentStructure');

const intro = 'I. 서론\n\n지역별 서비스 이용률을 조사하여 차이를 비교하였다. 응답을 모아 운영 계획을 세웠다.\n\n조사에서는 지역 간 차이가 나타났다. 여건을 고려한 계획을 세울 필요가 있다.';
const ending = '\n\nIII. 결론\n\n이용 현황을 토대로 안내 방법을 수정한다. 현장에서 의견을 더 확인하여 운영 과정을 고친다.';
const chart = '구역별 서비스 이용률\n0.30\n\n0.20\n\n0.10\n\n0.00\n2020\t2021\t2022\t2023';
const source = intro + '\n\n' + chart + '\n\n출처: 지역 서비스 조사' + ending;

function mergeBody(doc) {
  const plan = structure.identityPlan(doc);
  plan.groups[1].ids.push(plan.groups[2].ids[0]);
  plan.groups.splice(2, 1);
  return plan;
}

test('numeric chart owns its caption and both axes before paragraph materialization', () => {
  const doc = structure.buildDocument(source);
  const block = doc.blocks.find(b => b.layoutRole === 'numeric_series');
  assert(block);
  assert.equal(block.kind, 'protected');
  assert.equal(block.text, chart);
  assert.equal(doc.source.slice(block.start, block.end), chart);
  const result = structure.applyPlan(doc, mergeBody(doc));
  assert.equal(result.applied, true);
  assert(result.text.includes(chart));
  assert(!result.text.includes('이용률 0.30'));
  assert.equal(structure.auditDelivery(result.text, result.text).pass, true);
});

test('numeric-series delivery rejects caption, tick, and horizontal-axis row collapse', () => {
  const approved = structure.applyPlan(structure.buildDocument(source), mergeBody(structure.buildDocument(source))).text;
  for (const corrupted of [
    approved.replace('이용률\n0.30', '이용률 0.30'),
    approved.replace('0.30\n\n0.20', '0.30 0.20'),
    approved.replace('0.00\n2020', '0.00 2020'),
    approved.replace('0.20', '0.25')
  ]) assert.equal(structure.auditDelivery(approved, corrupted).pass, false);
  assert.equal(structure.auditDelivery(approved, approved.replace('0.30\n\n0.20', '0.30\n0.20')).pass, true);
});

test('numeric-series blocks cannot join body text or split across approved groups', () => {
  const doc = structure.buildDocument(source), plan = structure.identityPlan(doc);
  const index = doc.blocks.findIndex(b => b.layoutRole === 'numeric_series');
  plan.groups[index - 1].ids.push(plan.groups[index].ids[0]);
  plan.groups.splice(index, 1);
  assert.throws(() => structure.applyPlan(doc, plan), { code: 'STRUCTURE_LOCK_EDIT' });
});

test('old role contracts are stale even when their canonical source hash matches', () => {
  const doc = structure.buildDocument(source), plan = structure.identityPlan(doc);
  plan.version = 'document-structure-v2';
  assert.throws(() => structure.applyPlan(doc, plan), { code: 'STRUCTURE_PLAN_STALE' });
});

test('chart evidence requires monotonic vertical values plus a separate numeric axis', () => {
  const variants = [
    '측정한 표본 값\n0.30\n\n0.20\n\n0.25\n2020 2021 2022',
    '측정한 표본 값\n0.30\n\n0.20\n\n0.10',
    '조사에서는 2020년 응답률이 0.30이었다.\n다음 해에는 0.20으로 낮아졌다.',
    '1. 연구 결과\n0.30\n\n0.20\n\n0.10\n2020 2021 2022'
  ];
  for (const value of variants) {
    const doc = structure.buildDocument(intro + '\n\n' + value + ending);
    assert(!doc.blocks.some(b => b.layoutRole === 'numeric_series'));
  }
});

test('quoted, code, and reference material are not reclassified as charts', () => {
  for (const value of ['“' + chart + '”', '```text\n' + chart + '\n```', 'IV. 참고문헌\n\n' + chart]) {
    const doc = structure.buildDocument(intro + '\n\n' + value + ending);
    assert(!doc.blocks.some(b => b.layoutRole === 'numeric_series'));
  }
});

test('signed percentage axes preserve exact rows without inventing chart cells', () => {
  const value = '지역별 증감률\n-10%\n0%\n10%\n2021 2022 2023';
  const doc = structure.buildDocument(intro + '\n\n' + value + ending + ' 다음 조사에서도 같은 기준으로 변화를 살펴본다.');
  const block = doc.blocks.find(b => b.layoutRole === 'numeric_series');
  assert.equal(block?.text, value);
  const result = structure.applyPlan(doc, mergeBody(doc));
  assert(result.text.includes(value));
});
