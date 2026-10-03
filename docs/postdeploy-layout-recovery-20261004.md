# Post-deployment sentence and paragraph recovery — local validation

Base: production commit `a21a58b33916d0f1053a1d1a19836dfef4b2af79`.
Branch: `fix/postdeploy-structure-20261003`. Unreleased; no production writes.

The audit covered 86 humanization histories after the October 3 deployment,
plus 88 earlier histories for regression comparison. Successful model chunks
and source-structure checks did not establish that the delivered paragraph
layout was readable or that semantic validation passed.

## Corrections

- Physical prose reflow recognizes evidenced Korean predicate endings,
  inflections, purpose endings and numeric units before chunk ownership is
  assigned. It avoids freezing a detached `다.` as a list item. Source-backed
  output seam recovery protects quotations, code and formulas, and does not
  merge arbitrary word pairs.
- Hangul list anchor lookup rejects occurrences inside words. Restoring `다.`
  can no longer select the final syllable of `한다.` and introduce a new break.
- Long incomplete prose does not become a subtitle merely because a layout
  pass inserts blank lines. Ordinary headings retain their existing role.
- Tabular numeric ranges take table precedence over numbered headings.
  Display math is protected as a complete block, including internal whitespace.
- Topic-form ordinals and subjects before ordinal reason frames retain their
  source enumeration identity. Actual missing items still fail the audit.
- Editable paragraphs are individually checked against readability limits
  after aggregate paragraph targets are reached. Literal spans remain intact.
  Nominal label sections, enumeration introductions and the outer bibliography
  boundary are separated without changing their content order.
- Layout is settled after candidate selection, before final semantic review.
  A later semantic fallback is settled only if both token and relation
  projections preserve the existing verdict. Missing structural content is
  never accepted as a successful layout repair.
- Final delivered paragraph counts, longest readable paragraph, overlong
  paragraph count and seam repair count are persisted. Legacy rows without
  layout verdicts retain unknown status rather than fabricated booleans.

## Local validation

- `node --test test/*.test.js`: **3,089 passed, 0 failed, 0 skipped**.
- Production import graph: **passed**, no violations.
- Deterministic replay: **174 saved input/output pairs**, comparing the
  production base with the patched preflight and layout pipeline.
- **0 newly failing structural audits**, **0 changes to non-whitespace
  characters**, **0 unstable outputs on a second layout application**, and
  **0 document-profile changes**. Fourteen layout outputs differ from baseline.
- The reported long document changes from one explicit paragraph in its saved
  output to 40 explicit paragraphs; maximum six sentences / 248 non-whitespace
  characters per readable paragraph. Structural and readability audits pass.
- One older result still fails because its protected subtitle was actually
  rewritten; this is retained as a real failure. Two earlier jobs keep their
  user-approved paragraph plans despite readability recommendations.
- Synthetic regressions cover the production failure shapes without storing
  user text. A mocked whole-engine test verifies canonical input reaching
  generation, successful final semantic status, and delivered metrics matching
  the actual returned text. History tests verify zero/failure persistence and
  omission of absent legacy fields.

The replay does not regenerate model responses or rejudge their meaning.
Existing semantic distortion/omission findings are not cleared by layout
validation. Original PDF reading order is outside this text-only audit.
Private replay data, original/result comparisons and test logs remain outside
the repository under the workspace's local reports directory.
