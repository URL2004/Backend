# PDF-derived text integrity — v2.5.78 candidate

Status: locally verified candidate, **not approved for production**.

## Additional KRW 3,000 verification — 2026-09-27 KST

The user subsequently authorized a separate additional KRW 3,000. Fresh planning and full advanced execution completed on `4ac406f`: nine approved changes (four merges, five splits), 81 planned/delivered blocks, structure delivery verified, no structure fallback and no running-furniture boundary findings. The full run took 520.3 seconds. All 81 source/output blocks were read in context. Existing duplicate patrol prose was reduced; damaged source TOC spacing remains.

Final semantic escalation initially exceeded the runner's KRW 2,400 admission slice, not the total authorization. A strict continuation released the existing KRW 600 contingency and reused 39 matching successful responses. It produced the identical final text and completed a fresh final escalation: `revalidated_fail`, `needs_review`. This is one generation with a continuation, not two independent samples. Clear epistemic hardening and relation changes remain; a judge's borderline modality observations are not all treated as confirmed errors. Production release remains on hold.

Additional approval accounting: KRW 966.48 confirmed token-priced usage plus KRW 503.34 unknown reservations (two interrupted attempts), total KRW 1,469.82; KRW 1,530.18 remains. Conservative planning conversion: KRW 2,000/USD. Forty-two HTTP attempts include failures/retries. No customer credit or production-data mutations occurred. Prior approval accounting is retained separately.

Offline tracing identified a further deterministic defect: list-prefix restoration could mistake a compound-word interpunct for a bullet, insert a newline and cause downstream structural rejection/rollback. A synthetic identity transformation reproduces the old failure. Boundary matching now requires a genuine line start or a whitespace-delimited marker following a complete sentence, and excludes quote/code spans. Numbered-anchor safeguards are retained. Focused tests cover four glyphs, actual flattened/compact lists, operators and quoted/code punctuation. This additional patch has **not** had a fresh paid full-generation run. An instrumented offline replay had two missing responses and a different final candidate; it diagnoses the layout path only and is not a semantic pass or an exact production replay.

Host timing measurements were variable: candidate three-job layout batch p95 208–252 ms and event-loop p95 71–79 ms; the baseline measured 904 ms/185 ms under the same non-isolated host conditions. Ordering/content/cancellation checks passed, but the 50 ms event-loop target was not met in these runs. Do not advertise an operational performance win from these measurements.

Final patch verification: 38 focused tests passed; production import graph 247 files/zero violations. Default-concurrency full suite passed 2,282/2,283 with the wall-clock layout p95 test exceeding 500 ms. That file passed all 15 tests in isolation. A complete rerun with `--test-concurrency=2` passed 2,283/2,283, zero skipped, in 108.8 seconds; no timing threshold was relaxed. These local passes do not replace the missing fresh full-model verification of this last boundary patch.

## Follow-up — 2026-09-27 KST

The original residual meaning findings were addressed by independently validating source restoration targets. One unsafe caption-crossing restoration no longer vetoes unrelated safe repairs. A background-to-chronology audit and inline-label physical-row repair were added. Restoring meaning no longer reinstates an intra-sentence PDF wrap. A further real audit caught a duplicated introductory clause caused by restoring across an unpunctuated caption; the common source restorer now rejects such composite spans. Limitative `그냥 … 아니라` is treated consistently with `단지 … 아니라`, not as categorical exclusion.

Fresh whole-document semantic revalidation of the deterministically amended prior generation passed with verification complete, no uncertainty and zero violations. This was **not a new whole-document generation**. The final full suite, including the references-only caption guard, passed 2,281 tests, zero failures/skips (63.0 seconds). Focused structure/furniture tests: 36 passing.

The independent `engine_phrase_fingerprint` style warning remains; zero semantic violations is not equivalent to all quality warnings being cleared.

A newly reported production run was confirmed to use the previous damaged output as its complete input. It was still on v2.5.77; its approved plan contained 11 changes, but delivery fell back (`STRUCTURE_DELIVERY_UNVERIFIED`, `structureApplied=false`, `structureFallback=true`, structure surcharge zero). Thus text entry alone cannot remove metadata already embedded in its content.

Follow-up fixes remove exact embedded headers only when independently repeated rows and the cover attest the same title/byline, and separate safely identifiable fused work captions. Replayed new input has zero remaining repeated headers and four separate caption groups. Ordinary prose mentions, quotes, code and references remain protected. The structure delivery audit now distinguishes editable list/inline-label bodies from locked prefixes and references; the previous whole-row comparison rejected legitimate body edits.

The structured ON path for this newly reported long document still needs fresh planning and full engine execution before release. Do not infer delivery success from the prior non-structured semantic pass or from local tests. The user explicitly chose verification within the existing balance and a deployment hold if insufficient; no additional budget is authorized. Accounting is KRW 2,285.55 including unknown reservation, leaving KRW 714.45 of the original approval. The fresh structure-plan request required a conservative maximum reservation of KRW 1,080.04 and was rejected before HTTP dispatch (`BUDGET_EXHAUSTED`). The engine surfaced cancellation as `ABORT_ERR`; the private admission record confirms the underlying budget cause. Both admission attempts added zero paid calls/cost. This reservation is not an estimate of an actual invoice. No production push or deployment has occurred; deployment is held as instructed.

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
