# Human-reference operating-point calibration

The existing character classifier separates the development reference classes well but its original 50-point cutoff produced too many human false positives on external validation. `detectRiskCalibration` changes the classifier's operating point using separate human-reference scores. It does not retrain the base model, modify the public detector or represent a calibrated authorship probability.

## Selection and independence

Use `node scripts/calibrate-detect-risk.js corpus.json manifest.json model.json policy.json`. Inputs must match the manifest; calibration includes only development human references with explicit evaluation and derivation permissions. Model training/calibration family aliases and text hashes cannot overlap the new threshold calibration. Out-of-scope inputs are listed explicitly. Existing output files cannot be overwritten.

The rank is chosen from the number of independent recorded families, a target tail rate (default 2.5%) and failure probability (default 5%), before looking at score values. The selected cutoff is an order statistic of each family's maximum margin. Duplicate documents cannot increase the family count. Strictly greater scores are positive; ties and integer rounding cannot add positives below the cutoff. A monotone logit shift puts this operating point at a displayed research score of 50. The 21-point warning rate must be measured separately.

This follows the order-statistic principle in [Tong, Feng and Li (2018)](https://pmc.ncbi.nlm.nih.gov/articles/PMC5804623/). The statistical interpretation assumes representative, independent reference families, a fixed scoring model and valid labels. Source-backed historical corpora and unknown author identities do not establish those assumptions for production. A small calculated bound is not a production accuracy promise.

Policy and base-model digests are bound together. `assertIndependentValidation` checks training and threshold-calibration aliases, hashes and recorded prior exposure. Freeze model, policy, scoring code, generation prompts and evaluation design before new scoring. A previously consumed test may become development material, but cannot be called independent again. Semantic duplicate screening and source/author controls remain necessary beyond exact hashes.

`node scripts/evaluate-detect-risk.js corpus.json manifest.json model.json policy.json scores.json output.json` recomputes every CPU candidate score, verifies source/policy hashes, checks complete coverage and writes a single-use holdout receipt. Existing core-genre gates remain in force. Its pooled cutoff is not a separately fitted genre calibration.

## Runtime isolation

`DETECT_RISK_SHADOW_ENABLED=1` adds `classifier.calibrated` only under the existing evidence and style shadow flags. It defaults off. The event contains numeric scores, version/digest and timing only; never calibration records, source text or user identity. This is CPU-only and always `applied: false`. Failures leave paid results intact. Disable the risk flag to stop this additional computation.

Public detector version, prompts, billing, cache identities, history correction and humanization teaser are unaffected. Do not connect this research score to the public result merely because an environment flag is enabled. Full independent validation and representative verified-process report/resume controls are still required for a release decision.

## Runtime comparison and monitoring

The runtime prepares a private immutable model/policy snapshot once. One classifier inference produces both the raw research score and its human-reference calibration. Caller mutations cannot alter that prepared snapshot; the general-purpose `predict` API continues to validate mutable inputs on each call. Preparation failure leaves the existing raw classifier shadow available and never changes a paid result.

Fusion scope exclusions keep the bounded current score, known genre and available score stages. They must not discard a valid independent-classifier comparison just because the older fusion model cannot score that genre. Unknown stages stay absent; out-of-scope scores stay null.

Monitoring v2 reports fusion, raw classifier and calibrated-classifier distributions separately, partitioned by model and policy digest. Its directional 50-point comparison uses the engine score before history correction when that stage exists. Exact duplicate events are removed within the same model/policy group; a different policy is a distinct comparison. The diagnostic denominator accepts both the score-outcome event's nested diagnostics and the shadow event's closed flattened stages. No unlabelled disagreement is described as a false positive or false negative.

The bundled policy was selected from the previously consumed v3 sample, reclassified as development: 259 computable human-reference documents in 219 recorded families. Sources are KLUE (CC BY-SA 4.0), NSMC (CC0) and the Apache-2.0 student evaluation repository documented in `detect-validation-v3.md`. Only numeric parameters and irreversible record/family digests are bundled, with no text. Source-backed references are not forensically authenticated human authors.
