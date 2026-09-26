'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const furniture=require('../engine-gpt-prod/documentFurniture');
const preflight=require('../engine-gpt-prod/sourcePreflight').auditAndSanitizeSource;
const layout=require('../engine-gpt-prod/layoutStructure');
const chunks=require('../engine-gpt-prod/structureChunk').splitChunksForGpt;
const document=require('../engine-gpt-prod/documentStructure');
const title='지역 생활 공간의 변화에 대한 연구',authors='김가람 이누리',header=title+' ｜ 김가람, 이누리';
const prose='주민들은 지역의 생활 공간과 공동체의 변화에 관해 여러 경험을 기록하였다. 기록의 맥락을 비교하고 시간에 따른 차이를 검토하였다. '.repeat(6);
const source=[title,authors,header,'1. 연구 배경',prose+' 연구자는 공동체의 책임을',header,'중요하게 다룬다. '+prose,'영화 <가상의 마을(2020)> 영화 <가상의 도시(2022)>',prose,header,'2. 결론',prose].join('\n');
test('repeated cover-attested title/byline is removed before prose joins without losing cover attribution',()=>{
 const r=furniture.removeRunningHeaders(source);assert.equal(r.removed.length,3);
 assert.ok(r.text.startsWith(title+'\n'+authors));assert.ok(!r.text.includes(header));
 assert.equal(r.text.replace(/\s/gu,''),source.split('\n').filter(l=>l!==header).join('').replace(/\s/gu,''));
 assert.equal(furniture.removeRunningHeaders(r.text).text,r.text);
 const p=preflight(source);assert.ok(p.issueCodes.includes('source_running_header_removed'));
 assert.ok(!p.text.includes(header));assert.match(p.text,/책임을\s+중요하게 다룬다/);
});
test('no cover evidence, two occurrences, close repeated rows, body prose and literal references are not removed',()=>{
 for(const text of [source.replace(title+'\n'+authors+'\n',''),source.replace(header,'다른 행'),
  [title,authors,header,header,header].join('\n'),prose.repeat(3),
  '```text\n'+source+'\n```','“'+source+'”','참고문헌\n'+source])assert.equal(furniture.removeRunningHeaders(text).text,text);
});
test('ambiguous byline and captions use literal ownership across layout, chunks and structure planning',()=>{
 const p=preflight(source).text;
 const caption='영화 <가상의 마을(2020)> 영화 <가상의 도시(2022)>';
 assert.equal(layout.classifyLine(caption),'signature');assert.equal(layout.classifyLine(header),'signature');
 const plan=chunks(p,{coalesceEditable:true});assert.ok(plan.chunks.some(c=>c.locked&&c.text.includes(caption)));
 const doc=document.buildDocument(source),b=doc.blocks.find(b=>b.text===caption);assert.equal(b.kind,'protected');
 assert.equal(document.applyPlan(doc,document.identityPlan(doc)).text,doc.source);
 assert.equal(preflight(p).text,p);
});
test('ordinary mention of film, inline titles, colon prose and citations remain editable',()=>{
 for(const line of ['영화 <가상의 마을(2020)>은 공간을 탐구한다.','영화는 공동체의 경험을 보여 준다.','이 작품은 <도시>를 참고한 것이다.']){
  assert.equal(furniture.isCaption(line),false);assert.notEqual(layout.classifyLine(line),'signature');
 }
});
test('caption/body fusion is a source-relative warning, not an automatic content deletion',()=>{
 const caption='영화 <가상의 도시(2022)>',s='이제 공간을 분석한다.\n'+caption+'\n인물은 도시에 머문다.';
 const audit=require('../engine-gpt-prod/fragmentIntegrity').auditFragmentIntegrity;
 assert.ok(audit(s,s).pass);assert.ok(audit(s,s.replaceAll('\n','\n\n')).pass);
 assert.ok(audit(s,s.replace('\n',' ')).codes.includes('introduced_furniture_body_fusion'));
 assert.ok(audit('이 글은 이미 '+caption+'를 인용한다.','이 글은 '+caption+'를 인용한다.').pass);
});
test('hyphenated nominal subsection is one owned heading, but numbered complete prose stays editable',()=>{
 const heading='2-3. 지역 공동체의 변화 방향';
 const s='2. 조사 결과\n주민들은 공간의 변화를 관찰하였다.\n'+heading+'\n연구자는 차이를 비교하고 결과를 기록하였다.';
 const plan=chunks(s,{coalesceEditable:true});
 assert.equal(layout.classifyLine(heading),'heading');
 assert.ok(plan.chunks.some(c=>c.lockType==='heading'&&c.text===heading));
 assert.notEqual(layout.classifyLine('2-3. 주민들은 공간을 비교하고 결과를 기록하였다.'),'heading');
 const engine=require('../engine-gpt-prod');
 const candidate=s.replace(heading+'\n',heading+' ').replace('차이를 비교하고','차이를 대조하고');
 const restored=engine.prepareGeneralSurfaceCandidate({source:s,candidate,chunks:plan.chunks});
 assert.ok(restored.text.includes(heading+'\n'));
 assert.ok(restored.text.includes('차이를 대조하고'));
 assert.equal(require('../engine-gpt-prod/structureChunk').buildStructureAudit({source:s,outputText:restored.text,chunks:plan.chunks,plan}).pass,true);
});
test('post-semantic layout keeps independent caption boundaries and the meaning repair',()=>{
 const s='1. 지역 기록\n연구자는 지역의 변화를 설명한다.\n영화 <가상의 지역(2020)>\n이를 통해 공동체의 역할을 살펴볼 수 있다.';
 const plan=chunks(s,{coalesceEditable:true});
 const r=require('../engine-gpt-prod/structureChunk').restorePostSemanticLayout({source:s,outputText:s.replaceAll('\n',' '),chunks:plan.chunks,mode:'assignment'});
 assert.equal(r.structuralPass,true);
 assert.match(r.text,/\n영화 <가상의 지역\(2020\)>\n/u);
 assert.ok(r.text.includes('이를 통해'));
 assert.equal(furniture.auditFurnitureBoundaries(s,r.text).length,0);
 assert.equal(r.text.replace(/\s/gu,''),s.replace(/\s/gu,''));
});
test('a source-attested contrast lead cannot disappear between otherwise unchanged sentences',()=>{
 const {droppedSourceContrastLead: dropped}=require('../engine-gpt-prod/clauseCoverage');
 const intro='이제 이 관점을 지역의 시설에 적용해 살펴보고자 한다.';
 const lead='이 건축물은 지역의 주민을 위한 공동 시설이다.';
 const right='하지만 민간 기관에서는 이를 이용하기 어렵다는 제약이 남아 있다.';
 const source=intro+' '+lead.replace('이다.','이지만,')+' 민간 기관에서는 이를 이용하기 어렵다는 제약이 남아 있다.';
 const before=intro+'\n'+lead+' '+right,after=intro+'\n'+right;
 assert.equal(dropped(source,before,after),true);
 assert.equal(dropped(source,before,before),false);
 assert.equal(dropped(source,before,before.replace(lead,'지역 주민들이 공동으로 사용하는 건축물이다.')),false);
 assert.equal(dropped(source,before,source),false); // legitimate sentence merge
 assert.equal(dropped('서로 다른 새로운 내용이다.',before,after),false);
 assert.equal(dropped(source,'“'+before+'”','“'+after+'”'),false);
 assert.equal(dropped(source,'```\n'+before+'\n```','```\n'+after+'\n```'),false);
});
test('caption title quotation marks do not hide a newly fused caption from audit',()=>{
 for(const caption of ['영화 〈가상의 도시〉','영화 《가상의 도시》']) {
  const s='관찰 내용은 다음과 같다.\n'+caption+'\n도시의 변화를 살펴본다.';
  assert.equal(furniture.auditFurnitureBoundaries(s,s.replaceAll('\n',' ')).length,1);
  assert.equal(furniture.auditFurnitureBoundaries('```\n'+s+'\n```','```\n'+s.replaceAll('\n',' ')+'\n```').length,0);
 }
});
test('late repair cannot copy an attested sentence into another paragraph',()=>{
 const copy=require('../engine-gpt-prod/candidateIntegrity').introducedExactProseCopy;
 const a='도시의 공동 공간은 주민들이 일상적인 문제를 함께 다루는 장소로 활용된다.';
 const b='조사자는 서로 다른 지역에서 관찰한 결과를 비교하여 공통적인 특징을 정리하였다.';
 const s=a+'\n\n'+b;
 assert.equal(copy(s,s,s+'\n\n'+a),true);
 assert.equal(copy(s,s,s.replace('공동 공간은','공동 공간은,')),false);
 assert.equal(copy(s+'\n'+a,s,s+'\n'+a),false); // source-authorized repetition
 assert.equal(copy('“'+a+'”','“'+a+'”','“'+a+'”\n“'+a+'”'),false);
 assert.equal(copy('```\n'+a+'\n```','```\n'+a+'\n```','```\n'+a+'\n'+a+'\n```'),false);
});
test('priority comparison cannot become categorical exclusion during a rewrite',()=>{
 const f=require('../engine-gpt-prod/fingerprintAudit');
 const s='중요한 것은 장비 자체보다 장비를 어떤 책임감으로 사용하는가이다.';
 const bad='중요한 것은 장비 자체가 아니라 장비를 어떤 책임감으로 사용하느냐이다.';
 assert.ok(f.auditFingerprint(s,bad).semanticRelations.shifts.some(x=>x.family==='priority_changed_to_exclusion'));
 assert.ok(!f.auditFingerprint(s,s).semanticRelations.shifts.some(x=>x.family==='priority_changed_to_exclusion'));
});
