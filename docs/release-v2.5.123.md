# v2.5.123 / detector v1.62 — 2026-10-26

The v122 census covered 266 retained completed humanizations, 133 detections,
9 blocked jobs and 23 cancelled jobs. Customer texts and operational snapshots
remain outside Git. Four account-deleted results were log-only and were not
recovered.

## Corrections

- Repair proven physical wraps inside developed labelled list sentences before
  assigning immutable heading ownership. Keep numbered prefixes, real headings,
  tables, quotations, code and creative line structure. A complete prose sentence
  followed by an unfinished clause cannot become a contextual nominal heading.
- Recognize bare numeric markers and uniquely source-backed Korean ordinal noun
  frames. Restore explicit sequential report boundaries and common form labels
  only with a qualified numbered report. Never infer absent numbers.
- A uniquely owned hanging list prefix can propose restoration of that source
  item before the normal semantic audit. Integrity and structural checks still
  apply, and any accepted restoration forces semantic review. Unresolved proven
  corruption remains a delivery error, not a genre-only warning.
- Remove basic-to-polish fallback entirely. The old endpoint returns 410. The
  new same-mode retry persists its intent and request key before acknowledging;
  uses the ordinary queue, original job/owner/mode/price/billing instrument;
  and survives restart, cancellation and response loss. Delivery staging also
  rejects a mode downgrade before billing. Original worker ceilings remain.
- Separate CSP, observation-event and notification rate-limit stores from the
  business-request store. Keep limits and Retry-After. Existing local notification
  outbox retries remain; browser backlog pacing now fits 30 requests/minute.
- Review the detector's combined statistical candidate, not just the initial
  model result. At most one review shares the original absolute deadline.
  An uplift that introduces unsupported evidence is rejected in favor of the
  consistent independently judged candidate. Record attempted statistical score,
  final score and rejection separately. History adjustment is unchanged.
- Do not pay for another semantic audit of an identical rejected recovery
  candidate. This request-local duplicate guard grants no approval and does not
  exempt changed text, final verification, safety checks or budget limits.
- Distinguish depth target miss from unchanged text using explicit metadata;
  retain the legacy field for older clients. Health exposes the shared worker
  cap separately from per-mode ceilings.

## Verification boundaries

Deterministic corpus replay resolves all three observed marker false alarms.
The two previously delivered malformed layouts are now detected; they are not
newly damaged outputs. Regression tests cover source ownership, literal/creative
barriers, ordinal loss, flood isolation, two-instance retry idempotency, mode
and billing preservation, cancellation, restart and bounded detector review.
Versioned detector cache separation prevents reusing pre-fix results.

The complete corpus was not regenerated with paid models. Nondeterministic
generation quality, uncertain semantic judgments and production queue latency
cannot be guaranteed by offline tests. Worker counts have not been increased;
deployment observations and comparative model verification belong in the private
release report, with actual counts and costs, not inferred improvements.
