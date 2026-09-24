# v2.5.66 — structured body coverage

## Confirmed incident

The submitted source and result matched an operational v2.5.65 advanced job exactly after whitespace normalization. The job had 91 logical chunks, 52 structural locks and only 12 primary editable chunks. Five section recoveries did not complete the omitted body corrections. Local source partitioning found 39 editable chunks; 26 appeared verbatim in the supplied result. These are chunk counts, not a sentence-level edit-rate metric.

The report received the `label_heavy` format flag. `shouldDeferLabelMicroFragment` ranked all editable chunks and admitted at most 12 in general modes or 8 in polish. Complete sentences and long chunks outranked short body sections. A small source-hint dictionary was not a complete spelling-error detector. The downstream optional recovery stage was not a guaranteed queue for the omitted chunks.

## Change

- Removed the representative-chunk selector from primary execution and depth-plan distribution. Every nonempty editable text fragment participates regardless of length, position, format flag or presence of a known correction hint.
- Structural locks remain the authority for titles, references, quotes and code. The secondary under-50-character/non-sentence-ending bypass now excludes only empty/separator fragments, not editable prose or heading bodies.
- Shared `shouldCallModel` between primary execution and its planning. Existing ETA and input eligibility callers also consume that policy.
- Added primary eligible, attempted and unattempted counts to engine metadata and history serialization. An attempted failed model call is not an unattempted fragment and is not represented as a successful correction.
- Kept the legacy deferred counters readable for historical reports. New primary execution no longer emits deferral reasons.

## Scope and safety

Models, reasoning, pricing, billing and delivery gates are unchanged. No quality-blocking policy was added. Worker concurrency stays at its existing value; the batch feature flag is not enabled by this patch. This may increase primary calls on highly structured documents previously truncated to representative chunks. It does not promise lower cost or latency; observe total request calls and duration after release.

This is not a per-word replacement list for the submitted document. Ambiguous damaged wording is not guessed, existing factual assertions are not arbitrarily weakened, and duplicate section numbers are not silently renumbered. Protected-title spelling and source-numbering improvements require separate reference-safe handling. Submitting a fragment to a model does not guarantee every spelling error will be corrected.

## Verification

- Exact operational source/result match and metadata confirmed read-only; no customer record was modified.
- Regression cases cover all three modes, more than 18 short bodies, unseen typo tokens, Japanese/Chinese text, structure locks, separator fragments, batch flag on/off planning and attempted failures.
- Full engine mock tests exercise middle-body correction through final assembly, all eligible primary calls and concurrency at most two.
- No new paid model calls for this patch. API-backed model quality, operational latency and cost are not claimed from mock tests. The existing cumulative paid-evaluation budget was not reset.
- Backend full suite: 1,957 passed, zero failures (test concurrency 2). Production import graph passed. Deployment receipts are recorded in the release handoff; private sources/results stay outside Git.

## Operational follow-up

Verify the live commit, v2.5.66 health version and primary coverage counters on new structured work. If a nonempty editable body is again unattempted, inspect execution/cancellation provenance rather than increasing edit-rate targets. Roll back to the immediately previous live deployment if new structural or semantic corruption is attributable to this patch.
