'use strict';
const {syntaxSpans}=require('../engine/textSyntax');

// Preserve excerpt contents and inline page attribution. Only a source-backed
// standalone quoted row may receive a visual paragraph gap before commentary.
function citedRows(value) {
  const text=String(value||''), rows=[];
  const spans=syntaxSpans(text);
  for(const m of text.matchAll(/[^\n]+/gu)) {
    const row=m[0].trim();
    const page=row.match(/\((?:p{1,2}\.\s*\d+(?:[-–~]\d+)?|\d+(?:[-–~]\d+)?\s*(?:p|쪽))\)\s*$/iu);
    if(!page||!/^['"“‘「『]/u.test(row))continue;
    const start=m.index+m[0].indexOf(row),end=start+row.length;
    if(spans.some(s=>s.spanType==='code'&&s.start<end&&s.end>start))continue;
    const quote=spans.find(s=>s.spanType==='quote'&&s.start===start&&s.end<=end-page[0].length);
    if(!quote||quote.end-quote.start<20)continue;
    rows.push({start,end,page:page[0].replace(/\s/gu,''),quote:text.slice(quote.start,quote.end).replace(/\s/gu,'')});
  }
  return rows;
}
function separateCitedQuoteCommentary(source,output) {
  const text=String(output||''), src=citedRows(source), rows=citedRows(text), edits=[];
  for(const row of rows) {
    const matches=src.filter(s=>s.page===row.page&&s.quote===row.quote);
    if(matches.length!==1||rows.filter(s=>s.page===row.page&&s.quote===row.quote).length!==1)continue;
    const gap=/^[ \t\r]*\n[ \t]*/u.exec(text.slice(row.end));
    if(!gap||/^\s*$/u.test(text.slice(row.end+gap[0].length))||text[row.end+gap[0].length]==='\n')continue;
    if(/^(?:라고|하고|라는|이라는|이라고|라며|하며|에서|으로|로|는|은|의|을|를)(?:\s|[가-힣])/u.test(text.slice(row.end+gap[0].length)))continue;
    edits.push({start:row.end,end:row.end+gap[0].length});
  }
  let result=text;
  for(const edit of edits.reverse()) result=result.slice(0,edit.start)+'\n\n'+result.slice(edit.end);
  return {text:result,repairCount:edits.length};
}
module.exports={separateCitedQuoteCommentary};
