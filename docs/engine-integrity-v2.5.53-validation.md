# v2.5.53 / detector v1.34 — validation and release acceptance

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

- Backend: 1,619 tests passed, zero failures (including seven confirmed-relation regressions).
- Frontend: 311 passed, one conditional skip, zero failures; external production build succeeded.
- Production import graph: 219 files / 645 edges, no forbidden imports.
- Historical local replay: 215 humanization pairs, zero non-whitespace changes or final-layout idempotence failures; 151 detector inputs, zero offset failures, 14 changed sentence counts. This is deterministic replay, not regeneration or accuracy ground truth.
- 20 paragraphs / 120 sentences, 30 iterations: alignment p95 34.69 ms; maximum event-loop delay 47.64 ms. Previous final-stage run: 33.71 / 46.24 ms. Three concurrent requests preserve content/order and cancel one correctly. These are local measurements, not production percentiles.
- Real API comparison: 12 humanization inputs (6 basic / 4 advanced / 2 polish), 8 detection variants, baseline and candidate; additional targeted reruns and one synthetic paired long audit.
- 488 physical HTTP attempts. Known estimated cost USD 2.260448; unknown held USD 0.09826425. At budget assumption KRW 1,400/USD, total about KRW 3,303 including unknown, or KRW 3,963 with 20% FX increase. No user credits deducted. Actual invoicing/tax is not established by this estimate.
- 56 recorded case rows are not 56 unique documents: 40 planned comparisons, 13 extra checks, three superseded/runner-error records. Mid-run module cache mixing was resolved by a fresh process; the failed attempt made no paid call. Failures remain in private records.
- Later failure-completion/deadline inheritance/state-bound changes were tested with deterministic error mocks. Do not describe every live comparison as the identical final artifact.

## Follow-up real-document acceptance (2026-09-16)

The initial hold below was resolved with a bounded, judge-confirmed relation repair. Unique grounded distortions are aligned mutually to an unambiguous source sentence; only that sentence can be restored. Ambiguous merges, quoted/code content and missing heading prefixes are not guessed. Independent semantic re-verification must pass before adoption; judge-only final audits never edit. Failed rechecks retain the preceding candidate and their costs. Delivery/billing rules are unchanged.

- Causal strength: the long-document replay restored three source assertions, then passed re-verification (117.71 s, USD 0.118600 for the audit/repair replay, not full regeneration).
- Comparison versus negation: a first repeat missed the already observed error. The judge now explicitly distinguishes preference from exclusion; a fresh run restored the original comparison and passed (67.14 s, USD 0.053977). We checked the actual sentence, not just a pass flag.
- Advanced recipient/actor case: the repaired output retains the original receiving action and passed (35.095 s, USD 0.021817).
- Specialist terms: claim-local substitution candidates prevent another paragraph's term from legitimizing a concept change. The polish replay restored the original term while retaining the separately used other term (20.993 s, USD 0.015482). This is not a global terminology autocorrect.
- Total so far: 507 physical attempts, USD 2.473161 known + USD 0.09826425 unknown held; KRW 3,600 at the budget FX, KRW 4,320 with 20% FX increase. No user credits charged. The 61 rows include retries and repair-stage replays, not 61 unique full-document generations.

The real-document release hold is lifted for the core fixes; commit, current-live checks and deployment smoke remain required. Short-chunk batching remains OFF. Historical text is not committed. These repair-stage replays do not establish population-level accuracy or whole-job latency improvements.

## Initial hold record / remaining limitations

Targeted reruns preserved eleven nominal report items and an omitted explanation, restored a truncated conclusion, separated form headings, and retained the original recipient/actor relationship in basic mode.

However, two long documents still change causal strength or replace a comparison with categorical negation. They are reported as needs_review, not repaired successfully. An advanced-mode recipient/actor rerun and a specialist-term judgment remain outstanding. Whole-job latency did not improve consistently; one final long-document run was 447.6 seconds vs 345.5 baseline. Small comparisons and sequential warm caches do not establish production cost or latency gains.

The above was the initial hold decision, superseded for the core fixes by the follow-up acceptance section. Batching activation remains held. Do not hide warnings, relax validation, or add blocking to manufacture a passing result. No production smoke, rollback or 1/6/24/72-hour monitoring has been claimed as completed in this pre-deployment record.

After acceptance: refetch live, verify clean tested commits and private-data exclusion, check health and activeJobs=0, deploy backend then frontend, initially keep batching OFF. Restore the previous live version on new meaning/structure damage or unverified output presented as normal.

The repository harness prohibits partial task commits. Coupled backend changes are committed together, with the frontend in its own repository; the five logical work groups are tracked above. Raw input, output, UID, credentials, paid runners and private evaluation artifacts are excluded from Git.
