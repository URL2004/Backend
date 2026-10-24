'use strict';
const {verifySemanticValidation}=require('./semanticProvenance');
const {hasGroundedSpan}=require('./semanticObligations');
const bare=value=>String(value||'').replace(/\s/gu,'');
const unique=(text,span)=>typeof span==='string' && span.trim().length>=12
  && text.includes(span) && text.indexOf(span)===text.lastIndexOf(span);
// A current verdict may have been materialized after whitespace-only layout
// repair. Use the same unique locator as semantic grounding; never erase word
// boundaries, change punctuation, or accept an ambiguous normalized match.
const uniqueCandidate=(text,span)=>require('./evidenceSpan').locateEvidenceSpan(text,span,12)!==null;
const sameMissingClaim=(span,previous,candidate)=>previous.has(span) || [...previous].some(prior=>
  Math.min(prior.length,span.length)>=24
  && Math.min(prior.length,span.length)/Math.max(prior.length,span.length)>=0.35
  && (prior.includes(span) || span.includes(prior)) && !candidate.includes(prior));
// F02: a sentence deleted whole is usually named by the final verdict alone, so
// the repeated-finding rule let it through. The verdict's quotation must cover
// at least half of a sentence that is textually witnessed as dropped.
const droppedWhole=(source,candidate,v)=>{
  const at=source.indexOf(v.sourceSpan),end=at+v.sourceSpan.length;
  return require('./deliveryIntegrityWitnesses').droppedSourceSentences(source,candidate,{spans:[{start:at,end}]})
    .some(w=>(Math.min(end,w.sourceEnd)-Math.max(at,w.sourceStart))*2>=w.sourceEnd-w.sourceStart);
};
// A claim the source states twice has no words of its own, so droppedWhole()
// abstains even when one statement left an empty slot. Witness that slot
// textually: the quoted window is one missing sentence with at most its two
// neighbours; both neighbours survive verbatim, once each, as consecutive
// result sentences that bracket the judge's context quote; neither neighbour
// resembles it (benign local compression); none of its own words survive; and
// every result sentence resembling it is another source sentence's verbatim
// copy or sits in that sentence's slot: next to its verbatim neighbour, its
// unique best match, not grown. That owner stands in another source block.
// Similarity alone never assigns an owner. Bounded: 400 sentences a side,
// 3 resembling rows.
const GAP_NEAR=0.44,GAP_MARGIN=0.08,GAP_MAX_NEAR=3,GAP_MAX_SENTENCES=400;
function bracketedGap(source,candidate,v) {
  const {splitSentenceSpans}=require('../engine/koreanText');
  const {sentenceSimilarity:sim,contentTokens}=require('./sentenceAlignment');
  const at=source.indexOf(v.sourceSpan),end=at+v.sourceSpan.length;
  const context=require('./evidenceSpan').locateEvidenceSpan(candidate,v.candidateSpan,12);
  const S=splitSentenceSpans(source),O=splitSentenceSpans(candidate);
  if(at<0 || !context || S.length<3 || S.length>GAP_MAX_SENTENCES || !O.length || O.length>GAP_MAX_SENTENCES)return false;
  const sourceBare=bare(source),outputBare=bare(candidate),outputKeys=O.map(o=>bare(o.text));
  const once=(text,key)=>text.indexOf(key)>=0 && text.indexOf(key)===text.lastIndexOf(key);
  // Result index of source sentence j kept verbatim and unambiguous, else -1.
  const anchor=j=>{
    const key=bare(S[j]?.text);
    return key.length>=12 && once(sourceBare,key) && once(outputBare,key)?outputKeys.indexOf(key):-1;
  };
  const sourceOf=q=>{const key=outputKeys[q];const j=key?S.findIndex(s=>bare(s.text)===key):-1;return j>=0 && anchor(j)===q?j:-1;};
  const touched=S.map((s,i)=>i).filter(i=>S[i].start<end && S[i].end>at);
  const missing=touched.filter(i=>!outputBare.includes(bare(S[i].text)));
  if(missing.length!==1)return false;
  const k=missing[0],middle=S[k].text;
  if(k<1 || k>=S.length-1 || S[k].start<at || S[k].end>end || touched.some(i=>Math.abs(i-k)>1)
    || bare(middle).length<12 || !/[.!?。！？][”’"')\]]*$/u.test(bare(middle)))return false;
  const p=anchor(k-1);
  if(p<0 || anchor(k+1)!==p+1 || context.start<O[p].start || context.end>O[p+1].end)return false;
  // A neighbour restating it, by score or by holding a third of its words
  // (suffix stripping loses 창가, 바로), may already carry the claim in place.
  const middleWords=contentTokens(middle);
  if([S[k-1],S[k+1]].some(s=>sim(middle,s.text)>=GAP_NEAR
    || middleWords.filter(t=>bare(s.text).includes(t)).length*3>=middleWords.length))return false;
  const near=O.map((o,q)=>q).filter(q=>sim(middle,O[q].text)>=GAP_NEAR);
  if(near.length>GAP_MAX_NEAR)return false;
  // The merge guards of droppedSourceSentences(): a word no other source
  // sentence contains (as text, so 출입문 is not its own beside 출입문이다)
  // survives anywhere, or an owner grew past 1.3x + 8 or by 3 words it lacks.
  const sourceKeys=S.map(s=>bare(s.text));
  if(middleWords.some(t=>outputBare.includes(t) && !sourceKeys.some((other,j)=>j!==k && other.includes(t))))return false;
  const clause=(kept,owner)=>{
    const known=new Set(contentTokens(S[owner].text).map(t=>t.slice(0,2)));let run=0;
    return contentTokens(kept).some(t=>(run=known.has(t.slice(0,2))?0:run+1)>=3);
  };
  // Source sentence whose slot result row q fills, else -1. A verbatim,
  // unambiguous copy is owned by its own sentence.
  const owner=q=>{
    if(sourceOf(q)>=0)return sourceOf(q);
    for(const [side,step] of [[q-1,1],[q+1,-1]]){
      const neighbour=side>=0 && side<O.length?sourceOf(side):-1,j=neighbour<0?-1:neighbour+step;
      if(j<0 || j>=S.length || outputBare.includes(bare(S[j].text)))continue;
      // The row on the other side, if verbatim, must be j's other neighbour.
      const across=q+step>=0 && q+step<O.length?sourceOf(q+step):-1;
      if(across>=0 && across!==j+step)continue;
      let top=-1,first=0,second=0;
      O.forEach((o,x)=>{const value=sim(S[j].text,o.text);if(value>first){second=first;first=value;top=x;}else if(value>second)second=value;});
      if(top===q && first>=GAP_NEAR && first-second>=GAP_MARGIN
        && outputKeys[q].length<=bare(S[j].text).length*1.3+8 && !clause(O[q].text,j))return j;
    }
    return -1;
  };
  // The owner must stand in another source block (split by blank or heading
  // lines): the source restating a claim within one passage makes dropping one
  // statement a legitimate deduplication, and a text without blocks abstains.
  const blocks=[];let block=0;
  for(const line of source.matchAll(/[^\n]*\n?/gu)){
    if(!line[0])break;
    const text=line[0].trim();
    // An unfinished physical prose line is not a new section. Only blank
    // lines or short, explicitly numbered/marked headings separate slots.
    const heading=text.length<=120 && !/[.!?。！？…][”’"')\]]*$/u.test(text)
      && /^(?:\d+(?:\.\d+)*[.)]|[IVX]+[.)]|#{1,6}|첫째|둘째|셋째|넷째|다섯째)\s+\S/u.test(text);
    if(!text || heading)block+=1;
    blocks.push([line.index,block]);
  }
  const blockOf=at=>blocks.reduce((found,[start,index])=>start<=at?index:found,0);
  return near.every(q=>{const j=owner(q);return j>=0 && blockOf(S[j].start)!==blockOf(S[k].start);});
}

// A fail label alone is not a hard delivery gate. Require the final candidate
// receipt, a unique current context, and independent evidence about the same
// missing source claim: a prior finding, or a textual witness that the quoted
// sentence was dropped whole or left its slot empty. No additional model
// request is made here.
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
    && hasGroundedSpan(v) && unique(source,v.sourceSpan) && uniqueCandidate(candidate,v.candidateSpan)
    && !candidateBare.includes(bare(v.sourceSpan))
    && (sameMissingClaim(bare(v.sourceSpan),previous,candidateBare) || droppedWhole(source,candidate,v)
      || bracketedGap(source,candidate,v)));
}

// A complete, current judge that explicitly confirms changed ownership,
// condition or polarity must not be softened into charged review delivery.
// Unlike stylistic warnings these are paired meaning errors. Unlocated,
// stale, incomplete, source-existing and globally uncertain findings abstain.
function confirmedRelationDefects(source, candidate, report) {
  const status = verifySemanticValidation(report, { source, candidate, requireDigest: true }).status;
  if (!['fail', 'uncertain'].includes(status) || report?.pass !== false || report.nominationOnly
      || report.verificationCompleted !== true || report.skipped) return [];
  if (report.uncertain && !(report.violations || []).some(v => v?.origin === 'unconfirmed'
      || v?.repairable === false || v?.relationGrounded === false)) return [];
  return (report.violations || []).filter(v => ['distortion', 'added_claim', 'scope_expansion', 'experience_novelty'].includes(v.type)
    && ['actor_action_target', 'condition_result', 'quantity_target', 'variable_definition', 'antecedent', 'modality_negation_causality'].includes(v.relation)
    && v.origin === 'introduced' && hasGroundedSpan(v) && v.spanVerified === true
    && unique(source, v.sourceSpan) && uniqueCandidate(candidate, v.candidateSpan)
    && bare(v.sourceSpan) !== bare(v.candidateSpan));
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
  let conditionsMetCount=0,droppedSentenceWitnessCount=0,bracketedGapWitnessCount=0;
  for(const v of omissions){
    const sourceSpan=typeof v.sourceSpan==='string'?v.sourceSpan:'',candidateSpan=typeof v.candidateSpan==='string'?v.candidateSpan:'';
    const key=bare(sourceSpan);
    const priorSame=sameMissingClaim(key,previous,candidateBare);
    const eligible=v.origin==='introduced' && hasGroundedSpan(v) && unique(String(source||''),sourceSpan)
      && uniqueCandidate(String(candidate||''),candidateSpan) && !candidateBare.includes(key);
    const witnessed=eligible && !priorSame && droppedWhole(String(source),String(candidate),v);
    const gap=eligible && !priorSame && !witnessed && bracketedGap(String(source),String(candidate),v);
    if(witnessed)droppedSentenceWitnessCount+=1;
    if(gap)bracketedGapWitnessCount+=1;
    const checks={
      not_introduced:v.origin!=='introduced',
      not_grounded:!hasGroundedSpan(v),
      source_span_not_unique:!unique(String(source||''),sourceSpan),
      candidate_span_not_unique:!uniqueCandidate(String(candidate||''),candidateSpan),
      source_span_still_present:candidateBare.includes(key),
      no_prior_same_span:!priorSame && !witnessed && !gap
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
    const band=previous.has(key)?'exact':shorter>=0.8?'high':shorter>=0.5?'partial':'low';
    overlap[band]+=1;
    if(failures.length===1 && failures[0]==='no_prior_same_span'){onlyPriorMissing.count+=1;onlyPriorMissing[band]+=1;}
    if(rows.length<MAX_GATE_ROWS)rows.push({
      sourceSpanChars:key.length,candidateSpanChars:bare(candidateSpan).length,sourceSpanDigest:key?spanDigest(sourceSpan):'',
      introduced:!checks.not_introduced,grounded:!checks.not_grounded,sourceUnique:!checks.source_span_not_unique,
      candidateUnique:!checks.candidate_span_not_unique,absentFromCandidate:!checks.source_span_still_present,
      priorSameSpan:priorSame,droppedSentenceWitness:witnessed,bracketedGapWitness:gap,
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
    // Met through the dropped-sentence witness rather than a repeated finding.
    droppedSentenceWitnessCount,
    // Met through the bracketed empty-slot witness instead of either above.
    bracketedGapWitnessCount,
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
      'confirmedCount','droppedSentenceWitnessCount','bracketedGapWitnessCount','overflowRowCount']),
    conditionFailedCounts:counts(value.conditionFailedCounts,GATE_CONDITIONS),
    firstFailedCounts:counts(value.firstFailedCounts,GATE_CONDITIONS),
    priorOverlapCounts:counts(value.priorOverlapCounts,['exact','high','partial','low']),
    onlyPriorMissing:counts(value.onlyPriorMissing,['count','high','partial','low'])};
  clean.rows=(Array.isArray(value.rows)?value.rows:[]).slice(0,MAX_GATE_ROWS).filter(row=>row && typeof row==='object').map(row=>({
    ...counts(row,['sourceSpanChars','candidateSpanChars','nearestPriorChars']),
    sourceSpanDigest:/^[0-9a-f]{12}$/u.test(row.sourceSpanDigest)?row.sourceSpanDigest:'',
    ...Object.fromEntries(['introduced','grounded','sourceUnique','candidateUnique','absentFromCandidate','priorSameSpan','droppedSentenceWitness','bracketedGapWitness']
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
function stopUnproductiveLongEscalation({attempt,sourceLength,semantic,metrics,reason}) {
  return attempt > 0 && sourceLength >= 6000
    && semantic?.ran === true && semantic.pass === true && !semantic.uncertain && semantic.verificationCompleted === true
    && Number(metrics?.substantiveChangedSentenceCount) >= 4 && Number(metrics?.substantiveEditRatio) >= .1
    && ['no_safe_change', 'candidate_unchanged'].includes(reason);
}
module.exports={confirmedOmissions,confirmedRelationDefects,stopUnproductiveShortEscalation,stopUnproductiveLongEscalation,explainConfirmedOmissions,
  sanitizeOmissionGateDiagnostics,GATE_DIAGNOSTICS_VERSION,GATE_STATES,GATE_CONDITIONS};
