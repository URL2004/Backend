# v2.5.57 — Source-grounded discourse boundaries

## Root cause

Sectioned documents skip the general semantic prose layout branch. Exact adjacent-sentence recovery also misses paraphrased source boundaries. Consequently a paragraph below the size cap can combine a case, intervention, and outcome while passing readability checks.

## Changes

- Restore response/outcome transitions already present at explicit source paragraph boundaries, before layout policy selection, including sectioned prose.
- Require a unique lexical correspondence, a matching discourse role, and sufficient sentences on both sides. Do not split merely on transitional words or length.
- Preserve non-whitespace content. Skip protected syntax, ambiguous repeated matches, creative writing and polish.
- Repair prose comma spacing and selected unambiguous noun-particle spaces outside literal content.
- Route spliced repeated-actor existential frames into the existing semantic repair audit. Do not perform blind subject deletion.
- Keep models, detector version, pricing, delivery and billing policies unchanged.

## Validation

- Eight new tests: positive and negative role recovery, sectioned integration, idempotence, protected content, source evidence, ambiguous matches, actor-frame review, and spacing.
- Full backend suite: 1,667 passed, zero failed/skipped.
- Production import graph: 223 files, 658 edges, zero violations.
- Local replay: 407 prior pairs plus 10 recent rows; only the identified overmerged case received two role boundaries. No non-whitespace changes or repeat-pass differences from this new rule.
- Latest final layout replay retains content for all ten recent rows.
- Existing NBSP inline-number repair rechecked against both original and delivered text of the reported numbered-item case.

## Limits

This is deterministic replay, not a new paid model run or proof of universal semantic accuracy. Ambiguous original claims must not be guessed: a duplicated term may represent a missing different concept. The new actor-frame audit uses the existing model repair process; identifying it does not guarantee every future repair succeeds. Existing saved results are not rewritten. Full historical human review remains incomplete as reported previously.
