'use strict';
const {splitSentenceSpans,ngramSet}=require('../engine/koreanText');
const grams=s=>ngramSet(String(s||'').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,''),3);

// A judge's paired span locates an error, not an exclusive ownership boundary.
// A whole-window copy must not erase material from an adjacent source sentence
// that was legitimately merged into this candidate. Ambiguity falls back to a
// bounded model patch + fresh audit; this check never declares semantic pass.
function hasOutsideSourceContribution(source,start,end,candidate,replacement){
  const spans=splitSentenceSpans(source),owned=grams(source.slice(start,end)),kept=grams(replacement),out=grams(candidate);
  const before=spans.filter(s=>s.end<=start).slice(-3),after=spans.filter(s=>s.start>=end).slice(0,3);
  for(const s of [...before,...after]){
    const distinctive=[...grams(s.text)].filter(g=>!owned.has(g)&&!kept.has(g));
    const lost=distinctive.filter(g=>out.has(g));
    if(lost.length>=8&&lost.length/Math.max(1,distinctive.length)>=.35)return true;
  }
  return false;
}
module.exports={hasOutsideSourceContribution};
