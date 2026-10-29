'use strict';

// A final recheck may reveal another local error after fixing the first ones.
// Keep that partially repaired text privately for ONE further literal proposal,
// instead of discarding the repairs and sending the user through generation
// again. No new model patch, renewed deadline, unverified output, or mode change.
async function completeFinalRestoration({ source, before, initial, verify, propose,
  accepts, observe, deadlineMs, signal, now = Date.now }) {
  let proposal=initial,report,text=initial.text,restoredCount=initial.restoredCount||0;
  const warnings=new Set(initial.warnings||[]), seen=new Set([before,text]);
  const priorReports=[];
  // Eight tiny, independently grounded sentence repairs in a long document
  // must not consume the same count allowance as eight large replacements in
  // a short one. Per-proposal caps, cumulative 30% byte limits, two verdicts
  // and the original deadline remain unchanged.
  const countLimit=Math.min(16,Math.max(8,Math.ceil(Math.min(source.length,before.length)/1000)));
  let removed=initial.restorationBudget?.removed,added=initial.restorationBudget?.added;
  for(let round=1;round<=2;round++) {
    if(signal?.aborted||deadlineMs<=now())return {accepted:false,reason:signal?.aborted?'aborted':'deadline_insufficient'};
    const started=now();
    report=await verify(text,priorReports);
    const accepted=accepts(report,text);
    observe({candidate:text,report,accepted,round});
    priorReports.push(report);
    if(accepted)return {accepted:true,text,report,restoredCount,
      patchedCount:initial.patchedCount||0,warnings:[...warnings],rounds:round};
    if(round===2)return {accepted:false,reason:'verification_failed',rounds:round};
    if(report?.pass!==false||report.verificationCompleted!==true||report.skipped
        ||signal?.aborted)return {accepted:false,reason:'verification_incomplete',rounds:round};
    // A preceding model patch / insertion has no literal byte receipt. Do not
    // reset the cumulative 30% restoration budget around that unknown edit.
    // A rejected/failed model proposal did not change the literal candidate.
    // Only an ACCEPTED patch invalidates its byte receipt.
    if(initial.patchedCount||initial.reinstatedCount
        ||!Number.isFinite(removed)||!Number.isFinite(added))
      return {accepted:false,reason:'restoration_budget_unavailable',rounds:round};
    const reserve=Math.max(30000,Math.ceil((now()-started)*1.2));
    if(deadlineMs-now()<reserve)return {accepted:false,reason:'deadline_insufficient',rounds:round};
    proposal=await propose(text,report);
    if(!proposal?.applied||!proposal.restoredCount||seen.has(proposal.text))
      return {accepted:false,reason:proposal?.skipReason||'no_grounded_target',rounds:round};
    const budget=proposal.restorationBudget;
    if(!budget||!Number.isFinite(budget.removed)||!Number.isFinite(budget.added)
        ||removed+budget.removed>before.length*.3||added+budget.added>source.length*.3
        ||restoredCount+proposal.restoredCount>countLimit)
      return {accepted:false,reason:'restoration_budget_exhausted',rounds:round};
    if(signal?.aborted||deadlineMs-now()<reserve)
      return {accepted:false,reason:signal?.aborted?'aborted':'deadline_insufficient',rounds:round};
    text=proposal.text;seen.add(text);removed+=budget.removed;added+=budget.added;
    restoredCount+=proposal.restoredCount;
    for(const warning of proposal.warnings||[])warnings.add(warning);
  }
}

module.exports={completeFinalRestoration};
