# Predicate scope and bounded semantic restoration follow-up

Date: 2026-09-27. Follow-up to `17f0ea2`, production base `c9dc0ca`.
Proposed engine remains `gpt-prod-v2.5.81`; relation candidates are v14.
Targeted integrated acceptance passed. No production deployment or push was performed in this task.

## Root causes and changes

1. **Beginning versus completion:** an unrelated beginning verb elsewhere in a sentence could conceal completion of the edited action. `predicateScope.js` links the bounded candidate to the same object, adds a conditional generation hint, and sends it to the existing semantic judge. It never treats a regex hit as a confirmed error.
2. **Retrospective interpretation versus fact:** interpretive endings were absent from the earlier candidate coverage. The same helper now nominates their loss and supplies a conditional preservation instruction. Equivalent interpretations and ordinary arithmetic wording are regression cases.
3. **Unrelated existing warnings rejected factual restoration:** an attested source-register restoration was refused when a separate pre-existing Korean warning remained elsewhere. Internal integrity summaries now carry count-only per-family values. The source-register exception compares deltas: no new non-register family/count, no new source-register expression and no other integrity rejection is allowed. Existing warnings remain visible; a fresh semantic verdict is still mandatory.
4. **Split sentence prevented safe connective recovery:** full-source restoration could duplicate an already split continuation, or fail whole-window similarity. For a judge-confirmed, unique paired finding with identical operands, restore only its attested alternative connective. Only that minimal operation bypasses whole-sentence-copy similarity/adjacent-coverage checks. Complete exact source/candidate windows, semantic grounding, protected spans, ordering, size limits, downstream integrity and re-verification remain required. This is not a global conjunction rewrite.

No model, price, credit, delivery, detector calibration, 240-second optional recovery budget or 120-second final verification budget was changed. No new mandatory model call was added; flagged inputs reuse the existing review/repair pipeline.

## Tests

- Final full suite: **2,365 passed**, zero failed/skipped, `node --test --test-concurrency=2 test/*.test.js`.
- Focused scope/restoration suites: 21 passed.
- Production import graph: 253 files, zero violations.
- Historical development replay: 60 pairs, no additional relation candidates relative to `17f0ea2`. This is neither an accuracy gold set nor evidence of zero false positives outside these samples.
- Three privately captured restoration safety failures reproduced without paid calls; the source-register-only delta is eligible after the fix. Increased existing warnings, new grammar warnings, quotes and structural/duplicate failures remain rejected.
- The initial default-concurrency suite had one timing failure in the paragraph p95 test during concurrent workload. Its isolated suite passed 15/15; subsequent concurrency-2 full suites passed. The 500 ms threshold was not changed. No operational p95 claim is made.

## Actual API sequence

All runs use the same private 5,388-character advanced-mode input. They are one document lineage, not independent accuracy samples. Complete outputs were read in context, including test names/values, quoted statements, event order and the three closing actions.

| Run | Generation provenance | Outcome |
|---|---|---|
| Scope replay | 6 matching saved responses, 12 new HTTP attempts | Final semantic pass and clean; both target errors restored/preserved |
| Fresh 1 | No saved responses, 19 new HTTP attempts | Both target relations preserved, but separate meaning findings could not be restored because of the unrelated-warning gate |
| Delta replay | 18 saved responses, 5 new attempts | Final semantic pass; sequential-connector style warning remained needs_review |
| Fresh 2 | No saved responses, 20 new attempts | Beginning/completion was detected and repaired early; split-window alternative/conjunction remained, final semantic fail |
| Minimal-connective replay | 17 saved responses, 5 new attempts | **Final semantic pass, clean**, no remaining semantic violations; structure, quotation, code/math and spacing checks pass |

The final small restoration change was validated using saved generation responses plus fresh changed semantic/repair calls, **not another complete fresh generation**. Saved responses are reused only when source, model settings, schema, instructions and normalized request contents match. One offline diagnostic run reused 19 responses and made no paid calls. Different replay timing can leave more optional-repair time; it is not a production latency experiment.

## Budget and limits

This follow-up has its own KRW 3,000 approval, separate from the previous task's ledger. All parallel calls/retries reserve a conservative maximum before transmission. Actual priced usage: **USD 0.7741171 / KRW 1,548.2342** at the conservative planning rate of KRW 2,000/USD. **61 paid HTTP attempts**, zero unknown-cost calls and zero active reservations; remaining cap KRW 1,451.7658. The existing KRW 600 contingency was made available within, not beyond, the approved KRW 3,000 cap. Saved-response usage is not charged again in this ledger.

The final result retained beginning versus completion, interpretive endings, tentative negation, alternative operands, quoted test descriptions and numeric assignments. The inherited unfinished source fragment was corrected without removing a valid proposition. The final engine quality was clean; source-side notices remain historical descriptions of the input.

This does not establish universal error elimination or classifier accuracy. The reflection still selects the long-explainer group; classification was not changed. Earlier runs had genuine errors and occasional overly strict semantic judgments. Budget/deadline safeguards remain intact, including the possibility of a needs_review result when a safe repair cannot be verified. Raw source, outputs, identities, credentials and local paid runners remain outside git. No user credits or Firestore documents were changed.
