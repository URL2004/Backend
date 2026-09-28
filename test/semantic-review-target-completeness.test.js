'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('more than sixteen obligations and twelve operator questions all reach the schema and payload',async()=>{
 const base='../engine-gpt-prod/';
 const paths=['openaiClient','semanticObligations','semanticOperatorReview','judge'].map(n=>require.resolve(base+n));
 const saved=paths.map(p=>require.cache[p]);
 const obligations=Array.from({length:18},(_,i)=>({id:`obligation-${i}`,finding:{}}));
 const operators=Array.from({length:14},(_,i)=>({id:`operator-${i}`,sourceSpan:'합성 원문의 문장이다.',candidateSpan:'합성 결과의 문장이다.'}));
 let sent;
 const policy={collectObligations:()=>obligations,currentCandidateReferences:()=>({}),reviewPayload:rows=>rows,
  reviewSchema:(base,rows)=>({...base,obligationIds:rows.map(o=>o.id)}),
  assessReviews:(all,answers)=>({reviews:answers,pending:all.filter(o=>!answers.some(a=>a.id===o.id)).map(()=>({repairable:false}))})};
 const operator={targets:()=>operators,instruction:'synthetic questions',
  schema:(base,rows)=>({...base,operatorIds:rows.map(o=>o.id)}),
  assess:(all,answers)=>({reviews:answers,pending:all.filter(o=>!answers.some(a=>a.id===o.id)).map(()=>({repairable:false}))})};
 const client={completeJson:async opts=>{
  sent=opts;
  return {model:opts.model,json:{violations:[],obligationReviews:opts.schema.obligationIds.map(id=>({id})),operatorReviews:opts.schema.operatorIds.map(id=>({id}))},usage:{estimatedUsd:0}};
 }};
 for(const [i,exports] of [client,policy,operator].entries())require.cache[paths[i]]={id:paths[i],filename:paths[i],loaded:true,exports};
 delete require.cache[paths[3]];
 try{
  const r=await require(base+'judge').semanticJudge('합성 원문의 문장이다.','합성 결과의 문장이다.',{},
   {config:{models:{judge:'gpt-6-luna',judgeEscalation:'gpt-6-sol'},reasoning:{judge:'medium'}}});
  assert.equal(sent.schema.obligationIds.length,18);assert.equal(sent.schema.operatorIds.length,14);
  for(const id of [...sent.schema.obligationIds,...sent.schema.operatorIds])assert.ok(sent.user.includes(id));
  assert.equal(sent.maxOutputTokens,10000);assert.equal(sent.reasoningEffort,'medium');
  assert.equal(r.pass,true);assert.equal(r.uncertain,false);
 }finally{paths.forEach((p,i)=>{if(saved[i])require.cache[p]=saved[i];else delete require.cache[p];});}
});
