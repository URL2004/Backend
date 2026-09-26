# PDF-derived text integrity — v2.5.78 candidate

Status: locally verified candidate, **not approved for production**.

## Root causes and changes

- Physical-row joining ran before repeated page furniture was recognized. Remove only independently repeated title/byline rows attested by a cover title and author line; preserve ambiguous rows, quotations, code, tables and references.
- Caption rows were classified as editable prose. Share protected ownership across input normalization, chunking and structure planning, and audit newly inline source-owned literals.
- Hyphenated nominal subsections were classified as lists before masking and as headings afterward. Use one heading role, leaving complete numbered prose editable.
- Post-semantic layout restoration omitted protected captions. Restore exact block boundaries and require unchanged non-whitespace content before reusing semantic validation.
- A later rewrite could drop a uniquely source-attested contrast lead or copy an existing complete prose sentence into another section. Reject these narrowly evidenced candidate regressions; do not globally delete fuzzy duplicates.
- Extend the existing relation audit for priority comparison changed into categorical exclusion. Keep existing delivery, billing, models and retry limits.

Engine candidate: v2.5.78; source preflight: 31; fragment audit: v3; fingerprint audit: 17. Detection policy is unchanged.

## Verification

- Full backend suite after the fingerprint version bump: 2,274 passing, zero failures/skips (74.7 seconds).
- Production import graph: 247 files, zero violations.
- Eleven new synthetic regressions cover positive detection, conservative negatives, quoted captions, subsection ownership, restored boundaries, contrast deletion and exact copy growth.
- Sixty existing private source fixtures: no normalization changes or non-whitespace changes versus the production baseline. This is development replay, not independent accuracy evidence.
- Local synthetic 20-paragraph/120-sentence benchmark, three concurrent jobs and ten rounds: batch p95 57.8 ms, event-loop p95 19.4 ms, maximum 21.9 ms; ordering, cancellation and content checks pass. These are not production latency estimates.

## Actual model verification

An approximately 10,000-character private document was generated with the production model configuration without charging user credits or writing production data.

| Run | Outcome |
| --- | --- |
| First generation | Header/caption faults fixed; semantic fail exposed subsection classification conflict. |
| Second generation | Structure fixes retained; semantic fail exposed a comparison change and non-adjacent copied conclusion. |
| Third generation | A model call was aborted by the time limit; no final result. Unknown cost remains reserved. |
| Strict continuation | Reused 25 matching successful responses from the third attempt; only unmatched calls were paid. Final semantic revalidation passed, but overall quality remains `needs_review`. This is not an independent fresh full generation. |

Final continuation retained four separate caption groups, removed eight attested running headers, passed fragment/structure audits and did not reproduce the reported patrol-clause duplication. Manual full-document reading still found a possible background-to-chronology shift, a modal-strength change, residual extracted line breaks and damaged source heading spacing. Automated semantic pass does not establish that these are resolved.

Budget accounting, at conservative KRW 2,000/USD: confirmed token-priced usage approximately KRW 1,807.31; unknown aborted-call reservation KRW 464.72; total accounted KRW 2,272.03 of the approved KRW 3,000. Failed and superseded runs are included; no user credits were deducted.

## Release gate and limitations

Do not deploy this candidate as a complete fix yet. Resolve and revalidate the remaining semantic/layout findings without widening source deletion or treating uncertain semantics as pass. No additional production quality blocking or billing changes were introduced.

The original PDF is unavailable: page coordinates, original image positions and table geometry have not been verified. The patch is deliberately conservative and does not claim universal PDF/OCR recovery. Private source text, output, identities and paid-call artifacts are kept outside the repository.
