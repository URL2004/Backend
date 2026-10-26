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
function repairFusedNumberedReport(value) {
  const source = String(value || '');
  // A flattened labelled report with a complete 1..N section sequence. Dates,
  // decimal references, compact inline lists and literal examples do not own
  // these boundaries. Insert whitespace only, never guess missing headings.
  if (!/^\[[^\]\n]{2,80}\]/u.test(source) || /[`~]{3}|\t|^\s*\|/mu.test(source)) return { text: source, changes: [] };
  const protectedRanges = require('../engine/textSyntax').syntaxSpans(source);
  const markers = [...source.matchAll(/(?<![\d.])([1-9]\d?)\.[ \t]+(?=[가-힣]|\d+번)/gu)]
    .filter(m => !protectedRanges.some(s => s.start <= m.index && s.end > m.index));
  if (markers.length < 3 || markers.length > 30
      || markers.some((m, i) => Number(m[1]) !== i + 1)
      || markers.some((m, i) => (markers[i + 1]?.index ?? source.length) - m.index < 70)) return { text: source, changes: [] };
  let text = source;
  for (const marker of [...markers].reverse()) {
    if (marker.index && !/\n[ \t]*$/u.test(source.slice(0, marker.index))) text = text.slice(0, marker.index) + '\n' + text.slice(marker.index);
  }
  // Common form labels are explicit in a qualifying numbered report. Do not
  // infer labels in arbitrary essays or split a grammatical particle from one.
  const labels = '(?:주제\\s*선정\\s*이유|주제\\s*관련\\s*지식(?:\\s*[（(]조사\\s*내용[）)])?|주제를\\s*탐구하며\\s*궁금한\\s*점(?:\\s*혹은\\s*더\\s*알고\\s*싶은\\s*점)?|\\d+번에\\s*대한\\s*답|탐구를\\s*통해\\s*배운\\s*점(?:\\s*또는\\s*성장한\\s*점)?|탐구\\s*내용\\s*요약하기)';
  const label = new RegExp('^(\\d+\\.[ \\t]+' + labels + ')([^\\n]+)$', 'u');
  text = text.split('\n').map(line => {
    const match = line.match(label);
    if (!match || /^(?:은|는|이|가|을|를|의|와|과|에|도|만)(?:\s|$)/u.test(match[2])
        || match[2].trim().length < 40 || !/[.!?。！？]/u.test(match[2])) return line;
    return match[1] + '\n' + match[2].trimStart();
  }).join('\n');
  text = text.replace(/^(\[[^\]\n]{2,80}\])[ \t]*(탐구[ \t]*제목)(?=[가-힣])/u, '$1\n$2\n');
  return { text, changes: text === source ? [] : [{ code: 'source_inline_heading_repaired', lineOrdinal: 1,
    message: '붙어 있던 연속 절 번호의 경계를 복원했어요.' }] };
}
module.exports={repairFusedReportLayout, repairFusedNumberedReport};
