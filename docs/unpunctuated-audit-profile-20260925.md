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

## Validation

- Full backend suite: **2,048/2,048 passed**; 17 new tests including basic and advanced mocked engine integration. These integrations use stubbed model responses, not paid live generation.
- Regression cases cover normal sentence/paragraph expansion, actual hedge removal, one of multiple hedges lost, original restoration ordinals, distributed paraphrase, repeated content, uncertainty retention, date/decimal/initial syntax, quotes/code/parentheses, contracted endings and CRLF/tab input.
- One new negative test initially failed: another claim's hedge masked real hardening. Claim-scoped coverage fixed it; the final full suite was rerun.
- Historical/current replay: 109 unique humanizing source/result pairs. The investigated false warning disappeared and unknown became general (confidence 0.5009 → 0.5991). One other input gained one legitimate analysis boundary without changing genre or relation warnings. No other genre-label or relation-warning changes in this replay.
- Default segmentation offsets: 458 source/output comparisons against the baseline, including 52 detection records, identical. This does not claim unchanged AI classification accuracy or a labelled detector evaluation.
- Local analysis segmentation benchmark: 8,169 characters, 240 clauses, 25 repetitions, p95 approximately 2.8 ms. This is not production end-to-end latency.
- Production import graph: 232 files / 698 edges, no forbidden imports. Diff check passed.

## Limits and release state

This is a conservative finite-ending heuristic, not a general Korean morphology parser. It does not guarantee resolving all punctuation-free or ambiguous prose. Low-confidence classification remains intentional; historical review statuses are not overwritten.

No paid API calls, production data mutations or deployment were performed for this change. Previously generated production pairs were replayed through the changed deterministic code. Raw texts and identifiers remain outside git. Production remains on v2.5.69 until a separately verified release.
