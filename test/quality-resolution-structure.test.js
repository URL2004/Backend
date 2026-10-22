'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const structure = require('../engine-gpt-prod/structureChunk');
const layout = require('../engine-gpt-prod/layoutStructure');
const {ordinalMarkers, restoreMissingOrdinalMarkers: restore} = require('../engine-gpt-prod/koreanOrdinal');

test('equivalent enumerative frames retain the item and actual deletions still fail', () => {
  const source = '첫 번째로는 기록을 검토한다.\n\n두 번째로는 의견을 모은다.\n\n세 번째로는 자료 보관 기준을 마련한다.';
  for (const noun of ['방안','방법','대안','해결책']) {
    const output=source.replace('세 번째로는',`세 번째 ${noun}은`);
    assert.equal(structure.compareOriginalStructuralMarkers(source,output).pass,true,noun);
    assert.equal(structure.compareOriginalStructuralMarkers(source,output.replace(/세 번째[^.]+\./u,'')).pass,false);
    assert.equal(structure.compareOriginalStructuralMarkers(source,output.replace('세 번째','두 번째')).pass,false);
  }
  assert.deepEqual(ordinalMarkers('첫째 아이는 학교에 갔다. 두 번째 실험은 다음 날 했다.'),[]);
});

test('balanced emphasized headings have stable roles with or without blank lines', () => {
  for (const wrap of [s=>`**${s}**`,s=>`__${s}__`]) {
    const headings = ['1. 목표','2. 수행 방법','3. 검토 결과','4. 다음 계획'].map(wrap);
    const source=headings.map(h=>h+'\n관측 기록을 바탕으로 해당 항목의 내용을 자세히 설명한다.').join('\n\n');
    const output=source.replaceAll('\n관측','\n\n관측');
    assert.equal(layout.buildLineRecords(source).filter(r=>r.role==='heading').length,4);
    assert.equal(structure.compareStructuralRoleSignatures(source,output).pass,true);
    const plan=structure.splitChunksForGpt(source,{preserveLineBoundaries:'structural'});
    assert.equal(structure.buildStructureAudit({source,outputText:output,chunks:plan.chunks,plan}).pass,true);
    assert.equal(structure.buildStructureAudit({source,outputText:output.replace(headings[1],''),chunks:plan.chunks,plan}).pass,false);
    const reversed=output.replace(headings[1],'TEMP_HEADING').replace(headings[2],headings[1]).replace('TEMP_HEADING',headings[2]);
    assert.equal(structure.buildStructureAudit({source,outputText:reversed,chunks:plan.chunks,plan}).pass,false);
  }
});

test('bold numbered prose and inline bold spans are not frozen as headings', () => {
  const text='**1. 관측 결과를 확인하고 자료를 다시 검토한 뒤 동료들과 충분히 논의하여 수정한 내용을 기록했다.**';
  assert.equal(layout.buildLineRecords(text)[0].role==='heading',false);
  assert.equal(layout.buildLineRecords('**2. 방법**은 결과를 검토하는 과정에서 결정했다.')[0].role==='heading',false);
});

test('repeated introduced lists restore only uniquely owned item prefixes under unchanged headings', () => {
  const source = '**1. 기록 도구**\n\n장점은 첫째, 관측 기록을 한곳에서 빠르게 확인할 수 있다. 둘째, 담당자가 검토한 의견을 바로 공유할 수 있다.\n\n단점은 첫째, 장비를 구매하는 초기 비용이 높다. 둘째, 담당자의 지속적인 관리와 점검이 필요하다.\n\n**2. 비교 도구**\n\n장점은 첫째, 표의 항목을 여러 기준에 따라 비교할 수 있다. 둘째, 저장한 수치를 간편하게 정렬할 수 있다.';
  const candidate = source.replace('첫째, 관측 기록을 한곳에서 빠르게 확인할 수 있다.', '관측 기록을 한곳에서 빠르게 확인할 수 있다.')
    .replace('둘째, 담당자가 검토한 의견을 바로 공유할 수 있다.', '또 담당자가 검토한 의견을 바로 공유할 수 있다.')
    .replace('첫째, 장비를 구매하는 초기 비용이 높다.', '장비를 구매하는 초기 비용이 높다.')
    .replace('둘째, 담당자의 지속적인 관리와 점검이 필요하다.', '또한 담당자의 지속적인 관리와 점검이 필요하다.');
  assert.deepEqual(ordinalMarkers(source).map(m => m.number), [1,2,1,2,1,2]);
  const result = restore(source, candidate);
  assert.equal(result.repairCount, 4);
  assert.equal(result.text, source);
  assert.equal(restore(source, result.text).repairCount, 0);
  const particleVariant=restore(source,candidate.replace('단점은 장비를','단점으로는 장비를'));
  assert.equal(particleVariant.repairCount,4);
  assert.deepEqual(ordinalMarkers(particleVariant.text).map(m=>m.number),[1,2,1,2,1,2]);
  const connectorVariant = source.replace('단점은 첫째,','반면 첫째,');
  assert.equal(structure.compareOriginalStructuralMarkers(source,connectorVariant).pass,true);
  assert.equal(restore(source,connectorVariant).repairCount,0);
  const unknownIntro=source.replace('단점은 첫째,','문제가 있는데 첫째,');
  assert.equal(restore(source,unknownIntro).repairCount,0);
  for (const bad of [candidate.replace('**2. 비교 도구**', '**2. 다른 도구**'),
    candidate.replace('장비를 구매하는 초기 비용이 높다.', '초기 비용은 들지 않는다.'),
    candidate.replaceAll(/첫째, |둘째, /gu, ''),
    candidate.replace('또 담당자가 검토한 의견을 바로 공유할 수 있다.', '또 담당자가 검토한 의견을 바로 공유할 수 있다. 담당자가 검토한 의견을 바로 공유할 수 있다.')]) {
    assert.equal(restore(source, bad).repairCount, 0);
  }
});

test('heading line witness cannot excuse deleted, merged, duplicated or reordered headings', () => {
  const source = '1. 관측 방법\n\n관측 장치를 준비하고 설정을 검토한다.\n\n2. 비교 결과\n\n기록한 수치를 비교하고 오차를 계산한다.';
  assert.equal(structure.compareStructuralRoleSignatures(source, source).headingLineWitness.pass, true);
  for (const candidate of [source.replace('1. 관측 방법', ''), source.replace('1. 관측 방법\n\n', '1. 관측 방법 '),
    source+'\n\n1. 관측 방법', source.replace('1. 관측 방법','2. 비교 결과').replace(/2\. 비교 결과(?=\n\n기록)/u,'1. 관측 방법')]) {
    assert.equal(structure.compareStructuralRoleSignatures(source, candidate).headingLineWitness.pass, false);
    const plan = structure.splitChunksForGpt(source, {preserveLineBoundaries:'structural'});
    assert.equal(structure.buildStructureAudit({source,outputText:candidate,chunks:plan.chunks,plan}).pass, false);
  }
});
