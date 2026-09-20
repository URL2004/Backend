'use strict';

const { splitSentenceSpans, ngramSet } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const layout = require('./layoutStructure');
const compact = value => String(value || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
const VERSION = 'clause-coverage-v1';

function words(value) {
  return new Set((String(value).match(/[가-힣A-Za-z0-9]{2,}/gu) || [])
    .map(w => w.toLowerCase().replace(/(?:에서는|에서|으로|에게|은|는|이|가|을|를|의|와|과)$/u, ''))
    .filter(w => w.length >= 2 && !/^(?:일반적으로|따라서|그러나|이러한|그러한)$/u.test(w)));
}
function features(text) { return {words:words(text),grams:ngramSet(text,3)}; }
function similarity(a, b) {
  const aa = a.words, bb = b.words;
  const common = [...aa].filter(w => bb.has(w)).length;
  const grams=[...a.grams].filter(g=>b.grams.has(g)).length;
  return Math.max(grams/Math.max(1,a.grams.size+b.grams.size-grams), common / Math.max(1, Math.max(aa.size,bb.size)));
}

// These are bounded review hints, NOT findings or delivery gates. A compound
// sentence can survive lexically while one independently predicated arm vanishes.
function auditClauseCoverage(source, output) {
  const ss = splitSentenceSpans(String(source || '')), os = splitSentenceSpans(String(output || ''));
  const sourceLiterals=syntaxSpans(source),outputLiterals=syntaxSpans(output);
  const outputFeatures=os.map(o=>features(o.text)),outputCompact=compact(output);
  const candidates = [];
  for (let index=0; index<ss.length && candidates.length<6; index++) {
    const s = ss[index];
    if (s.text.length > 1400 || layout.buildLineRecords(s.text).some(r => !r.blank && r.role !== 'prose')) continue;
    const literals = syntaxSpans(s.text);
    for (const join of s.text.matchAll(/(?:었으며|았으며|였으며|됐으며|되었고|했고|했으며|지만|으나),?\s+/gu)) {
      if (sourceLiterals.some(r=>['quote','code'].includes(r.spanType) && r.start<=s.start+join.index && r.end>s.start+join.index)) continue;
      if (literals.some(r => r.start <= join.index && r.end > join.index)) continue;
      const left = s.text.slice(0,join.index+join[0].length).trim();
      const right = s.text.slice(join.index+join[0].length).trim();
      if (words(left).size < 5 || words(right).size < 5
          || !/(?:은|는|이|가)(?=\s)/u.test(right)
          || !layout.isSentenceComplete(right) || syntaxSpans(right).some(r => r.spanType === 'code')) continue;
      if (outputCompact.includes(compact(s.text))) continue;
      const leftFeatures=features(left),rightFeatures=features(right);
      const ranks = os.map((o,i)=>({span:o,index:i,score:outputLiterals.some(r=>['quote','code'].includes(r.spanType) && r.start<=o.start && r.end>=o.end)
        ? -1 : similarity(leftFeatures,outputFeatures[i])})).sort((a,b)=>b.score-a.score);
      const best=ranks[0];
      if (!best || best.score < .48 || best.score-(ranks[1]?.score || 0)<.10
          || best.span.text.length > s.text.length*.85 || !layout.isSentenceComplete(best.span.text)) continue;
      // Keep nearby split/rephrased arms, including a newly separated paragraph.
      // Earlier generic background is not a replacement for this local result.
      const local=os.slice(best.index,best.index+3);
      if (local.some((o,i)=>compact(o.text).includes(compact(right)) || similarity(rightFeatures,outputFeatures[best.index+i])>=.48
          || (!right.includes(',') && o.text.split(/(?:었으며|았으며|였으며|됐으며|되었고|했고|했으며|지만|으나),?\s+/u)
            .some(part=>similarity(rightFeatures,features(part))>=.48)))) continue;
      candidates.push({code:'compound_claim_omission_candidate',sourceOrdinal:index+1,
        relation:/(?:지만|으나)/u.test(join[0])?'contrast':'coordination',
        partialTailPresent:right.split(',').slice(0,-1).some(part=>words(part).size>=3 && compact(best.span.text).includes(compact(part))),
        outputOrdinal:best.index+1,sourceSpan:s.text,missingSpan:right,
        outputSpan:best.span.text,outputStart:best.span.start,outputEnd:best.span.end});
      break;
    }
  }
  const unambiguous=candidates.filter(c=>candidates.filter(other=>other.outputStart===c.outputStart).length===1);
  return {version:VERSION,candidateOnly:true,semanticRequired:unambiguous.length>0,candidates:unambiguous};
}

function restoreConfirmedClauseOmissions(source, output, violations, limit=5) {
  const audit=auditClauseCoverage(source,output),restored=[];
  let text=String(output || '');
  for(const c of audit.candidates.slice(0,limit).sort((a,b)=>b.outputStart-a.outputStart)) {
    const confirmed=(violations || []).some(v=>{
      const span=compact(v?.span);
      return v?.type==='omission' && v.sourceSpanVerified === true && v.repairable === true && span.length>=12
        && (span.includes(compact(c.missingSpan)) || compact(c.missingSpan).includes(span));
    });
    // Concessive endings carry a relation that plain insertion would erase;
    // leave these to model repair plus its existing semantic recheck.
    if(!confirmed || c.relation!=='coordination' || c.partialTailPresent)continue;
    // Never replace the surviving arm, or clear a semantic verdict on a string
    // match. Existing candidate integrity and final digest revalidation apply.
    text=text.slice(0,c.outputEnd)+' '+c.missingSpan+text.slice(c.outputEnd);
    restored.push({sourceSentenceIndex:c.sourceOrdinal-1,sentence:c.missingSpan,
      anchorType:'confirmed_compound_tail',violation:{type:'source_clause_restored',span:'',detail:''}});
  }
  return {text,restored,candidates:audit.candidates};
}

module.exports={VERSION,auditClauseCoverage,restoreConfirmedClauseOmissions};
