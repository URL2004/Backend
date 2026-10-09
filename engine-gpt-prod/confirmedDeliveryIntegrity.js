'use strict';
const {verifySemanticValidation}=require('./semanticProvenance');
const {hasGroundedSpan}=require('./semanticObligations');
const bare=value=>String(value||'').replace(/\s/gu,'');
const unique=(text,span)=>typeof span==='string' && span.trim().length>=12
  && text.includes(span) && text.indexOf(span)===text.lastIndexOf(span);

// A fail label alone is not a hard delivery gate. Require the final candidate
// receipt, a unique current context, and a prior independent finding about the
// same missing source claim. No additional model request is made here.
function confirmedOmissions(source,candidate,report,priorReports=[]) {
  if (verifySemanticValidation(report,{source,candidate,requireDigest:true}).status!=='fail'
      || report.verificationCompleted!==true || report.uncertain || report.nominationOnly) return [];
  const previous=new Set(),seen=new Set();
  const visit=r=>{
    if(!r || r===report || seen.has(r))return;seen.add(r);
    if(r.pass===false && !r.uncertain && !r.skipped && r.verificationCompleted===true)
      for(const v of r.violations||[])
        if(v.type==='omission' && v.origin==='introduced' && hasGroundedSpan(v))previous.add(bare(v.sourceSpan));
    for(const child of r.reports||[])visit(child);
  };
  priorReports.forEach(visit);
  const candidateBare=bare(candidate);
  return (report.violations||[]).filter(v=>v.type==='omission' && v.origin==='introduced'
    && hasGroundedSpan(v) && unique(source,v.sourceSpan) && unique(candidate,v.candidateSpan)
    && !candidateBare.includes(bare(v.sourceSpan)) && previous.has(bare(v.sourceSpan)));
}
function stopUnproductiveShortEscalation({attempt,sourceLength,semantic,metrics,reason}) {
  return attempt>0 && sourceLength>0 && sourceLength<=600
    && semantic?.ran===true && semantic.pass===true && !semantic.uncertain
    && semantic.verificationCompleted!==false
    && Number(metrics?.substantiveChangedSentenceCount)>0 && Number(metrics?.substantiveEditRatio)>=0.01
    && ['candidate_unchanged','depth_not_improved','minimum_effect_failed','safety_audit_failed'].includes(reason);
}
module.exports={confirmedOmissions,stopUnproductiveShortEscalation};
