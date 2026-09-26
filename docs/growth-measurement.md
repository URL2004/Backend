# Growth measurement contract

## Authentication diagnostics

`POST /events` accepts `type=auth_diagnostic` before authentication. Required fields are `attempt_id` (32 lowercase random hex characters), `method` (`google|kakao`), `flow` (`popup|redirect`), `stage`, and `outcome` (`start|success|cancel|error`). Stages are `provider`, `sdk`, `popup`, `callback`, `token_exchange`, `backend_exchange`, `firebase_signin`, `complete`. Success requires `complete`.

Optional bounded fields: `error_code` (explicit allowlist, unknown codes become `unknown`), `duration_ms` (0–600000), `release`, `device`, `traffic_source`, `traffic_medium`. All other fields are discarded. Browser family is derived from the request, not a raw client parameter. No OAuth state, token, email, account ID, source text or exception message belongs in this payload. Each IP has a separate 60 requests / 5 minutes limit; valid events are info logs with event `client.auth_diagnostic`, without external alerts. The endpoint does not authenticate the reported outcome and must never authorize account access or billing.

Download these structured logs at least weekly, before the host's retention expires. Preserve server timestamps as `ts`. Deduplicate by attempt ID in the report. Starts mature after 10 minutes; the first linked terminal within that window determines success/cancel/error. No terminal is `incomplete`; a window still open is `pending`. Later terminals and orphan callbacks do not fabricate starts. Delivery loss, throttling and client manipulation remain measurement limitations. Report linkage and duplicate/conflict counts with every rate.

## Report command and input

Run `node scripts/growth-report.js input.local.json output.local.json`. Inputs/outputs stay outside Git. `start` is inclusive, `end` exclusive, `asOf` the extraction time; all must be ISO timestamps with a timezone. For seven KST days, use midnight `+09:00` boundaries and allow at least 24 hours after `end` for checkout maturation. GA4 property timezone must be checked before reconciling; use GA4 gross purchase revenue, not refund-adjusted revenue, against approved order amounts. Record GSC's reporting dates separately rather than pretending its daily timezone matches GA4.

```json
{
  "start": "2026-09-27T00:00:00+09:00",
  "end": "2026-10-04T00:00:00+09:00",
  "asOf": "2026-10-05T00:00:00+09:00",
  "authEvents": [],
  "orders": [],
  "gaPurchases": [],
  "checkoutEvents": [],
  "ads": [],
  "searchRows": []
}
```

Omit unavailable datasets: omitted means unknown (`null`), an empty array means a completed export found zero rows. Never replace missing data with an empty array.

| Dataset | Fields |
| --- | --- |
| authEvents | `ts`, `attempt_id`, `method`, `flow`, `stage`, `outcome`, `error_code`, `browser`, `device`, `traffic_source`, `traffic_medium` |
| orders | `orderId`, `approvedAt`, `amount`, `refundedAmount`, `firstPurchase` (boolean or null), optional one-way `buyerKey` and `attribution` |
| gaPurchases | `transactionId`, `purchaseEvents`, `revenue` (KRW; aggregate for precisely the report period) |
| checkoutEvents | `event`, `ts`, `transactionId` if an order exists |
| ads | `start`, `end`, `source`, `medium`, `campaign`, `cost` (KRW) |
| searchRows | `query`, `page`, `device`, `clicks`, `impressions`, `position`; export the selected GSC dates |

Checkout requires the full order approval export through `end + 24 hours`. Count each started order once, including orders with cancel/error followed by successful retry. Pre-order cancellation has no transaction ID and remains separate. Do not send empty transaction IDs to GA4.

Revenue is approved-order-cohort gross minus cumulative refunds as of extraction, not accounting profit or refund cash flow during that period. The order source is authoritative for approved/refunded amounts; GA4 discrepancies are reported by hashed order identifier and category, never silently repaired or replayed to analytics. Use the existing read-only Toss reconciliation script to verify the ledger independently.

Advertising uses only an explicitly supplied `attribution={model:"last_non_direct_30d",source,medium,campaign}` from a captured original touch; no inferred backfill. Missing attribution stays unmatched. First-buyer CAC requires known first-purchase flags and a pseudonymous buyer key. `observedNetRoas` is a ratio, not a percentage or incremental return. Platform-reported conversions belong in a separate source table, with their own window. The command never changes budgets.

## Release and review

Deploy backend before frontend. Record both commits and UTC/KST completion time. After deployment verify `/healthz`, normal page loading, a controlled auth path, exclusion of admin traffic and new-event receipt. Verify again next day. On reproduced new login/billing failures revert the affected feature commit, test and deploy the rollback. Keep backward compatibility with old clients.

First complete post-release day starts the new measurement cohort. Compare two complete, same-definition seven-day intervals by provider/channel/device; report denominator, linkage and sample size. No causal lift claim from an uncontrolled before/after comparison. On days 7/14/28 record `improved`, `worse`, or `judgment_pending` with evidence. Repeat-purchase/activation cohort work needs linked source data and cannot be reconstructed from aggregate event-user counts.
