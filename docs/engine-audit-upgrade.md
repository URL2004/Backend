# Detection and humanization audit implementation

The upgrade preserves own-humanized-history calibration while making its provenance, score stages and final validation state explicit. Detection is `gpt-detect-v1.31` / `detect-prompt-v6-document-scope`; humanization is `gpt-prod-v2.5.49`.

## Request and score flow

Both detection routes score the complete input with canonical paragraph, protected-span and eligible-prose metadata. Reference context is separate. Their raw detector cache shares a text/language/context fingerprint, scoped to user and model/prompt/policy/profile variant. Calibration runs after the cache; adjusted scores never enter that cache.

Humanization history automatically resolves the latest matching server detection even if the client omitted its source score. An explicit mismatched score hint is rejected. A calibrated detection cannot become an authoritative uncalibrated source. Signed output history is indexed by normalized output hash; source detection is indexed by exact input hash. Index fields locate records; they never replace HMAC and source checks.

The existing factor, maximum reduction and floor remain configurable. A verified original score caps an exact normalized own-result match. Near matches retain the existing percentage adjustment but additionally require an ordered small edit and unchanged numeric, polarity and quote anchors; they do not inherit the original-score cap. Lookup/configuration outages produce a retryable uncharged error instead of silently returning an unadjusted score.

`historyComparison` contains both raw and adjusted deltas, identifies the service-score basis, and distinguishes lower/equal/higher/unknown-baseline results. Backups require a separate UID/text/score/comparison HMAC; see [comparison contract](detect-history-comparison.md). No-op/zero/equal scores are not represented as improvement.

## Humanization contracts

Trusted system/task/retry blocks are validated together. Paragraph locks and shared meaning-preservation rules are consistent. Semantic passes are bound to exact source/candidate SHA256 values. Skipped and stale checks cannot authorize candidate selection as a validated pass. A final stale/unconfirmed check that actually ran is delivered with a review warning; intentionally skipped checks remain explicitly skipped.

Number ownership, argument direction, causality, claim strength and implicit experience heuristics trigger semantic review rather than asserting factual errors. Ungrounded judge spans do not authorize repairs. User editing preferences are separated from provided facts; a reachable source URL does not prove a proposed claim. Existing review delivery and technical blocking policies remain in place.

`HUMANIZE_PROMPT_VARIANT=compact_v1` and `HUMANIZE_EDIT_OBJECTIVE=issue_focused_v1` are experimental, default-off candidates. The 2×2 ablation matrix in `humanizeQualityEvaluation` separates them. Neither passing prompt contracts nor reduced prompt characters establishes quality or cost improvement.

## Rollout prerequisites

1. Create the two additive Firestore `history` indexes in `firestore.indexes.json` (`detectInputHash + createdAt desc`, `calibrationTextHash + createdAt desc`) and wait until ready before serving the new lookup queries.
2. Keep the production history-calibration setting enabled as intended. The admin setting remains authoritative; missing configuration does not imply an enabled policy.
3. For older eligible histories, use the explicit-UID, default-dry-run [backfill tool](detect-history-index-backfill.md). It changes hash fields only, rechecks deletion state and provenance transactionally, and does not turn unsigned/client backups into authoritative history.
4. Ship the paired frontend complete-document/comparison change with the backend. The legacy bounded scan is a compatibility fallback, not proof that every older record is indexed.
5. Leave experimental prompt/edit-objective flags off until preservation, reversed-order naturalness, genre coverage and delivery failures meet independently defined acceptance criteria. Publish calibration-inclusive service changes separately from unadjusted detector experiments.

The offline [corpus registry](engine-corpus-registry.md) records unknown authorship, exact connected families, prior exposure, permissions and external detector provenance. Existing CopyKiller scores are external measurements, not authorship labels. Raw source/output documents and local evaluation runners must remain outside the repository.
