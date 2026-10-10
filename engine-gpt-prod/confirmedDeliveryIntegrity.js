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
// F-03: why the gate above did or did not fire. Observation only: it never
// decides anything and confirmedOmissions() is not routed through it. It holds
// counts, lengths, a short digest and overlap ratios; never a quotation.
const GATE_DIAGNOSTICS_VERSION='confirmed-omission-gate-v1';
const GATE_STATES=['evaluated','no_final_verdict','final_verdict_stale','final_verification_incomplete',
  'final_verdict_uncertain','final_verdict_pass','final_verdict_unknown','nomination_only'];
const GATE_CONDITIONS=['not_introduced','not_grounded','source_span_not_unique','candidate_span_not_unique',
  'source_span_still_present','no_prior_same_span'];
const MAX_GATE_ROWS=12,MAX_OVERLAP_CHARS=600,MAX_PRIOR_SPANS=64;
const spanDigest=value=>require('./semanticProvenance').textDigest(bare(value)).slice(0,12);
// Longest common run of characters, whitespace removed (the gate compares the
// same projection). Bounded input; two rolling rows.
function longestCommonRun(a,b) {
  if(!a || !b)return 0;
  let best=0,previous=new Uint16Array(b.length+1);
  for(let i=1;i<=a.length;i++){
    const row=new Uint16Array(b.length+1);
    for(let j=1;j<=b.length;j++)if(a[i-1]===b[j-1]){row[j]=previous[j-1]+1;if(row[j]>best)best=row[j];}
    previous=row;
  }
  return best;
}
function gateState(report,status) {
  if(!report || typeof report!=='object' || status==='skipped')return 'no_final_verdict';
  if(status==='stale')return 'final_verdict_stale';
  // A final verdict cut by time: the gate never saw a completed decision.
  if(report.verificationCompleted!==true)return 'final_verification_incomplete';
  if(status==='pass')return 'final_verdict_pass';
  if(report.uncertain || status==='uncertain')return 'final_verdict_uncertain';
  if(status!=='fail')return 'final_verdict_unknown';
  if(report.nominationOnly)return 'nomination_only';
  return 'evaluated';
}
function explainConfirmedOmissions(source,candidate,report,priorReports=[]) {
  const status=verifySemanticValidation(report,{source,candidate,requireDigest:true}).status;
  const state=gateState(report,status);
  // The same walk as confirmedOmissions(), counting what it keeps and drops.
  const previous=new Set(),seen=new Set();
  let priorReportCount=0,priorQualifiedReportCount=0,priorOmissionFindingCount=0,priorOmissionUnqualifiedCount=0;
  const visit=r=>{
    if(!r || r===report || seen.has(r))return;seen.add(r);priorReportCount+=1;
    const qualified=r.pass===false && !r.uncertain && !r.skipped && r.verificationCompleted===true;
    if(qualified)priorQualifiedReportCount+=1;
    for(const v of r.violations||[]){
      if(v?.type!=='omission')continue;
      priorOmissionFindingCount+=1;
      if(qualified && v.origin==='introduced' && hasGroundedSpan(v))previous.add(bare(v.sourceSpan));
      else priorOmissionUnqualifiedCount+=1;
    }
    for(const child of r.reports||[])visit(child);
  };
  (Array.isArray(priorReports)?priorReports:[]).forEach(visit);
  const priorSpans=[...previous].slice(0,MAX_PRIOR_SPANS).map(span=>span.slice(0,MAX_OVERLAP_CHARS));
  const candidateBare=bare(candidate);
  const failed=Object.fromEntries(GATE_CONDITIONS.map(code=>[code,0]));
  const firstFailed=Object.fromEntries(GATE_CONDITIONS.map(code=>[code,0]));
  const overlap={exact:0,high:0,partial:0,low:0};
  const onlyPriorMissing={count:0,high:0,partial:0,low:0};
  const violations=Array.isArray(report?.violations)?report.violations:[];
  const omissions=violations.filter(v=>v?.type==='omission');
  const rows=[];
  let conditionsMetCount=0;
  for(const v of omissions){
    const sourceSpan=typeof v.sourceSpan==='string'?v.sourceSpan:'',candidateSpan=typeof v.candidateSpan==='string'?v.candidateSpan:'';
    const key=bare(sourceSpan);
    const checks={
      not_introduced:v.origin!=='introduced',
      not_grounded:!hasGroundedSpan(v),
      source_span_not_unique:!unique(String(source||''),sourceSpan),
      candidate_span_not_unique:!unique(String(candidate||''),candidateSpan),
      source_span_still_present:candidateBare.includes(key),
      no_prior_same_span:!previous.has(key)
    };
    const failures=GATE_CONDITIONS.filter(code=>checks[code]);
    for(const code of failures)failed[code]+=1;
    if(failures.length)firstFailed[failures[0]]+=1; else conditionsMetCount+=1;
    // How close the nearest earlier independent omission finding was.
    let run=0,priorChars=0;
    const probe=key.slice(0,MAX_OVERLAP_CHARS);
    if(probe)for(const prior of priorSpans){
      const length=prior===probe?probe.length:longestCommonRun(probe,prior);
      if(length>run || (length===run && run>0 && prior.length<priorChars)){run=length;priorChars=prior.length;}
    }
    const shorter=probe && priorChars?run/Math.min(probe.length,priorChars):0;
    const longer=probe && priorChars?run/Math.max(probe.length,priorChars):0;
    const band=!checks.no_prior_same_span?'exact':shorter>=0.8?'high':shorter>=0.5?'partial':'low';
    overlap[band]+=1;
    if(failures.length===1 && failures[0]==='no_prior_same_span'){onlyPriorMissing.count+=1;onlyPriorMissing[band]+=1;}
    if(rows.length<MAX_GATE_ROWS)rows.push({
      sourceSpanChars:key.length,candidateSpanChars:bare(candidateSpan).length,sourceSpanDigest:key?spanDigest(sourceSpan):'',
      introduced:!checks.not_introduced,grounded:!checks.not_grounded,sourceUnique:!checks.source_span_not_unique,
      candidateUnique:!checks.candidate_span_not_unique,absentFromCandidate:!checks.source_span_still_present,
      priorSameSpan:!checks.no_prior_same_span,
      priorOverlapOfShorter:Math.round(shorter*100)/100,priorOverlapOfLonger:Math.round(longer*100)/100,
      nearestPriorChars:priorChars,firstFailedCondition:failures[0]||''
    });
  }
  return {
    version:GATE_DIAGNOSTICS_VERSION,state,finalStatus:status,
    finalVerificationCompleted:report?.verificationCompleted===true,
    finalViolationCount:violations.length,omissionCount:omissions.length,
    priorReportCount,priorQualifiedReportCount,priorOmissionFindingCount,priorOmissionUnqualifiedCount,
    priorOmissionSpanCount:previous.size,
    conditionFailedCounts:failed,firstFailedCounts:firstFailed,
    // Omission findings that meet every per-finding condition, whatever the
    // state; they block delivery only when state === 'evaluated'.
    conditionsMetCount,confirmedCount:state==='evaluated'?conditionsMetCount:0,
    priorOverlapCounts:overlap,onlyPriorMissing,
    overflowRowCount:Math.max(0,omissions.length-rows.length),rows
  };
}
// Persistence projection: fixed codes, booleans, bounded numbers and a hex
// digest. Anything else, including any string from a model, is dropped.
function sanitizeOmissionGateDiagnostics(value) {
  if(!value || value.version!==GATE_DIAGNOSTICS_VERSION || !GATE_STATES.includes(value.state))return null;
  const whole=n=>Number.isSafeInteger(n) && n>=0?Math.min(1000000,n):0;
  const ratio=n=>typeof n==='number' && Number.isFinite(n)?Math.max(0,Math.min(1,Math.round(n*100)/100)):0;
  const counts=(source,keys)=>Object.fromEntries(keys.map(key=>[key,whole(source?.[key])]));
  const clean={version:GATE_DIAGNOSTICS_VERSION,state:value.state,
    finalStatus:['fail','pass','uncertain','stale','unknown','skipped'].includes(value.finalStatus)?value.finalStatus:'unknown',
    finalVerificationCompleted:value.finalVerificationCompleted===true,
    ...counts(value,['finalViolationCount','omissionCount','priorReportCount','priorQualifiedReportCount',
      'priorOmissionFindingCount','priorOmissionUnqualifiedCount','priorOmissionSpanCount','conditionsMetCount',
      'confirmedCount','overflowRowCount']),
    conditionFailedCounts:counts(value.conditionFailedCounts,GATE_CONDITIONS),
    firstFailedCounts:counts(value.firstFailedCounts,GATE_CONDITIONS),
    priorOverlapCounts:counts(value.priorOverlapCounts,['exact','high','partial','low']),
    onlyPriorMissing:counts(value.onlyPriorMissing,['count','high','partial','low'])};
  clean.rows=(Array.isArray(value.rows)?value.rows:[]).slice(0,MAX_GATE_ROWS).filter(row=>row && typeof row==='object').map(row=>({
    ...counts(row,['sourceSpanChars','candidateSpanChars','nearestPriorChars']),
    sourceSpanDigest:/^[0-9a-f]{12}$/u.test(row.sourceSpanDigest)?row.sourceSpanDigest:'',
    ...Object.fromEntries(['introduced','grounded','sourceUnique','candidateUnique','absentFromCandidate','priorSameSpan']
      .map(key=>[key,row[key]===true])),
    priorOverlapOfShorter:ratio(row.priorOverlapOfShorter),priorOverlapOfLonger:ratio(row.priorOverlapOfLonger),
    firstFailedCondition:GATE_CONDITIONS.includes(row.firstFailedCondition)?row.firstFailedCondition:''
  }));
  return clean;
}
function stopUnproductiveShortEscalation({attempt,sourceLength,semantic,metrics,reason}) {
  return attempt>0 && sourceLength>0 && sourceLength<=600
    && semantic?.ran===true && semantic.pass===true && !semantic.uncertain
    && semantic.verificationCompleted!==false
    && Number(metrics?.substantiveChangedSentenceCount)>0 && Number(metrics?.substantiveEditRatio)>=0.01
    && ['candidate_unchanged','depth_not_improved','minimum_effect_failed','safety_audit_failed'].includes(reason);
}
module.exports={confirmedOmissions,stopUnproductiveShortEscalation,explainConfirmedOmissions,
  sanitizeOmissionGateDiagnostics,GATE_DIAGNOSTICS_VERSION,GATE_STATES,GATE_CONDITIONS};
