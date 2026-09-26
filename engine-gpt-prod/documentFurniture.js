'use strict';

// Text-only evidence is weaker than PDF coordinates. Never remove arbitrary
// repeated prose: require a witnessed cover title AND author line, separated
// repeated title/byline rows. Ambiguous metadata stays a protected literal.
const { syntaxSpans } = require('../engine/textSyntax');
const compact = value => String(value).replace(/\s/gu, '');
const HEADER = /^([^｜|│\n]{8,100})[｜|│]\s*([가-힣]{2,5}(?:\s*[,·、]\s*[가-힣]{2,5}){0,5})$/u;
function isCaption(value) {
  const text = String(value || '').trim();
  return text.length <= 240 && (
    /^(?:(?:영화|도서|작품|사진)\s*[<〈《][^<>〈〉《》\n]{1,100}[>〉》]\s*)+$/u.test(text)
    || /^(?:\[?(?:그림|사진|도표|Figure|Fig\.)\s*\d+(?:[-.]\d+)*\]?)[.:：]?\s+[^\n]{1,160}$/iu.test(text)
  );
}
function isBylineHeader(value) { return HEADER.test(String(value || '').trim()); }
function analyzeFurniture(value) {
  const source = String(value || '');
  const spans = syntaxSpans(source).filter(s => s.spanType === 'quote' || s.spanType === 'code');
  const rows=[]; let start=0;
  for(const raw of source.split('\n')) {
    rows.push({raw,text:raw.trim(),start,end:start+raw.length,index:rows.length});start+=raw.length+1;
  }
  const protectedAt = row => spans.some(s=>s.start<row.end && s.end>row.start)
    || /^\s*>/u.test(row.raw) || /\t/u.test(row.raw);
  for(const row of rows) {
    const first=row.start+row.raw.indexOf(row.text),last=first+row.text.length;
    // A quoted title inside a caption does not exempt its surrounding row.
    row.literal=spans.some(s=>s.start<=first&&s.end>=last)
      || /^\s*>/u.test(row.raw) || /\t/u.test(row.raw);
  }
  const groups = new Map(); let references=false;
  for(const row of rows) {
    if(/^(?:#{1,6}\s*)?(?:참고\s*문헌|References|Bibliography)\s*$/iu.test(row.text)) references=true;
    if(references || protectedAt(row))continue;
    const m=row.text.match(HEADER); if(!m)continue;
    const key=compact(row.text), group=groups.get(key)||{title:m[1].trim(),authors:m[2],rows:[]};
    group.rows.push(row);groups.set(key,group);
  }
  const removable=[];
  for(const group of groups.values()) {
    if(group.rows.length<3 || group.rows.some((r,i)=>i && r.start-group.rows[i-1].end<250))continue;
    const cover=rows.filter(r=>r.index<group.rows[0].index && !protectedAt(r));
    const title=compact(group.title), authors=compact(group.authors).replace(/[,·、]/gu,'');
    if(!cover.some(r=>compact(r.text)===title) || !cover.some(r=>compact(r.text).replace(/[,·、]/gu,'')===authors))continue;
    removable.push(...group.rows);
  }
  return {rows,removable};
}
function removeRunningHeaders(value) {
  const source=String(value||''),{rows,removable}=analyzeFurniture(source);
  const ids=new Set(removable.map(r=>r.index));
  return {text:rows.filter(r=>!ids.has(r.index)).map(r=>r.raw).join('\n'),
    removed:removable.map(r=>({lineOrdinal:r.index+1,code:'source_running_header_removed',action:'removed',
      message:'표지의 제목·작성자와 일치하며 반복되는 페이지 머리말을 본문에서 분리했어요.'}))};
}
function auditFurnitureBoundaries(source, output) {
  const rows=analyzeFurniture(source).rows;
  const issues=[],seen=new Set();
  function inlineSpans(text,literal){
    const found=[];let cursor=0;
    while(cursor<text.length){const start=text.indexOf(literal,cursor);if(start<0)break;
      const end=start+literal.length,next=text.indexOf('\n',end);
      if(text.slice(text.lastIndexOf('\n',start-1)+1,start).trim()||text.slice(end,next<0?text.length:next).trim())found.push({start,end});
      cursor=end;
    }return found;
  }
  for(const row of rows) {
    if(row.literal || (!isCaption(row.text) && !isBylineHeader(row.text)))continue;
    // Exact source-owned literals only; no fuzzy extraction or speculative
    // removal from a generated sentence. Repeated source rows are counted once.
    if(seen.has(row.text))continue;seen.add(row.text);
    const previous=inlineSpans(source,row.text).length;
    for(const {start,end} of inlineSpans(output,row.text).slice(previous)){
      issues.push({code:'introduced_furniture_body_fusion',sourceStart:row.start,sourceEnd:row.end,outputStart:start,outputEnd:end});
      if(issues.length>=40)return issues;
    }
  }
  return issues;
}
module.exports={isCaption,isBylineHeader,analyzeFurniture,removeRunningHeaders,auditFurnitureBoundaries};
