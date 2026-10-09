'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildArchiveDocument}=require('../routes/transform');
test('blocked jobs retain known and unresolved costs without claiming a charge',()=>{
 const row=buildArchiveDocument({id:'synthetic-blocked',status:'blocked',createdAt:1000,startedAt:2000,terminalAtMs:8000,deducted:false,
  engineMeta:{engineVersion:'gpt-prod-v2.5.106',modelCost:{version:1,knownUsd:.04,unknownReservedUsd:.02,stages:[]}},
  gates:['confirmed_semantic_omission']});
 assert.equal(row.estimatedUsd,.04);assert.equal(row.unknownReservedUsd,.02);assert.equal(row.deducted,false);
 assert.equal(row.processingDurationMs,6000);assert.equal(row.totalDurationMs,7000);
 assert.equal(row.inputText,undefined);assert.equal(row.outputText,undefined);
});
test('paragraph-only validation preserves lineage without restoring the old whole-document pass',()=>{
 const row=buildArchiveDocument({id:'synthetic-refined',status:'done',createdAt:1000,terminalAtMs:8000,
  result:{outputText:'합성 보강 결과',engineMeta:null,qualityStatus:'needs_review',refinementAudit:{parentEngineVersion:'gpt-prod-v2.5.106'}}});
 assert.equal(row.engineVersion,'gpt-prod-v2.5.106');assert.equal(row.semanticValidationStatus,undefined);
});
