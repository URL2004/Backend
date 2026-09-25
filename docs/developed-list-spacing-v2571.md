# v2.5.71 — developed numbered answers

## Confirmed cause

The investigated v2.5.70 record retained two single newlines in both source and result. It did not lose line breaks. However, three developed numbered answers were classified as a list-heavy block. `needsVisualParagraphGap` unconditionally excluded list-to-list boundaries, and readability treated all lists as protected. This preserved compact-list formatting even for independent, multi-sentence answers.

## Change

- Add blank-line separation for consecutive, same-level numeric siblings (`1.` / `2.` or `1)` / `2)`) when both bodies have at least two sentences, 60 non-whitespace characters and complete sentence endings.
- Preserve each item's number, order and text. This is whitespace-only formatting, not model rewriting.
- Share the eligibility predicate with readability measurement, so missing gaps are not silently exempted merely because the text is a list.
- Reapply eligible spacing after locked-prefix restoration in the final layout fixed point; otherwise restoring original single separators would undo the improvement.
- Keep compact lists, answer keys, nested/nonconsecutive numbering, tables, quotes and code protected. Polish, sensitive preservation profiles and user-approved structure retain their existing layout policy.
- No model, prompt, pricing, credit or delivery-policy change; no extra model call.

## Validation

Full backend suite: 2,068/2,068 passed (17 new regression tests), no skips or failures. Production import graph: 232 files / 698 edges, no forbidden imports.

Regression tests cover basic/advanced final layout, text and ordinal preservation, fixed-point convergence and idempotence, readability, quoted terminology at the beginning of an item, compact lists, answer keys, fenced code, blockquotes, nested numbering, numbering gaps, hierarchical numbering, tables, existing blank lines, polish, sensitive profiles, CRLF, parenthesized numbering and user-approved structure.

Private history replay: 111 unique source/result pairs, each through basic and advanced final-layout paths (222 comparisons). Only the reported numbered-answer pair changed, in both modes: two blank lines were inserted. All compared non-whitespace text remained identical to baseline final-layout output; no previously passing structure or convergence check regressed. Raw user text and identifying metadata remain outside git.

This is deterministic final-stage replay of real model outputs, not new paid generation or a claim of improved model semantic quality. It specifically addresses visual spacing between existing numbered answer lines. Completely flattened inline lists and arbitrary numbering systems are not newly rewritten. Historical saved results are not migrated.

Release baseline / rollback target: `43eef75` (v2.5.70). Target: v2.5.71. Production deployment receipt is stored outside git after health verification.
