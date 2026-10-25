# v2.5.122 — safety-stop recovery

2026-10-25. Detector remains v1.61; scoring and history adjustment constants are unchanged.

The current-engine census contained 185 completions and 19 safety stops. In the reported interval, 10 stops and 12 user cancellations had no deduction flag or matching charge ledger. These samples do not establish a causal before/after rate.

## Changes

- A final relation patch can borrow at most 30 seconds from its already reserved final-verdict window. The shared money/call caps, absolute job deadline and remaining verdict reservation still apply. An expired optional-recovery clock no longer prevents this reserved attempt before any HTTP request. No-call admission failures are identified separately from provider timeouts.
- A grounded subclause can nominate its complete source sentence only with unique mutual ownership, protected-text and neighbouring-content checks. Final recovery prefers this source sentence for factual relation errors over a partial word replacement. Existing replacement-count/coverage limits and a fresh digest-bound semantic pass remain required. Sentence expansion is bounded to documents with at most 512 sentence spans.
- Polish word-frequency heuristics cannot authorize an early rollback, extra full rewrite or terminal stop. The mandatory semantic verdict determines whether an introduced evaluation is real. Confirmed residual additions stop delivery; incomplete evidence retains review status. Unchanged-output handling remains intact.
- Blocked jobs atomically save private source/candidate and final-recovery evidence with their terminal state. These fields are excluded from public job/archive payloads. The admin endpoint checks administrator access, archived owner/status and evidence digests. Existing account-deletion handling covers the same evidence collection.
- The frontend exposes blocked evidence to administrators and gives polish users the same reason, no-charge notice and job ID as other humanizing modes. A preservation failure does not ask the user to invent experience.

## Verification and limits

Regression coverage includes expired clocks with fixed final deadlines, exhausted funds/call limits, HTTP admission, confirmed and unconfirmed meaning changes, source ownership, evidence tampering and access control, and user/admin rendering. Run the complete backend/frontend suites and production-import check before deployment.

The earlier blocked candidates were never persisted; their original wording cannot be reconstructed. Re-running a model would create a new candidate, not recover historical evidence. This change does not prove every old stop was a false positive or that production stops will become zero. No paid customer job is replayed by this release's checks.
