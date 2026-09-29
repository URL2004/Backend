# v2.5.92: preserve vertical clipboard table cells

Cause: tables pasted as one cell per line had no tab/pipe separators and were
classified as prose. Forced-wrap repair interpreted nominal suffixes as Korean
particles and joined both adjacent column headers and cross-row cells.

Changes:
- Shared layout analysis protects bounded vertical cell sequences with multiple
  header labels, rectangular repetition and distinct short row keys.
- Each line remains one cell; no guessed column layout is rendered or invented.
- Chunk freezing and final structure signatures consume the same table roles.
- Single-character suffixes alone no longer justify joining short nominal lines.

Verification:
- Attached source replay: all four tables, 70 cell lines, preserved exactly.
- Non-whitespace source content unchanged.
- Synthetic tests cover preflight, frozen chunks, idempotence and rejection of
  merged header/row boundaries by the final structural signature audit.
- Negative cases include prose, verse, code and numbered lists.
- No paid model generation; deterministic preprocessing and regression testing.

Limits: ambiguous, incomplete, merged-cell or already flattened tables are not
reconstructed. Medical/legal content is not fact-checked or rewritten by this
change. The separate generated-prose repetition reported in the example is not
claimed fixed here. Existing stored results and billing policies are unchanged.
