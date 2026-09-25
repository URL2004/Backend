# Source-grounded style follow-up — 2026-09-25

Baseline: `6286bff` (production v2.5.68). Feature branch: `fix/source-grounded-style-20260925`.

## Changes

1. Compound category labels with commas now share the same classification in chunk locking, boundary restoration and final layout audit. Empty comma segments, clause endings, timestamps and URLs remain excluded. Only existing source labels are restored; their body remains editable.
2. Parallel purpose regressions are repaired only when a unique source nominal frame contains the same actions and exact following proposition. Completed-action sequences, ambiguous source matches, quotations and code are excluded.
3. A source-backed subject particle can repair a newly introduced possessive in a `도움이 될` clause. The noun and following local clause must match the source. Existing possessives and other clauses are not guessed. Candidate integrity and semantic-review selection include the new issue.
4. The existing role-to-cause regression repair is now registered in the Korean issue catalogue. It was previously detectable but missing from the catalogue used for severity/improvement evaluation.
5. Explicit ordinal predicates at sentence end count toward structural identity, just like ordinal frames at sentence start. They never become paragraph-split locations. Missing/changed ordinals, quotes, code, negation and ordinary ordinal nouns retain separate regression tests.
6. Academic generation and local repair share guidance for parallel purpose, scope attribution, avoiding duplicated recommendation predicates and simplifying metaphors without changing claim strength or factual modifiers. Other genres are not assigned this academic style contract.
7. A unique source example list can be restored before its surviving class label when all members vanished and the surrounding sentence still matches. Partial lists, ambiguous matches, quoted/code lists and unrelated contexts are excluded. Derived words do not count as preserved list members.
8. A uniquely shared quoted category can anchor a lost affirmative restriction in a conditional clause. Only the source clause is restored; quote contents and the following edited clause remain unchanged. Negative restrictions and uncertain correspondences are not guessed.

The prompt size/line caps are unchanged. The first expanded prompt failed the existing cap; redundant genre instructions were condensed instead of relaxing it. Existing preservation instructions remain in the shared core. Four wording tests follow equivalent compressed instructions.

No model, pricing, credit, delivery-policy, detection-score or frontend changes. No new external lookup or model-call stage. Source factual errors remain distinct from introduced editing errors; the engine does not guess external factual corrections.

## Verification

- Backend: 2,031 tests passed, including 19 new follow-up tests.
- Production import graph: 232 files, 698 edges, no forbidden imports.
- Historical deterministic replay: 97 humanizing pairs; no new number, quote/code or marker loss from repairs. Detection input offsets checked on 52 historical records. This is not a new detection-accuracy evaluation.
- Compound-label parser comparison on all historical pairs: zero unintended line-classification changes.
- Ordinal parser comparison: two additional sentence-final markers in one historical result; directly reviewed as legitimate enumeration. No new matches in the other 96 pairs.
- Layout restoration tested for basic, advanced and polish; no lexical changes, idempotent on second application.
- Real model validation uses the previously approved cumulative budget, reserves unknown failed-call costs, and does not deduct user credits. Raw texts, account identifiers and local runners are excluded from git.

## Important validation finding

A long-document API replay passed semantic validation but contained a newly introduced particle error. A separate structural warning was a false positive caused by relocated ordinal predicates, not a loss of the numbered contents. Both were investigated and reproduced before fixing; the initial run is not counted as a clean success. A semantic model pass is not a guarantee of grammatical correctness.

A second generation exposed equivalent quoted-response and adverbial-ordinal variants; regression cases cover both. Another API result lost explicit examples and weakened a restriction while receiving a clean engine status. Both were directly reviewed and incorporated into source-grounded repair, not dismissed because the model had passed them.

API scope: five full generations on three sources (four advanced requests, one basic request), followed by two full-document semantic validations of repaired candidates. The long candidate passed without further textual changes; the shorter candidate required an additional aspect repair and then passed. Final numbers, literals and structures were checked separately. The last two guards were validated by replaying real failed outputs and actual semantic revalidation, not by claiming another end-to-end generation after those additions. No paid polish generation was included.

Conservative cost accounting: approximately KRW 1,316 for this follow-up, KRW 6,462 cumulatively within the previously approved KRW 10,000 budget. Unknown failed-call usage remains reserved. These are upper estimates, not supplier invoice figures.

## Limitations and release status

Stylistic preference is not an automatic license to delete emphasis, lower recommendation strength or replace technical concepts. Remaining subjective repetition is not presented as completely solved. API samples and local replay are not production-wide accuracy or latency estimates.

This follow-up is not deployed. Version labels remain at the baseline until a separately verified release. The private comparison report and API ledger are stored outside the repository.
