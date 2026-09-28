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
    const ratio=lost.length/Math.max(1,distinctive.length);
    if(lost.length>=8&&ratio>=.35)return true;
    // Short adjacent claims cannot reach an absolute eight-gram threshold.
    // Near-complete distinctive overlap is sufficient to DEFER a destructive
    // source copy, never to declare coverage or approve generated meaning.
    if(s.text.replace(/[^\p{L}\p{N}]/gu,'').length<=24) {
      const core=s.text.trimStart().replace(/^(?:그러나|하지만|그런데|그리고|또한)\s+/u,'');
      const parts=[...grams(core)].filter(g=>!owned.has(g)&&!kept.has(g));
      const shared=parts.filter(g=>out.has(g));
      const compactCore=core.replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();
      const compactCandidate=String(candidate).normalize('NFC').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();
      if(shared.length>=2 && shared.length/Math.max(1,parts.length)>=.9
        && compactCore.length>=4 && compactCandidate.includes(compactCore))return true;
    }
  }
  return false;
}
module.exports={hasOutsideSourceContribution};
