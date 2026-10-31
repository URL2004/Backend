'use strict';
const {splitSentenceSpans}=require('../engine/koreanText');
const {syntaxSpans}=require('../engine/textSyntax');

// Invoked only by confirmedMicroRepair's grounded-finding gate. These are
// exact source proposals, never semantic verdicts. Whole-document ownership,
// byte budgets, structure safety and a fresh semantic audit still apply.
function repairConfirmedClause(source,candidate,finding) {
  const a=splitSentenceSpans(source),b=splitSentenceSpans(candidate);
  if(a.length!==1||b.length<1||b.length>3||source.length>500||candidate.length>700
      ||/[\r\n]/u.test(source)||syntaxSpans(source).some(p=>p.spanType!=='parenthetical'))return '';
  // Recover an omitted concessive premise when the retained complete clause
  // is literally the source suffix. Surrounding candidate sentences remain.
  const suffix=b.filter(s=>s.text.length>=20&&source.endsWith(s.text)&&source!==s.text
    && source.indexOf(s.text)===source.lastIndexOf(s.text)
    && candidate.indexOf(s.text)===candidate.lastIndexOf(s.text));
  if(suffix.length===1){
    const s=suffix[0],prefix=source.slice(0,-s.text.length);
    if(prefix.length>=12&&prefix.length<=160&&/(?:지만|으나|더라도|는데),?\s+$/u.test(prefix)
        && !candidate.includes(prefix.trim())
        && !syntaxSpans(candidate).some(p=>p.spanType!=='parenthetical'&&p.start<s.end&&p.end>s.start))
      return candidate.slice(0,s.start)+source+candidate.slice(s.end);
  }
  if(b.length!==1||/[\r\n]/u.test(candidate)||syntaxSpans(candidate).some(p=>p.spanType!=='parenthetical'))return '';
  // Preserve the author's learning/reflection without reverting the rewritten
  // body. Only the same explicit predicate stem can own the attested ending.
  const ending=source.match(/(?<![가-힣])([가-힣]{2,12})(하다는\s+(?:것|점)(?:을|도)\s+(?:알게\s+되었|배웠|이해하였|확인하였)(?:습니다|다)|이라는\s+점을\s+(?:새롭게\s+)?배웠(?:습니다|다))[.]$/u);
  if(!ending||/(?:알게|배웠|깨달|느꼈|생각했)/u.test(candidate))return '';
  const finite=ending[2].startsWith('하다는')?'(?:합니다|하다)':'(?:입니다|이다)';
  const tail=candidate.match(new RegExp(ending[1]+finite+'[.]$','u'))?.[0];
  if(!tail)return '';
  if(!candidate.endsWith(tail)||candidate.indexOf(tail)!==candidate.lastIndexOf(tail)
      ||!String(finding.span||'').includes(ending[1]))return '';
  const words=s=>new Set(s.match(/[가-힣]{2,}/gu)||[]),left=words(source),right=words(candidate);
  if([...left].filter(w=>right.has(w)).length<4)return '';
  return candidate.slice(0,-tail.length)+ending[0];
}
module.exports={repairConfirmedClause};
