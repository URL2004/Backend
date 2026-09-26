'use strict';

const { createHash } = require('node:crypto');
const layout = require('./layoutStructure');
const VERSION = 'layout-relations-v1';
const flat = value => String(value || '').replace(/\s+/gu, ' ').trim();
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');

// Non-text metadata only. Offsets are in the whitespace-run projection, so a
// new ordinary paragraph at a complete sentence is harmless, but a heading,
// list/label, table row or code line cannot silently acquire different content.
function relationDigest(value) {
  const records = layout.buildLineRecords(value).filter(r => !r.blank);
  const edges = [];
  let offset = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i], text = flat(r.text), next = records[i + 1];
    if (layout.isStructuralRole(r.role)) {
      const body = r.role === 'code' ? r.raw : text;
      edges.push([offset, r.role, hash(body), r.cellCount || 0]);
    }
    // Prevent a new isolated introductory clause being treated as a harmless
    // paragraph split. Its following explanation remains attached.
    if (next && layout.isDependentLead(text)) {
      const gap = String(value).slice(r.end, next.start);
      if (/\n[ \t\r]*\n/u.test(gap)) edges.push([offset, 'detached_lead']);
    }
    // Explicit condition/group paragraphs are relations, not decoration.
    if (/^(?:(?:pH|온도|압력)\s*\d|(?:실험|대조|비교)\s*군(?:은|는|에서)|(?:첫째|둘째|셋째|넷째|다섯째|여섯째|일곱째|여덟째|아홉째|열째)\s*[,，])/iu.test(text)) {
      edges.push([offset, 'condition_or_enumeration']);
    }
    offset += text.length + 1;
  }
  return hash(JSON.stringify({ version: VERSION, edges }));
}

// Only glue a clearly unfinished introductory clause to its explanation.
// Never guess table cells, finish missing words, merge questions into answers,
// or merge arbitrary short paragraphs for the sake of a paragraph count.
function repairDependentLeads(value) {
  const text = String(value || '');
  const records = layout.buildLineRecords(text).filter(r => !r.blank);
  const edits = [];
  for (let i = 0; i < records.length - 1; i++) {
    const left = records[i], right = records[i + 1];
    if (left.role !== 'prose' || right.role !== 'prose' || !layout.isDependentLead(left.text)) continue;
    if (!/^[ \t\r\n]+$/u.test(text.slice(left.end, right.start))) continue;
    edits.push({ start: left.end, end: right.start });
  }
  let output = text;
  for (const e of edits.reverse()) output = output.slice(0, e.start) + ' ' + output.slice(e.end);
  return { text: output, repairedCount: edits.length };
}

// Explicit experimental condition introductions are ownership boundaries.
// Never derive them from sentence count or infer a missing condition/value.
// This conservative path handles plain prose only; tables, headings, quoted
// material and ambiguous comparisons retain their own layout contracts.
function separateAttestedConditions(source, candidate) {
  const text=String(candidate||''), unchanged={text,repairedCount:0};
  const {splitSentenceSpans}=require('../engine/koreanText');
  const condition='(?:pH\\s*\\d+(?:\\.\\d+)?|온도\\s*-?\\d+(?:\\.\\d+)?\\s*°?[CF]|압력\\s*\\d+(?:\\.\\d+)?\\s*(?:kPa|MPa|Pa)|(?:실험|대조|비교)군(?:\\s*[A-C가-다])?)';
  const startRe=new RegExp('^(?:(?:같은|동일한|반면|또한|한편)\\s+)?('+condition+')\\s*(?:조건|에서는|에서|의|을|은|는)','iu');
  const scan=value=>{
    if(layout.buildLineRecords(value).some(r=>!r.blank&&r.role!=='prose'))return [];
    return splitSentenceSpans(value).flatMap(s=>{
      const m=s.text.match(startRe);
      if(!m||(s.text.match(new RegExp(condition,'giu'))||[]).length!==1)return [];
      const magnification=s.text.slice(0,80).match(/(\d+)\s*배율/u)?.[1]||'';
      return [{...s,key:m[1].replace(/\s/gu,'').toLowerCase()+':'+magnification}];
    });
  };
  const a=scan(String(source||'')),b=scan(text);
  if(a.length<2||a.length>20||a.length!==b.length||new Set(a.map(s=>s.key)).size<2
    ||a.some((s,i)=>s.key!==b[i].key))return unchanged;
  const edits=b.slice(1).flatMap(s=>{
    const gap=text.slice(0,s.start).match(/\s+$/u);
    if(!gap||/\n\s*\n/u.test(gap[0]))return [];
    return [{start:s.start-gap[0].length,end:s.start}];
  });
  let out=text;
  for(const e of edits.reverse())out=out.slice(0,e.start)+'\n\n'+out.slice(e.end);
  return {text:out,repairedCount:edits.length};
}

// A resume copied with one sentence per line is not automatically a separate
// question per line. Group only a continuous past-experience -> future-action
// narrative with explicit phase evidence. Multi-sentence answers, questions,
// headings, conditions and lists retain the existing ownership contract.
function groupContinuousResumeLines(lines) {
  const rows = Array.isArray(lines) ? lines.map(String) : [];
  const { splitSentences } = require('../engine/koreanText');
  if (rows.length < 4 || rows.some(row => row.length > 230 || splitSentences(row).length !== 1
      || layout.classifyLine(row) !== 'prose' || /^(?:첫|두|세|네|다섯)\s*번째|[?？]/u.test(row))) return null;
  const future = row => /(?:겠습니다|고자\s*합니다|할\s*계획입니다|할\s*것입니다)[.!?]?$/u.test(row.trim());
  const firstFuture = rows.findIndex(future);
  if (firstFuture < 2 || firstFuture >= rows.length - 1 || !rows.slice(firstFuture).every(future)
      || !rows.slice(0,firstFuture).every(row=>/[가-힣]{2,}습니다[.!?]?$/u.test(row.trim()))) return null;
  const starts = [0];
  for(let i=1;i<firstFuture;i++) {
    if (/(?:공부|준비|참여|근무|활동|연구)(?:를|를?\s*할|하던|하였던)?\s*때|(?:재학\s*중|근무\s*당시)/u.test(rows[i].slice(0,90))
        && !rows.slice(0,i).some(row=>/(?:공부|준비|참여|근무|활동|연구)(?:를|를?\s*할|하던|하였던)?\s*때|(?:재학\s*중|근무\s*당시)/u.test(row.slice(0,90)))) starts.push(i);
  }
  // Require an observed phase transition, not just similarly short lines.
  if (starts.length < 2) return null;
  starts.push(firstFuture, rows.length);
  const groups=starts.slice(0,-1).map((start,i)=>rows.slice(start,starts[i+1]).join(' '));
  if(groups.some(group=>group.replace(/\s/gu,'').length>500))return null;
  return groups;
}

module.exports = { VERSION, relationDigest, repairDependentLeads, separateAttestedConditions, groupContinuousResumeLines };
