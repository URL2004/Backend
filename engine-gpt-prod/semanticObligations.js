'use strict';

const { textDigest } = require('./semanticProvenance');
const unique = (text, span) => typeof span === 'string' && span.length > 0
  && text.indexOf(span) >= 0 && text.indexOf(span) === text.lastIndexOf(span);

// Missing words locate in SOURCE, not in the candidate from which they vanished.
function hasGroundedSpan(finding) {
  return finding?.repairable === true && finding.relationGrounded === true
    && finding.grounding === 'unique_exact_span'
    && (finding.type === 'omission' ? finding.sourceSpanVerified === true : finding.spanVerified === true);
}
const obligationId = v => textDigest(JSON.stringify([v.type,v.sourceSpan,v.relation,
  v.type==='omission'?v.span:''])).slice(0,24);

// This is request-local evidence, never an oracle. A changed candidate quotation
// does not erase its source-anchored question. The next EXISTING audit must
// explicitly resolve or dismiss it; missing reviews remain uncertain.
function collectObligations(source, reports = [], project = value => value) {
  const found = new Map(), visited = new Set();
  const visit = report => {
    if (!report || typeof report !== 'object' || visited.has(report)) return;
    visited.add(report);
    if (!report.skipped && report.verificationCompleted !== false) {
      for (const value of [...(report.violations || []), ...(report.initialViolations || [])]) {
        if (value?.origin !== 'introduced' || !hasGroundedSpan(value)) continue;
        const v = {...value, sourceSpan:project(value.sourceSpan), candidateSpan:project(value.candidateSpan), span:project(value.span)};
        if (typeof v.sourceSpan!=='string' || v.sourceSpan.length < 12 || !v.candidateSpan) continue;
        const id = obligationId(v);
        if (!found.has(id)) found.set(id,{id,finding:v,questions:[]});
        const group=found.get(id);
        const questions=v.obligationQuestions||[{previousCandidateSpan:v.candidateSpan,previousProblemSpan:v.span,detail:v.detail||''}];
        for(const question of questions)
          if(!group.questions.some(q=>JSON.stringify(q)===JSON.stringify(question)))group.questions.push(question);
        group.finding.obligationQuestions=group.questions;
      }
    }
    for (const child of [...(report.reports || []), ...(report.restorationNominationReports || [])]) visit(child);
  };
  for (const report of reports) visit(report);
  return [...found.values()];
}

function reviewSchema(base, obligations) {
  if (!obligations.length) return base;
  return {...base,properties:{...base.properties,obligationReviews:{type:'array',items:{type:'object',additionalProperties:false,
    properties:{id:{type:'string',enum:obligations.map(o=>o.id)},
      status:{type:'string',enum:['resolved','not_error','unresolved']},
      sourceSpan:{type:'string'},candidateSpan:{type:'string'},detail:{type:'string'}},
    required:['id','status','sourceSpan','candidateSpan','detail']}}},required:[...base.required,'obligationReviews']};
}

function currentCandidateReferences(obligations, candidate) {
  const refs = Object.create(null);
  for (const { id, finding } of obligations) {
    // Exact, unique current quotations only. This locates evidence, never
    // decides whether its meaning or surrounding ownership is preserved.
    const spans = [finding.sourceSpan, finding.candidateSpan];
    const span = spans.find(s => unique(candidate, s) && s.trim().length >= 8);
    if (span) refs[id] = span;
  }
  return refs;
}

function reviewPayload(obligations, references = {}) {
  return obligations.map(({id,finding:v,questions})=>({id,type:v.type,sourceSpan:v.sourceSpan,
    previousCandidateSpan:v.candidateSpan,previousProblemSpan:v.span,relation:v.relation,previousDetail:v.detail,
    ...(references[id] ? {currentCandidateReference: references[id] === v.sourceSpan ? 'sourceSpan' : 'previousCandidateSpan'} : {}),
    previousQuestions:(questions||[]).filter(q=>q.previousCandidateSpan!==v.candidateSpan
      || q.previousProblemSpan!==v.span || q.detail!==(v.detail||''))}));
}

function assessReviews(obligations, reviews, source, candidate, {allowDismiss=false,candidateReferences={}}={}) {
  const result=[], pending=[];
  for (const {id,finding} of obligations) {
    const matches=(reviews||[]).filter(r=>r?.id===id),answer=matches[0];
    // An explicit empty source quote references the immutable source anchor ID;
    // the CURRENT candidate quote must be supplied or explicitly referenced
    // from this request's verified unique quotations. Absence is not a reference.
    const ref=candidateReferences[id];
    const validRef=ref && [finding.sourceSpan,finding.candidateSpan].includes(ref) && unique(candidate,ref);
    const r=answer && {...answer,sourceSpan:answer.sourceSpan===''?finding.sourceSpan:answer.sourceSpan,
      candidateSpan:answer.candidateSpan==='' && validRef ? ref : answer.candidateSpan};
    const valid=matches.length===1 && ['resolved','not_error','unresolved'].includes(r.status)
      && r.sourceSpan===finding.sourceSpan && unique(source,r.sourceSpan)
      && unique(candidate,r.candidateSpan) && r.candidateSpan.trim().length>=8 && r.detail?.trim().length>=8
      && (r.status!=='not_error'||allowDismiss)
      && (r.status!=='resolved'||r.candidateSpan!==finding.candidateSpan);
    const status=valid?r.status:'unconfirmed';
    result.push({id,status,sourceSpan:finding.sourceSpan,
      candidateSpan:valid?r.candidateSpan:'',detail:valid?r.detail:'Prior finding was not explicitly grounded and adjudicated.'});
    if (!valid || status==='unresolved') pending.push({...finding,
      // Never treat an old quotation as a current repair target.
      candidateSpan:valid?r.candidateSpan:'',origin:'unconfirmed',repairable:false,
      relationGrounded:false,grounding:'unresolved_obligation',
      detail:valid?r.detail:'Earlier semantic finding requires explicit re-adjudication.',obligationId:id});
  }
  return {reviews:result,pending};
}

function projectEvidence(report, project) {
  if (!report) return report;
  const map=v=>({...v,sourceSpan:project(v.sourceSpan),candidateSpan:project(v.candidateSpan),span:project(v.span)});
  return {...report,violations:(report.violations||[]).map(map),initialViolations:(report.initialViolations||[]).map(map),
    reports:(report.reports||[]).map(r=>projectEvidence(r,project)),
    restorationNominationReports:(report.restorationNominationReports||[]).map(r=>projectEvidence(r,project))};
}

function allExplicitlyReviewed(obligations, report) {
  const reviews=[...(report?.obligationReviews||[]),...(report?.reports||[]).flatMap(r=>r.obligationReviews||[])];
  return obligations.every(o=>reviews.some(r=>r.id===o.id && ['resolved','not_error'].includes(r.status)));
}

module.exports={hasGroundedSpan,collectObligations,reviewSchema,reviewPayload,assessReviews,obligationId,projectEvidence,allExplicitlyReviewed,currentCandidateReferences};
