# Detection interpretation and semantic repair

The detector score and its existing history calibration remain unchanged. The
report adds a versioned interpretation of six subdivisions of the existing
0–20, 21–49 and 50–100 ranges. Subdivisions describe the score only; repetition
and editing advice require source-verified evidence. Short or incomplete input,
missing scores, and partial cause coverage receive limited explanations.

`lib/detectInterpretation.js` is shared verbatim with the browser. Public source
locations are translated from the scorer's trimmed input to submitted offsets
and paragraph indices; mismatched offsets are not promoted to verified evidence.
Interpretation is saved with the original report and replayed without scoring
again. No calibration badge or before/after calibration copy is introduced.

Humanization v2.5.46 gives a localized factual repair priority over cosmetic
sentence-rhythm checks only when the source-bound violation, unchanged surrounding
text, original fact/number/quote/structure checks and a fresh semantic audit all
pass. The final document audit accepts only the exact semantically verified
candidate. Unchanged repairs skip the redundant same-model audit; independent
escalation remains available. Inspect `semanticRepairStyleWarnings` and
`semanticUnchangedRepairCount` in operational engine metadata.

Validation includes missing-score, whitespace-offset, paragraph-boundary,
malformed-evidence and precise repair regressions. Two detector scoring candidates
failed development screening and were not applied. The local 6-pair humanization
replay is diagnostic evidence, not a population accuracy or latency claim.

Monitor semantic warnings, repair rejections, model calls, cost and latency by
input length. A repaired meaning must never be traded for unchanged rhythm. If
factual, numeric, quote or structural regression appears, revert this release
through a tested feature commit and normal production deployment. No pricing,
refund, structure-option or user cancellation behavior changes in this release.
