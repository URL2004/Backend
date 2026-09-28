# Engine layout integrity candidate — 2026-09-28

## Release decision: HOLD

Based on production `f1b5b85` and prior held candidate `95f6584`.
This candidate has NOT been deployed. No model, price, credit deduction,
delivery policy, or score-floor policy was changed in this follow-up.

## Confirmed defects and changes

1. Generic heading inference split a compound heading noun before its final
   syllable. Prefer the full suffix and require immediate prose evidence;
   reject ambiguous nominal continuations rather than use a distant sentence.
2. A flattened report's cover labels swallowed the following numbered sections.
   Recover explicit cover/contiguous-section/bracket boundaries under a narrow
   source contract. Protect literals; insert whitespace only. Reuse these
   source-derived anchors in inline-label restoration and audit.
3. A cover date touching a section number changed numeric tokenization after
   harmless formatting. Use the same anchors before numeric extraction. Real
   value, unit, section-number and duplicate mutations still fail the audit.
4. Deterministic omission restoration accepted explicitly unrepairable or
   ungrounded findings via a weaker keyword fallback. Reject those findings as
   insertion authority while retaining their unresolved warnings.
5. A remote predecessor could place a recovered paragraph lead in the preceding
   paragraph. Require immediately adjacent source anchors; preserve paragraph
   ownership on ties. Consecutive omissions retain source order.

Unknown table cells and missing delimiters are not fabricated. Some flattened
subheadings and long numbered bodies still need readability work.

## Verification

- Whole backend suite: **2,496 passed**, zero failures/skips.
- Production import graph: 268 files, 814 edges, zero violations.
- 457-source preflight replay: only the new flattened report changed; no
  non-whitespace differences. Previous 456 sources unchanged. This is NOT a
  manual semantic review of every document.
- Previous 456 source/result numeric token sets unchanged. The new report's
  32 numeric tokens agree; actual date/height changes remain detectable.
- Synthetic regressions cover compound nouns, literals, CRLF/idempotence,
  numeric mutations, rejected finding authority, paragraph-end ties, consecutive
  omissions and non-adjacent anchors.
- Captured long-document judge response plus reconstructed pre-restoration text
  reproduces two bad/unsafe insertions in the old code. Revised restoration
  makes one correctly located insertion and retains the other unresolved
  finding. This local replay is NOT a new full-model run.

## Actual model executions

- New flattened report: final meaning audit complete/pass, structure pass,
  no rollback. Its numeric warning was traced to tokenization and resolved by
  the subsequent deterministic replay. Some formatting and limited substantive
  rewriting remain; it is not certified as an ideal rewrite.
- Long document: 14m33s, structure pass, final meaning audit **1/3 completed**
  within the 120s final window. Two requests were canceled with unknown usage
  retained. Not a quality pass. Manual full-text review also found the two
  restoration defects above. The latest fixes have not had a full regeneration.
- Short-text detection: four previously seen development controls, three
  cache-disabled repetitions each. Scores: 53/56/58, 4/4/4, 5/5/4, 34/58/58.
  The last input's primary model returned one versus two grounded categories,
  switching corroboration off/on. This is a remaining routing-stability issue,
  not proof that all low scores are incorrect. No arbitrary score boost added.

## Independent review

Actual Claude Opus 5.5 and Fable 5.1 calls identified heading counterexamples,
compound particles and paragraph tie placement. Reproduced cases became tests.
Some Fable responses were output-truncated; no unanimous release approval is
claimed. Model opinions do not replace executable checks or full-text review.

## Budget and remaining gates

New approval: KRW 5,000 total including council and model execution, planning
FX KRW 2,000/USD. Accounted: **KRW 4,505.45**, including **KRW 547.55** held for
two calls with unknown usage. Remaining KRW 494.55 cannot admit another complete
long-document regeneration. User credits and production records were not changed.

Before deployment: validate the latest full long-document pipeline, resolve
final-review scheduling within existing limits, check short-text corroboration
stability on independent genre controls, and recheck current production/health.
Do not call unfinished sections a pass, raise scores to fit a distribution, or
publish this candidate as deployed. Keep the tested candidate on an archive
branch until those gates are satisfied.
