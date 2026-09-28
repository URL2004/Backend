'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../engine-gpt-prod/semanticOperatorReview');
const cases=[
 ['관측 결과를 보고 곧바로 원인을 확신하지는 않았다.','관측 결과를 보고 원인을 확신하지는 않았다.','temporal_limit_candidate'],
 ['나는 도구가 익숙하다는 이유로 같은 방법을 고르지 않았다.','나는 도구가 익숙하다는 이유만으로 같은 방법을 고르지 않았다.','sole_reason_candidate'],
 ['이번 결과를 확인하면서 이전 설명에 의문이 들었다.','이번 결과를 확인하면서 이전 설명에 의문이 커졌다.','mental_onset_strength_candidate'],
 ['그와 함께 새로운 자료를 찾아 다른 분야도 공부하고 싶었다.','그러면서도 새로운 자료를 찾아 다른 분야도 공부하고 싶었다.','additive_concession_candidate'],
 ['그 경험을 통해 비슷한 감정을 느꼈다.','그 경험을 통해 비슷한 감정을 느꼈던 것 같다.','certainty_scope_candidate']
];
for(const [a,b,code]of cases)test(`operator question is explicit, not an automatic verdict: ${code}`,()=>{
 const targets=policy.targets(a,b);assert.equal(targets.length,1);assert.ok(targets[0].codes.includes(code));
 assert.equal(policy.assess(targets,[],[],a,b).pending.length,1);
 assert.equal(policy.assess(targets,[{...targets[0],status:'preserved',detail:'앞뒤 문장의 동일한 한정 관계를 직접 확인한 가상 응답이다.'}],[],a,b).pending.length,0);
});
test('unchanged text and synonymous immediate qualifiers are not targeted',()=>{
 for(const[a]of cases)assert.deepEqual(policy.targets(a,a),[]);
 assert.deepEqual(policy.targets('나는 곧바로 원인을 확신하지는 않았다.','나는 즉시 원인을 확신하지는 않았다.'),[]);
});
test('a nearby moved qualifier can be grounded without an automatic source insertion',()=>{
 const a=cases[0][0],b=cases[0][1]+' 시간이 조금 흐른 뒤에야 판단했다.',t=policy.targets(a,b);
 assert.equal(policy.assess(t,[{...t[0],candidateSpan:b,status:'preserved',detail:'이 예에서는 뒤 문장에 시점 제한이 남았다는 가상 판정이다.'}],[],a,b).pending.length,0);
});
test('missing, duplicate, wrong-ID, vague and unsupported changed responses cannot silently pass',()=>{
 const[a,b]=cases[0],t=policy.targets(a,b),r={...t[0],status:'preserved',detail:'대응 구절의 시점 제한을 전체 문맥에서 확인했다.'};
 for(const rs of [[],[r,r],[{...r,id:'fake'}],[{...r,detail:''}],[{...r,candidateSpan:'다른 문장'}],[{...r,status:'changed'}]])
  assert.equal(policy.assess(t,rs,[],a,b).pending.length,1);
 const f={origin:'introduced',repairable:true,sourceSpan:a};
 assert.equal(policy.assess(t,[],[f],a,b).pending.length,0); // existing FAIL remains authoritative
});
test('overflow target answers cannot be silently omitted',()=>{
 const[a,b]=cases[0],one=policy.targets(a,b)[0],all=Array.from({length:14},(_,i)=>({...one,id:String(i)}));
 const answers=all.slice(0,12).map(t=>({...t,status:'preserved',detail:'동일한 시점 관계를 검토했다는 가상 판정이다.'}));
 assert.equal(policy.assess(all,answers,[],a,b).pending.length,2);
});
test('compact ID references preserve exact nominated ownership without accepting missing fields',()=>{
 const[a,b]=cases[0],t=policy.targets(a,b),r={id:t[0].id,status:'preserved',sourceSpan:'',candidateSpan:'',detail:'해당 고정 구절 쌍의 관계가 유지된다는 가상 심사다.'};
 assert.equal(policy.assess(t,[r],[],a,b).pending.length,0);
 const {sourceSpan,...missing}=r;
 assert.equal(policy.assess(t,[missing],[],a,b).pending.length,1);
 assert.equal(policy.assess(t,[{...r,id:'wrong'}],[],a,b).pending.length,1);
 assert.equal(policy.assess(t,[{...r,status:'changed'}],[],a,b).pending.length,1);
});
test('actual judge rejects an empty verdict for unreviewed operators',async()=>{
 const path=require.resolve('../engine-gpt-prod/openaiClient'),jp=require.resolve('../engine-gpt-prod/judge');
 const old=require.cache[path],oldJudge=require.cache[jp];
 require.cache[path]={id:path,filename:path,loaded:true,exports:{completeJson:async opts=>{
  assert.ok(opts.schema.required.includes('operatorReviews'));assert.ok(opts.user.includes('OPERATOR_REVIEW_TARGETS'));
  return{json:{violations:[]},model:opts.model,usage:{estimatedUsd:0}};
 }}};delete require.cache[jp];
 try{const r=await require(jp).semanticJudge(cases[0][0],cases[0][1],{},
  {config:{models:{judge:'gpt-6-luna',judgeEscalation:'gpt-6-sol'},reasoning:{judge:'medium'}}});
  assert.equal(r.pass,false);assert.equal(r.uncertain,true);assert.equal(r.violations[0].repairable,false);
 }finally{if(old)require.cache[path]=old;else delete require.cache[path];if(oldJudge)require.cache[jp]=oldJudge;else delete require.cache[jp];}
});
test('quoted embedded question stays with its reporting predicate and exact offsets',()=>{
 const {splitSentenceSpans}=require('../engine/koreanText');
 for(const[q,c]of [['‘','’'],['“','”'],['"','"'],['「','」']]){
  const s=`결과를 보고 ${q}이 설명이 맞을까?${c} 하는 의문이 들었다. 다음 자료를 확인했다.`;
  const spans=splitSentenceSpans(s);assert.equal(spans.length,2);
  assert.equal(spans[0].text,`결과를 보고 ${q}이 설명이 맞을까?${c} 하는 의문이 들었다.`);
  for(const span of spans)assert.equal(s.slice(span.start,span.end),span.text);
  assert.ok(policy.targets(s,s.replace('의문이 들었다','의문이 커졌다')).some(t=>t.codes.includes('mental_onset_strength_candidate')));
 }
 assert.equal(splitSentenceSpans('“설명이 맞을까?” 다음 자료를 확인했다.').length,2);
 assert.equal(splitSentenceSpans('“설명이 맞을까?”\n\n하는 말이 들렸다.').length,2);
});
