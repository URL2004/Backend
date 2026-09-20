'use strict';
const layout = require('./layoutStructure');
const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const { splitProseParagraphs } = require('./proseParagraphs');
const bare = text => String(text || '').replace(/\s/gu, '');

// A label owns its prefix, not an unlimited one-line body. Keep edits purely
// whitespace-based; headings, formulas, quotations and code are not new prose.
function improveInlineLabelLayout(value, {strength='basic',protectedBlocks=[]}={}) {
  const text=String(value||''),records=layout.buildLineRecords(text),literals=syntaxSpans(text);
  const edits=[];let splitCount=0,gapCount=0,spacingCount=0;
  for(let i=0;i<records.length;i++) {
    const r=records[i]; if(r.role!=='label_inline')continue;
    if(literals.some(s=>['quote','code'].includes(s.spanType)&&s.start<=r.start&&s.end>=r.end))continue;
    if(protectedBlocks.some(b=>bare(b).includes(bare(r.text))))continue;
    const raw=text.slice(r.start,r.end),parts=layout.labelParts(raw);
    if(!parts?.rest)continue;
    const colon=raw.search(/[:：]/u),tail=raw.slice(colon+1),body=tail.trimStart();
    const candidate=splitBody(body,strength);
    const processed=candidate.includes('\n')&&!isSafeLabelBodyLayout(candidate)?body:candidate;
    const prefix=raw.slice(0,colon+1);
    const replacement=prefix+' '+processed;
    if(replacement!==raw)edits.push({start:r.start,end:r.end,value:replacement});
    splitCount+=(processed.match(/\n\n/gu)||[]).length;
    if(!/^\s/u.test(tail))spacingCount++;
    const prev=records[i-1];
    if(prev&&!prev.blank&&['label_inline','prose'].includes(prev.role)
        && splitSentenceSpans(body).length>=2&&bare(body).length>=100) {
      edits.push({start:r.start,end:r.start,value:'\n'});gapCount++;
    }
  }
  let result=text;
  // Replace a line before inserting a gap at the same start offset.
  for(const e of edits.sort((a,b)=>b.start-a.start||b.end-a.end))result=result.slice(0,e.start)+e.value+result.slice(e.end);
  return {text:result,splitCount,gapCount,spacingCount,applied:result!==text,contentPreserved:bare(result)===bare(text)};
}

function splitBody(body,strength) {
  const initial=splitProseParagraphs(body,{strength}).text;
  return initial.split(/\n\s*\n/u).flatMap(block=>{
    const spans=splitSentenceSpans(block),literals=syntaxSpans(block),cuts=[];let last=0;
    for(let i=2;i<spans.length-1;i++) {
      if(i-last<2)continue;
      const left=block.slice(spans[last].start,spans[i-1].end),right=block.slice(spans[i].start);
      if(bare(left).length<100||bare(right).length<100)continue;
      const alternative=/(?:대신할|대체할|대체\s*할|대안으로|다른\s*방법으로)/u.test(spans[i].text)
        && /(?:있습니다|있다|소개|사용|활용)/u.test(spans[i].text);
      const lengthBreak=bare(left).length>=380&&spans.length>=7;
      if(!alternative&&!lengthBreak)continue;
      const a=spans[i-1].end,b=spans[i].start;
      if(!layout.isSentenceComplete(spans[i-1].text)||!/^\s+$/u.test(block.slice(a,b)))continue;
      if(literals.some(s=>s.start<b&&s.end>a))continue;
      cuts.push({a,b});last=i;
    }
    let result=block;for(const c of cuts.reverse())result=result.slice(0,c.a)+'\n\n'+result.slice(c.b);
    return result;
  }).join('\n\n');
}

// Structural restoration still joins broken sentences, but no longer erases
// complete, developed prose paragraphs merely because a label precedes them.
function isSafeLabelBodyLayout(value) {
  const text=String(value||'');
  if(!text.includes('\n'))return false;
  const literals=syntaxSpans(text);
  if(literals.some(s=>s.spanType==='code'||text.slice(s.start,s.end).includes('\n')))return false;
  const lines=text.split(/\n+/u).map(s=>s.trim()).filter(Boolean);
  return lines.length>=2&&lines.every(line=>layout.classifyLine(line)==='prose'
    &&layout.isSentenceComplete(line)&&splitSentenceSpans(line).length>=2&&bare(line).length>=60);
}
module.exports={improveInlineLabelLayout,isSafeLabelBodyLayout};
