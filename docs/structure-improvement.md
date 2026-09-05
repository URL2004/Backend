# Advanced structure improvement

`HUMANIZE_STRUCTURE_ENABLED=1` enables the credit-only advanced option. It is off
by default. Existing requests without `structureMode` preserve the current flow.
The public `GET /transform/structure-config` reports availability; administrator
accounts may verify the API while the public flag is off.

`POST /transform/structure-plan` accepts the same text, authentication, length and
language checks as advanced humanization. It runs through the existing durable
queue and execution lease. Poll the returned job ID through `GET /transform/:id`.
Preview jobs never enter the completion billing or humanization history path.
The authenticated account, source hash, structure version and one-hour expiry
bind a plan. Identical preview requests reuse a 30-minute cache bucket. Preview
starts have a separate daily counter with the existing request/concurrency cap.

Start with `structureMode: "improve"` and `structurePlanId`. The server retrieves
and validates the stored plan; it never accepts client-supplied operations.
All original blocks must occur exactly once. Main headings/questions, numbered
headings, protected boundaries, tables, quotes and references cannot be edited.
Only supported paragraph moves/merges/splits and unnumbered subsection moves are
applied deterministically. Unsupported inputs and no-op plans have no surcharge.

Facts and numbers retain the original input as the integrity baseline. Structural
checks use the approved arrangement. The final paragraph correspondence check is
conservative: unverified delivery causes one preservation-mode rerun. Its model
cost is retained in internal usage. No structure charge is made for this fallback.

The surcharge is `ceil(advancedBaseCredits * 0.30)`; evidence cost is excluded.
The actual amount is durably staged with the completed output before the existing
`job_<id>` ledger commit. Identical approved-plan/settings submissions reuse the
same execution ID. Restart recovery uses the staged amount. Unlimited/admin
exceptions remain; `creditBreakdown.charged` reports the actual amount, including
zero for these exceptions. Legacy coupon subscriptions do not support the option.

Validation: `test/document-structure.test.js`, `test/structure-route.test.js` and
completion recovery checks in `test/audit-hardening.test.js`. Production rollout
requires the full suite, a synthetic model run, both viewport checks and an actual
credit-account debit/replay check. Disable the flag if structure damage or duplicate
debits are observed. Execution cancellation behavior is outside this change.
