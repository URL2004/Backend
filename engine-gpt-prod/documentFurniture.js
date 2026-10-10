'use strict';

// Text-only evidence is weaker than PDF coordinates. Never remove arbitrary
// repeated prose: require a witnessed cover title AND author line, separated
// repeated title/byline rows. Ambiguous metadata stays a protected literal.
const { referenceLineFlags } = require('../engine/freezeblocks');
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
  const referenceFlags = referenceLineFlags(source);
  const rows=[]; let start=0;
  for(const raw of source.split('\n')) {
    rows.push({raw,text:raw.trim(),start,end:start+raw.length,index:rows.length,reference:referenceFlags[rows.length]});start+=raw.length+1;
  }
  const protectedAt = row => spans.some(s=>s.start<row.end && s.end>row.start)
    || /^\s*>/u.test(row.raw) || /\t/u.test(row.raw);
  for(const row of rows) {
    const first=row.start+row.raw.indexOf(row.text),last=first+row.text.length;
    // A quoted title inside a caption does not exempt its surrounding row.
    row.literal=spans.some(s=>s.start<=first&&s.end>=last)
      || /^\s*>/u.test(row.raw) || /\t/u.test(row.raw);
  }
  const groups = new Map();
  for(const row of rows) {
    if(row.reference || protectedAt(row))continue;
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
  const edits=removable.map(r=>({start:r.start,end:Math.min(source.length,r.end+1),ordinal:r.index+1}));
  const literals=syntaxSpans(source).filter(s=>['quote','code'].includes(s.spanType));
  // A previous rewrite may have embedded the SAME evidenced running header.
  // Recover only exact parenthetical furniture, or a row seam with unfinished
  // prose / a caption on its right. Ordinary quoted mentions remain untouched.
  for(const literal of new Set(removable.map(r=>r.text))) {
    let cursor=0;
    while(cursor<source.length) {
      const start=source.indexOf(literal,cursor);if(start<0)break;
      const end=start+literal.length;cursor=end;
      const row=rows.find(r=>r.start<=start&&r.end>=end);
      if(!row||row.reference||ids.has(row.index)||literals.some(s=>s.start<end&&s.end>start))continue;
      const left=source.slice(row.start,start),right=source.slice(end,row.end);
      if(/\t|\S {2,}\S/u.test(row.raw))continue;
      const parentheses=/\($/u.test(left)&&/^\)/u.test(right);
      const seam=left.trim()&&!/[.!?。！？][”’"']?\s*$/u.test(left)
        && /(?:을|를|의|과|와|해도|이고|에서|으로|대한|인)\s*$/u.test(left)
        && /^\s+[가-힣]/u.test(right);
      if(!parentheses&&!seam&&!isCaption(right.trim()))continue;
      edits.push({start:parentheses?start-1:start,end:parentheses?end+1:end,ordinal:row.index+1});
    }
  }
  let text=source;
  for(const e of edits.sort((a,b)=>b.start-a.start))text=text.slice(0,e.start)+text.slice(e.end);
  return {text,removed:edits.map(e=>({lineOrdinal:e.ordinal,code:'source_running_header_removed',action:'removed',
      message:'표지의 제목·작성자와 일치하며 반복되는 페이지 머리말을 본문에서 분리했어요.'}))};
}
function separateFusedCaptions(value) {
  const source=String(value||''),spans=syntaxSpans(source),edits=[];
  const referenceFlags=referenceLineFlags(source);
  let rowIndex=0,nextLine=source.indexOf('\n');
  const pattern=/(?:(?:영화|도서|작품|사진)\s*[<〈《][^<>〈〉《》\n]{1,100}[>〉》][ \t]*)+/gu;
  for(const m of source.matchAll(pattern)) {
    const start=m.index,end=start+m[0].trimEnd().length;
    while(nextLine>=0&&nextLine<start){rowIndex++;nextLine=source.indexOf('\n',nextLine+1);}
    if(referenceFlags[rowIndex])continue;
    if(spans.some(s=>(s.spanType==='code'||s.start<start)&&s.start<end&&s.end>start))continue;
    const rowStart=source.lastIndexOf('\n',start-1)+1,next=source.indexOf('\n',end),rowEnd=next<0?source.length:next;
    const left=source.slice(rowStart,start),right=source.slice(end,rowEnd);
    if(left.trim()&&!/[.!?。！？][”’"']?\s*$/u.test(left))continue;
    // A particle attached to a work title makes it a prose mention, not a caption.
    if(right.trim()&&(!/^\s+[가-힣]/u.test(right)||/^(?:은|는|이|가|을|를|의|와|과|에서)(?:\s|[가-힣])/u.test(right.trim())
        ||right.trim().length<20||!/[.!?。！？]$/u.test(right.trim())))continue;
    if(left.trim())edits.push({start:rowStart+left.trimEnd().length,end:start});
    if(right.trim())edits.push({start:end,end:end+right.length-right.trimStart().length});
  }
  let text=source;for(const e of edits.sort((a,b)=>b.start-a.start))text=text.slice(0,e.start)+'\n'+text.slice(e.end);
  return {text,applied:edits.length>0,count:edits.length};
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
module.exports={isCaption,isBylineHeader,analyzeFurniture,removeRunningHeaders,separateFusedCaptions,auditFurnitureBoundaries};
