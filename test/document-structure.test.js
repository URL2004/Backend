'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const structure=require('../engine-gpt-prod/documentStructure');
const pricing=require('../lib/humanizePricing');
const {buildHumanizeContract}=require('../engine-gpt-prod/humanizeContract');
const source='I. 서론\n\n지역 도서관의 이용 현황을 확인했다. 신청 과정에서 생긴 불편을 정리했다.\n\nII. 본론\n\n첫 번째 방안은 안내문을 고치는 것이다. 이용자가 필요한 정보를 찾을 수 있게 해야 한다.\n\n조사에서는 안내가 어렵다는 의견이 있었다. 신청서 항목이 많아 작성 시간이 길었다.\n\nIII. 결론\n\n이용 과정의 개선을 위해 설명을 정리할 필요가 있다. 실행 이후에는 다시 의견을 받아 확인한다.';
test('approved reorder preserves every original block and top-level headings',()=>{
 const doc=structure.buildDocument(source),plan=structure.identityPlan(doc);
 [plan.groups[3],plan.groups[4]]=[plan.groups[4],plan.groups[3]];
 const result=structure.applyPlan(doc,plan);assert(result.applied);
 assert(result.text.indexOf('조사에서는')<result.text.indexOf('첫 번째'));
 assert.deepEqual(result.changes.map(c=>c.fromPositions),[[5],[4]]);
 for(const block of doc.blocks)assert(result.text.includes(block.text));
});
test('identity plan is free and leaves source untouched',()=>{
 const doc=structure.buildDocument(source),result=structure.applyPlan(doc,structure.identityPlan(doc));
 assert.equal(result.applied,false);assert.equal(result.text,doc.source);
});
test('persisted plan binds owner, input, ID, completion state and finite expiry across restart',()=>{
 const doc=structure.buildDocument(source),p=structure.identityPlan(doc);
 [p.groups[3],p.groups[4]]=[p.groups[4],p.groups[3]];
 const job={id:'1234567890abcdef',uid:'owner',status:'done',structurePreview:true,result:{structurePlan:{...p,id:'1234567890abcdef',applied:true,expiresAtMs:200}}};
 assert.equal(structure.validateStoredPlan(JSON.parse(JSON.stringify(job)),{uid:'owner',text:source,now:100}).id,job.id);
 const invalid=[j=>j.uid='other',j=>j.status='running',j=>j.result.structurePlan.id='wrong',j=>j.result.structurePlan.expiresAtMs=100,j=>delete j.result.structurePlan.expiresAtMs,j=>j.result.structurePlan.applied=false];
 for(const mutate of invalid){const copy=structuredClone(job);mutate(copy);assert.throws(()=>structure.validateStoredPlan(copy,{uid:'owner',text:source,now:100}));}
 assert.throws(()=>structure.validateStoredPlan(job,{uid:'owner',text:source+' 변경',now:100}));
});
test('final delivery catches undoing the approved order, loss, and changed protected headings',()=>{
 const doc=structure.buildDocument(source),p=structure.identityPlan(doc);[p.groups[3],p.groups[4]]=[p.groups[4],p.groups[3]];
 const approved=structure.applyPlan(doc,p).text;
 assert.equal(structure.auditDelivery(approved,approved.replace('정리했다','정리하였다')).pass,true);
 assert.equal(structure.auditDelivery(approved,source).pass,false);
 assert.equal(structure.auditDelivery(approved,approved.replace('I. 서론','I. 개요')).pass,false);
 assert.equal(structure.auditDelivery(approved,approved.split('\n\n').slice(1).join('\n\n')).pass,false);
});
test('paragraph split and merge preserve text without duplicate sentences',()=>{
 const doc=structure.buildDocument(source),plan=structure.identityPlan(doc);
 plan.groups[3].breakAfterSentences=[0];
 const split=structure.applyPlan(doc,plan);assert(split.applied);assert(split.text.includes('고치는 것이다.\n\n이용자가'));
 const merge=structure.identityPlan(doc);merge.groups[3].ids.push(merge.groups[4].ids[0]);merge.groups.splice(4,1);
 const out=structure.applyPlan(doc,merge);assert(out.applied);assert.equal(out.text.split('조사에서는').length,2);
});
test('stale source, missing/duplicate/unknown blocks and invalid sentence indices fail closed',()=>{
 const doc=structure.buildDocument(source);
 const mutations=[p=>p.sourceHash='old',p=>p.groups.pop(),p=>p.groups[3].ids=['b004'],p=>p.groups[3].ids=['evil'],p=>p.groups[3].breakAfterSentences=[999],p=>p.groups[3].breakAfterSentences=[0,0]];
 for(const mutate of mutations){const plan=structure.identityPlan(doc);mutate(plan);assert.throws(()=>structure.applyPlan(doc,plan));}
});
test('top-level movement and movement across a fixed section fail closed',()=>{
 const doc=structure.buildDocument(source),a=structure.identityPlan(doc),b=structure.identityPlan(doc);
 [a.groups[0],a.groups[2]]=[a.groups[2],a.groups[0]];
 [b.groups[1],b.groups[3]]=[b.groups[3],b.groups[1]];
 assert.throws(()=>structure.applyPlan(doc,a),{code:'STRUCTURE_FIXED_HEADINGS'});
 assert.throws(()=>structure.applyPlan(doc,b));
});
test('quotes and reference tail cannot be split or combined',()=>{
 const doc=structure.buildDocument(source+'\n\nIV. 참고문헌\n\n홍길동. 도서관 운영의 이해. 2020.\n\n홍길동. 지역 자료실의 발전. 2021.');
 assert(doc.blocks.slice(-2).every(b=>b.kind==='protected'));
 const plan=structure.identityPlan(doc);plan.groups.at(-1).breakAfterSentences=[0];
 assert.throws(()=>structure.applyPlan(doc,plan),{code:'STRUCTURE_LOCK_EDIT'});
});
test('new structure layout remains locked during subsequent humanization',()=>{
 const c=buildHumanizeContract({mode:'formal',requestStrength:'advanced',documentProfile:{profile:'personal_essay'},approvedStructure:true});
 assert.equal(c.paragraph.layoutAuthority,'source_role');assert.equal(c.paragraph.advancedNarrativeLayout,false);
});
test('surcharge is 30 percent rounded to whole credits and excludes evidence',()=>{
 for(const [len,addon] of [[3000,30],[10000,60],[20000,120],[30000,180]]){
  assert.equal(pricing.restructureStructureCredit(len),addon);
  assert.equal(pricing.restructureCredit(len,true,true),pricing.restructureCredit(len,true)+addon);
 }
 for(const len of [2999,3000,3001,3349,3350,3351,9999,10000,10001,29999,30000])assert.equal(pricing.restructureStructureCredit(len),Math.ceil(pricing.restructureBaseCredit(len)*0.3));
});
test('planner gets bounded structured data and no full-document rewrite authority',async()=>{
 process.env.OPENAI_SAFETY_SALT='unit-test-structure-safety-identifier-not-a-secret';
 let calls=0;const doc=structure.buildDocument(source);
 const result=await structure.createPlan({text:source,uid:'test',config:{models:{detectEscalation:'test-model'}},complete:async args=>{
  calls++;assert.equal(args.meta.task,'structure_plan');assert(args.system.includes('모든 block id를 정확히 한 번'));return {json:{groups:structure.identityPlan(doc).groups},usage:{estimatedUsd:0}};
 }});assert.equal(calls,1);assert.equal(result.applied,false);
});
