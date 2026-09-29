# Orchestrated semantic release review — 2026-09-29

## Scope and release state

This candidate extends the preserved v2.5.90 work, rebased by cherry-pick onto fetched production `c863be82`. It is **not release-certified**. Historical paid validation still failed; no new paid model call was made during this orchestration turn. Production, runtime flags, models, billing and delivery policies are unchanged.

## Collaboration

Three independent workers investigated repair routing, residual semantic findings, and safety. The coordinator integrated changes and tests. Workers exchanged concrete counterexamples and cross-reviewed each other's changes. These were Codex collaboration workers, not Claude Opus/Fable sessions.

| Finding | Root cause | Correction |
| --- | --- | --- |
| Table ownership could reuse a pass | Whitespace projection erased tab-cell boundaries, even with equal cell counts | Bind raw table rows in both relation digests; version hashes; moved-cell source/candidate is stale |
| Final repaired candidate could use weaker judge routing | Restoration diagnostic marker was not propagated as a confirmation control through section splitting/receipt admission | Explicit final restoration stage forces existing confirmation controls and disables nested repair |
| Long audit reserve was incomplete | Recovery admission reserved 120 seconds despite approved 180-second long-text envelope | Monotonic 120–180 second reservation based on current materialized source/candidate at every admission/deadline |
| Short source grew beyond long-text threshold | Initial source length ignored later candidate growth and shortened frozen literals | Read live merged chunks before merge, then current materialized adopted output; failed reader conservatively reserves 180 seconds |
| Quoted alternative borrowed into narrator claim | Micro restoration protected target quotes but not the source operator's ownership | Reject protected-source operator borrowing; retain existing grounded whole-window restoration fallback |

No acceptance threshold was loosened. No unresolved finding was marked passed. No infinite repair loop or job-deadline extension was introduced.

## Residual document review

Seven historical residual findings were reviewed against their source context. Genuine issues include duplicate content, unnatural conditional phrasing and lost evaluation; temporal ordering and priority/necessity require preservation. A certainty finding inside explicit hope is likely an overcall; attempted/ongoing explanation remains borderline. Neither was blanket-suppressed.

Offline proposals can restore six grounded pairs. The low-overlap naturalness case still requires bounded model repair and fresh full-candidate validation. A proposal is not a semantic pass.

The historical final verdict took 123,733 ms, exceeding the unchanged 120,000 ms post-repair opportunity. The approved 180-second allowance lets an in-flight long verdict finish; it does not authorize another repair loop. Existing confirmed findings must be repaired before the final audit where possible.

## Verification

- Complete backend suite: **2,728 passed; zero failed, skipped or cancelled**.
- Production import scan: **277 files, 842 edges, zero violations**.
- New regressions cover table-cell reassignment and stale provenance, source quote ownership, seven semantic categories, confirming-tier routing across sections and receipts, failure preservation, materialized 5,900→6,100 character growth, monotonic reservation and unchanged job deadline.
- One initial full-suite assertion needed the new `finalAuditReserveMs` diagnostic field; the corrected complete suite passed. No assertion was removed.
- Strict offline replay with production staging flag OFF matched 16 historical requests exactly by model, reasoning, output limit, schema name, instructions and input (only random data-envelope nonce normalized). Nine unmatched requests were denied; external model calls were zero. The replay ended uncertain/incomplete, not passed. Runtime code did not change during that replay.
- Private source/result/evaluation files remain outside Git. No user credits charged or Firestore writes performed.

## Remaining gate

Run the latest complete pipeline with actual production flags through generation, grounded repair and full confirming verdict, then review the final text. The previous paid failed results and incomplete offline replay cannot substitute for this. Preserve the existing 3,000 KRW approval ledger: accounted 2,271.63573 KRW, remaining 728.36427 KRW, no active or unknown reservations. Additional spend requires approval; no other prior balance was transferred.

Do not push production or change flags until the gate passes. Store this tested but incomplete candidate on a non-production archive branch in accordance with project rules.
