'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createRecoveryBudget}=require('../engine-gpt-prod/recoveryBudget');
const {bindSemanticValidation}=require('../engine-gpt-prod/semanticProvenance');
const {groundViolation}=require('../engine-gpt-prod/judge');
const {polishPaddingDecision}=require('../engine-gpt-prod/polishPaddingDecision');

test('reserved final repair outlives optional style clock but shares cost, call and fixed deadline limits',()=>{
 let now=1000;const b=createRecoveryBudget(.1,{clock:()=>now,maxElapsedMs:30000,maxCalls:2,jobDeadlineMs:500000});
 now=40000;assert.equal(b.denialReason({priority:'late'}),'recovery_time_limit_exhausted');
 const final=b.forFinalRepair(60000);assert.equal(final.deadlineMs(),60000);
 const id=final.reserveCall(.03,{stage:'final_relation_patch'});assert.ok(id);final.settleCall(id,{estimatedUsd:.03});
 assert.equal(final.reserveCall(.08),null);assert.equal(b.snapshot().lastDeniedReason,'recovery_budget_exhausted');
 assert.equal(b.forFinalRepair(100000).deadlineMs(),60000);
 now=60000;assert.equal(final.reserveCall(.01),null);assert.equal(b.snapshot().lastDeniedReason,'final_repair_window_exhausted');
 assert.equal(b.snapshot().spentUsd,.03);
});
test('reserved repair does not bypass the shared call count or absolute job deadline',()=>{
 let now=1000;const b=createRecoveryBudget(1,{clock:()=>now,maxCalls:1,jobDeadlineMs:5000});
 const f=b.forFinalRepair(90000);assert.equal(f.deadlineMs(),5000);
 const id=f.reserveCall(.01);assert.ok(id);f.settleCall(id,{estimatedUsd:.001});
 assert.equal(f.reserveCall(.01),null);assert.equal(b.snapshot().lastDeniedReason,'recovery_call_limit_exhausted');
});
test('HTTP final repair can use reserved time without sending expired optional calls',async t=>{
 const ledger=require('../engine-gpt-prod/callLedger'),client=require('../engine-gpt-prod/openaiClient');
 const oldFetch=global.fetch,oldKey=process.env.OPENAI_API_KEY;let sent=0;
 process.env.OPENAI_API_KEY='synthetic';global.fetch=async()=>{sent++;return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}],usage:{input_tokens:10,output_tokens:5}}));};
 t.after(()=>{global.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;});
 let now=Date.now()-60000;const b=createRecoveryBudget(1,{clock:()=>now,maxElapsedMs:30000});now=Date.now();
 const opts={system:'synthetic',user:'synthetic',model:'gpt-6-luna',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},meta:{task:'repair',phase:'final_relation_patch'}};
 await ledger.run(async()=>{
  ledger.setRecoveryBudget(b);
  await assert.rejects(client.completeJson(opts),e=>e.code==='OPENAI_CHUNK_TIMEOUT'&&e.admissionSkipped===true&&e.admissionReason==='recovery_deadline');
  assert.equal(sent,0);
  const r=await ledger.withPolicy({optional:true,reservedFinalRepair:true,stage:'final_relation_patch',deadlineMs:Date.now()+20000},()=>client.completeJson(opts));
  assert.equal(r.json.ok,true);assert.equal(sent,1);
 });
});

const source='자료를 더 살펴보아야 한다고 생각했다. 기록한 내용은 자료실에서 보관했다.';
const candidate='자료를 더 살펴볼 필요가 있다고 생각했다. 기록한 내용은 자료실에서 보관했다.';
const padding={increased:true};
test('a lexical increase reviewed as same meaning does not hard-stop polish',()=>{
 const r=bindSemanticValidation({ran:true,pass:true,verificationCompleted:true},source,candidate);
 assert.deepEqual(polishPaddingDecision(source,candidate,padding,r),{block:false,review:false,reason:'semantic_pass'});
 assert.equal(polishPaddingDecision(source,candidate+' 추가',padding,r).review,true);
});
test('uncertain word counts remain reviewable; grounded newly added evaluation is still blocked',()=>{
 assert.equal(polishPaddingDecision(source,candidate,padding,{ran:false}).block,false);
 const a='관찰한 자료를 별도 파일에 보관했다.',b='관찰한 자료는 별도 파일에 보관할 필요가 있다.';
 const finding=groundViolation({type:'new_evaluation',origin:'introduced',relation:'modality_negation_causality',sourceSpan:a,candidateSpan:b,span:'보관할 필요가 있다',detail:'완료된 행위를 새로운 필요성 판단으로 바꾸었다.'},a,b);
 const fail=bindSemanticValidation({ran:true,pass:false,verificationCompleted:true,violations:[finding]},a,b);
 assert.equal(polishPaddingDecision(a,b,padding,fail).block,true);
 assert.equal(polishPaddingDecision(a,b,padding,{...fail,verificationCompleted:false}).block,false);
});

test('subclause findings nominate full uniquely aligned source sentences, with no delivery verdict',()=>{
 const a='실험 기록을 살펴본 결과 관측만으로 원인을 입증한 것은 아니었다.';
 const b='실험 기록을 살펴본 결과 관측만으로 원인을 입증했다고 확신했다.';
 const tail=Array.from({length:8},(_,i)=>`연구 ${i}의 자료는 별도 기록에 보관하여 다음 조사에서 사용했다.`).join(' ');
 const s=a+' '+tail,o=b+' '+tail;
 const v=groundViolation({type:'distortion',origin:'introduced',relation:'modality_negation_causality',sourceSpan:'관측만으로 원인을 입증한 것은 아니었다.',candidateSpan:'관측만으로 원인을 입증했다고 확신했다.',span:'입증했다고 확신했다',detail:'관측만으로 입증하지 못했다는 부정 조건이 뒤집혔다.'},s,o);
 const restore=require('../engine-gpt-prod/confirmedRelationRestore').restoreConfirmedRelations;
 const report={pass:false,verificationCompleted:true,violations:[v]};
 const r=restore(s,o,report,{preferSourceWindows:true});assert.equal(r.text,s);assert.equal(r.pass,undefined);
 assert.equal(restore(s,o,{...report,violations:[{...v,origin:'unconfirmed'}]},{preferSourceWindows:true}).applied,false);
 assert.equal(restore(s+' '+a,o,report,{preferSourceWindows:true}).applied,false);
});

test('blocked candidate storage preserves complete private texts, rejects tampering and mismatched owners',()=>{
 const storage=require('../lib/semanticAuditStorage'),diag=require('../engine-gpt-prod/semanticDiagnostics');
 const trace=diag.buildTrace({submittedSource:source,source,candidate,engineVersion:'synthetic',report:{ran:true,pass:false}});
 const context={version:1,source,candidate,auditSource:source,gates:['synthetic'],recovery:[{candidate:'rejected',trace}]};
 const r=storage.document({uid:'owner',id:'job',status:'blocked',semanticAuditTrace:trace,blockedAuditContext:context});
 const view=storage.forBlockedAdmin(r,{uid:'owner',jobId:'job'});assert.equal(view.available,true);assert.equal(view.candidate,candidate);assert.equal(view.delivered,false);assert.equal(view.recovery.length,1);
 assert.equal(storage.forBlockedAdmin(r,{uid:'other',jobId:'job'}).reason,'owner_mismatch');
 assert.equal(storage.forBlockedAdmin({...r,blockedDigest:'bad'},{uid:'owner',jobId:'job'}).reason,'invalid_evidence');
 assert.equal(storage.forBlockedAdmin({...r,invalidated:true},{uid:'owner',jobId:'job'}).available,false);
 assert.equal(storage.forHistory(r,{uid:'owner',jobId:'job',source,candidate}).blockedPayload,undefined);
 const code=fs.readFileSync(require.resolve('../routes/transform'),'utf8');
 const fields=code.slice(code.indexOf('const PERSIST_FIELDS ='),code.indexOf('// ── 유지할 근거'));
 assert.doesNotMatch(fields,/blockedAuditContext|semanticAuditTrace/);
});

test('blocked admin endpoint requires admin and exact archived owner/status before reading private evidence',async()=>{
 const code=fs.readFileSync(require.resolve('../routes/payment'),'utf8');let handler,reads=0,admin=null,row={uid:'owner',status:'blocked'},body;
 const storage={COLLECTION:'transformSemanticAudits',forBlockedAdmin:()=>({available:true,candidate:'private rejected text'})};
 const db={collection:n=>({doc:()=>({get:async()=>{reads++;return {exists:true,data:()=>row,id:'0123456789abcdef'};}})})};
 const c={router:{post:(p,f)=>{handler=f;}},require:()=>storage,requireAdmin:async()=>admin,ADMIN_LEDGER_TASK_ID_RE:/^[A-Za-z0-9_-]+$/,db,JOB_ARCHIVE_COLLECTION:'transformJobArchive',serializeAdminJobDoc:d=>d.data(),logger:{info(){},error(){}}};vm.createContext(c);
 vm.runInContext(code.slice(code.indexOf("router.post('/admin/blocked-job-audit'"),code.indexOf("router.post('/admin/jobs'")),c);
 let status=200;const res={status:n=>(status=n,res),json:v=>(body=v)};const req={body:{uid:'owner',jobId:'0123456789abcdef'}};
 await handler(req,res);assert.equal(reads,0);
 admin='admin';row={uid:'other',status:'blocked'};await handler(req,res);assert.equal(status,409);assert.equal(reads,1);
 row={uid:'owner',status:'done'};await handler(req,res);assert.equal(status,409);assert.equal(reads,2);
 row={uid:'owner',status:'blocked'};await handler(req,res);assert.equal(body.evidence.candidate,'private rejected text');
});
