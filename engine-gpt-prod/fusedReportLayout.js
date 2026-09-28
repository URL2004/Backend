'use strict';

// Only recover explicit anchors in a flattened report. This is not a table
// reconstruction heuristic: cells without delimiters remain unresolved.
function repairFusedReportLayout(value) {
  const source=String(value||'');
  if (!/^(?:과제명|보고서명|제목)\s*[:：]/u.test(source)
      || source.includes('```') || source.includes('~~~')) return {text:source,changes:[]};
  const field=/(?:교과목|과목명|작성자|제출일자|제출일)\s*[:：]/gu;
  const front=source.slice(0,500);
  const fields=[...front.matchAll(field)];
  if(new Set(fields.map(m=>m[0].replace(/[\s:：]/gu,''))).size<3) return {text:source,changes:[]};
  // A contiguous 1..N sequence, not dates/decimals or individual in-text
  // references, provides evidence for boundaries before numbered sections.
  const markers=[...source.matchAll(/(?<!\d)([1-9]\d?)\.[ \t]+(?=[가-힣])/gu)];
  if(markers.length<3 || markers.some((m,i)=>Number(m[1])!==i+1)) return {text:source,changes:[]};
  if(fields.some(m=>m.index>=markers[0].index)) return {text:source,changes:[]};
  const protectedRanges=[...source.matchAll(/(?:https?:\/\/[^\s<>"'()[\]]+|`[^`\n]+`|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|'[^'\n]*')/gu)]
    .map(m=>[m.index,m.index+m[0].length]);
  const positions=new Set();
  const add=p=>{if(p>0 && !protectedRanges.some(([a,b])=>p>a&&p<b)) positions.add(p);};
  for(const m of fields) add(m.index);
  for(const m of markers) add(m.index);
  // Bracket-delimited headings are explicit; citation numbers and inline
  // references with a following particle are not headings.
  for(const m of source.matchAll(/\[([가-힣][가-힣 ··-]{2,32})\]/gu)) {
    const end=m.index+m[0].length;
    if(/^(?:에서는|에서도|에는|에도|에서|에게|으로|까지|부터|보다|처럼|은|는|이|가|을|를|의|와|과|에|도|로|만)(?:\s|[,.])/u.test(source.slice(end))) continue;
    add(m.index);add(end);
  }
  let text=source;
  const insertedOffsets=[];
  for(const p of [...positions].sort((a,b)=>b-a)) {
    if(!/\n[ \t]*$/u.test(source.slice(0,p)) && !/^[ \t]*\r?\n/u.test(source.slice(p))) {
      text=text.slice(0,p)+'\n'+text.slice(p);insertedOffsets.push(p);
    }
  }
  return {text,insertedOffsets:insertedOffsets.sort((a,b)=>a-b),changes:text===source?[]:[{code:'source_explicit_report_boundaries_repaired',lineOrdinal:1,action:'repaired',
    message:'붙어 있던 표지 항목과 연속 절 번호·괄호 제목의 경계를 분리했어요.'}]};
}
module.exports={repairFusedReportLayout};
