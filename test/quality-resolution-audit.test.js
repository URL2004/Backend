'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const diagnostics = require('../engine-gpt-prod/semanticDiagnostics');
const provenance = require('../engine-gpt-prod/semanticProvenance');
const operators = require('../engine-gpt-prod/semanticOperatorReview');
const { groundViolation } = require('../engine-gpt-prod/judge');

test('complete changed operator evidence becomes a grounded failure without a duplicate violation', () => {
  const source = '관측 자료를 보고 곧바로 원인을 확신하지는 않았다.';
  const candidate = '관측 자료를 보고 원인을 확신하지는 않았다.';
  const targets = operators.targets(source, candidate);
  const r = operators.assess(targets, [{ id: targets[0].id, status: 'changed', sourceSpan: '', candidateSpan: '',
    detail: '원문의 즉각적인 판단을 유보하는 시간 한정이 결과에서 빠졌다.' }], [], source, candidate);
  const f = groundViolation(r.pending[0], source, candidate);
  assert.equal(f.origin, 'introduced'); assert.equal(f.repairable, true);
  assert.equal(f.candidateSpan, candidate); assert.deepEqual(f.uncertaintyReasons, []);
  const missing = operators.assess(targets, [], [], source, candidate).pending[0];
  assert.equal(missing.origin, 'unconfirmed'); assert.equal(missing.repairable, false);
});

test('review quotations canonicalize whitespace only; mismatched ownership keeps rejected evidence', () => {
  const source = '관측 자료를 보고\n\n곧바로 원인을 확신하지는 않았다.';
  const candidate = '관측 자료를 보고\n원인을 확신하지는 않았다.';
  const t = {id:'example',sourceSpan:source,candidateSpan:candidate,codes:['temporal_limit_candidate']};
  const answer = {id:t.id,status:'changed',sourceSpan:source.replace(/\s+/gu,' '),candidateSpan:candidate.replace(/\s+/gu,' '),detail:'즉각적인 판단 유보의 시간 한정이 결과에서는 남지 않았다.'};
  const r=operators.assess([t],[answer],[],source,candidate);
  assert.equal(r.reviews[0].status,'changed'); assert.equal(r.pending[0].candidateSpan,candidate);
  const invalid=operators.assess([t],[{...answer,candidateSpan:'검사 대상에 없는 인용이다.'}],[],source,candidate);
  assert.equal(invalid.pending[0].origin,'unconfirmed');
  assert.equal(invalid.reviews[0].submittedReview.candidateSpan,'검사 대상에 없는 인용이다.');
  assert.deepEqual(invalid.reviews[0].uncertaintyReasons,['operator_candidate_unlocated']);
  const duplicate=operators.assess([t],[answer],[],source,candidate+'\n'+candidate);
  assert.equal(duplicate.reviews[0].status,'unconfirmed');
});

test('heading token subsets cannot outrank prose when nominating certainty changes', () => {
  const source='1. 연구 방법의 효과\n\n연구 방법의 효과는 다음 실험으로 확인할 수 있다.';
  const candidate='1. 연구 방법의 효과\n\n다음 실험에서는 연구 방법이 어떤 효과를 내는지 확인할 수 있다.';
  const targets=operators.targets(source,candidate);
  assert.ok(targets.every(t=>t.sourceSpan!=='1. 연구 방법의 효과'));
  const changed=operators.targets('이 방법은 처리 시간을 줄일 수 있다.','이 방법은 처리 시간을 줄인다.');
  assert.ok(changed.some(t=>t.codes.includes('certainty_scope_candidate')));
});

test('a repeated short topic cannot outrank its more complete source correspondence', () => {
  const source='기록 도구의 구조가 달라지면 같은 관측 목적이라도 자료를 보관하는 방식이 달라질 수 있다. 다만 구조와 사용 방법은 도구마다 다르다.';
  const candidate='기록 도구의 구조가 달라지면 같은 관측 목적이라도 자료를 보관하는 방식이 달라질 수 있다. 다만 도구의 구조와 사용 방법은 각각 다르다.';
  assert.ok(!operators.targets(source,candidate).some(t=>t.sourceSpan.includes('달라질 수 있다')&&t.candidateSpan.startsWith('다만')));
  const changed=candidate.replaceAll('달라질 수 있다','반드시 달라진다');
  assert.ok(operators.targets(source,changed).some(t=>t.codes.includes('certainty_scope_candidate')));
});

test('shared heading ownership prevents repeated-topic cross-section operator questions', () => {
  const a='1. 실험 단계\n실험을 끝낸 뒤 곧바로 기록하거나 장치를 옮기는 작업이 쉽지 않았다.';
  const b='2. 지지 단계\n발판 위에서 장치를 지지하는 작업은 쉽지 않았다.';
  const source=a+'\n\n'+b;
  const candidate=a.replace('곧바로','즉시')+'\n\n'+b.replace('지지하는','받치는');
  const targets=operators.targets(source,candidate);
  assert.ok(!targets.some(t=>t.sourceSpan.includes('실험을 끝낸') && t.candidateSpan.includes('발판 위에서')));
  const bad=a.replace('곧바로 ','')+'\n\n'+b;
  assert.ok(operators.targets(source,bad).some(t=>t.codes.includes('temporal_limit_candidate')));
  const owners=require('../engine-gpt-prod/relationAlignment').sentenceOwners;
  const spans=require('../engine/koreanText').splitSentenceSpans;
  assert.equal(owners(source,candidate.replace('2. 지지 단계','2. 다른 단계'),spans(source),spans(candidate)),null);
});

test('short inability-to-difficulty changes remain review questions in both directions', () => {
  const a='담당자가 줄어들어 업무를 동등하게 나누지 못하는 환경도 원인이다.';
  const b='담당자가 줄어들어 업무를 동등하게 나누기 어려운 환경도 원인이다.';
  for(const [source,candidate] of [[a,b],[b,a]]) {
    assert.ok(operators.targets(source,candidate).some(t=>t.codes.includes('certainty_scope_candidate')));
    const quality=require('../engine-gpt-prod/finalQualityV2');
    const audit=quality.buildDeterministicAudit({source,outputText:candidate,mode:'blog'});
    assert.deepEqual(quality.shouldRunSemanticJudge({source,requestedMode:'blog',effectiveMode:'blog',audit}),
      {run:true,reason:'relation_candidate'});
  }
  assert.equal(operators.targets(a,a).length,0);
});

test('unconfirmed omission cannot bypass independent confirmation because its words occur in source', () => {
  const should=require('../engine-gpt-prod/judge').shouldEscalateSemanticReport;
  const source='원문의 중요한 조건을 만족할 때만 이 작업을 진행할 수 있다.';
  const v={type:'omission',span:source,sourceSpan:source,origin:'introduced',repairable:false,relationGrounded:false};
  assert.equal(should({violations:[v],uncertain:true},source),true);
  assert.equal(should({violations:[{...v,repairable:true,relationGrounded:true}],uncertain:false},source),false);
});

test('evidence is bound to exact final history and excluded from list documents and unrelated fields', () => {
  const source='관리자는 조건을 충족하면 사용을 승인할 수 있다.';
  const candidate='관리자는 조건을 충족하면 사용을 승인한다.';
  const f=groundViolation({type:'distortion',origin:'introduced',relation:'modality_negation_causality',span:'승인한다',
    sourceSpan:source,candidateSpan:candidate,detail:'승인 가능성이 의무적인 승인으로 바뀌었다.'},source,candidate);
  f.evidence={sourceDigest:provenance.textDigest(source),candidateDigest:provenance.textDigest(candidate),model:'review-model',phase:'semantic'};
  const report=provenance.bindSemanticValidation({ran:true,pass:false,violations:[f],verificationCompleted:true},source,candidate);
  const trace=diagnostics.buildTrace({report,submittedSource:source,source,candidate,engineVersion:'test-v1',decisionReason:'relation_review'});
  assert.equal(trace.status,'fail'); assert.equal(trace.windows[0].findings[0].candidate.text,candidate);
  const archive=require('../routes/transform').buildArchiveDocument({id:'synthetic',uid:'owner',status:'done',createdAt:1,
    text:source,result:{outputText:candidate},semanticAuditTrace:trace});
  assert.equal(archive.text,undefined); assert.equal(archive.result,undefined);
  assert.equal(archive.semanticAuditTrace,undefined);
  const storage=require('../lib/semanticAuditStorage');
  const record=storage.document({uid:'owner',id:'synthetic',semanticAuditTrace:trace});
  const params={uid:'owner',jobId:'synthetic',source,candidate};
  assert.equal(storage.forHistory(record,params).available,true);
  assert.equal(storage.forHistory(record,{...params,uid:'other'}).reason,'owner_mismatch');
  assert.equal(storage.forHistory({...record,contentDigest:'invalid'},params).reason,'invalid_evidence');
  const exposed=diagnostics.forHistory({...trace,apiKey:'must-not-leak'},source,candidate);
  assert.equal(exposed.available,true); assert.equal(exposed.apiKey,undefined);
  assert.equal(diagnostics.forHistory(trace,source,candidate+' 변경').reason,'output_changed');
  assert.equal(diagnostics.forHistory(trace,source+' 다른 원문',candidate).available,false);
  assert.equal(diagnostics.forHistory(null,source,candidate).reason,'not_recorded');
});

test('completed evidence is staged before billing, survives a failed commit, and refinement invalidates it atomically', async () => {
  const code=fs.readFileSync(path.join(__dirname,'../routes/transform.js'),'utf8');
  const saved=[];let writes=0,charge=0;
  const c={require,completionState:require('../lib/transformCompletionState'),logger:{info(){}},
    classifyBillingDisposition:()=> 'charged',commitJobBilling:async()=>{charge++;},commitRefineBilling:async()=>true,
    persistJob:async job=>{saved.push(structuredClone(job));writes++;return{ok:writes!==2};},
    attachRefineTargets(){},measurePreservation:()=>({}),saveJobHistory:async()=>{}};
  vm.createContext(c);vm.runInContext(code.slice(code.indexOf('async function finishRefinement('),code.indexOf('async function commitRefineBilling(')),c);
  const job={id:'evidence',text:'source',mode:'blog',status:'running',needed:10,semanticAuditTrace:{version:diagnostics.VERSION}};
  await assert.rejects(c.stageCompletion(job,{outputText:'result',qualityWarnings:[]}));
  assert.equal(charge,1);assert.ok(saved[0].semanticAuditTrace);assert.equal(job.result,undefined);
  await c.recoverCompletion(job);assert.ok(job.semanticAuditTrace);assert.equal(job.result.semanticAuditTrace,undefined);
  job.pendingRefinement={outputText:'refined',n:1,needed:0,outputVersion:2};
  c.persistJob=async()=>({ok:false});await assert.rejects(c.finishRefinement(job));assert.ok(job.semanticAuditTrace);
  c.persistJob=async()=>({ok:true});await c.finishRefinement(job);assert.equal(job.semanticAuditTrace,null);
});

test('real persistence atomically archives private evidence before charging without publishing it to the owner', async () => {
  const code=fs.readFileSync(path.join(__dirname,'../routes/transform.js'),'utf8');
  const claims=require('../lib/accountActivityClaims'), rows=new Map(), commits=[];
  let fail=false, charged=0;
  const db={collection:name=>({doc:id=>`${name}/${id}`}),async runTransaction(fn){
    const writes=[];
    const result=await fn({get:async ref=>({exists:rows.has(ref),data:()=>structuredClone(rows.get(ref))}),
      set:(ref,value,options)=>writes.push({ref,value:structuredClone(value),options})});
    if(fail)throw new Error('synthetic storage failure');
    for(const w of writes)rows.set(w.ref,w.options?.merge?{...rows.get(w.ref),...w.value}:w.value);
    commits.push(writes);return result;
  }};
  const trace=diagnostics.buildTrace({submittedSource:'source',source:'source',candidate:'output',engineVersion:'test',
    report:{ran:true,pass:false,violations:[{detail:'관리자만 확인하는 검사 근거'}]}});
  const storage=require('../lib/semanticAuditStorage');
  const params={uid:'owner',jobId:'private',source:'source',candidate:'output'};
  const c={db,require,jobNotification:require('../lib/jobNotification').jobNotification,
    attemptTrace:require('../lib/transformAttemptTrace'),completionState:require('../lib/transformCompletionState'),
    normalizeCompletedJobState(){},ensureTerminalTimestamp(){},pruneUndefinedForFirestore:value=>value,
    buildArchiveDocument:require('../routes/transform').buildArchiveDocument,jobPersistChains:new Map(),
    JOB_ARCHIVE_COLLECTION:'transformJobArchive',ACCOUNT_ACTIVITY_COLLECTION:claims.COLLECTION,
    TRANSFORM_LANE:claims.TRANSFORM_LANE,TRANSFORM_CLAIM_TTL_MS:claims.TRANSFORM_CLAIM_TTL_MS,
    activeLane:claims.activeLane,laneWithClaim:claims.laneWithClaim,laneWithoutClaim:claims.laneWithoutClaim,
    accountDeletionBlocksWrites:claims.accountDeletionBlocksWrites,executionPolicy:require('../lib/transformExecution'),
    logger:{warn(){},info(){}},classifyBillingDisposition:()=> 'charged',
    commitJobBilling:async()=>{
      assert.equal(storage.forHistory(rows.get('transformSemanticAudits/private'),params).available,true);
      assert.equal(rows.get('transformJobArchive/private').semanticAuditTrace,undefined);
      assert.equal(rows.get('transformJobs/private').semanticAuditTrace,undefined);charged++;
    },saveJobHistory:async()=>{}};
  vm.createContext(c);
  vm.runInContext(code.slice(code.indexOf('const PERSIST_FIELDS ='),code.indexOf('const ARCHIVE_FIELDS =')),c);
  vm.runInContext(code.slice(code.indexOf('function persistJob('),code.indexOf('function resultLength(')),c);
  vm.runInContext(code.slice(code.indexOf('async function stageCompletion('),code.indexOf('async function commitRefineBilling(')),c);
  const job={id:'private',uid:'owner',createdAt:1,status:'running',text:'source',mode:'blog',needed:10,semanticAuditTrace:trace};
  fail=true;
  await assert.rejects(c.stageCompletion(job,{outputText:'output'}),/COMPLETION_PERSIST_UNAVAILABLE/);
  assert.equal(charged,0);assert.equal(rows.size,0);
  fail=false;await c.stageCompletion(job,{outputText:'output'});
  assert.equal(charged,1);
  assert.ok(commits.every(writes=>['transformJobs','transformJobArchive','transformSemanticAudits']
    .every(collection=>writes.some(w=>w.ref===collection+'/private'))));
  const restarted=structuredClone(rows.get('transformJobs/private'));
  assert.equal(restarted.semanticAuditTrace,undefined);
  await c.persistJob(restarted);
  assert.equal(storage.forHistory(rows.get('transformSemanticAudits/private'),params).available,true);
  const payload=rows.get('transformSemanticAudits/private').payload;
  await c.persistJob({...restarted,semanticAuditTrace:null});
  assert.equal(storage.forHistory(rows.get('transformSemanticAudits/private'),params).reason,'output_changed');
  assert.deepEqual(rows.get('transformSemanticAudits/private').payload,payload);
  assert.equal(rows.get('transformJobs/private').semanticAuditTrace,undefined);
  rows.set('accountDeletionJobs/owner',{status:'processing'});
  assert.equal((await c.persistJob({...job,id:'after-deletion'})).code,'ACCOUNT_DELETION_IN_PROGRESS');
  assert.equal(rows.has('transformSemanticAudits/after-deletion'),false);
});

test('large evidence preserves full quotes, all findings and recovery attempts in bounded compressed storage', () => {
  const v={type:'distortion',origin:'unconfirmed',sourceSpan:'가'.repeat(1200),candidateSpan:'나'.repeat(1200),detail:'다'.repeat(1200)};
  const trace=diagnostics.buildTrace({submittedSource:'source',source:'source',candidate:'output',engineVersion:'test',
    report:{ran:true,pass:false,uncertain:true,violations:Array.from({length:60},()=>v)},
    recovery:Array.from({length:35},(_,index)=>({index,reason:'not_better'}))});
  assert.ok(Buffer.byteLength(JSON.stringify(trace))<=diagnostics.MAX_BYTES);
  assert.equal(trace.truncated,false);assert.equal(trace.omittedFindings,0);
  assert.equal(trace.windows[0].findings.length,60);assert.equal(trace.recovery.length,35);
  assert.equal(trace.omittedRecoveryAttempts,0);
  assert.match(trace.policyFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(trace.windows[0].findings[0].source.truncated,false);
  assert.equal(trace.windows[0].findings[0].source.length,1200);
  assert.equal(trace.windows[0].findings[0].source.text.length,1200);
  assert.equal(diagnostics.forHistory(trace,'source','output').available,true);
  const storage=require('../lib/semanticAuditStorage');
  const record=storage.document({uid:'owner',id:'large',semanticAuditTrace:trace});
  assert.ok(record.payload.length<storage.MAX_COMPRESSED_BYTES);
  assert.deepEqual(storage.forHistory(record,{uid:'owner',jobId:'large',source:'source',candidate:'output'}).windows,trace.windows);
  assert.throws(()=>storage.document({id:'too-large',uid:'owner',semanticAuditTrace:{text:'x'.repeat(diagnostics.MAX_BYTES)}}),
    /SEMANTIC_EVIDENCE_TOO_LARGE/);
});

test('an identical optional objective is not paid twice; changed input, tier and context remain eligible', async t => {
  const name='HUMANIZE_SECTION_ESCALATION_MAX',old=process.env[name];process.env[name]='0';
  t.after(()=>{if(old===undefined)delete process.env[name];else process.env[name]=old;});
  const recovery=require('../engine-gpt-prod/sectionRecovery');
  const memory=require('../engine-gpt-prod/recoveryAttemptMemory').createAttemptMemory();
  const chunks=[0,1].map(i=>{const text=Array.from({length:20},(_,j)=>`또한 ${i+1}-${j+1}번째 자료는 현대 사회에서 중요한 역할을 할 수 있습니다. 따라서 관련 문제를 체계적으로 개선할 필요가 있습니다.`).join(' ');return{text,outputText:text,sectionPath:'section_'+i};});
  let calls=0;
  const opts={chunks,sourceLength:4000,mode:'assignment',requestStrength:'advanced',documentProfile:{profile:'long_explainer'},
    recoveryContext:'policy-a',attemptMemory:memory,retrySection:async entry=>{calls++;return{outputText:entry.output,usage:{estimatedUsd:.01}};}};
  const first=await recovery.recoverSections(opts);assert.equal(calls,2);assert.equal(first.metrics.attempts.length,2);
  const second=await recovery.recoverSections(opts);assert.equal(calls,2);assert.equal(second.metrics.identicalAttemptSkippedCount,2);assert.equal(second.usages.length,0);
  chunks[0].outputText+=' 새 조건을 검토한다.';await recovery.recoverSections(opts);assert.equal(calls,3);
  await recovery.recoverSections({...opts,recoveryContext:'policy-b'});assert.equal(calls,5);
  const e={index:0,source:'source',output:'candidate',plan:{}};
  assert.notEqual(memory.key(e,'mini','p'),memory.key(e,'escalation','p'));
  memory.remember(memory.key(e,'mini','p'),{failureCode:'timeout',rejectionCode:'timeout'});
  assert.equal(memory.get(memory.key(e,'mini','p')),null);
});
