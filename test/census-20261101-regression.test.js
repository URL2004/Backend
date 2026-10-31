'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restoreRepeatedCitationTails:tails}=require('../engine-gpt-prod/citationTailRecovery');
const {confirmedMicroRepair:micro}=require('../engine-gpt-prod/confirmedMicroRepair');
const {groundViolation}=require('../engine-gpt-prod/judge');
const source='연구자는 추가 실험을 진행하더라도 표본 수에 관한 질문은 여전히 남는다고 지적한다.²² 다음 절에서는 결과를 비교한다.²³';
const output='연구자는 추가 실험에도 불구하고 표본 수에 관한 질문은 여전히 남는다고 지적한다.²²²² 다음 절에서는 결과를 비교한다.²³';
test('box drawing columns retain literal spaces while ordinary prose remains editable',()=>{
 const diagram='┌───────────┐     ┌───────────┐\n│   [준비]  │  ➔  │   [확인]  │\n└───────────┘     └───────────┘';
 const broken=diagram.replace(/ {2,}/gu,' ');
 const text='진행 순서\n'+diagram+'\n\n관찰한 자료를 모아 결과를 비교했습니다.';
 const {isBoxDrawingRow,restoreBoxDrawingLayout:restore}=require('../engine-gpt-prod/boxDrawingLayout');
 assert.ok(diagram.split('\n').every(isBoxDrawingRow));
 assert.equal(restore(text,text.replace(diagram,broken)).text,text);
 assert.equal(restore(text,text.replace(diagram,broken).replace('확인','삭제')).restoredCount,0);
 assert.equal(restore(text,text).restoredCount,0);
 assert.equal(restore(text+'\n'+diagram,broken).restoredCount,0);
 const plan=require('../engine-gpt-prod/structureChunk').splitChunksForGpt(text,{coalesceEditable:true});
 for(const row of diagram.split('\n'))assert.ok(plan.chunks.some(c=>c.locked&&c.text.includes(row)));
 assert.ok(plan.chunks.some(c=>!c.locked&&c.text.includes('관찰한 자료')));
 assert.equal(require('../engine-gpt-prod/sourceLiteralRecovery').recoverSourceLiterals(text,text.replace(diagram,broken),[]).text,text);
});
test('only an attested duplicate citation tail is removed, with fixed-point recovery',()=>{
 const r=tails(source,output);assert.equal(r.restoredCount,1);
 assert.equal(r.text,output.replace('²²²²','²²'));assert.deepEqual(tails(source,r.text),{text:r.text,restoredCount:0});
 const literal=require('../engine-gpt-prod/sourceLiteralRecovery').recoverSourceLiterals(source,output,[]);
 assert.equal(literal.text,r.text);assert.equal(literal.citationRestoredCount,1);
});
test('citation recovery preserves real numbers, equations, code, quotes and uncertain owners',()=>{
 for(const [a,b]of [[source,output.replace('²³','²⁴')],[source,output.replace('²³','')],
  [output,output],[source,output.replace('질문은 여전히 남는다고 지적한다','새로운 가설을 다음 장에서 논의한다')],
  ['“'+source+'”','“'+output+'”'],['```\n'+source+'\n```','```\n'+output+'\n```'],
  ['x²² + 1','x²²²² + 1'],['표본 번호는 2222이다.','표본 번호는 2222이다.'],
  [source+' '+source,output+' '+output]])assert.equal(tails(a,b).text,b);
});
test('a grounded learning ending retains the changed body and does not invent a reflection',()=>{
 const a='현장에서 정확한 기록을 남기려면 서로 다른 자료를 비교하는 과정이 중요하다는 점도 배웠습니다.';
 const b='현장에서 정확한 기록을 남길 때는 서로 다른 자료를 비교하는 과정도 중요합니다.';
 const f=groundViolation({type:'distortion',origin:'introduced',relation:'modality_negation_causality',sourceSpan:a,candidateSpan:b,span:b},a,b);
 assert.equal(micro(a,b,f),b.replace('중요합니다.','중요하다는 점도 배웠습니다.'));
 assert.equal(micro(a,b,{...f,origin:'unconfirmed'}),'');
 assert.equal(micro(a,b.replace('중요합니다','필요합니다'),f),'');
 assert.equal(micro(a,b+' '+b,f),'');
});
test('local timeout recovery keeps the original chunk deadline, mode and complete usage',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
 const script=fs.readFileSync(require.resolve('../engine-gpt-prod/index'),'utf8');
 const code=script.slice(script.indexOf('async function processChunk('),script.indexOf('\nfunction ',script.indexOf('async function processChunk(')));
 const calls=[],context={require:createRequire(require.resolve('../engine-gpt-prod/index')),Date,process:{env:{}},
  shouldCallModel:()=>true,extractProtectedTerms:()=>[],buildPatchTargets:()=>[],isHighRiskChunk:()=>false,safeSurface:()=>null,
  isNonEscalatableModelFailure:r=>require('../engine-gpt-prod/modelFailure').isNonEscalatableModelFailureCode(r.hardFailReason),
  buildV2EscalationPatchTargets:()=>[],rewriteEffort:{rewriteEscalationEffort:()=> 'low'},safeFailureCodesFromRecord:r=>[r.hardFailReason],
  emptyUsage:()=>({estimatedUsd:0}),addUsage:(a,b)=>({estimatedUsd:a.estimatedUsd+b.estimatedUsd}),
  callHumanize:async options=>{calls.push(options);return calls.length===1
    ?{hardFail:true,record:{hardFailReason:'openai_timeout',error:'openai_timeout',usage:{estimatedUsd:.01}}}
    :{hardFail:false,outputText:'자료를 비교한 뒤 조사 내용을 기록했습니다.',record:{usage:{estimatedUsd:.02}}};}};
 vm.createContext(context);vm.runInContext(code,context);
 const chunk={text:'조사 내용을 기록하기 전에 자료를 비교했습니다.'};
 const cfg={models:{humanizePrimary:'primary',humanizeEscalation:'secondary'},reasoning:{humanize:'low'},escalation:{enabled:true}};
 const record=await context.processChunk({chunk,chunks:[chunk],index:0,source:chunk.text,mode:'assignment',requestStrength:'advanced',cfg});
 assert.equal(calls.length,2);assert.equal(calls[0].chunkDeadlineMs,calls[1].chunkDeadlineMs);
 assert.equal(calls[1].mode,'assignment');assert.equal(calls[1].requestStrength,'advanced');
 assert.equal(record.usage.estimatedUsd,.03);assert.equal(record.primaryError,'openai_timeout');
 assert.ok(record.warnings.includes('chunk_timeout_recovered'));assert.equal(chunk.outputText,'자료를 비교한 뒤 조사 내용을 기록했습니다.');
});
test('timeout recovery cannot widen quota/refusal/abort/deadline/configuration failures',()=>{
 const {canRecoverChunkTimeout:eligible}=require('../engine-gpt-prod/modelFailure');
 const base={code:'openai_timeout',primaryModel:'a',escalationModel:'b',enabled:true,now:100,deadlineMs:30100};
 assert.equal(eligible(base),true);
 for(const patch of [{code:'openai_quota_exhausted'},{code:'request_aborted'},{code:'openai_refusal'},
   {code:'openai_rate_limited'},{code:'openai_network_error'},{deadlineMs:30099},{enabled:false},
   {escalationModel:'a'},{escalationModel:''},{signal:{aborted:true}}])assert.equal(eligible({...base,...patch}),false);
});
test('recovered primary errors never trigger another full-document retry',()=>{
 const {recoverableTechnicalBlockReason:reason}=require('../routes/transform');
 const out={floorReport:{status:'blocked',criticals:[{gate:'confirmed_semantic_relation'}]},
  engineMeta:{chunkFailureCodes:['openai_timeout'],chunkResidualFailureCodes:[]}};
 assert.equal(reason(out),'');
 out.engineMeta.chunkResidualFailureCodes=['openai_timeout'];assert.equal(reason(out),'openai_timeout');
 out.engineMeta.chunkResidualFailureCodes=['openai_quota_exhausted','openai_timeout'];assert.equal(reason(out),'');
});
