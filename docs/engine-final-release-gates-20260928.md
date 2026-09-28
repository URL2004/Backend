# Engine v2.5.87 candidate: release gate record

Status: NOT RELEASED. Based on live `f1b5b85` through archived candidate `3762ea7`.
This document contains no customer text, identifiers, or private run payloads.

## Repairs

1. Mixed split/merge ownership: a neighbouring output sentence can contain
   both the selected source claim and a different source claim. Refuse an
   overwrite that would duplicate the selected claim's remaining content.
2. Failed post-repair validation: retain the last completed failed verdict
   and its exact previous text, rather than adopting an unvalidated repair or
   discarding its findings. Preserve cost and spent repair rounds. Cancellation
   still propagates. The existing escalation route is unchanged.
3. Low-surface confirmed relation: an exact, single-sentence finding can use
   both immediate, strong, reciprocal, uniquely matched neighbours as positional
   evidence. No blanket similarity threshold reduction. Existing ownership,
   protected-text, structure, quantity, and fresh-verification gates remain.
   Optional search is bounded to 256 sentences and 400-character anchors.

Models, prices, billing, delivery rules, and detector settings are unchanged.

## Evidence and limits

- Full final regression suite: 2,513 passed, zero failed/canceled/skipped
  (36.1 seconds); no paid model or production database writes in the suite.
- Production import graph: 269 files, 817 edges, no violation.
- Historical 456-pair fingerprint restoration replay: 11 relevant targets,
  no changes. Not a new manual audit of all 456 documents.
- Stored semantic verdict replay: 17 reports, four changed restoration
  proposals referring to the same residual sentence; other proposals unchanged.
  A proposal replay does not certify a repaired text.
- A complete shorter real-document run passed semantic and structural gates
  after repairs 1–2. The long run retained a genuine relation weakening and
  lacked final semantic validation. Repair 3 was made afterward and has only
  synthetic/stored-response coverage, not a full new model run.
- Hard additional budget: KRW 2,000. Accounted KRW 1,888.19415, including
  KRW 26.127 retained for unknown canceled usage. 39 actual HTTP attempts.
  Final two audits were denied BEFORE transmission. Remaining KRW 111.80585.
- The test budget did not protect a separate final-audit reserve. This is a
  test orchestration limitation, not evidence of a production service timeout.

## Remaining release gate

Validate the exact latest repaired long candidate with fresh final semantic
audits, then verify the integrated end-to-end route. Reserve the full mandatory
validation allowance before spending on optional re-generation or recovery.
Do not turn incomplete validation into a pass or deploy detector-only code as
an implicit substitute for the agreed integrated release.

No production push, deployment, environment changes, or user credit deductions
were performed in this increment. Preserve on an archive branch until gates pass.
