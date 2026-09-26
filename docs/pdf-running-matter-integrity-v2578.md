# PDF-derived text integrity — v2.5.78 candidate

Status: locally verified candidate, **not approved for production**.

## Follow-up — 2026-09-27 KST

The original residual meaning findings were addressed by independently validating source restoration targets. One unsafe caption-crossing restoration no longer vetoes unrelated safe repairs. A background-to-chronology audit and inline-label physical-row repair were added. Restoring meaning no longer reinstates an intra-sentence PDF wrap. A further real audit caught a duplicated introductory clause caused by restoring across an unpunctuated caption; the common source restorer now rejects such composite spans. Limitative `그냥 … 아니라` is treated consistently with `단지 … 아니라`, not as categorical exclusion.

Fresh whole-document semantic revalidation of the deterministically amended prior generation passed with verification complete, no uncertainty and zero violations. This was **not a new whole-document generation**. The final full suite, including the references-only caption guard, passed 2,281 tests, zero failures/skips (63.0 seconds). Focused structure/furniture tests: 36 passing.

The independent `engine_phrase_fingerprint` style warning remains; zero semantic violations is not equivalent to all quality warnings being cleared.

A newly reported production run was confirmed to use the previous damaged output as its complete input. It was still on v2.5.77; its approved plan contained 11 changes, but delivery fell back (`STRUCTURE_DELIVERY_UNVERIFIED`, `structureApplied=false`, `structureFallback=true`, structure surcharge zero). Thus text entry alone cannot remove metadata already embedded in its content.

Follow-up fixes remove exact embedded headers only when independently repeated rows and the cover attest the same title/byline, and separate safely identifiable fused work captions. Replayed new input has zero remaining repeated headers and four separate caption groups. Ordinary prose mentions, quotes, code and references remain protected. The structure delivery audit now distinguishes editable list/inline-label bodies from locked prefixes and references; the previous whole-row comparison rejected legitimate body edits.

The structured ON path for this newly reported long document still needs fresh planning and full engine execution before release. Do not infer delivery success from the prior non-structured semantic pass or from local tests. An additional KRW 3,000 was requested but has not yet been approved. Existing accounting is KRW 2,285.55 including unknown reservation, leaving KRW 714.45 of the original approval. No production push or deployment has occurred.

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
