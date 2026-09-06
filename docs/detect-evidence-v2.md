# Detection evidence research and operational shadow

This is the first implementation stage of the 2026-09-06 low-score redesign. Production remains a writing-style signal index. The new fusion model is **research-only** and never replaces a public score. The existing cause contract, history policy, credits, cancellation behavior and humanization engine remain in force.

## Corrections to the proposed direction

- An inactive server ceiling does not prove that the prompt caused low raw scores. It identifies where a score was not changed. Prompt causation requires a controlled ablation.
- The previous five hundred observations are repeated variants of fewer source documents. They are not five hundred independent labelled documents. Logs missing diagnostics cannot establish a zero cap rate.
- Sigmoid margins near zero compress scores around 50. A score above 60 is mathematically possible; it is not ruled out by the formula. A quantile remap can increase displayed scores without improving discrimination.
- A threshold discovered on twenty short reviews is a development hypothesis. Do not deploy that threshold as a policy for all short documents.
- A benchmark-mixture probability depends on the class mixture and domain. It is not a verified production authorship probability. Keep calibration statistics internal until representative validation exists.
- An authorship classifier and a promised humanization score reduction are different objectives. An AI-origin text remains AI-origin after transformation. Measure style change and content fidelity separately; do not make an automatic minus-15 score target or force a 60-plus frequency into production.
- ND and NC intake restrictions here are conservative project policy. Existing third-party detector labels are an external-alignment dataset, not ground-truth authorship.

## Implemented components

`lib/detectBenchmark.js` builds a body-free manifest from an external corpus. It joins document/topic/parent relationships transitively, separates development and holdout by group, forces previously exposed groups into development, rejects normalized exact duplicates, missing parents, cycles and unreviewed restricted-license uses. Coverage is measured against the proposed 300 human / 300 AI / 100 humanized five-genre plan. Missing genres and generation models are reported rather than fabricated. Exact grouping does not establish semantic deduplication.

`scripts/train-detect-evidence.js` fits nonnegative logistic fusion weights on development observations and fits a positive Platt slope on a separate, group-isolated calibration subset inside development. Inputs are the selected LLM raw score, existing n-gram margin, sentence-length uniformity, ending repetition, formulaic connector rate and abstract closure rate. These surface measurements are features, not independent proof of AI authorship. Short reviews and explanatory prose have separate models. This is not a retrained n-gram v2 model or a morphology/LM-likelihood service.

The training CLI checks text hashes, manifest consistency, training permissions and split membership. The model artifact identifies all development groups and its research-only status. The final evaluation CLI joins results to manifest provenance, rejects missing cases or candidate/source mismatch and uses an exclusive consumption receipt keyed by the manifest to prevent a different candidate from reusing the same final validation run.

`lib/detectEvaluation.js` retains the old paired evaluator and adds rank AUROC with ties, diagnostic recall at 5% FPR, 21/50/60/75 rates, Wilson intervals, paired exact McNemar, ECE/Brier/reliability bins, genre/length summaries, three-run variation and cost/p95 latency. Post-hoc operating points are never deployable thresholds. Missing subgroup, repeat or performance evidence prevents passing the broader gate. Metrics alone never authorize release. Humanization pair evaluation rejects different detector versions, history-adjusted results and unverified content preservation.

`engine-gpt-prod/prompts/detectRubric.js` is an offline candidate with seven anchored 0–3 dimensions and grounded sentence indices. Array and original-prose-plus-indexed-sentences inputs can be compared. Repeated or unlocated high ratings are rejected. This candidate is not imported by the production detector, and its uncalibrated dimension sum is not a public score.

## Production instrumentation

Set `DETECT_EVIDENCE_SHADOW_ENABLED=1` to collect `detect_report.evidence_shadow`. It defaults off. `DETECT_EVIDENCE_SHADOW_SAMPLE_RATE` accepts 0–1 and defaults to 1 when the feature is enabled. Sampling is deterministic by request ID. An explicit rate of zero disables sampling.

Shadow inference is CPU-only, bounded to 100–4,000-character Korean inputs, and skips detected protected formats. A missing or invalid model produces features-only telemetry, not a fallback public score. Unrepresented application/essay profiles can be observed without receiving a candidate prediction. Unknown profiles are considered only below 300 characters in research. No new model requests, subprocesses, network calls, credit deductions or user-visible correction data are introduced.

The event has a closed numeric/enumerated projection: current/candidate/raw scores, profile, length, sentence count, six features, statistical match count, model identity/digest, overhead and the counterfactual short-recheck indicator. It contains no submitted text, excerpts, free model explanations or user identifier. It is not persisted to the user result or history. Request replays do not generate another shadow sample; application-cache hits are labelled as such. A shadow score is not a fresh independent LLM judgment when the underlying result came from cache.

`lib/detectRequestStore.js` now reports whether an existing result won staging. Serialization always clones an object; the route no longer treats that new object identity as a replay. Score-source telemetry distinguishes `llm`, `cached_llm` and `request_replay`. Public billing/replay behavior remains unchanged except that fresh responses no longer falsely advertise `idempotentReplay`.

`scripts/summarize-detect-evidence.js` aggregates normalized JSON/JSONL events by detector version, profile and candidate digest. It reports diagnostic coverage, actual caps, actual cache hits, request replay, threshold crossings and latency separately. Unlabelled traffic cannot supply accuracy or a human false-positive rate.

## Local commands

Keep input bodies, generation files, API runners, observations and evaluation outputs outside Git.

```text
node scripts/build-detect-benchmark.js corpus.json manifest.json frozen-seed
node scripts/train-detect-evidence.js corpus.json manifest.json development-observations.json candidate.json
node scripts/evaluate-detect-evidence.js scores.json manifest.json candidate.json report.json development
node scripts/evaluate-detect-evidence.js scores.json manifest.json candidate.json report.json holdout
node scripts/summarize-detect-evidence.js events.jsonl summary.json
```

The final CLI is deliberately one-use per manifest. An interrupted or invalid input preparation can be repaired before consumption; a completed final evaluation must not be reopened for tuning. Future work should also retain lineage across corpus versions and semantically related topics.

## Activation and remaining gates

Only instrumentation and validated cache observability fixes are eligible for immediate operational deployment. Keep the candidate in shadow until representative labelled coverage, human FPR, recall, repeat stability, calibration and operational criteria pass. Turning the shadow flag off stops research inference. It does not alter the current score path or billing.

The proposed five-genre benchmark, a third generation model/family, verified application/assignment controls, 100 content-verified humanization pairs and two weeks of shadow observation cannot be marked complete from a two-genre pilot. Application-profile extension, short-input score remapping, automatic recheck suppression, a new classifier/likelihood service, production fusion and humanizer reranking remain gated by their own evidence.

Sources: [KLUE](https://github.com/KLUE-benchmark/KLUE), [NSMC](https://github.com/e9t/nsmc), [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices).

## First research run, 2026-09-07 KST

The fusion candidate used 340 previously exposed reference/generation records, with 306 in feature scope. ND KorQuAD references were excluded from training. Development fit/calibration counts were 42 human + 36 AI / 17 + 17 for short reviews and 60 + 74 / 26 + 32 for explainers. Legacy generation recipe digests are not archived exact request-byte hashes. These records are development material only.

A fresh corpus contains 300 source-backed human references (150 KLUE paragraphs, 150 NSMC reviews) and 300 AI texts, split by linked source group into development 370 and final holdout 230. The AI side uses Luna/Terra and three instruction types (topic, outline, rewrite), with all lengths within 15% of their references before scoring. This meets the total binary count but not the five-genre quota or three-generator requirement. NSMC original movie identifiers are unavailable, so semantic topic separation cannot be guaranteed for reviews.

The frozen candidate was evaluated on the final 115 human + 115 AI records:

| Threshold 50 | Current | Shadow candidate |
|---|---:|---:|
| Human false positives | 1/115 | 6/115 |
| AI detections | 49/115 | 106/115 |
| Human explainer false positives | 1/58 | 2/58 |
| AI explainers detected | 49/58 | 52/58 |
| Human short-review false positives | 0/57 | 4/57 |
| AI short reviews detected | 0/57 | 54/57 |

**Do not activate this candidate as the public score.** Human false positives increased and exceeded the 5% target. A much higher AI-positive count does not override that failure. Candidate predictions remain research-only. The 370 fresh development records have been prepared but were not used to tune this candidate.

The separate rubric/input-format development study used 40 texts, two formats, three repeats (240 model calls). Explanatory AUC was 0.61 for the historical baseline raw score, 0.585 for array rubric and 0.64 for prose rubric; short-review AUC was 0.735, 0.33 and 0.27 respectively. Equal-weight rubric sums were unstable and are uncalibrated. The baseline was not rerun concurrently; treat the comparison as a screening result. No rubric candidate was promoted or used in fusion weights.

The local completion report contains repeat results, full metrics, deployment identity and operational verification. This implementation does not claim the six-to-eight-week roadmap or two-week shadow observation is complete.
