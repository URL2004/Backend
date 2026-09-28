'use strict';

// Hints are not verdicts. Never carry a previous revision's quotations into a
// fresh audit as though they were still the current SOURCE / REWRITE.
function currentReviewHints(signals, source, output) {
  const unique=(text,span)=>typeof span==='string'&&span.length>0
    &&text.indexOf(span)>=0&&text.indexOf(span)===text.lastIndexOf(span);
  const paired=v=>unique(source,v.sourceSpan)&&unique(output,v.candidateSpan||v.outputSpan);
  return (signals||[]).flatMap(value=>{
    if(typeof value!=='string')return [];
    let item;try{item=JSON.parse(value);}catch{return [value];}
    if(!item||typeof item!=='object'||Array.isArray(item))return [];
    if(item.code==='prior_semantic_findings') {
      const findings=(item.findings||[]).filter(paired);
      return findings.length?[JSON.stringify({...item,findings})]:[];
    }
    if(Object.hasOwn(item,'sourceSpan')||Object.hasOwn(item,'outputSpan')||Object.hasOwn(item,'candidateSpan'))
      return paired(item)?[value]:[];
    return [value];
  });
}
module.exports={currentReviewHints};
