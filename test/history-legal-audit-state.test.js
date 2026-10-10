'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compactHistoryEngineMeta:compact}=require('../lib/historyService');
const {auditLegalIntegrity:audit}=require('../engine-gpt-prod/legalAudit');
test('legal pass preserves true, false, null and unknown instead of coercing unrun to failure',()=>{
 for(const value of [true,false,null,undefined,'false',0])assert.equal(compact({legalIntegrityPass:value}).legalIntegrityPass,typeof value==='boolean'?value:null);
 assert.equal(compact({}).legalIntegrityPass,null);
});
test('not-applicable audit reaches history as null; failures and existing booleans are unchanged',()=>{
 const result=audit('실험 결과를 정리했다.','관찰 결과를 기록했다.',{profile:'report_assignment'});
 assert.equal(result.applicable,false);
 const meta={legalIntegrityPass:result.applicable?result.pass===true:null,legalIntegrityIssueCodes:result.issueCodes};
 assert.equal(compact(meta).legalIntegrityPass,null);
 assert.deepEqual(compact(meta).legalIntegrityIssueCodes,[]);
 assert.equal(compact({legalIntegrityPass:false}).legalIntegrityPass,false);
 assert.equal(compact({structureSignaturePass:null}).structureSignaturePass,false);
});
