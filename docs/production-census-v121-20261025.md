# Production census follow-up — 2026-10-25

Baseline: production f9d2e97, humanizer v2.5.120 / detector v1.60. Scope ends at 2026-10-25 03:17:54 KST: 405 retained humanizing results and 239 retained detection results. Three additional completed log records belong to subsequently deleted accounts. No deleted content was restored. Private corpus, signatures, replay output and identifiers stay outside Git.

## Changes

- Include judge-confirmed `added_claim` relations in the existing bounded restoration and final delivery gate. Exact source/output grounding, ownership, current validation receipts and fresh whole-candidate verification remain mandatory.
- Allow an unchanged inline label, and a repeated answer label only under its identical unique question/heading, to survive whitespace-only sentence-tokenizer differences. Do not copy labels, change sections or loosen ambiguous ownership.
- A fresh digest-bound successful escalation supersedes an earlier rejected proposal. Preserve the prior rejection reasons, primary verdict and all recorded cost. Incomplete, uncertain, stale or rejected confirmations cannot clear failure.
- Recognize balanced prose parentheses split by extraction without changing characters or values. Protect right-hand quote glyphs used as an opening pair in spacing repair and issue detection. Keep repairs idempotent.
- Add `exact_linewrapped` for a complete server-signed humanizing result with repeated internal PDF wraps. All normalized characters must match. Existing word boundaries cannot be removed; inserted boundaries must contain one or two line breaks, between letters, at least three times. No word edits, horizontal-space insertion, numeric splits, unsigned history or excerpts. No source-score cap for this new match. Factor, maximum reduction, floor and history limit remain unchanged.
- Release identifiers: humanizer v2.5.121, detector v1.61, history calibration v8. The detector's model prompts and raw score arithmetic are unchanged.

## Evidence and limits

644 completion histories matched their credit ledger. Detection location audits found no offset errors in 8,694 saved sentence ranges or 2,392 evidence locations; the rebuilt input documents cover 9,087 spans. All 36 stored calibration receipts passed owner, signature, content and arithmetic checks. One additional full-result recheck had only repeated inserted PDF wraps; its current server signature and proposed matching were separately verified offline.

The new preflight changes one of 405 saved inputs, preserving its non-whitespace characters and numeric tokens. The historical broken output is not thereby repaired. Local restoration proposals still need a fresh semantic verdict before delivery. Unit tests exercise successful/failed confirmation, unsigned and cross-user matches, word edits, paragraph boundaries, quote protection and source-preserving refusal cases. No live customer history, credit entry or result was rewritten for this audit.

Execution p50 79.1 s, p95 433.1 s, maximum 930.0 s; queue p95 279.4 s, maximum 403.6 s. A 41.5-minute lifecycle includes a 36.95-minute user approval wait. Semantic calls account for most recorded API cost. No production concurrency, budget or verification limit is raised; before/after latency or cost improvement percentages require post-release observations.

Saved warnings are not equivalent to confirmed meaning defects. Automated structural replay depends on reconstructed source planning and does not replace the historical approved layout contract. Model judgment uncertainty and corpus-wide semantic correctness are not claimed resolved.
