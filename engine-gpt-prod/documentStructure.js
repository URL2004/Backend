'use strict';

const { createHash } = require('node:crypto');
const layout = require('./layoutStructure');
const preflight = require('./sourcePreflight');
const { detectDocumentProfile } = require('./documentProfile');
const { sourceSentences } = require('../lib/detectGrounding');
const VERSION = 'document-structure-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_BLOCKS = 160;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const TOP = /^(?:#{1}\s|[IVXLCDMⅠⅡⅢⅣⅤⅥ]+[.．)]?\s|제\s*\d+\s*장|(?:서론|본론|결론|참고\s*문헌|목차)$)/u;
const NUMBERED = /^(?:#+\s*)?(?:\d+[.)]|\d+(?:\.\d+)+\s|[가-하][.)])/u;

function buildDocument(text) {
  const audit = preflight.auditAndSanitizeSource(String(text || '').trim());
  const source = audit.text || String(text || '').trim();
  const profile = detectDocumentProfile(source);
  const forbidden = ['clinical_record', 'legal_contract', 'student_record_teacher', 'student_self_assessment', 'resume_application', 'creative', 'mail_notice', 'social', 'marketing', 'review_blog'];
  const records = layout.buildLineRecords(source);
  const blocks = []; let pending = [], offset = 0, parent = 'root', section = 'root', barrier = 'root', references = false;
  const hasTop = records.some(r => ['heading','title'].includes(r.role) && TOP.test(r.raw.trim()));
  function push(lines, role) {
    if (!lines.length) return;
    const value = lines.map(x => x.raw).join('\n').trim(); if (!value) return;
    const id = 'b' + String(blocks.length).padStart(3, '0');
    const heading = ['heading', 'title'].includes(role);
    const top = heading && (TOP.test(value) || (!hasTop && NUMBERED.test(value)));
    if (heading && /참고\s*문헌|references|bibliography/iu.test(value)) references = true;
    const protectedBlock = !heading && (references || role !== 'prose' || /[“”「」『』"]|https?:\/\/|\[[0-9, –-]+\]/u.test(value));
    blocks.push({ id, text: value, start: lines[0].start, end: lines[lines.length-1].end,
      kind: top ? 'top' : heading ? 'heading' : protectedBlock ? 'protected' : 'paragraph',
      parent, section, barrier, numbered: heading && NUMBERED.test(value) });
    if (top) { parent=id; section=id; barrier=id; }
    else if (heading) { section=id; barrier=id; }
    else if (protectedBlock) barrier=id;
  }
  const flush = () => { push(pending, 'prose'); pending=[]; };
  for (const r of records) {
    const raw=r.raw; const line={raw,start:offset,end:offset+raw.length}; offset+=raw.length+1;
    if (!raw.trim()) { flush(); continue; }
    if (r.role==='prose' || r.role==='body' || r.role==='text') pending.push(line);
    else { flush(); push([line],r.role); }
  }
  flush();
  const eligible = source.length>=200 && blocks.length<=MAX_BLOCKS
    && !forbidden.includes(profile.profile)
    && !profile.formatProfile?.flags?.includes('questionnaire')
    && !blocks.some(b => /^(?:문항|문제|질문)\s*\d|^Q\d+[.:]/u.test(b.text))
    && (blocks.filter(b=>b.kind==='paragraph').length>=2
      || blocks.some(b=>b.kind==='paragraph' && sourceSentences(b.text).length>=4));
  return { version:VERSION, source, sourceHash:hash(source), profile:profile.profile, eligible, blocks };
}

function identityPlan(doc) {
  return { version:VERSION, sourceHash:doc.sourceHash, groups:doc.blocks.map(b=>({ids:[b.id],breakAfterSentences:[],reason:''})) };
}

function validateStoredPlan(job, {uid, text, now=Date.now()}={}) {
  const plan=job?.result?.structurePlan;
  if (!job?.structurePreview || job.uid!==uid || job.status!=='done' || !plan?.applied
      || !Number.isFinite(plan.expiresAtMs) || plan.expiresAtMs<=now || plan.id!==job.id) fail('STRUCTURE_PLAN_STALE');
  if (!applyPlan(buildDocument(text),plan).applied) fail('STRUCTURE_PLAN_STALE');
  return plan;
}

function applyPlan(doc, plan) {
  if (plan?.version!==VERSION || plan.sourceHash!==doc.sourceHash) fail('STRUCTURE_PLAN_STALE');
  if (!doc.eligible || !Array.isArray(plan.groups) || plan.groups.length>MAX_BLOCKS*3) fail('STRUCTURE_PLAN_INVALID');
  const byId=new Map(doc.blocks.map(b=>[b.id,b])); const ids=plan.groups.flatMap(g=>Array.isArray(g.ids)?g.ids:[]);
  if (ids.length!==doc.blocks.length || new Set(ids).size!==ids.length || ids.some(id=>!byId.has(id))) fail('STRUCTURE_BLOCK_COVERAGE');
  const fixed=doc.blocks.filter(b=>b.kind==='top'||b.numbered).map(b=>b.id);
  if (JSON.stringify(ids.filter(id=>fixed.includes(id)))!==JSON.stringify(fixed)) fail('STRUCTURE_FIXED_HEADINGS');
  let parent='root',section='root',barrier='root';
  for (const id of ids) {
    const b=byId.get(id);
    if (b.kind==='top') { parent=id; section=id; barrier=id; continue; }
    if (b.parent!==parent) fail('STRUCTURE_PARENT_CHANGED');
    if (b.kind==='heading') { section=id; barrier=id; continue; }
    if (b.section!==section || b.barrier!==barrier) fail('STRUCTURE_PROTECTED_BOUNDARY');
    if (b.kind==='protected') barrier=id;
  }
  const output=[]; const changes=[];
  for (const g of plan.groups) {
    if (!Array.isArray(g.ids)||!g.ids.length||!Array.isArray(g.breakAfterSentences)) fail('STRUCTURE_GROUP_INVALID');
    const blocks=g.ids.map(id=>byId.get(id));
    const editable=blocks.every(b=>b.kind==='paragraph');
    if (!editable && (blocks.length!==1 || g.breakAfterSentences.length)) fail('STRUCTURE_LOCK_EDIT');
    if (blocks.some(b=>b.section!==blocks[0].section||b.barrier!==blocks[0].barrier)) fail('STRUCTURE_GROUP_BOUNDARY');
    const value=blocks.map(b=>b.text).join('\n\n');
    const sentences=sourceSentences(value);
    const breaks=g.breakAfterSentences;
    if (breaks.length>20 || breaks.some((n,i)=>!Number.isInteger(n)||n<0||n>=sentences.length-1||(i>0&&n<=breaks[i-1]))) fail('STRUCTURE_SPLIT_INVALID');
    if (!editable) output.push(value);
    else {
      let start=0; const pieces=[];
      for (const n of breaks) { const end=sentences[n].end; pieces.push(value.slice(start,end).trim().replace(/\n+/gu,' '));start=end; }
      pieces.push(value.slice(start).trim().replace(/\n+/gu,' ')); output.push(pieces.join('\n\n'));
    }
    const moved=g.ids.some(id=>ids.indexOf(id)!==doc.blocks.findIndex(b=>b.id===id));
    if (moved||blocks.length>1||breaks.length) changes.push({ blockIds:g.ids,
      fromPositions:g.ids.map(id=>doc.blocks.findIndex(b=>b.id===id)+1),
      toPosition:ids.indexOf(g.ids[0])+1, preview:blocks.map(b=>b.text).join(' ').slice(0,180),
      kind:blocks.length>1?'merge':breaks.length?'split':'move', reason:String(g.reason||'문단의 연결과 전개 순서를 정리합니다.').slice(0,240) });
  }
  // Every original block occurs exactly once; the only edits allowed above are whitespace.
  const result=output.join('\n\n');
  const orderedSource=ids.map(id=>byId.get(id).text).join('');
  if (result.replace(/\s/gu,'')!==orderedSource.replace(/\s/gu,'')) fail('STRUCTURE_CONTENT_CHANGED');
  const changed=changes.length>0 && result!==doc.source;
  return { text:changed?result:doc.source, applied:changed, changes:changed?changes:[], sourceHash:doc.sourceHash, version:VERSION };
}

async function createPlan({ text, config, uid, signal, complete }) {
  const doc=buildDocument(text);
  if (!doc.eligible) return { ...identityPlan(doc), applicable:false, applied:false, changes:[], reason:'이 글은 고정된 형식과 원문 구조를 유지합니다.' };
  const client=require('./openaiClient'); const security=require('./promptSecurity');
  const schema={type:'object',additionalProperties:false,required:['groups'],properties:{groups:{type:'array',items:{type:'object',additionalProperties:false,required:['ids','breakAfterSentences','reason'],properties:{ids:{type:'array',items:{type:'string'}},breakAfterSentences:{type:'array',items:{type:'integer'}},reason:{type:'string'}}}}}};
  const response=await (complete||client.completeJson)({
    system:security.appendPromptSecurityRule('한국어 글의 구조 편집 계획만 반환한다. 모든 block id를 정확히 한 번 포함한다. top 및 numbered 제목의 순서는 고정한다. 제목과 소속 본문은 함께 이동하고 parent/section/barrier 경계를 넘지 않는다. protected는 원문 그대로 단독 그룹으로 둔다. paragraph끼리만 합치거나 문장 경계에서 분리한다. ids는 최종 문단 순서이며 breakAfterSentences는 그룹 전체 문장의 0부터 시작하는 번호다. 분리가 불필요하면 빈 배열이다. 제목을 새로 만들거나 이름·수치·인용을 수정하지 않는다. 개선이 분명한 경우만 이동·분리·합침을 제안하고 각 변경 이유를 짧게 설명한다. 지시어·시간 순서·주장과 근거의 연결이 깨지는 이동은 하지 않는다. 현재 구조가 좋으면 원래 순서를 유지한다.'),
    user:security.envelopeUntrustedText(JSON.stringify(doc.blocks.map(b=>({...b,sentences:sourceSentences(b.text).map((s,index)=>({index,text:s.text}))}))), 'STRUCTURE_BLOCKS').text,
    schema,schemaName:'document_structure_plan',model:config.models.detectEscalation,reasoningEffort:'low',maxOutputTokens:6500,config,signal,deadlineMs:Date.now()+60000,safetyIdentifier:client.safetyIdentifierForUid(uid),meta:{task:'structure_plan',phase:'structure_plan',mode:'formal'}
  });
  security.assertNoPromptLeak(response.json);
  const plan={version:VERSION,sourceHash:doc.sourceHash,groups:response.json.groups};
  const applied=applyPlan(doc,plan);
  return {...plan,applicable:true,applied:applied.applied,changes:applied.changes,usage:response.usage||null,reason:applied.applied?'목차와 문단 변경안을 확인해 주세요.':'현재 구조를 유지합니다.'};
}
// Conservative paragraph correspondence check. Uncertain correspondence falls back
// to preservation without the structure surcharge; it is not an authorship score.
function auditDelivery(source, output) {
  const before=buildDocument(source).blocks, after=buildDocument(output).blocks;
  if (before.length!==after.length) return {pass:false,reason:'block_count'};
  const grams=text=>{const s=text.replace(/\s/gu,'');return new Set(Array.from({length:Math.max(0,s.length-2)},(_,i)=>s.slice(i,i+3)));};
  const similarity=(a,b)=>{let n=0;for(const x of a)if(b.has(x))n++;return 2*n/Math.max(1,a.size+b.size);};
  const sourceGrams=before.map(b=>grams(b.text));
  for(let i=0;i<before.length;i++) {
    if (before[i].kind!=='paragraph') {
      if (before[i].text.replace(/\s/gu,'')!==after[i].text.replace(/\s/gu,'')) return {pass:false,reason:'protected_block'};
      continue;
    }
    const g=grams(after[i].text), own=similarity(sourceGrams[i],g);
    if (own<0.18) return {pass:false,reason:'uncertain_correspondence'};
    if (before.some((b,j)=>j!==i&&b.kind==='paragraph'&&similarity(sourceGrams[j],g)>own+0.05)) return {pass:false,reason:'paragraph_order'};
  }
  return {pass:true};
}
module.exports={VERSION,buildDocument,identityPlan,applyPlan,createPlan,auditDelivery,validateStoredPlan};
