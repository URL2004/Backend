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
// A physical PDF row can split the prose after an inline label. Join only the
// immediately adjacent, unfinished sentence: no blank paragraphs, new labels,
// tables, quotations or code may be crossed. Preserve every non-space byte.
function repairInlineLabelContinuations(value) {
  let text = String(value || '');
  let repairCount = 0;
  const records = layout.buildLineRecords(text), literals = syntaxSpans(text);
  const edits = [];
  for (let i = 0; i < records.length - 1; i++) {
    const left = records[i], right = records[i + 1];
    if (left.role !== 'label_inline' || right.role !== 'prose' || right.blank
        || layout.isSentenceComplete(left.text) || !layout.isSentenceComplete(right.text)
        || left.text.length < 40 || right.text.length < 12
        || /\t|\S {2,}\S/u.test(left.raw + right.raw)) continue;
    const start = left.end - (left.raw.length - left.raw.trimEnd().length);
    const end = right.start + right.raw.length - right.raw.trimStart().length;
    if (!/^[ \t]*\n[ \t]*$/u.test(text.slice(start, end))) continue;
    if (literals.some(s => s.start < right.end && s.end > left.start)) continue;
    edits.push({ start, end });
  }
  for (const e of edits.reverse()) {
    text = text.slice(0, e.start) + ' ' + text.slice(e.end);
    repairCount++;
  }
  return { text, applied: repairCount > 0, repairCount, contentPreserved: bare(text) === bare(value) };
}
// A witnessed standalone colon label followed by two more short labels at
// sentence boundaries is an explicit section sequence. Restore only the
// start of each label, never guess where its subtitle ends or invent a title.
function repairEmbeddedLabelBoundaries(value) {
  const text=String(value||'');
  const tokens=[...text.matchAll(/([.!?。！？])[ \t]*([가-힣A-Za-z][가-힣A-Za-z _-]{0,15})[:：][ \t]+/gu)];
  if(tokens.length<2||tokens.length>40)return {text,changes:[]};
  const records=layout.buildLineRecords(text), literals=syntaxSpans(text);
  const protectedAt=(start,end)=>literals.some(s=>['quote','code'].includes(s.spanType)&&s.start<end&&s.end>start);
  const witness=records.find(r=>r.role==='label_inline'&&r.text.length<=100
    && !layout.isSentenceComplete(r.text) && !protectedAt(r.start,r.end));
  if(!witness)return {text,changes:[]};
  const matches=tokens
    .filter(m=>{
      const start=m.index+1+m[0].slice(1).search(/\S/u);
      const r=records.find(r=>r.start<=start&&r.end>=start);
      return r && ['prose','label_inline'].includes(r.role) && start>witness.end
        && !protectedAt(m.index,m.index+m[0].length)
        && !/(?:한다|했다|이다|였다|있다|없다|하는|하면|하며)$/u.test(m[2]);
    });
  if(matches.length<2||matches.length>40||new Set(matches.map(m=>m[2])).size!==matches.length)return {text,changes:[]};
  for(let i=0;i<matches.length;i++){
    const m=matches[i],body=text.slice(m.index+m[0].length,matches[i+1]?.index??text.length);
    if(bare(body).length<60||!/[.!?。！？]/u.test(body))return {text,changes:[]};
  }
  let result=text;
  for(const m of matches.reverse()){
    const start=m.index+1,end=start+m[0].slice(1).search(/\S/u);
    result=result.slice(0,start)+'\n\n'+result.slice(end);
  }
  return {text:result,changes:[{code:'source_embedded_label_boundary',lineOrdinal:1,
    message:'반복되는 명시적 라벨 앞의 문단 경계를 복원했어요.'}]};
}
module.exports={improveInlineLabelLayout,isSafeLabelBodyLayout,repairInlineLabelContinuations,repairEmbeddedLabelBoundaries};
