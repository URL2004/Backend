# API cost corrections — v2.5.102

Production baseline: `90830a4` / v2.5.101. The late-September increase in cost per revenue coincided with expanded judge inputs, document-specific schema enums and repeated final audits. Model mix, traffic and test usage also affect the account bill; this patch does not attribute the entire increase to one cause.

GPT-6 requests now explicitly cache the stable developer instruction prefix for 30 minutes. Dynamic instructions and document data follow the boundary. Review schemas no longer contain changing document IDs; server-side validation still rejects missing, duplicate and invented IDs. Operator prompts include applicable complete rule families and retain whole-document review. Repeated evidence uses lossless compact rendering only when it saves input, including its explanation overhead.

Deterministic, idempotent document preparation now runs before review segmentation and receipt-key creation. Verdict-only audits still inspect exactly the supplied text. Changed text, provenance, obligations or reviewer strength continue to require the appropriate fresh audit. No model downgrade, reasoning-effort reduction or relaxed semantic release gate is included.

All model calls, including mandatory audits and paid failures, contribute to a separate per-job cost summary persisted in history and archives. Unknown reservations remain separate from known estimates. Optional recovery limits retain their existing scope. Stage labels in usage logs match the call ledger. Legacy GPT-5.6 Sol estimates use corrected prices.

Exhausted-credit responses now stop transport and whole-job retries, including mixed concurrent failures. Short-chunk batching retains its default OFF setting; its dormant path no longer fans provider exhaustion into individual retries and preserves allocated batch costs during partial recovery.

Validation: the full 3,101-test regression suite passed. A final rerun after batch-accounting checks passed 3,095 tests and exposed six stale release-version assertions; those assertions were updated to v2.5.102 and their five test files rerun. Detailed results remain outside Git. Production import validation passed. A controlled synthetic comparison used six identical cases per revision with GPT-6.1 Sol and high reasoning. Both revisions matched all six expected verdicts. Estimated API cost fell from $0.106749 to $0.052914 (50.43%); cached-input share rose from 13.36% to 58.88%. Elapsed time was 35.54 vs 37.15 seconds, so this sample does not establish a latency improvement or a population quality/cost reduction.

After deployment, compare completed UTC days using API expense / refund-adjusted cash revenue at a consistent exchange rate. Review job-level cost, mandatory-audit share, cache read/write tokens, final-audit calls and retry failures. Cash revenue and credit consumption occur at different times; isolate local evaluation expense where identifiable. The observed weekly ratio of 12.71% is a baseline, not a promised post-release ratio. Private logs, API runners and evaluation artifacts stay outside Git.

Rollback target: `90830a448470401b3e9ed328f45dd63ac0e9f2b7`. Verify an idle service before release, the new engine version and health afterward, and fresh job accounting when available.
