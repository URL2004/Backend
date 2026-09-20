'use strict';
const { splitSentenceSpans, splitSentences, ngramSet } = require('../engine/koreanText');
const layoutStructure = require('./layoutStructure');
const { syntaxSpans } = require('../engine/textSyntax');
const { buildLineRecords } = require('./layoutStructure');

function role(text) {
  if (/^(?:이때|이 경우|이러한 상황에서|이런 상황에서)\s/u.test(text)
      && /(?:제시|제공|지도|지원|활용|조정|설명|대응|마련)/u.test(text)) return 'response';
  if (/^(?:이러한|이런)\s+(?:지도|지원|조치|대응|피드백)(?:는|은|를 통해|을 통해|를 받|의 의미)/u.test(text)) return 'outcome';
  if (/^(?:대상자|참가자|학생|환자)(?:는|은)\s+이러한\s+(?:지도|지원|조치)(?:를|을)\s/u.test(text)) return 'outcome';
  if (/^(?:이러한|이런)\s+(?:통찰|경험|깨달음)/u.test(text)
      && /(?:나는|나의|내가|저는|저의|제가|나 자신)/u.test(text)
      && /(?:돌아보|되돌아보|느꼈|다짐|깨달)/u.test(text)) return 'reflection';
  return '';
}
function introducesNewRole(sentences, i) {
  const current = sentences[i].text;
  const kind = role(current);
  if (kind && !sentences.slice(0, i).some(s => role(s.text) === kind)) return kind;
  // A contrast must compare substantive subjects, not merely qualify the
  // immediately preceding claim. Both sides must have developed prose.
  if (/^(?:반면|이에 반해)\s/u.test(current)) {
    const subject = current.split(/(?:에서는|은|는|이|가)\s/u)[0].replace(/^(?:반면|이에 반해)\s/u,'');
    if (subject.length >= 8 && !/^(?:그|이|같은)\s/u.test(subject)) {
      const grams = ngramSet(subject, 2);
      const prior = ngramSet(sentences.slice(0,i).map(s=>s.text).join(' '), 2);
      if (grams.size && [...grams].filter(g=>prior.has(g)).length / grams.size < .4) return 'comparison';
    }
  }
  const before = sentences.slice(0,i).map(s=>s.text).join(' ');
  if (/^(?:무엇보다|또한|한편)\s/u.test(current)
      && /(?:교육|인식|문화|미디어)/u.test(current)
      && /(?:제도|정책|법제|공시|할당제|규제)/u.test(before)
      && !/(?:교육|인식|미디어)/u.test(before)) return 'practice_to_culture';
  return '';
}

// Operates inside ordinary prose runs only, never across headings or existing
// paragraphs. Inserts whitespace at original sentence offsets; no word moves.
function splitProseParagraphs(value) {
  const text = String(value || '');
  if (!text || text.length > 60000) return { text, splitCount: 0, reasons: [] };
  const records = buildLineRecords(text);
  const literals = syntaxSpans(text);
  const edits = [], reasons = [];
  let run = [];
  function flush() {
    if (!run.length) return;
    const start = run[0].start, end = run.at(-1).end;
    run = [];
    const paragraph = text.slice(start,end);
    const sentences = splitSentenceSpans(paragraph);
    if (paragraph.replace(/\s/gu,'').length < 140 || sentences.length < 4 || sentences.length > 100) return;
    let last = 0;
    for (let i=2;i<sentences.length;i++) {
      if (i-last < 2) continue;
      const reason = introducesNewRole(sentences,i);
      if (!reason) continue;
      const suffix = paragraph.slice(sentences[i].start);
      if (suffix.replace(/\s/gu,'').length < 60) continue;
      // Contrast alone needs evidence on both sides; a developed final role
      // such as an educational intervention may be a single long sentence.
      if (reason==='comparison' && sentences.length-i < 2) continue;
      const left=start+sentences[i-1].end, right=start+sentences[i].start;
      if (!/^\s+$/u.test(text.slice(left,right))) continue;
      if (literals.some(s=>s.start < right && s.end > left)) continue;
      edits.push({left,right});reasons.push(reason);last=i;
    }
  }
  for(const r of records) {
    if(r.blank || r.role!=='prose') flush();
    else run.push(r);
  }
  flush();
  let result=text;
  for(const e of edits.sort((a,b)=>b.left-a.left)) result=result.slice(0,e.left)+'\n\n'+result.slice(e.right);
  const moved = rebalanceReflectionLead(result);
  return {text:moved.text,splitCount:edits.length,reasons,boundaryMoveCount:moved.count};
}

function rebalanceReflectionLead(text) {
  const blocks=[...text.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/gu)];
  const edits=[], literals=syntaxSpans(text);
  for(let i=0;i<blocks.length-1;i++) {
    const left=blocks[i],right=blocks[i+1];
    if ([left[0],right[0]].some(p=>buildLineRecords(p).some(r=>!r.blank&&r.role!=='prose'))) continue;
    const sentences=splitSentenceSpans(left[0]);
    if(sentences.length<3 || role(sentences.at(-1).text)!=='reflection')continue;
    if(!/^특히\s/u.test(right[0]) || !/(?:깨달|느꼈|돌아보|나의|내가|나만의)/u.test(right[0]))continue;
    const last=sentences.at(-1),previous=sentences.at(-2);
    const a=left.index+previous.end,b=left.index+last.start,c=left.index+left[0].length,d=right.index;
    if(literals.some(s=>(s.start<b&&s.end>a)||(s.start<d&&s.end>c)))continue;
    if(!/^\s+$/u.test(text.slice(a,b))||!/^\s+$/u.test(text.slice(c,d)))continue;
    edits.push({a,b,value:'\n\n'},{a:c,b:d,value:' '});
  }
  let result=text;
  for(const e of edits.sort((a,b)=>b.a-a.a))result=result.slice(0,e.a)+e.value+result.slice(e.b);
  return {text:result,count:edits.length/2};
}
// Existing logical paragraph accounting is independent of visual splitting.
// Depth/discourse/resume audits consume these contracts unchanged.
function splitLogicalProseParagraphs(value) {
  const blocks = String(value || '').replace(/\r\n?/gu, '\n').split(/\n[ \t]*\n+/u).map(block => block.trim()).filter(Boolean);
  const result = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    if (isStandaloneProseLineGroup(lines)) result.push(...lines);
    else result.push(block);
  }
  return result;
}
function isStandaloneProseLineGroup(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return false;
  return lines.every(line => {
    if (isStructuralLine(line)) return false;
    const substantiveLength = String(line || '').replace(/[\p{P}\p{S}\s]/gu, '').length;
    if (substantiveLength < 40) return false;
    const sentences = splitSentences(line).filter(sentence => String(sentence || '').trim());
    return /[.!?…。！？]["'”’」』】)\]]*$/u.test(line) || sentences.length >= 2;
  });
}
function isStructuralLine(line) {
  const value = String(line || '').trim();
  if (!value) return true;
  const role = layoutStructure.classifyLine(value);
  if (layoutStructure.isStructuralRole(role)) return true;
  if (/^[A-Za-z][.)]\s+\S/u.test(value)) return true;
  return /^(?:참고\s*문헌|참고\s*자료|인용\s*문헌|References|Bibliography|Works\s+Cited)$/iu.test(value);
}
module.exports={splitProseParagraphs, splitLogicalProseParagraphs, isStandaloneProseLineGroup};
