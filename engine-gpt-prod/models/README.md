# Korean style statistics v1

This optional local classifier contributes a bounded writing-style index. It is
not an authorship probability or proof of the author's identity. Enable with
`DETECT_STATISTICAL_ASSIST_ENABLED=1`; the default is off. Disable the flag and
restart to revert new requests to the existing detector. The cache variant
includes the flag and model version; completed idempotent requests keep their
original result and charge.

The current public policy is `statistical-assist-v3-monotone`. Independent support
also requires `DETECT_INDEPENDENT_STATISTICS_ENABLED=1`. Without that second flag,
at least one recurring, located model cause is still required. Both flags and
the policy version participate in the cache variant.

## Construction and attribution

The weights in `korean-style-statistics-v1.json` were trained on 200 public
KLUE-MRC reference documents and 200 matched AI rewrites, from development groups
only. Normalization uses NFKC, lowercase, and Korean/ASCII letters; TF-IDF uses
character 2–5 grams, min_df=3, max_features=30000, sublinear TF and L2
normalization. Logistic regression uses C=1, balanced classes, max_iter=1000 and
seed 20260906. Runtime inference uses the exported vocabulary, IDF, coefficients
and intercept without Python or an additional provider call.

Source: Sungjoon Park et al., **KLUE: Korean Language Understanding Evaluation**
(2021), [KLUE repository](https://github.com/KLUE-benchmark/KLUE),
[source license](https://github.com/KLUE-benchmark/KLUE/blob/main/License.md).
The distributed statistical model asset is provided under
[Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/).
Changes from the source are normalization, feature extraction and supervised
training using generated contrast texts. No original document text or document
identifiers are included. This notice concerns the model asset, not unrelated
application code. Preserve attribution and the same license when redistributing
adaptations of this asset.

## Frozen model construction and historical v1 rule

A separate development set of 40 source groups (40 reference, 40 rewrite and 40
topic-only AI texts) sets the decision threshold to the maximum reference-human
margin plus 0.000001. We froze the model and policy before evaluating 40 further
held-out source groups. All groups are disjoint from training and earlier
evaluation groups. AI generation alternates Luna and Terra; length is matched
to 85–115% of reference length before detector evaluation.

The original v1 support rule required 500–2600 input characters, Korean-majority letters,
general/report_assignment/long_explainer routing, an existing score of 21–49,
and a moderate/strong, recurring/pervasive cause with at least two distinct
grounded sentence locations. The classifier must match at least 100 features
and exceed the frozen threshold. The resulting style index is
`min(74, round(100 * sigmoid(margin - threshold)))`.
This transform is an index, not a calibrated probability. Other scores stay
unchanged. Missing or corrupt optional weights preserve the completed result.

## Current public policy (2026-09-08)

The weights, normalization and threshold remain unchanged. Supported inputs have
500–2600 characters, Korean-majority letters and a general/report_assignment/
long_explainer profile. Explicit protected syntax is identified by the canonical
detect input document. If it includes quotations, headings, tables, reference
sections or code, the optional statistical stage abstains in **both** branches;
the completed LLM result remains available. Numbered/bulleted prose remains
eligible. Unmarked quotations and implicit headings cannot all be identified by
these deterministic syntax guards.

For grounded support, a score at least 21 and a moderate/strong recurring or
pervasive cause with at least two distinct located sentences is required. For
independent support, the selected model confidence must not be low, at least four
editable sentence units are required, and threshold-adjusted margin must be at
least 0.05. Both branches require at least 100 matching features and positive
threshold-adjusted margin.

Support can now apply below 74, including scores 50–73. The result is
`max(originalScore, min(74, round(100 * sigmoid(thresholdAdjustedMargin))))`.
No support metadata is added if the result does not increase. This removes the
old discontinuity in which identical support could raise 49 above an unchanged
50. It never lowers a model score or lifts a score into the 75–100 band. Length
and profile boundaries still define model applicability; they are not validated
as universal authorship boundaries. Legacy v1/v2 cached support metadata remains
readable under its original score limits.

A local replay of the already-exposed 900-document 2026-09-07 collection recovered
the previous statistical stage exactly for 900/900 records using the saved
selected confidence and qualifying-cause counts. The new stage changed five
scores: four already-positive AI explanations increased within the 50–74 band,
and one quoted human reference lost an inapplicable support adjustment. At 50,
human positives changed 18/600 to 17/600; AI positives stayed 130/300. At 21 and
75 the classifications were unchanged. These are regression/development counts,
not a new independent holdout or a validation of the new prompt/grounding chain.
The original raw model causes were not retained in that dataset, so the replay
reconstructs the statistical branch predicate only, not semantic evidence.

The separate `detect-evidence-fusion-v1.json`, `detect-style-classifier-v1.json`
and `detect-risk-calibration-v1.json` assets remain research/shadow candidates.
Their scores do not replace the public detector and their validation numbers
must not be attributed to this public statistical model.

No causal categories are invented to explain the statistical contribution.
The report describes the combined method and may still mark sentence-level
explanation coverage as partial. Private diagnostics retain model, grounded
and statistical stages separately. History calibration is a separate downstream
policy; this statistical-stage rule does not define its settings or discounts.

## Held-out results and limits (2026-09-06)

At the 50 boundary, reference false positives are 0/40 before and after; AI
detection improves from 24/80 (30%) to 48/80 (60%). Rewrite detection is 2/40
(5%) to 8/40 (20%); topic-only detection is 22/40 (55%) to 40/40 (100%).
At 21, results are unchanged: reference 8/40 and AI 48/80 positive.
Wilson 95% intervals at 50: reference 0–8.76%, baseline AI 21.06–40.77%,
candidate AI 49.05–70.04%. AI pairs share source groups, so pooled Wilson
intervals are descriptive and do not account for within-group correlation.

These are public article/explanatory proxies, not verified real student work
or resumes. Dataset era, genre and generator signatures may affect results.
Most rewritten AI texts remain undetected at 50 (32/40), including many under
21 to which this rule intentionally does not apply. Routing a document as a
report does not establish validation on genuine college assignments. Do not
advertise these figures as general accuracy or use the index as proof of
authorship. Broader claims require a fresh, independently sourced evaluation.

The production implementation matched the frozen policy on all 240 development
and holdout cases. Release checks also cover grounding, feature guards, cache
invalidation, private metadata, report wording, and existing charge/replay
behavior. Monitor the score stages and disable the flag if operational errors
or verified human false positives increase.
