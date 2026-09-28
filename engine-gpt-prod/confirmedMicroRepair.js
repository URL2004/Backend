'use strict';
const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const { sentenceSimilarity } = require('./sentenceAlignment');

// These are proposals ONLY for uniquely grounded, judge-confirmed pairs.
// Keep the rewrite, changing an attested operator rather than copying prose.
// The caller retains all whole-window/structure checks and must re-judge.
function confirmedMicroRepair(source, candidate, finding) {
  if (finding.origin !== 'introduced' || !finding.relationGrounded || !finding.repairable
      || !finding.spanVerified || finding.grounding !== 'unique_exact_span') return '';
  const protectedRange = (text, start, end) => syntaxSpans(text)
    .some(p => p.spanType !== 'parenthetical' && p.start < end && p.end > start);
  if (finding.type === 'intensity_amplification') {
    const pattern = /(?<![가-힣])(?:무척|매우|몹시|상당히|훨씬|대단히|극히|엄청나게|지극히)[ \t]+/gu;
    const additions = [...candidate.matchAll(pattern)].filter(m => !source.includes(m[0].trim())
      && String(finding.span).includes(m[0].trim())
      && !protectedRange(candidate, m.index, m.index + m[0].length));
    if (additions.length === 1) {
      const m = additions[0];
      return candidate.slice(0,m.index) + candidate.slice(m.index+m[0].length);
    }
  }
  if (finding.type !== 'distortion' || finding.relation !== 'modality_negation_causality') return '';
  const purposes=[];
  for(const m of source.matchAll(/(?<![가-힣])([가-힣]{2,20})기\s+위한\s+(과정|단계|준비)/gu)) {
    const target=m[1]+'는 '+m[2],start=candidate.indexOf(target);
    if(start>=0&&!/[가-힣]/u.test(candidate[start-1]||'')&&candidate.indexOf(target,start+1)<0
      &&String(finding.span).includes(target)&&!protectedRange(candidate,start,start+target.length)
      &&!protectedRange(source,m.index,m.index+m[0].length))purposes.push({start,end:start+target.length,text:m[0]});
  }
  if(purposes.length===1){const m=purposes[0];return candidate.slice(0,m.start)+m.text+candidate.slice(m.end);}
  const abilities = [];
  for (const m of source.matchAll(/(?<![가-힣])([가-힣]{2,16})할\s*수\s*있는(?=\s)/gu)) {
    const plain = m[1] + '하는';
    const start = candidate.indexOf(plain);
    if (start >= 0 && !/[가-힣]/u.test(candidate[start-1] || '')
        && !/[가-힣]/u.test(candidate[start+plain.length] || '') && candidate.indexOf(plain,start+1) < 0
        && !candidate.includes(m[0]) && String(finding.span).includes(plain)
        && !protectedRange(source,m.index,m.index+m[0].length)
        && !protectedRange(candidate,start,start+plain.length)) abilities.push({start,end:start+plain.length,text:m[0]});
  }
  if (abilities.length === 1) {
    const m=abilities[0];
    return candidate.slice(0,m.start)+m.text+candidate.slice(m.end);
  }
  // A displaced sentence-initial connective can be restored across up to six
  // *one-to-one, monotone* sentences. Splits/merges/ambiguous or quoted spans
  // deliberately fall back to the model patch rather than guessing ownership.
  const a=splitSentenceSpans(source), b=splitSentenceSpans(candidate);
  if (a.length < 2 || a.length > 6 || a.length !== b.length) return '';
  const prefix=/^(다만|하지만|그러나|반면|따라서|그러므로)([ \t]+)/u;
  const left=a.map(s=>s.text.match(prefix)), right=b.map(s=>s.text.match(prefix));
  const old=left.flatMap((m,i)=>m?[{i,m}]:[]), moved=right.flatMap((m,i)=>m?[{i,m}]:[]);
  if (old.length!==1 || moved.length!==1 || old[0].m[1]!==moved[0].m[1] || old[0].i===moved[0].i) return '';
  const strip=s=>s.replace(prefix,'');
  for(let i=0;i<a.length;i++) {
    const rank=(s,rows)=>rows.map((r,j)=>({j,score:sentenceSimilarity(strip(s),strip(r.text))})).sort((x,y)=>y.score-x.score);
    for(const rows of [rank(a[i].text,b),rank(b[i].text,a)])
      if(rows[0].j!==i || rows[0].score<.6 || rows[0].score-(rows[1]?.score||0)<.12) return '';
  }
  const from=b[moved[0].i].start, to=b[old[0].i].start;
  const length=moved[0].m[0].length;
  if(protectedRange(candidate,from,from+length)||protectedRange(candidate,to,to+1))return '';
  const changes=[{start:from,end:from+length,text:''},{start:to,end:to,text:old[0].m[0]}];
  let result=candidate;
  for(const c of changes.sort((x,y)=>y.start-x.start))result=result.slice(0,c.start)+c.text+result.slice(c.end);
  return result;
}
module.exports={confirmedMicroRepair};
