'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const engine=require('../engine-gpt-prod'),structure=require('../engine-gpt-prod/structureChunk');
const {detectDocumentProfile}=require('../engine-gpt-prod/documentProfile');
test('safe formatting cannot glue a locked heading onto prose and discard a local meaning repair',()=>{
  const original='처음에는 이 문제만 중요하다고 생각했다.\n그 뒤에 다른 문제를 확인했다.\n후기\n자료를 더 살펴보았다. 결론은 다음 모임에서 정하기로 했다.';
  const current='처음에는 이 문제가 중요하다고 생각했다.\n이후 다른 문제도 확인했다.\n후기\n자료를 더 검토했다. 다음 모임에서 결론을 정하기로 했다.';
  const profile=detectDocumentProfile(original);
  const plan=structure.splitChunksForGpt(original,{coalesceEditable:true});
  const frozen=engine.freezeLockedBlocks(original,current,plan.chunks);
  assert.ok(frozen?.blocks.length);
  const candidate=frozen.output.replace('이 문제가 중요','이 문제만 중요');
  const result=engine.auditGeneralSurfaceCandidateWithStructure({source:frozen.source,
    current:frozen.output,candidate,chunks:frozen.auditChunks,plan,documentProfile:profile,mode:'blog'});
  assert.ok(result.candidate.includes('이 문제만 중요'));
  assert.equal(result.integrity.candidate.tokenBoundaryRisk,0);
  assert.ok(!result.codes.includes('structure_loss'),JSON.stringify(result.codes));
});

test('materialized ledger audits use the raw-source profile, never the frozen audit profile',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const code=fs.readFileSync(path.join(__dirname,'../engine-gpt-prod/index.js'),'utf8');
  const block=code.slice(code.indexOf('const candidateDeterministicAudit ='),code.indexOf('const candidateDepthReport ='));
  assert.match(block,/source: rawSource/u);
  assert.match(block,/\bvoiceProfile,/u);
  assert.doesNotMatch(block,/voiceProfile: auditVoiceProfile/u);
});
