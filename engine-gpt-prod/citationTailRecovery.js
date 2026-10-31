'use strict';
const { syntaxSpans } = require('../engine/textSyntax');

// Restore only an introduced repetition of an ordered, source-owned citation
// tail. Digits inside equations, quotations and code are never rewritten.
function restoreRepeatedCitationTails(source, candidate) {
  const src=String(source ?? ''),out=String(candidate ?? '');
  const inventory=text=>{
    const protectedSpans=syntaxSpans(text);
    return [...text.matchAll(/(?<=[.!?。！？])[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,16}(?=\s|$)/gu)]
      .filter(m=>!protectedSpans.some(p=>p.start<m.index+m[0].length&&p.end>m.index));
  };
  const a=inventory(src),b=inventory(out),edits=[];
  if(a.length!==b.length)return {text:out,restoredCount:0};
  // All ordered tails must either match or be an exact duplication. This
  // prevents ordinal alignment across a missing or inserted reference.
  if(a.some((m,i)=>b[i][0]!==m[0]&&b[i][0]!==m[0]+m[0]))return {text:out,restoredCount:0};
  for(let i=0;i<a.length;i++){
    if(a[i][0]===b[i][0]||a.some(m=>m[0]===b[i][0]))continue;
    let shared=0;
    while(shared<32&&shared<a[i].index&&shared<b[i].index
      &&src[a[i].index-shared-1]===out[b[i].index-shared-1]
      &&(shared===0||!/[\r\n.!?。！？]/u.test(src[a[i].index-shared-1])))shared++;
    if(shared<12)continue;
    const anchor=src.slice(a[i].index-shared,a[i].index);
    const left=anchor+a[i][0],right=anchor+b[i][0];
    if(src.indexOf(left)!==src.lastIndexOf(left)||out.indexOf(right)!==out.lastIndexOf(right))continue;
    edits.push({start:b[i].index,end:b[i].index+b[i][0].length,text:a[i][0]});
  }
  let text=out;
  for(const e of edits.reverse())text=text.slice(0,e.start)+e.text+text.slice(e.end);
  return {text,restoredCount:edits.length};
}
module.exports={restoreRepeatedCitationTails};
