# v2.5.53 / detector v1.34 — validation and release hold

Date: 2026-09-16 KST. Baseline: `dc3ae90` (engine v2.5.52, detector v1.33).
Frontend baseline: `7b29fc8`. Production has NOT been changed.

## Implemented

1. Shared offset-preserving sentence, quote, initials and code parsing; detector input policy/cache version bump.
2. Paragraph ownership fast path, request-local feature/result caches, bounded asynchronous alignment (50,000 states / 2 seconds). Joint source/output semantic boundaries based on shared headings and monotonic anchors; uncertain alignment is judge-only.
3. Absolute job deadlines through nested calls, optional recovery vs mandatory final-verdict budgets, final formatting before verification, explicit incomplete-audit state and verified candidate fallback. Per-HTTP cost reservation and request-scoped call ledger include failures and discarded candidates.
4. Short independent chunk batching (up to four, each under 400 characters, sum at most 1,600), ID validation, item-only fallback, shared provider concurrency two. Default OFF; not approved for production activation.
5. Optional aggregate telemetry and draft administrator patch notes. Models, prices, delivery/billing policy, public UI and historical records unchanged.

Additional reproduction fixes preserve complete nominal report items, reject false headings inside verbs, retain form heading/label ownership, and route recipient/actor changes to the existing meaning audit. No new quality blocking or waivers.

## Checks

- Backend: 1,612 tests passed, zero failures.
- Frontend: 311 passed, one conditional skip, zero failures; external production build succeeded.
- Production import graph: 218 files / 640 edges, no forbidden imports.
- Historical local replay: 215 humanization pairs, zero non-whitespace changes or final-layout idempotence failures; 151 detector inputs, zero offset failures, 14 changed sentence counts. This is deterministic replay, not regeneration or accuracy ground truth.
- 20 paragraphs / 120 sentences, 30 iterations: alignment p95 34.69 ms; maximum event-loop delay 47.64 ms. Previous final-stage run: 33.71 / 46.24 ms. Three concurrent requests preserve content/order and cancel one correctly. These are local measurements, not production percentiles.
- Real API comparison: 12 humanization inputs (6 basic / 4 advanced / 2 polish), 8 detection variants, baseline and candidate; additional targeted reruns and one synthetic paired long audit.
- 488 physical HTTP attempts. Known estimated cost USD 2.260448; unknown held USD 0.09826425. At budget assumption KRW 1,400/USD, total about KRW 3,303 including unknown, or KRW 3,963 with 20% FX increase. No user credits deducted. Actual invoicing/tax is not established by this estimate.
- 56 recorded case rows are not 56 unique documents: 40 planned comparisons, 13 extra checks, three superseded/runner-error records. Mid-run module cache mixing was resolved by a fresh process; the failed attempt made no paid call. Failures remain in private records.
- Later failure-completion/deadline inheritance/state-bound changes were tested with deterministic error mocks. Do not describe every live comparison as the identical final artifact.

## Release hold / remaining limitations

Targeted reruns preserved eleven nominal report items and an omitted explanation, restored a truncated conclusion, separated form headings, and retained the original recipient/actor relationship in basic mode.

However, two long documents still change causal strength or replace a comparison with categorical negation. They are reported as needs_review, not repaired successfully. An advanced-mode recipient/actor rerun and a specialist-term judgment remain outstanding. Whole-job latency did not improve consistently; one final long-document run was 447.6 seconds vs 345.5 baseline. Small comparisons and sequential warm caches do not establish production cost or latency gains.

Accordingly production deployment and batching activation are held. Do not hide warnings, relax validation, or add blocking to manufacture a passing result. Revalidate the remaining cases before release. No production smoke, rollback or 1/6/24/72-hour monitoring has been claimed as completed.

After acceptance: refetch live, verify clean tested commits and private-data exclusion, check health and activeJobs=0, deploy backend then frontend, initially keep batching OFF. Restore the previous live version on new meaning/structure damage or unverified output presented as normal.

The repository harness prohibits partial task commits. Coupled backend changes are committed together, with the frontend in its own repository; the five logical work groups are tracked above. Raw input, output, UID, credentials, paid runners and private evaluation artifacts are excluded from Git.
