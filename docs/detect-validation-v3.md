# Detection validation v3

This release adds measurement, a **research-only** character classifier, and clearer evidence descriptions. Public detector v1.29, its prompts, thresholds, history calibration and billing are unchanged. Humanizer v2.5.47 is unchanged. No production score is selected from this classifier.

## Score and explanation paths

`detectDiagnostics` keeps provider decimals, rounded attempt scores, the selected primary/recheck phase, evidence alignment, statistical assistance, engine final score and optional displayed score. The actual order is primary → optional recheck selection → evidence alignment → statistical assistance → engine finish → optional history calibration. Older cached diagnostics retain only stages actually recorded; missing stages are never invented.

`DETECT_EVIDENCE_SHADOW_ENABLED=1` enables existing research events. The separate `DETECT_STYLE_SHADOW_ENABLED=1` adds the bundled classifier to the same privacy-filtered event. Both default off in code. Sampling follows `DETECT_EVIDENCE_SHADOW_SAMPLE_RATE`. This CPU-only path has no provider calls, no billing effects, no public fields and always reports `applied: false`. Disabling the style flag stops the new computation. Research errors cannot fail a completed paid result.

The bundled classifier uses Korean character 2/3/4-gram TF-IDF, L2-normalized vectors and regularized logistic regression. Its vocabulary and weights are fitted separately from its Platt calibration. Three family-grouped folds select regularization on fitting data. It consumes no LLM score or prior statistical-detector weights. Its Korean/length/feature-coverage checks indicate computation eligibility, not verified genre support or determinability of authorship.

## Data and freezing

`build-detect-research-manifest.js corpus.json options.json manifest.json` adds writing-process labels, provenance, explicit permissions, source revisions and stable family aliases. Original text and derivatives share a split. Optional author/site/template grouping and lexical near-duplicate screening further join families. Exposed families remain development-only across registries. Character overlap screening cannot certify the absence of semantic duplicates; manually reviewed relations can be supplied as `relatedFamilyIds`.

Human original, human with AI light edits, AI draft, AI with substantial human edits, mixed writing and humanized AI are different processes. Assisted or transformed writing cannot become a human gold control. Research-documented participant declarations are weaker evidence than independent writing histories and must retain their evidence level. A text's publication date is null when unknown; collection date is not its original writing date.

`train-detect-style-classifier.js corpus.json manifest.json model.json thresholds.json` requires development-only, permitted training records. Grouped fitting and calibration partitions are disjoint. Record model, threshold, prompt/config and manifest digests **before** inspecting new test scores. Previously evaluated holdouts are diagnostic/development material in later rounds, not fresh final validation.

`evaluate-detect-validation.js scores.json manifest.json model.json thresholds.json output.json` requires complete, unique, hash-matched records and a matching candidate digest, checks training leakage and writes a single-use holdout receipt. Store raw corpora, API runners, keys and evaluation results outside the repository.

## Measurements and release decisions

Report current and candidate AUROC; 21-point warning exposure and 50-point positives separately; AI recall at FPR 1% and 5%; frozen calibration-selected operating points; Wilson intervals; exact one-sided FPR upper bounds; family-paired bootstrap differences; reliability bins/Brier/ECE; uncached repeat variation; candidate coverage; actual cost and p95 latency. Holdout-selected ROC thresholds are descriptive and cannot be deployed from the same test. Family-any-positive bounds are reported separately from document FPR, and do not eliminate unknown cross-family dependence.

Threshold validation includes core report/assignment and resume/application human controls with documented writing processes. Missing core calibration, insufficient independent human evidence, increased FPR, repeat regressions or missing operational evidence prevent promotion. The evaluator deliberately never enables release automatically; its legacy paired summary is also marked ineligible. Statistical metrics and coverage do not establish authorship for an individual text.

The initial classifier's 710 development texts are source-backed Korean explanatory/review references and generated controls. Public sources include [KLUE](https://github.com/KLUE-benchmark/KLUE) (CC BY-SA 4.0) and [NSMC](https://github.com/e9t/nsmc) (CC0). It is not trained or calibrated for verified student resumes. The independent student source is [llm-as-a-judge-human-eval](https://github.com/seungyoon1/llm-as-a-judge-human-eval), revision `56464977cdd31543190839502715d9c97f783273` (repository Apache-2.0); participant process evidence and metadata discrepancies must accompany results. Do not equate repository licensing with independent authorship authentication.

## Humanization quality

`humanizeQualityEvaluation` verifies exact evidence excerpts and compares facts, numbers, names, citations, speaker and conclusions first. Lexical numeric mismatches are review flags and may include equivalent representations. Blind A/B comparisons score grammar, naturalness, repetition and genre fit twice in reversed order. Disagreement is reported, not averaged into a confident win. Automatic judges are not human blind ratings or proof of content fidelity.

Use a fixed sample chosen independently of detector scores. Run before/after detection on one version with cache and history calibration excluded; retain content failures even when detection scores fall. Detector deltas are secondary, never the main quality criterion or a reason to convert generated text to a human label. External detector agreement is a separate optional comparison, not a gold label.

## Result and history compatibility

Interpretation v2 explains insufficient/limited/available style evidence separately from the index. Low scores do not certify human authorship. Existing v1 history descriptors and signed backups remain readable without mutation. V2 descriptors validate the bounded `assessability` object before signing. No correction badge or correction delta is added, and the before/after humanization teaser remains intact.
