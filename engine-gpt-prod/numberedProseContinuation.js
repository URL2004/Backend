'use strict';
const {syntaxSpans}=require('../engine/textSyntax');
// A numbered sentence ending in a coordinator cannot end there. Join only a
// directly adjacent, complete continuation; preserve all literal characters.
function repairNumberedProseContinuation(value){
 const source=String(value||''),lines=source.split('\n'),spans=syntaxSpans(source),changes=[];let offset=0;
 for(let i=0;i<lines.length-1;i++){
  const left=lines[i],nextOffset=offset+left.length+1;
  const continuations=[];
  for(let j=i+1;j<=Math.min(i+3,lines.length-1);j++){
    const line=lines[j],part=line.trim();
    if(!part||/[\t|`~]/u.test(line)||/^\s*(?:\d+[.)]|[-*•#>]|[①-⑳]|[ⅠⅡⅢⅣⅤ]|[\[【])/u.test(part))break;
    continuations.push(line);
    if(/(?:다|요)[.!?。！？]$/u.test(part))break;
  }
  const right=continuations.join('\n'),a=left.trim(),b=continuations.map(x=>x.trim()).join(' '),boundary=offset+left.trimEnd().length;
  if(/^\d{1,2}[.)]\s+/u.test(a)&&a.length>=40&&a.length<=160
      &&/(?:통해|에서|하며|하여|면서|했으며)\s/u.test(a)&&/\s(?:및|또는|그리고)$/u.test(a)
      &&b.length>=25&&b.length<=240&&/(?:다|요)[.!?。！？]$/u.test(b)
      &&!/[\t|`~]/u.test(left+right)&&!/^\s*(?:\d+[.)]|[-*•#>]|[①-⑳]|[ⅠⅡⅢⅣⅤ]|[\[【])/u.test(b)
      &&!spans.some(s=>s.start<nextOffset+right.length&&s.end>offset&&s.spanType==='code')
      &&!spans.some(s=>s.start<nextOffset&&s.end>boundary)){
    let at=offset;const rows=[left,...continuations],proposals=[];
    for(let j=0;j<rows.length-1;j++){
      const end=at+rows[j].length+1+rows[j+1].length-rows[j+1].trimStart().length;
      const start=at+rows[j].trimEnd().length;
      proposals.push({start,end,separator:' ',
      code:'source_numbered_prose_continuation_repaired',lineOrdinal:i+1,action:'repaired',
      message:'번호 문장의 나열 표현 뒤에서 끊긴 줄을 이어 본문이 중간에서 나뉘지 않도록 했어요.'});
      at+=rows[j].length+1;
    }
    if(!proposals.some(c=>spans.some(s=>s.start<c.end&&s.end>c.start)))changes.push(...proposals);
  }
  offset=nextOffset;
 }
 let text=source;for(const c of [...changes].reverse())text=text.slice(0,c.start)+c.separator+text.slice(c.end);
 return {text,changes};
}
module.exports={repairNumberedProseContinuation};
