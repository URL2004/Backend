'use strict';
const {splitSentenceSpans}=require('../engine/koreanText');
const {syntaxSpans}=require('../engine/textSyntax');
const {sentenceSimilarity}=require('./sentenceAlignment');

// Called only after unique judge grounding. These are proposals, not verdicts:
// caller ownership, byte limits, structure checks and fresh judging still apply.
function repairConfirmedLocalEdit(source,candidate,finding) {
  if(!source||!candidate||source.length>700||candidate.length>700)return '';
  const a=splitSentenceSpans(source),b=splitSentenceSpans(candidate);
  const protectedSpans=text=>syntaxSpans(text).filter(s=>s.spanType!=='parenthetical');
  // A newly invented book-title wrapper has no source ownership. Remove only
  // that wrapper when EVERY other byte is identical; never edit real quotes.
  if(finding.type==='added_claim'&&finding.relation==='other'&&a.length===1&&b.length===1
      &&!/[\r\n]/u.test(source+candidate)&&!protectedSpans(source).length){
    const quotes=[...candidate.matchAll(/『([^『』\r\n]{1,40})』|《([^《》\r\n]{1,40})》/gu)];
    if(quotes.length===1){const m=quotes[0],plain=candidate.slice(0,m.index)+(m[1]||m[2])+candidate.slice(m.index+m[0].length);
      if(plain===source&&String(finding.span||'').includes(m[0]))return plain;
    }
  }
  if(!['distortion','omission'].includes(finding.type))return '';
  // One small, attested changed span in otherwise identical full prose is a
  // local edit, not a whole-sentence rollback against the 30% byte ceiling.
  if(a.length===1&&b.length===1&&!/[\r\n]/u.test(source+candidate)
      &&!protectedSpans(source).length&&!protectedSpans(candidate).length){
    let start=0,left=source.length,right=candidate.length;
    while(start<left&&start<right&&source[start]===candidate[start])start++;
    while(left>start&&right>start&&source[left-1]===candidate[right-1]){left--;right--;}
    if(start>=12&&source.length-left>=12&&left-start<=24&&right-start<=24
        &&left>start&&/[가-힣]/u.test(source.slice(start,left))
        &&(start+source.length-left)/Math.max(source.length,candidate.length)>=.8
        &&source!==candidate)return source;
  }
  if(finding.relation!=='modality_negation_causality'||a.length<2||a.length>6||a.length!==b.length)return '';
  const contrast=/^(하지만|그러나|반면)([ \t]+)/u, additive=/^(?:이와 함께|그와 함께|또한|그리고)([ \t]+)/u;
  const left=a.flatMap((s,i)=>contrast.test(s.text)?[{i,m:s.text.match(contrast)}]:[]);
  if(left.length!==1||b.some(s=>contrast.test(s.text)))return '';
  const index=left[0].i,m=b[index].text.match(additive);if(!m)return '';
  const strip=s=>s.replace(contrast,'').replace(additive,'');
  for(let i=0;i<a.length;i++)for(const [needle,rows]of [[a[i],b],[b[i],a]]){
    const scores=rows.map((s,j)=>({j,score:sentenceSimilarity(strip(needle.text),strip(s.text))})).sort((x,y)=>y.score-x.score);
    if(scores[0].j!==i||scores[0].score<.6||scores[0].score-(scores[1]?.score||0)<.12)return '';
  }
  const start=b[index].start,end=start+m[0].length;
  if(protectedSpans(candidate).some(s=>s.start<end&&s.end>start)
      ||protectedSpans(source).some(s=>s.start<a[index].start+left[0].m[0].length&&s.end>a[index].start))return '';
  return candidate.slice(0,start)+left[0].m[0]+candidate.slice(end);
}
module.exports={repairConfirmedLocalEdit};
