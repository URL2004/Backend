# Final semantic release candidate — 2026-09-29

## Release decision

**NOT RELEASED.** Live remains `c863be82` / `gpt-prod-v2.5.89`. The v2.5.90 candidate is archived, not on the production branch. Staged confirmation remains OFF in production. No model, price, credit deduction, delivery policy, frontend, or production configuration changed.

The additional user-approved test budget was KRW 3,000, independent of older balances. Confirmed usage is USD 1.135817865, conservatively KRW 2,271.64 at the budget exchange rate of 2,000/USD. Unknown and active reservations are zero. Remaining budget: KRW 728.36. No customer credits were charged; no Firestore writes were made. Private evaluation text, outputs, identities, response captures and credentials are excluded from this repository.

## Evidence

| Run | Scope | Outcome | Budget KRW |
| --- | --- | --- | ---: |
| Fresh long-document run | 8,689 characters; generation, repair and whole final audit | Completed fail, needs_review; 28 final model findings | 1,828.13 |
| Post-fix final audit | Exact saved generation/prior responses; two NEW final model calls | Completed fail, needs_review; 7 final model findings | 443.51 |

Both paid runs used a frozen code revision. The second is NOT a fresh full-generation run: three optional calls without exact saved responses were denied by the replay harness, including one new semantic repair. Neither run passed the deployment gate. The finding count change is an observation, not an accuracy or production quality-rate claim. Some residual findings require false-positive review, but a newly duplicated clause and awkward wording were real issues.

After the paid audit, the duplication and final-repair priority were changed again. Those last changes have synthetic/offline evidence only, not a new paid whole-document pass. The remaining budget cannot reserve a fresh full generation plus complete validation.

## Root causes and candidate changes

1. **Mismatched adoption baselines.** A 33-line unprepared candidate was compared with a 63-line per-section prepared repair. Capture the exact initial prepared input in original section order and refreeze it reversibly. Replace the comparison baseline only for whitespace-only, role-preserving preparation. This callback grants no verdict. Existing verdict-reuse structure hashes are unchanged; a separate preparation-only signature prevents harmless preceding prose spacing from moving apparent heading ownership.
2. **Source-owned wording counted as newly introduced style damage.** Exact source sentences exposed at new paragraph starts triggered the repeated-demonstrative notice and rejected a valid repair. Attribute only this non-repairable style notice by sentence and multiplicity. New wording and extra copies still count. Meaning, duplication, quotation, structure and other Korean safety checks remain.
3. **Dependent local restorations.** Earlier accepted one-sentence proposals may serve as immediate-neighbour anchors for later proposals in the same bounded pass. Reciprocal uniqueness, BOTH anchors, ordering, eight-window and 30% limits, and fresh re-judging remain mandatory. Grounded `new_evaluation` findings use the same local contract.
4. **Mandatory time consumed optional time.** Mandatory judge-only intervals used the optional recovery 240-second wall-time allowance. Exclude only intervals with a mandatory audit active and no optional request in flight. Concurrent optional work still spends the shared allowance. Cost, call limits, unknown reservations, job deadline and final reserve remain enforced. Error/cancellation exits close the exclusion idempotently.
5. **Final patch used general-style priority.** Confirmed final relation patches now use the existing late slots/time reserve. General style recovery does not gain priority.
6. **Whole-sentence restoration duplicated a previously split lead.** For grounded intensity findings with an identical argument and an exactly attested source predicate, restore the predicate only. Protected quotations and ambiguous matches remain excluded. A synthetic regression and exact saved-text replay show the reproduced duplicate no longer appears. No automatic semantic pass is granted.
7. **Confirming response truncation.** A prior trace used 9,023 reasoning tokens inside a 10,000-output-token envelope. Reserve bounded per-review headroom for confirming audits, capped at 16,000; primary envelope, model, effort, retries and deadlines stay unchanged. No truncation occurred in this paid run, but this alone is not proof of a quality fix.

The output-budget rationale follows [OpenAI's reasoning-token documentation](https://developers.openai.com/api/docs/guides/reasoning#allocating-space-for-reasoning): reasoning and visible JSON consume the same output limit. It does not establish judge accuracy.

## Validation

- Full backend suite: **2,704 passed**, 0 failed/cancelled/skipped.
- Production import graph: **277 files / 842 edges / 0 violations**.
- Prior 60 pairs: exact deterministic-module equality with the analysis cache ON/OFF. This is cache equivalence, NOT fresh model regeneration or a 60-document semantic pass.
- New regression coverage: per-section prepared-input order; cancellation; protected layout; source attribution/multiplicity; dependent repair anchors; unknown-cost/call caps; mandatory/optional overlapping clocks; restoration-induced duplication; final patch priority.
- Final offline replay preserves all four section headings and removes the reproduced duplicate. Unmatched changed model requests remain explicitly unexecuted.
- No production smoke or 1/6/24/72-hour post-release observation was performed because no release occurred.

## Remaining release gates

Run the latest integrated code through full long-document generation and whole final verification. Check genuinely changed temporal/condition/evaluation relations, source-relative naturalness and duplication, and whether remaining final findings can be repaired AND verified within the existing time limit. Do not waive findings to obtain a pass, relabel uncertainty as clean, or substitute a manually edited sample for pipeline verification. Another pending long document is also not validated by this single example. Commit/push only to an archive branch until these gates pass.
