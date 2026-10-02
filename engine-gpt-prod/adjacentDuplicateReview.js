'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const { locateEvidenceSpan } = require('./evidenceSpan');
const CODE = 'source_suffix_replay_candidate';
const normalize = value => String(value || '').replace(/\s+/gu, ' ').trim();
const terminal = value => /[.!?。！？]["”’')\]]*$/u.test(value.trim());
const tokens = value => new Set((value.match(/[가-힣A-Za-z]{2,}/gu) || [])
  .map(t => t.replace(/(?:으로|에서|에게|은|는|이|가|을|를|의|와|과|도)$/u, ''))
  .filter(t => t.length >= 2));
const coverage = (a,b) => [...a].filter(t=>b.has(t)).length / Math.max(1,a.size);
const owners = value => new Set([...value.matchAll(/(?<![가-힣])([가-힣]{1,20}?)(?:에게|에서|에만|에는|은|는|이|가|을|를|의|에)(?=\s|$)/gu)]
  .map(m=>m[1]).filter(t=>!['것','수','경우','문제'].includes(t) && !/[하되인있없]$/u.test(t)));
const guarded = value => /\d|https?:|(?:다면|라면|으면|할 때|했을 때|경우|오직|누구|어떤|때문|따라서|반면)/u.test(value);

// A source-forced line suffix survives behind a new complete replacement.
// Exact source/output offsets nominate a QUESTION, never a deletion or error.
// Ordinary adjacent paraphrases intentionally abstain: lexical similarity
// cannot establish that actors, conditions and explanatory roles are the same.
function candidates(source, output) {
  const before=String(source || ''), after=String(output || '');
  if (!before || !after || before === after) return [];
  const flat=normalize(before);
  const sourceRows=splitSentenceSpans(flat).map(s=>s.text);
  const outputRows=splitSentenceSpans(after);
  const sourceProtected=syntaxSpans(before).filter(s=>s.spanType !== 'parenthetical');
  const outputProtected=syntaxSpans(after).filter(s=>s.spanType !== 'parenthetical');
  const overlaps=(spans,start,end)=>spans.some(s=>s.start<end && s.end>start);
  const result=[];
  for (let i=1;i<outputRows.length;i++) {
    const left=outputRows[i-1], right=outputRows[i];
    const previous=normalize(left.text), suffix=normalize(right.text);
    if (!terminal(previous) || !terminal(suffix) || suffix.length<8 || suffix.length>90) continue;
    if (!/^\s*$/u.test(after.slice(left.end,right.start))) continue;
    if (overlaps(outputProtected,left.start,right.end)) continue;
    if (locateEvidenceSpan(before,previous,12)) continue;
    const suffixAt=locateEvidenceSpan(before,suffix,8);
    if (!suffixAt || !/\n[ \t\r\n]*$/u.test(before.slice(0,suffixAt.start))) continue;
    const matched=sourceRows.filter(s=>s.endsWith(suffix) && s.length>=suffix.length+30);
    if (matched.length!==1) continue;
    const sourceSentence=matched[0];
    const sourceAt=locateEvidenceSpan(before,sourceSentence,20);
    if (!sourceAt || overlaps(sourceProtected,sourceAt.start,sourceAt.end)) continue;
    const prefix=sourceSentence.slice(0,-suffix.length).trim();
    if (terminal(prefix) || guarded(prefix) || guarded(previous)) continue;
    const a=tokens(prefix), b=tokens(previous);
    if (a.size<7 || coverage(a,b)<0.6 || coverage(b,a)<0.45) continue;
    // No cross-owner inference: newly named actors/properties or missing
    // explicit owners abstain, even if most other words still match.
    const originalOwners=owners(prefix), candidateOwners=owners(previous);
    const hasOwner=(text,owner)=>new RegExp(`(?<![가-힣])${owner}`, 'u').test(text);
    if ([...originalOwners].some(t=>!hasOwner(previous,t))
      || [...candidateOwners].some(t=>!hasOwner(sourceSentence,t))) continue;
    if (sourceRows.some(s=>s!==sourceSentence && coverage(a,tokens(s))>=0.5)) continue;
    const sourceSpan=before.slice(sourceAt.start,sourceAt.end);
    const outputSpan=after.slice(left.start,right.end);
    if (!locateEvidenceSpan(after,outputSpan,12)) continue;
    result.push({code:CODE,sourceSpan,outputSpan,sourceStart:sourceAt.start,sourceEnd:sourceAt.end,
      outputStart:left.start,outputEnd:right.end,outputOrdinal:i});
  }
  return result;
}
const instruction='source_suffix_replay_candidate는 원문 강제 개행의 뒷조각이 새 완결문 다음에도 남아 있는지 확인하는 질문이다. sourceSpan 전체와 candidateSpan의 앞뒤 두 단위를 대조하여 앞문장이 이미 같은 주장을 완결했는지 확인한다. 원문부터 반복된 내용·다른 주체·조건·보충 설명·정상 문장 분리는 preserved이며, 실제 신규 중복이 확인될 때만 정확한 위치를 갖춘 introduced violation을 반환한다. 후보 위치 자체는 삭제 허가가 아니며 uncertain이면 추측 복구하지 않는다.';
module.exports={CODE,candidates,instruction};
