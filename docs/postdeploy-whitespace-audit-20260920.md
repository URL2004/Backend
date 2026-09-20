# Post-deployment whitespace and score audit

Baseline: production `e8120d1`, humanizer v2.5.55 and detector v1.35. This follow-up is not yet deployed.

## Confirmed, narrow fixes

- Statistical-assist scope previously counted all pasted whitespace toward the 500–2,600 character range. The same lexical content and fixed model response could change from 18 to 49 after padding the input across 500 characters. The scope gate now trims and collapses whitespace only for its length measurement. Original text is still used for syntax protection, evidence offsets and trained features. Scoring weights, margin thresholds, genre scope, model prompt and history calibration are unchanged. The new policy version changes the cache variant; v4 saved support remains readable.
- Inline numbered-heading recovery recognized ASCII spaces/tabs but missed nonbreaking spaces commonly pasted from documents. It now recognizes U+00A0 and U+202F between a sentence ending and a numbered heading. Dates, quotation lines and fenced code stay protected. No content is added or deleted.

## Evidence and limits

Read-only post-deployment export: eight humanization pairs and 22 detection histories from the deployment at 2026-09-20 02:34 KST. The humanization snapshot ends at 09:13; detection at 09:16. Full source/result pairs were directly reviewed for all eight recent humanizations. Raw text, account IDs and per-user histories are stored only outside the repository.

Detection: mean 29.6, median 28, six scores at most 20, two at least 50. No score reductions between selected model and engine result, no history-calibration reductions between raw and display, and no cache hits were observed in this sample. Two scores increased through statistical assistance. Eleven of the 22 histories belong to one account; this is not an independent or representative accuracy benchmark. Authorship is not known. These observations do not establish false-negative rate or justify a uniform score increase.

An additional live local replay completed eight humanizations and four detections against production runtime configuration. Provider usage totals USD 0.365443 with no unresolved usage, below the approved 3,000 KRW budget using the conservative 2,000 KRW/USD allowance. Customer credits/history were not changed. Detect replay called the engine directly, without the route's genre resolution, cache and account-history calibration, so it is not a complete end-to-end production-score reproduction. Eight humanizations are a diagnostic sample, not a production p95 or quality-rate estimate.

## Still open; do not claim these are fixed

- Source restoration can coexist with residual paraphrase and duplicate legal references; the final stored candidate is insufficient to prove the exact creation stage.
- A specialized service name lost its qualifying words despite clean status.
- Damaged, tightly wrapped prose can retain broken words and spacing; a replay was still marked clean with semantic audit skipped.
- A complete polite sentence without punctuation can survive final restoration, adjacent to the next sentence.
- A transition sentence can end up with the preceding topic rather than the following conditions.
- General model sensitivity, genre-conditioned statistical discontinuity and the 0.05 statistical-margin threshold require source-labelled controls and held-out evaluation. No arbitrary uplift or retuning is included.
- Historical corpus of 407 pairs has not received complete manual semantic review. Automated corpus replay and targeted direct review must not be described as full manual review.

Validation: 1,651 tests passed, zero failures/skips; production import graph and diff whitespace checks passed. Local assist-only replay of 352 stored detection histories changed one case (53 to 46, scope length 502 to 499 after whitespace normalization); this is not a new model accuracy evaluation.

The new patches do not claim to resolve all quality issues. They should not be used to waive the remaining release validation.
