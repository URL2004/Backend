# v2.5.95: check the order of chunk boundary markers, count marker failures

Cause: when small editable chunks are coalesced, the text sent to the model
carries source-owned boundary markers (`[[[V2_BOUNDARY_nnn]]]` for paragraphs,
`[[[V2_LINE_nnnn]]]`, `[[[V2_SENTENCE_nnnn]]]`). `restoreBoundaryMarkers`
rejected a missing, duplicated or leaked marker and a changed locked sentence
or line count, but not a change of order. If the model swapped two markers
(and with them the content they separate), the audit returned `ok: true`.
Found during the 2026-09-30 three-way review of the "Kiwi-free" proposal.

Changes:
- `restoreBoundaryMarkers` now fails with `orderChanged: true` when markers
  that occur exactly once appear out of order. The expected order is the order
  of the markers in the text actually sent to the model (`chunk.llmText`), not
  the concatenation of the paragraph, line and sentence lists: line and
  sentence markers are interleaved by source position. Missing and duplicated
  markers are still reported on their own. The chunk gate reports
  "병합 청크의 원문 경계 토큰 순서가 바뀌었습니다." and the existing
  escalation and residual paths apply unchanged.
- Count-only telemetry. Each attempt's audit is summarised without text
  (`summarizeBoundaryAudit`: marker kinds, ok, reasons, failed kinds). An
  escalated chunk keeps the primary attempt's summary in
  `primaryBoundaryMarkerAudit`. Per job, `engineMeta.boundaryMarkerStats`
  holds the denominators (chunks and markers by kind) and the first-attempt
  failures, escalation failures, recoveries by escalation and residual
  chunks. Jobs that used markers log `gpt_prod.boundary_marker_stats` (info);
  jobs with a failure also log `gpt_prod.boundary_marker_failed` (SEV3, admin
  ops log only, no Discord).
- `engineMeta.relationCandidateCounts`: delivered-text relation nominations by
  code (for example `antecedent_link_loss_candidate`). Nominations are not
  confirmed errors; this only sizes them.
- The admin layout lab (`layoutNlpTest`) no longer forces the Python layout NLP
  on. It follows `LAYOUT_NLP_PYTHON_ENABLED` through the new
  `isPythonNlpEnabled()`, like the production path (default off).
- `/internal/health` reports process memory (`memory.rssMb` and heap figures).
  The public `/healthz` is unchanged.

Verification:
- `test/boundary-marker-order.test.js`: swapped paragraph markers fail; a chunk
  with paragraph and sentence markers passes in llmText order and fails when a
  sentence marker and a paragraph marker swap; missing and duplicated markers
  are not reported as order changes; the per-attempt summary carries no text;
  document counters separate first failure, recovery and residual and skip
  locked chunks; catalog entry; one NLP switch for lab and engine; memory only
  in the detailed health payload.
- Engine mock run asserts `engineMeta.boundaryMarkerStats` and
  `relationCandidateCounts` are present.

Limits: the later general surface retry for residual chunks is not counted
here. Marker telemetry covers seams between coalesced chunks and locked
sentences or lines; a paragraph that moves inside a single uncoalesced chunk
is not visible to it. Stored results and billing are unchanged.
