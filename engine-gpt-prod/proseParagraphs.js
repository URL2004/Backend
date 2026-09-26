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
  const before = sentences.slice(0,i).map(s=>s.text).join(' ');
  const after = sentences.slice(i).map(s=>s.text).join(' ');
  const kind = role(current);
  if (kind && !sentences.slice(0, i).some(s => role(s.text) === kind)) return kind;
  // A contrast must compare substantive subjects, not merely qualify the
  // immediately preceding claim. Both sides must have developed prose.
  if (/^(?:반면|이에 반해)\s/u.test(current)) {
    const subject = current.split(/(?:에서는|은|는|이|가)\s/u)[0].replace(/^(?:반면|이에 반해)\s/u,'');
    if (subject.length >= 3 && !/^(?:그|이|같은|이런|그런)\s/u.test(subject)
        && !before.includes(subject)) {
      const grams = ngramSet(subject, 2);
      const prior = ngramSet(sentences.slice(0,i).map(s=>s.text).join(' '), 2);
      const head = subject.split(/\s+/u).at(-1);
      const sharedCategory = subject.split(/\s+/u).length >= 2 && head.length >= 2 && before.includes(head);
      if (sharedCategory || grams.size && [...grams].filter(g=>prior.has(g)).length / grams.size < .4) return 'comparison';
    }
  }
  // Recognize a functional change by both sides: observed situation/problem
  // becomes an action plan with a developed continuation. A connector alone
  // cannot trigger this path, and conditions remain with their intervention.
  const finding = /(?:조사|검토|관측|측정|분석|발견|확인|접수|실패|오류|문제)/u.test(before)
    && /(?:했다|하였다|되었다|있었다|걸렸|확인되어)/u.test(before);
  const actionPlan = /(?:대책|방안|조치|개선|안내문|계획|지원)/u.test(current)
    && /(?:마련|수정|정비|제공|시행|지원|개선)/u.test(current)
    && /(?:계획|예정|기로\s*했다|해야|마련했다)/u.test(after);
  const priorPlan = /(?:대책|개선\s*방안|조치\s*계획)(?:은|는|을|를)/u.test(before)
    || /(?:하기로\s*했다|할\s*예정)/u.test(before);
  if (finding && actionPlan && !priorPlan && sentences.length-i >= 2) return 'findings_to_plan';
  // Coarse temporal scene changes differ from within-event sequencing such as
  // 이어/그다음/마지막으로. Require an earlier phase and a later action phase.
  if (/^(?:[한두세네]|\d+)\s*(?:달|개월|년|주)\s*(?:뒤|후)(?:에는|에|부터)?\s/u.test(current)
      && /(?:첫\s*(?:주|날|달)|초기|처음|시작)/u.test(before)
      && /(?:작성|발표|제출|정리|완료|검토|수정)/u.test(after)
      && sentences.length-i >= 2) return 'later_phase';
  if (/^(?:무엇보다|또한|한편)\s/u.test(current)
      && /(?:교육|인식|문화|미디어)/u.test(current)
      && /(?:제도|정책|법제|공시|할당제|규제)/u.test(before)
      && !/(?:교육|인식|미디어)/u.test(before)) return 'practice_to_culture';
  return '';
}

// Classify work performed by the sentence, not its opening connector. Evidence
// must span both sides of a candidate boundary; a keyword alone is insufficient.
function activityEvidence(value) {
  let text = String(value || '');
  let coveredEnd = -1;
  const literals = syntaxSpans(text).filter(s => {
    if (!['quote', 'code'].includes(s.spanType) || s.start < coveredEnd) return false;
    coveredEnd = s.end;
    return true;
  });
  // Remove outer spans only: nested quotes must not shift an outer span's
  // offsets and accidentally consume the author's following prose.
  for (const s of literals.reverse()) {
    text = text.slice(0,s.start) + ' ' + text.slice(s.end);
  }
  return {
    orientation: /(?:고민|주제|목표|선정|동기|기획|필요성|문제의식|선택한\s*이유)/u.test(text),
    execution: /(?:구성|배치|제작|설계|수행|개발|구현|수집|관찰|측정|작성|조절|채색|분석|적용|설명|표현)/u.test(text),
    validation: /(?:검증|시험|테스트|점검|시제품|불편|문제.{0,18}발견|규격.{0,15}조정|수정|보완)/u.test(text),
    reflection: /(?:배웠|배우고|깨달|체감|익혔|익힐|기를\s*수|기르|길렀|인식했다|인식하게|이해하게|바라보게)/u.test(text),
    feedback: /(?:반응|칭찬|평가\s*결과|성과|효과.{0,12}확인|완성.{0,25}공유)/u.test(text)
  };
}

function activityTransition(sentences, features, i, strength) {
  if (i < 2 || sentences.length-i < 2) return '';
  const before = features.slice(0,i), after = features.slice(i), current = features[i];
  const hasWork = before.filter(f => f.execution || f.validation).length >= 2;
  // A conclusion needs sustained interpretation/feedback, not one "확인했다".
  if (hasWork && !before.some(f => f.reflection)
      && (current.reflection || current.feedback)
      && after.some(f => f.reflection)
      && after.filter(f => f.reflection || f.feedback).length >= 2
      && (strength === 'advanced' || sentences.length >= 5)) return 'activity_result';
  if (strength !== 'advanced') return '';
  if (before.filter(f => f.orientation).length >= 2
      && current.execution && !current.orientation && !current.reflection
      && after.slice(0,2).every(f => f.execution || f.validation)) return 'activity_execution';
  if (before.filter(f => f.execution).length >= 2 && !before.some(f => f.validation)
      && current.validation && !current.reflection
      && after[1].validation) return 'activity_validation';
  return '';
}

// Operates inside ordinary prose runs only, never across headings or existing
// paragraphs. Inserts whitespace at original sentence offsets; no word moves.
function splitProseParagraphs(value, { strength = 'basic', protectedBlocks = [] } = {}) {
  const leadRepair = require('./layoutRelations').repairDependentLeads(value);
  const text = leadRepair.text;
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
    const key = paragraph.replace(/\s/gu,'');
    if (protectedBlocks.some(b => String(b).replace(/\s/gu,'').includes(key))) return;
    const sentences = splitSentenceSpans(paragraph);
    if (sentences.length < 4 || sentences.length > 100) return;
    const features = sentences.map(s => activityEvidence(s.text));
    let last = 0;
    for (let i=2;i<sentences.length;i++) {
      if (i-last < 2) continue;
      const reason = activityTransition(sentences,features,i,strength) || introducesNewRole(sentences,i);
      if (!reason) continue;
      const suffix = paragraph.slice(sentences[i].start);
      const developedTransition = ['findings_to_plan', 'later_phase'].includes(reason);
      const minimumSide = developedTransition ? 45 : 60;
      if (suffix.replace(/\s/gu,'').length < minimumSide
          || paragraph.slice(sentences[last].start, sentences[i].start).replace(/\s/gu,'').length < minimumSide) continue;
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
  return {text:moved.text,splitCount:edits.length,reasons,boundaryMoveCount:moved.count,
    dependentLeadRepairCount: leadRepair.repairedCount};
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
module.exports={splitProseParagraphs, splitLogicalProseParagraphs, isStandaloneProseLineGroup, activityEvidence};
