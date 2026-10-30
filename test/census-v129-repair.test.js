'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {groundViolation}=require('../engine-gpt-prod/judge');
const {confirmedMicroRepair:micro}=require('../engine-gpt-prod/confirmedMicroRepair');
const {restoreConfirmedRelations:restore}=require('../engine-gpt-prod/confirmedRelationRestore');
const pre=require('../engine-gpt-prod/sourcePreflight');
const layout=require('../engine-gpt-prod/layoutStructure');
const structure=require('../engine-gpt-prod/structureChunk');
const {repairNumberedProseContinuation:join}=require('../engine-gpt-prod/numberedProseContinuation');
const finding=(a,b,type='distortion',relation='modality_negation_causality')=>groundViolation({type,relation,origin:'introduced',sourceSpan:a,candidateSpan:b,span:type==='omission'?a:b},a,b);

test('a uniquely grounded small literal drift uses the actual changed byte budget',()=>{
 const a='우리는 실험실을 방문한 뒤 극심한 진동 때문에 관측 장비의 위치를 다시 점검하고 측정 기록을 자세히 검토했다.';
 const b=a.replace('극심한 진동','진동이 큰 환경');
 const f=finding(a,b),r=restore(a,b,{pass:false,violations:[f]},{preferSourceWindows:true});
 assert.equal(r.text,a);assert.equal(r.restoredCount,1);assert.equal(r.pass,undefined);
 assert.ok(r.restorationBudget.removed<b.length*.3);
 for(const bad of [{...f,origin:'source_issue'},{...f,repairable:false},{...f,relationGrounded:false},{...f,grounding:'ambiguous'}])assert.equal(micro(a,b,bad),'');
 assert.equal(micro('“'+a+'”','“'+b+'”',finding('“'+a+'”','“'+b+'”')),'');
 assert.equal(micro(a,b+' 새로운 결과도 확인했다.',finding(a,b+' 새로운 결과도 확인했다.')),'');
 const prefix='이전 실험 결과를 검토했다.\n관측 환경 및 진동 반응의 차이\n';
 const suffix=' 다음 활동에서는 다른 조건에서 측정한 결과를 함께 검토했다.';
 const pair=groundViolation({...f,sourceSpan:a,candidateSpan:b},prefix+a+suffix,prefix+b+suffix);
 assert.equal(restore(prefix+a+suffix,prefix+b+suffix,{pass:false,violations:[pair]},{preferSourceWindows:true}).text,prefix+a+suffix);
 assert.equal(restore(prefix+a+suffix,prefix.replace('진동','온도')+b+suffix,{pass:false,violations:[pair]},{preferSourceWindows:true}).applied,false);
});
test('detector diagnostics retain actual transport failure codes without storing freeform errors',()=>{
 const d=require('../lib/detectDiagnostics');
 for(const code of ['ETIMEDOUT','OPENAI_CHUNK_TIMEOUT','OPENAI_BODY_TERMINATED']){
  const failure=d.summarizeFailure({code,message:'private payload'},'recheck');
  const clean=d.sanitizeDiagnostics({version:d.VERSION,attempts:[failure],recheckFailed:true});
  assert.equal(clean.attempts[0].failureCode,code);assert.equal(clean.recheckFailed,true);
  assert.ok(!JSON.stringify(clean).includes('private payload'));
 }
 assert.equal(d.summarizeFailure({code:'private error details'},'recheck').failureCode,'other');
});
test('only a confirmed invented book wrapper with otherwise identical bytes can be removed',()=>{
 const a='관찰기록에는 실험 장비의 위치를 조정하는 방법과 측정할 때 주의해야 할 내용이 자세히 나와 있다.';
 const b=a.replace('관찰기록','『관찰기록』'),f=finding(a,b,'added_claim','other');
 assert.equal(micro(a,b,f),a);
 assert.equal(restore(a,b,{pass:false,violations:[f]},{preferSourceWindows:true}).text,a);
 assert.equal(micro(b,a,finding(b,a,'added_claim','other')),'');
 const changed=b.replace('자세히','간략히');assert.equal(micro(a,changed,finding(a,changed,'added_claim','other')),'');
 const quoted='“'+a+'”';assert.equal(micro(quoted,quoted.replace('관찰기록','『관찰기록』'),f),'');
});
test('a confirmed contrast lost to an additive operator is restored only in aligned sentences',()=>{
 const a='실험에서 기구의 상태를 점검했다. 하지만 이 과정에서 기록한 결과를 곧바로 모든 환경에 적용할 수는 없었다.';
 const b='실험에서 기구의 상태를 살폈다. 이와 함께 이 과정에서 기록한 결과를 곧바로 모든 환경에 적용할 수는 없었다.';
 assert.equal(micro(a,b,finding(a,b)),b.replace('이와 함께','하지만'));
 assert.equal(micro(a,b.split('. ').reverse().join('. '),finding(a,b.split('. ').reverse().join('. '))),'');
 assert.equal(micro(a,b.replace('이와 함께','따라서'),finding(a,b.replace('이와 함께','따라서'))),'');
});
test('numbered prose ending in a coordinator joins its adjacent continuation without changing literals',()=>{
 const a='3. 측정 실습을 통해 https://example.org 접속 과정에서 표시된 응답 시간과 장비 상태 및';
 const b='측정 조건을 자세히 기록하고 여러 실험에서 나타난 차이를 함께 확인하였다.';
 const source=a+'\n'+b,expected=a+' '+b;
 assert.equal(join(source).text,expected);assert.equal(join(source).changes.length,1);
 assert.equal(pre.auditAndSanitizeSource(source).text,expected);
 const plan=structure.splitChunksForGpt(expected,{coalesceEditable:true});
 const audit=structure.buildStructureAudit({source:expected,integritySource:source,outputText:expected,chunks:plan.chunks,plan});
 assert.equal(audit.originalStructurePass,true);assert.equal(audit.lineAnchorLayoutPass,true);
 const broken=structure.buildStructureAudit({source:expected,integritySource:source,outputText:expected.replace(/^3\./u,'4.'),chunks:plan.chunks,plan});
 assert.equal(broken.pass,false);
 const multi=a+'\n측정 조건을 자세히 기록하며 관찰 장비의 상태가\n여러 실험에서 어떻게 달라지는지 함께 확인하였다.';
 const prepared=pre.auditAndSanitizeSource(multi);
 assert.ok(prepared.text.includes(' 및 측정 조건'));
 assert.equal(prepared.text.replace(/\s/gu,''),multi.replace(/\s/gu,''));
 for(const value of [a+'\n\n'+b,a+'\n4. '+b,'```\n'+source+'\n```',a.replace(' 및',' 항목')+'\n'+b])assert.equal(join(value).text,value);
 const quoted='“'+source+'”';assert.equal(join(quoted).text,quoted);
});
test('coordinated nominal headings before a shorter complete paragraph stay separate',()=>{
 const heading='관찰 방법과 실험 기록';
 const body='이번 활동에서는 여러 종류의 관찰 도구를 이용하여 결과를 기록하고 측정 환경에 따라 나타나는 차이를 살펴보았다.';
 const source='이전 활동의 결과를 간략히 정리했다.\n\n'+heading+'\n'+body;
 assert.equal(layout.buildLineRecords(source).find(r=>r.text===heading).role,'heading');
 const plan=structure.splitChunksForGpt(source,{coalesceEditable:true});
 assert.ok(plan.chunks.some(c=>c.locked&&c.text.includes(heading)));
 const broken=source.replace(heading+'\n',heading+' ');
 assert.ok(structure.restoreLockedHeadingLayout(source,broken,plan.chunks).text.includes(heading+'\n'));
 for(const text of ['관찰 방법과 실험 기록을 비교하면','관찰 방법과 실험 기록을 비교했다.'])assert.equal(layout.classifyLine(text,{next:{text:body}}),'prose');
});
test('repeated source attribution labels have stable boundaries; ordinary mentions stay prose',()=>{
 const body='여러 지역에서 수집한 자료를 분석한 결과에는 조사 당시의 환경과 측정 조건을 함께 고려해야 한다는 설명이 담겨 있다.';
 const source=body+'\n예시투데이\n\n'+body+'\n\n예시투데이\n'+body;
 const rows=layout.buildLineRecords(source).filter(r=>r.text==='예시투데이');
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.role!=='prose'));
 const plan=structure.splitChunksForGpt(source,{coalesceEditable:true});
 assert.equal(plan.chunks.filter(c=>c.locked&&c.text.trim()==='예시투데이').length,2);
 assert.equal(layout.classifyLine('예시투데이 보도를 검토했다.'),'prose');
});
