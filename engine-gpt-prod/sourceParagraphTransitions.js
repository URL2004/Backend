'use strict';
const { splitSentenceSpans, splitSentences, ngramSet } = require('../engine/koreanText');
const { isStructureDominatedParagraph } = require('./layoutStructure');
const { syntaxSpans } = require('../engine/textSyntax');

// Restore only unique, adjacent sentence anchors on the two sides of an
// explicit source paragraph boundary. Never cut by length, move words, or
// reconstruct an uncertain alignment. Works even with a locked preamble.
function restoreSourceParagraphTransitions(source, output) {
  const iterator=restoreSourceParagraphTransitionsSteps(source,output);
  let step=iterator.next();
  while(!step.done)step=iterator.next();
  return step.value;
}
function* restoreSourceParagraphTransitionsSteps(source, output, local = false) {
  if (!local) {
    const sections = yield* restoreSectionParagraphTransitions(source, output);
    if (sections.applicable) return sections;
  }
  const text = String(output || '');
  const paragraphs = local
    ? require('./layoutStructure').splitReadableParagraphs(source)
    : String(source || '').split(/\r?\n[ \t]*\r?\n+/u).map(s => s.trim()).filter(Boolean);
  const spans = splitSentenceSpans(text);
  if (paragraphs.length < 2 || paragraphs.length > 40 || spans.length > 180 || text.length > 30000) return { text, repairedCount: 0 };
  const cache = new Map();
  const grams = value => {
    if (!cache.has(value)) cache.set(value, ngramSet(value, 2));
    return cache.get(value);
  };
  const similarity = (left, right) => {
    const a = grams(left), b = grams(right);
    let shared = 0;
    for (const gram of a) if (b.has(gram)) shared++;
    return shared / Math.max(1, a.size + b.size - shared);
  };
  const replacements = new Map();
  const literals = syntaxSpans(text);
  for (let p = 1; p < paragraphs.length; p++) {
    yield;
    const left = paragraphs[p - 1], right = paragraphs[p];
    if (isStructureDominatedParagraph(left) || isStructureDominatedParagraph(right)) continue;
    const last = splitSentences(left).at(-1), first = splitSentences(right)[0];
    if (!last || !first || Math.min(last.length, first.length) < 25) continue;
    const candidates = [];
    for (let i = 1; i < spans.length; i++) {
      if(i%32===0)yield;
      const l = similarity(last, spans[i - 1].text), r = similarity(first, spans[i].text);
      if (l < .6 || r < .45) continue;
      if (similarity(first.slice(0, 45), spans[i].text.slice(0, 45)) < .35) continue;
      candidates.push({ i, score: (l + r) / 2 });
    }
    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length || (candidates[1] && candidates[0].score - candidates[1].score < .12)) continue;
    const i = candidates[0].i, start = spans[i - 1].end, end = spans[i].start;
    const separator = text.slice(start, end);
    if (!/^[ \t\r\n]*$/u.test(separator) || /\n[ \t]*\r?\n/u.test(separator)) continue;
    if (literals.some(s => s.spanType !== 'parenthetical' && s.start < end && s.end > start)) continue;
    replacements.set(start, end);
  }
  let repaired = text;
  for (const [start, end] of [...replacements].sort((a, b) => b[0] - a[0])) {
    repaired = `${repaired.slice(0, start)}\n\n${repaired.slice(end)}`;
  }
  return { text: repaired, repairedCount: replacements.size };
}

// A long, sectioned paper must not become an all-or-nothing alignment task.
// Only identical unique headings in the same consecutive order own a window.
// Existing per-window bounds and adjacent-sentence confidence stay unchanged.
function* restoreSectionParagraphTransitions(source, output) {
  const a=String(source||'').replace(/\r\n?/gu,'\n'), b=String(output||'').replace(/\r\n?/gu,'\n');
  if (a.length>60000||b.length>60000) return {text:output,repairedCount:0,applicable:false};
  const {buildLineRecords}=require('./layoutStructure');
  const headings = text => buildLineRecords(text).filter(r=>['title','heading'].includes(r.role))
    .map(r=>({key:r.text.trim(),start:r.start,end:r.end}));
  const left=headings(a),right=headings(b);
  if(left.length<2||left.length>60||right.length>60) return {text:output,repairedCount:0,applicable:false};
  const unique=(list,key)=>list.filter(r=>r.key===key).length===1;
  const edits=[];let count=0;
  for(let i=0;i<left.length;i++) {
    yield;
    const h=left[i];
    if(!unique(left,h.key)||!unique(right,h.key))continue;
    const j=right.findIndex(r=>r.key===h.key),next=left[i+1],other=right[j+1];
    if(next ? !other||next.key!==other.key||!unique(left,next.key)||!unique(right,next.key) : other)continue;
    const from=h.end,to=next?.start??a.length,start=right[j].end,end=other?.start??b.length;
    const result=yield* restoreSourceParagraphTransitionsSteps(a.slice(from,to),b.slice(start,end),true);
    if(result.repairedCount){edits.push({start,end,text:result.text});count+=result.repairedCount;}
  }
  let text=b;
  for(const e of edits.sort((x,y)=>y.start-x.start))text=text.slice(0,e.start)+e.text+text.slice(e.end);
  return {text,repairedCount:count,applicable:true};
}
// A section heading must not disable role boundaries in the prose below it.
// Unlike exact boundary recovery, this permits paraphrases, but only restores
// a role transition already present at an explicit source paragraph boundary.
function discourseRole(sentence) {
  if (/^(?:이때|이러한 상황에서|이런 상황에서|이를 위해)\s/u.test(sentence)
      && /(?:제시|지원|지도|설명|제공|조정|실행|수립|도입|마련|수행|개선)/u.test(sentence)) return 'response';
  if (/^(?:이러한|이런)\s+(?:지도|지원|노력|조치|방법|대응|활동|과정|경험|교육)(?:은|는|을 통해|으로)/u.test(sentence)
      && /(?:도움|기여|효과|의미|가능|높|줄|개선|배|이해)/u.test(sentence)) return 'outcome';
  return null;
}

function restoreSourceDiscourseRoles(source, output) {
  const text = String(output || '');
  if (text.length > 30000 || String(source || '').length > 30000) return { text, repairedCount: 0 };
  const paragraphs = String(source || '').split(/\r?\n[ \t]*\r?\n+/u).map(s => s.trim()).filter(Boolean);
  const anchors = paragraphs.slice(1).filter(p => !isStructureDominatedParagraph(p))
    .map(p => splitSentences(p)[0]).filter(Boolean)
    .map(sentence => ({ sentence, role: discourseRole(sentence), grams: ngramSet(sentence, 2) }))
    .filter(a => a.role);
  if (!anchors.length) return { text, repairedCount: 0 };
  const spans = splitSentenceSpans(text);
  const edits = new Map();
  const protectedSpans = syntaxSpans(text);
  for (const anchor of anchors) {
    const matches = [];
    for (let i = 1; i < spans.length; i++) {
      if (discourseRole(spans[i].text) !== anchor.role) continue;
      const grams = ngramSet(spans[i].text, 2);
      let common = 0;
      for (const g of grams) if (anchor.grams.has(g)) common++;
      const score = common / Math.max(1, grams.size + anchor.grams.size - common);
      if (score >= .18 && common >= 12) matches.push({ i, score });
    }
    matches.sort((a, b) => b.score - a.score);
    if (!matches.length || (matches[1] && matches[0].score - matches[1].score < .12)) continue;
    const i = matches[0].i;
    const start = spans[i - 1].end, end = spans[i].start;
    if (protectedSpans.some(s => s.start < end && s.end > start)) continue;
    if (!/^[ \t]+$/u.test(text.slice(start, end))) continue;
    const previous = text.lastIndexOf('\n\n', start);
    const pStart = previous < 0 ? 0 : previous + 2;
    const next = text.indexOf('\n\n', end);
    const pEnd = next < 0 ? text.length : next;
    const paragraph = text.slice(pStart, pEnd);
    // Literal blocks and inline quotations are left to the protected layout path.
    if (isStructureDominatedParagraph(paragraph) || /["“”‘’「」『』《》`~]|^\s*>/mu.test(paragraph)) continue;
    const before = splitSentences(text.slice(pStart, start));
    const after = splitSentences(text.slice(end, pEnd));
    if (before.length < 2 || after.length < 2 || before.length + after.length < 4) continue;
    edits.set(start, end);
  }
  let repaired = text;
  for (const [start, end] of [...edits].sort((a, b) => b[0] - a[0])) repaired = repaired.slice(0, start) + '\n\n' + repaired.slice(end);
  return { text: repaired, repairedCount: edits.size };
}
module.exports = { restoreSourceParagraphTransitions, restoreSourceParagraphTransitionsSteps, restoreSourceDiscourseRoles };
