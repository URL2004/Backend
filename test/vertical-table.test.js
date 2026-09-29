'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/layoutStructure');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const { splitChunksForGpt } = require('../engine-gpt-prod/structureChunk');
const { relationDigest } = require('../engine-gpt-prod/layoutRelations');
const table = ['장비 사례','주요 경로','작동 특징','선택 시 고려사항','운영상 의미',
  '기기 가','유선','신호를 직접 전달','연결 방식과 전원 확인','현장에서 상태를 재평가',
  '기기 나','무선','주변 환경의 영향','거리와 연결 상태 확인','후속 상태 관찰',
  '기기 다','혼합','조건에 따른 전환','전환 여부 확인','연속 기록 유지'].join('\n');
test('vertical cells retain ownership through preflight, chunking and relation audit', () => {
  const source = 'Ⅰ. 장비 비교\n\n각 장비는 서로 다른 조건에서 사용하며 연결과 기록을 함께 확인한다.\n\n' + table + '\n\n결과는 조건에 따라 달라진다.';
  const result = preflight.auditAndSanitizeSource(source);
  assert.ok(result.text.includes(table));
  assert.equal(layout.analyzeLineStructure(source).tableLineCount,20);
  const chunks=splitChunksForGpt(result.text,{coalesceEditable:true}).chunks;
  for(const cell of table.split('\n')) assert.ok(chunks.some(c=>c.locked && c.text.includes(cell)),cell);
  for(const [a,b] of [['주요 경로\n작동 특징','주요 경로 작동 특징'],['재평가\n기기 나','재평가 기기 나']]) {
    assert.notEqual(relationDigest(source),relationDigest(source.replace(a,b)));
    const audit = require('../engine-gpt-prod/structureChunk').compareStructuralRoleSignatures(source, source.replace(a,b));
    assert.equal(audit.pass, false);
  }
  assert.equal(preflight.auditAndSanitizeSource(result.text).text,result.text);
});
test('parallel comparison headers protect single-cell rows', () => {
  const t=['항목','직접연결','간접연결','무선연결','진입','직접','중계','전파','속도','빠름','조건별 차이','상태별 차이'].join('\n');
  assert.equal(layout.analyzeLineStructure(t).tableLineCount,12);
});
test('plain prose, verse, lists and code are not inferred as vertical tables', () => {
  for(const value of [Array.from({length:15},(_,i)=>`조건 ${i}에 따라 결과를 기록한다.`).join('\n'),
    Array.from({length:12},(_,i)=>`바람 속 작은 흔적 ${i}`).join('\n'),
    '```text\n'+table+'\n```', table.split('\n').map((s,i)=>`${i+1}. ${s}`).join('\n')]) {
    assert.equal(layout.analyzeLineStructure(value).tableLineCount,0);
  }
});
test('nominal suffixes cannot alone justify joining short lines', () => {
  for(const value of ['주요 경로\n작동 특징','작업의 결과를 재평가\n기기명'])
    assert.equal(preflight.repairForcedProseWraps(value).text,value);
});
