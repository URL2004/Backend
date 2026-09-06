# Detection score investigation and release checks

The detector reports observable writing signals, not verified authorship. A low score alone is not evidence of a postprocessing defect. Compare model scores, evidence grounding, escalation, cause alignment, and history calibration separately.

## Internal diagnostics

Fresh successful detections carry a closed `detectDiagnostics` object through the stability cache, stored history and `detect_report.score_outcome` logs. It contains at most two attempts: primary and recheck. Each attempt stores only score, confidence, signal counts, eligible signal counts and supported ceilings before/after grounding. The object also records the recheck reason, recheck failure, selected model score and evidence-aligned score. Existing `rawProbability`, final `probability` and calibration metadata complete the pipeline.

No submitted text, source excerpts, model prose, identity, provider response or provider error is included in this projection. The public detection response has no new diagnostic field or calibration badge. Old cache/history entries without diagnostics stay missing; their first model score cannot be reconstructed. A cached trace describes its original computation, not a new model call. Existing cache-hit metadata distinguishes this.

This instrumentation does not change model selection, prompt, score, cause alignment, calibration, credits, cancellation or request deadlines. A cause mismatch may trigger a new model judgment that can increase or decrease the score; the cause ceiling is applied after selecting that response.

## Offline paired evaluation

Run `node scripts/evaluate-detect-scores.js /absolute/path/scores.json development` (or `holdout`). Input is an array with `id`, `group`, `split`, `authorship` (`human_reference` or `ai`), `baselineScore` and `candidateScore`. Text and credentials are not needed. Keep corpora, API runners and per-sample results outside Git.

The evaluator rejects duplicate IDs, missing/non-numeric scores, invalid labels and source groups crossing development/holdout. It reports 21/50 threshold rates, Wilson 95% intervals and paired threshold crossings. At 50 the point criteria are no increase in human-reference positives and at least 5 percentage points more AI positives. Development results are never release-eligible. `releaseEligible` from numeric holdout results is only a necessary condition: frozen prompts, untouched heldout groups, representative genres, provenance, human evidence review and operational checks remain required. Do not tune on a previously examined holdout or claim authorship accuracy from unlabeled production traffic.

## 2026-09-06 development screen

60 existing development source groups, each with reference-human prose and an AI rewrite, were frozen before comparison. 120 inputs were freshly tested under each of three variants: current baseline, removing the prompt's numeric cause-count requirements, and rechecking scores below 50 with the existing upper model. Runtime models and reasoning settings stayed fixed. Calibration and application result cache were excluded. Removing the final cap was also evaluated from the selected raw model responses.

At 50, baseline human-reference positives were 2/60 and AI positives 1/60. The prompt and recheck candidates each returned human-reference positives 2/60 and AI positives 2/60: only +1.67 percentage points in AI detection. Removing the cap did not improve these counts. No candidate met the development criterion, so no new holdout was consumed and no score-affecting candidate was released. These are article/explanatory rewrite controls, not validated college-assignment or application-letter coverage. Rechecking all low scores increased mean latency from 3.39s to 6.09s and aggregate estimated model cost from $0.078856 to $0.818868 for 120 inputs. Provider prompt caching may affect cost comparisons.

The low-score accuracy issue remains unresolved by these candidates. The released change improves diagnosis and reproducible evaluation; it does not claim higher detector accuracy.
