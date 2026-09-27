# Audit follow-up, 2026-09-28

Baseline: production `6a891af` (humanize 2.5.81 / detect 1.45).

## Candidate verification

- Backend regression: 2,380 passed, zero failed/skipped.
- Production import graph: 257 files / 781 edges, passed.
- Private replay: 456 humanize records and 274 detection records. This is development data, not independently labelled accuracy ground truth.
- Full source/result contextual review completed for six newly generated short/medium documents: all six passed model semantic and structural validation; five clean, one existing specificity warning.
- One long run was interrupted locally before completion. Another could not reserve its next call under the test budget. Neither is a passing full-document verification.
- Detection: 3 baseline calls, 9 initial candidate calls, 21 final candidate calls. Final repeated checks cover one real case and six synthetic controls; all 150 emitted evidence locations matched canonical eligible source sentences and persisted without excerpts.
- A personal narrative with an outline previously produced 18/51/51 after genre-dependent statistical support. Corrected genre produced 36/38/36 with no statistical score addition in those runs. Strong repetitive synthetic prose scored 82/68/86; weaker controls remained lower. These observations are not authorship accuracy estimates or distribution targets.
- Runtime models, prices, billing/delivery policies, history calibration, and user-facing notices are unchanged. No user credits or production records were modified by private evaluations.

## Candidate changes

1. Recognize repeated numbered prompts and constrained parallel headings; split explicit numbered question/answer pairs using whitespace only.
2. Keep authored slide/interview script bodies eligible while protecting real source quotations/code. Preserve source offsets.
3. Distinguish lived narratives from outline-only report signals and reflexive pronouns from application voice.
4. Persist source-verified detector evidence coordinates and bounded paragraph-refinement provenance, without claiming whole-document verification.
5. Candidate-only semantic follow-up: nominate connective/qualification shifts; restore grounded failures before final revalidation; retain partial verification/cost information on cancellation.

## Release restriction

Item 5 has NOT passed the long-document paid gate. Preserve it on the candidate branch but exclude it from the verified release. Keep the existing production semantic-repair and cancellation behavior in that release. Do not remove a quality warning merely to make a test green.

The remaining specificity warning was traced to a Korean attributive phrase being extracted as an entity. It is not fixed in this release. Long-document completion, broader classifier generalization, and independent cross-version before/after comparison remain open.

## Test cost

New approval: KRW 5,000. Conservative accounting at KRW 2,000/USD: KRW 4,204.75 including KRW 3,323.70 reserved for six usage-unknown attempts. Known priced usage: KRW 881.05. Ninety-six HTTP attempts are not ninety-six independent document tests. No active reservation remains.

## Release checks to complete

Re-run the complete regression and private saved-response replay after excluding item 5; check clean staged contents, fetched production ancestry, live health and active jobs before release. Deployment and post-release checks are not yet complete at this candidate checkpoint.
