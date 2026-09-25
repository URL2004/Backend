# Punctuation-poor prose: genre and relation audit

Baseline: `978a238` / production v2.5.69. Branch: `fix/unpunctuated-audit-profile-20260925`.

## Root causes

1. Plain Korean declarative clauses without punctuation were counted as one sentence. Genre features requiring three sentences therefore disappeared even when the text contained several complete propositions.
2. Relation audit matched this entire source run against at most three output sentences. A legitimate split could leave the retained hedge outside that partial window and incorrectly raise `epistemic_hedge_hardened`.
3. Conversely, the hedge in a neighbouring, different claim could incorrectly exempt a strongly matching declarative claim from review.

## Changes

- Added opt-in plain finite-ending inference to the shared offset-preserving sentence parser. Contracted past forms, explicit present forms and negation are recognised; arbitrary nouns ending in 다/요, quoting constructions, quoted text, code and parentheses are excluded. It never inserts punctuation or changes source bytes.
- Genre classification and semantic relation matching opt in. Existing default segmentation, detector sentence offsets and formatting behaviour are unchanged. No confidence threshold or detection score adjustment was added. Truly ambiguous short input remains unknown.
- Relation matching uses the inferred units but retains their original source sentence ordinals for downstream restoration. Inferred ordinals must never be sent to a consumer expecting original ordinals.
- A strongly matching declarative clause is not exempted merely because an unrelated adjacent clause contains a hedge. Distributed legitimate splits retain group context when there is no clear content-coverage separation.
- Fingerprint audit version advanced from 15 to 16. No model, price, credit or delivery-policy changes. No new model call stage.
- Conjunctive hedge inflections such as `것 같은데` and `것 같고` retain uncertainty instead of triggering a certainty warning.
- The common deterministic sentence restorer refuses to replace a partial output match with a source ordinal containing multiple inferred claims. Without verified claim-level replacement coordinates it leaves repair/review to the existing pipeline rather than duplicating the entire source run.

## Validation

- Full backend suite: **2,051/2,051 passed**; 20 new tests including basic and advanced mocked engine integration. These integrations use stubbed model responses, distinct from the paid runs below.
- Regression cases cover normal sentence/paragraph expansion, actual hedge removal, one of multiple hedges lost, original restoration ordinals, distributed paraphrase, repeated content, uncertainty retention, date/decimal/initial syntax, quotes/code/parentheses, contracted endings and CRLF/tab input.
- One new negative test initially failed: another claim's hedge masked real hardening. Claim-scoped coverage fixed it; the final full suite was rerun.
- Historical/current replay: 109 unique humanizing source/result pairs. The investigated false warning disappeared and unknown became general (confidence 0.5009 → 0.5991). One other input gained one legitimate analysis boundary without changing genre or relation warnings. No other genre-label or relation-warning changes in this replay.
- Default segmentation offsets: 458 source/output comparisons against the baseline, including 52 detection records, identical. This does not claim unchanged AI classification accuracy or a labelled detector evaluation.
- Local analysis segmentation benchmark: 8,169 characters, 240 clauses, 25 repetitions, p95 approximately 2.8 ms. This is not production end-to-end latency.
- Production import graph: 232 files / 698 edges, no forbidden imports. Diff check passed.

## Limits and release state

This is a conservative finite-ending heuristic, not a general Korean morphology parser. It does not guarantee resolving all punctuation-free or ambiguous prose. Low-confidence classification remains intentional; historical review statuses are not overwritten.

Release target: v2.5.70. Production data and historical review statuses are not rewritten. Raw texts, API responses, budget ledger and the final deployment receipt remain outside git. Rollback target: pre-release live `978a238` (v2.5.69).

## Paid validation finding

The first paid round reproduced an additional failure in a synthetic multi-claim document. The escalation model retained uncertainty as `것 같은데`, but the audit did not recognise that inflection. After a model repair attempt the deterministic fallback inserted a whole unpunctuated source run into only part of the result. The resulting duplicate numbers and content failed final validation; deployment was held. This is a failed validation run, not a clean success.

Both the inflection matcher and the common restoration guard were corrected and covered by regression tests. Every intermediate model response from that failed run was replayed through the corrected relation audit; retained uncertainty no longer triggers the false warning. A complete fresh synthetic generation then passed meaning, number, structure and Korean audits without duplication. Its substantive edit ratio was only 4.49%, so the existing limited-effect notice remains. This release does not claim to solve low edit strength or all depth-recovery alignment limitations.

Paid runs use the production model/reasoning configuration through direct engine execution, without a user UID or credit deduction. NIKL external lookups are disabled in this isolated harness; this is not a full production-environment equivalence test. Optional recovery and escalation calls are included in the cost ledger. Results are small-sample integrity checks, not production accuracy, latency or general quality estimates.

### Fresh runs on the final code

| Case | Meaning / numbers / structure | Genre | Paragraphs | Substantive edit | Elapsed |
| --- | --- | --- | --- | --- | --- |
| Investigated punctuation-poor input, basic | Pass | General | 3 | 17.99% | 51.3 s |
| Same input, advanced | Pass | General | 2 | 18.29% | 70.4 s |
| Synthetic independent claims, advanced | Pass | Unknown (insufficient genre evidence) | 2 | 4.49% | 94.2 s |

All three final outputs were read directly and had completed final semantic validation, no quality-review warnings, and no new duplicate content or numeric loss. Basic and advanced retained the source's uncertainty and concluding opinion. Unknown remains a legitimate outcome for the synthetic input, not an error to suppress.

The advanced investigated input still reports a depth-target effect notice; both investigated modes retain `sentence_distribution_shift` because that separate metric uses default segmentation. The synthetic input reports low substantive effect. These are not claims of fully resolved transformation quality.

Six paid generations were run in this round, including the failed discovery run and three fresh final-code reruns. Conservative additional accounted cost was approximately KRW 698.06; the cumulative approved-budget ledger is KRW 7,159.52 of KRW 10,000 (USD 2.9831305 at the budget conversion of KRW 2,400/USD, including unresolved reservations). These are conservative accounting estimates, not an invoice or current FX quote. No user credits were deducted.
