# Engine release-gates candidate — 2026-09-28

## Status: HOLD, not deployed

Candidate v2.5.86 / detect v1.51 extends the previously held archive.
Production base was re-fetched as `f1b5b85`. Models, billing, delivery policy,
history adjustment, score floors and production settings are unchanged.

## Changes

- Retain request-local, still-exact confirmed findings as repair nominations
  when a later verdict is incomplete. Respect grounded explicit dismissals;
  never grant pass from old evidence or move an ambiguous repair target.
- Add confirmed, exact paired new-repetition findings to bounded restoration.
  All window, quotation, ownership, 30% and eight-window limits remain.
  This is not fuzzy deletion and every proposal still requires revalidation.
- In verdict-only audits, schedule larger windows first. Where verified unique
  headings allow a complete two-window partition of a <=12,000-character
  document, use two <=6,000-character windows instead of a queued third window.
  No guessed boundaries, increased concurrency or extended final deadline.
- Clarify implicit adjacent references versus actual changed referents,
  conditions, temporal order and causality. Do not require lexical identity
  merely to resolve an earlier finding.
- Short detection gets at most one existing confirming call for a narrowly
  grounded recurring content signal. A high confirming result requires its
  own independent supported causes; otherwise retain primary score AND causes.
  Record the selected phase separately from attempted phase and total cost.

## Tests and actual execution

- Full backend: **2,506 passed**, zero failures/skips.
- Production import graph: 269 files, 817 edges, no violations.
- Historical 456-pair audit partition replay: only three re-partitioned;
  exact character coverage, order and limits passed. Not a semantic review.
- Four previously seen short development controls, three fresh repetitions
  each. An additional three hybrid replays exercised the new one-category
  route with actual confirming calls. No blind-accuracy claim.
- Full long generation returned in 771 seconds but final audit was incomplete
  (2/3 sections). Manual reading found a subject/predicate mismatch and new
  repeated activity description. This run is NOT a pass.
- After further fixes, automatic repair of the stored candidate plus fresh
  whole-document audit completed 2/2 sections in 111.9 seconds, but remaining
  connective/reference findings prevented pass. This was a stage replay, not
  a full regeneration or an exact reconstruction of all request-local state.
- The clarified context contract passed a faithful implicit-reference control,
  rejected changed-reference and reversed-order controls, and passed the saved
  second long section. Do not combine verdicts across revisions into a claim
  of one successful current full-pipeline run.

## Council and budget

Actual Claude Opus 5.5 and Fable 5.1 participated in two rounds each; views were
cross-presented and counterexamples tested. No unanimous release approval is
claimed. Raw customer material and local responses are outside Git.

New total approval: KRW 3,000, including council and tests. Accounted KRW
2,694.31 at planning FX 2,000/USD, including KRW 265.72 of unknown canceled-call
reservation. Remaining KRW 305.69 cannot admit the required full long rerun.
Ledger closed. No customer-credit deduction or production database write.

## Remaining release gates

Latest complete generation/selection/repair/final-validation run of the long
case, the other pending full-document case, and remaining flattened-report
subheading/body readability are not certified. Short-sample generalization
also remains limited. Preserve this tested candidate on an archive branch;
do not deploy it or announce these changes as live. Re-fetch current production
before resuming and reserve the full validation budget before requests.
