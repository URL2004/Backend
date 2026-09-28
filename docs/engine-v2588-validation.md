# v2.5.88 candidate validation — not deployed

## Scope

Based on production `f1b5b85` and archived candidate `9238a50`. No production
branch push, environment change, billing change, user-credit deduction or
Firestore write was made for this validation. Detector remains candidate v1.51.

## Implemented

- Send every semantic obligation and operator question that the response
  assessor requires. The previous 16/12-item slices could make an obligation
  impossible to answer while still requiring it for acceptance.
- Permit an explicit current-candidate quotation reference only when an input
  source/previous quotation exists uniquely in the current candidate. A model
  answer with status and concrete rationale remains mandatory. Stale, ambiguous,
  missing and duplicate answers cannot pass; unchanged previous errors cannot
  be called resolved. Dismissal still requires the configured confirming model.
- Add multi-replacement, Unicode-offset, stale-verdict, target-overflow and
  current-reference adversarial regressions. No model/effort/deadline relaxation.

## Checks

- Full backend suite: 2,518 passed; 0 failed, cancelled or skipped.
- Production import graph: 269 files, 817 edges, 0 violations.
- Synthetic three-job final-layout benchmark: batch p95 196.52 ms; event-loop
  maximum 19.63 ms. Content/order/cancellation checks passed. Not production p95.
- Actual Opus 5.5 and Fable 5.1 each reviewed twice, with counterarguments passed
  between them. Reviews are advice, not release certification.

## Paid results and release decision

The separate KRW 5,000 ceiling includes council, retries and unresolved usage.
Planning FX is 2,000 KRW/USD. Accounted total: KRW 4,671.42, comprising
KRW 1,653.26 priced usage and KRW 3,018.16 retained unknown reservations.
No cancelled request was treated as free.

- Latest fresh full generation did not complete within the private 900-second
  test deadline. This is not proof of exceeding production's configured deadline.
- Prior 120-second full final audits completed neither of two windows.
- With compact current references, the 17-obligation first window passed in
  76 seconds; the second timed out. Aggregate verification remains incomplete.
- A separate retry of the same unfinished second window also timed out.
- A PRIVATE four-heading-window scheduling experiment completed 1/4 windows
  within the unchanged 120-second deadline. It was not adopted into production
  code. Additional calls did not establish a latency solution.

All four sections of the saved candidate were manually compared. Known local
restorations and heading/paragraph continuity were observed, but manual review
does not convert unfinished model validation into a pass or establish broad
quality/accuracy claims.

**Release held.** No detector-only release, forced pass, deadline increase,
reasoning reduction or unverified restoration adoption was used to clear it.
Raw texts, prompts, response captures, budgets and local runners stay outside git.

## Remaining engineering issue

The fixed final deadline is not reliably compatible with cumulative whole-window
confirming-model work. Successful observed calls took 117–139 seconds; other
attempts reached 120/180-second limits. Input length or window count alone did
not predict completion. Repeating the same calls is not a demonstrated fix.

A future incremental verifier must bind each completed section to exact source,
candidate, structural ownership, neighboring context and obligation-set digests;
only unchanged, fully adjudicated evidence may be reused. Changed boundaries,
unresolved claims and missing answers must still receive fresh checks. That
design and a latest integrated full run remain unimplemented/unverified here.
