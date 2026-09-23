'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {evaluateChunkGate}=require('../engine-gpt-prod');
const structure=require('../engine-gpt-prod/structureChunk');
const source='1. 연구 배경\n\n시료의 특성을 조사했다.\n\n2. 실험 방법\n\n6. 냉각 후 각 용기의 질량을 정밀한 전자저울로 측정하였다.';
test('rewriting numbered procedure prose is not a missing section title',()=>{
  const output=source.replace('냉각 후 각 용기의 질량을 정밀한 전자저울로 측정하였다.','냉각한 다음 정밀한 전자저울을 이용하여 각 용기의 질량을 측정하였다.');
  const result=evaluateChunkGate({original:source,outputText:output,mode:'assignment',protectedTerms:[]});
  assert.equal(result.warnings.includes('section_anchor_loss'),false);
  assert.equal(structure.compareOriginalStructuralMarkers(source,output).pass,true);
});
test('actual numbered section titles remain protected',()=>{
  const output=source.replace('1. 연구 배경\n\n','');
  const result=evaluateChunkGate({original:source,outputText:output,mode:'assignment',protectedTerms:[]});
  assert.equal(result.warnings.includes('section_anchor_loss'),true);
  const renamed=evaluateChunkGate({original:source,outputText:source.replace('연구 배경','미래 계획'),mode:'assignment',protectedTerms:[]});
  assert.equal(renamed.hardFail,true);
});
