# v2.5.58 — New paragraph boundaries inside structural documents

## Confirmed causes

The prior fix restored explicit source boundaries; it could not create boundaries in an unsplit source. Whole-document section flags excluded semantic layout even for ordinary body prose. Length caps passed paragraphs with distinct discourse roles. Repeated layout could merge newly separated roles. A purpose clause ending in an unfinished modifier was classified as a title, making the incomplete line uneditable and invisible to prose diagnostics.

## Implementation

- Add block-local semantic splitting after existing layout policies. Headings, lists, tables, quotes and code remain individually protected; their presence does not disable adjacent prose.
- Recognize developed response/outcome, substantive comparison, policy-to-cultural intervention and reflective transitions. Require sufficient prose and sentence context; do not split on a connector alone or manufacture equal-length paragraphs.
- Restore the position of a reflection lead when it clearly introduces the following reflective paragraph.
- Preserve every non-whitespace character and original sentence order. Maintain polish, creative and legal-profile exclusions.
- Keep logical paragraph accounting exports used by depth/discourse/detection unchanged.
- Recognize purpose clauses with unfinished modifiers as prose; existing preflight can join their continuation before generation.
- Bump humanizer to v2.5.58 and source preflight to 23. Model, prices, detector version and delivery/billing policy are unchanged.

## Verification

- Full suite: 1,675 passed, zero failures/skips.
- Eight new regression tests including unsplit source, sectioned body, source-independent splits, protected literals, negative connectors, final locked-layout fixed point and reflection-boundary placement.
- 415-row local replay (407 old + 8 recent): nine rows received 13 new boundaries; one additional recent row received a reflection-boundary move. Zero non-whitespace changes or standalone-rule repeat-pass differences.
- All eight recent rows retain non-whitespace content and are stable through repeated paragraph layout.
- Recent comparison example: two body paragraphs become four, with both headings retained. Three related intervention examples receive two new boundaries each.
- Five older affected rows were directly inspected; splits separate contrasting groups, methods, strengths/limitations, survey sentiments, or job-loss/job-creation discussion.

## Remaining limits

This is deterministic replay, not paid model regeneration. Saved historic results are unchanged. Already-corrupted input may still require model repair; recognizing an incomplete line is not permission to invent its missing contents. Not every text should gain paragraphs, and semantic rules are deliberately conservative. Historical spelling/content issues outside these layout fixes remain separate review items. Universal correctness and completion of all historical manual review are not claimed.
