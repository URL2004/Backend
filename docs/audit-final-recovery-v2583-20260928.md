# Remaining integrity recovery — 2026-09-28

Status: **HOLD, not a production release**. Base `f1b5b85`.
Candidate humanizer v2.5.83, detector v1.48 / prompt v9f.
No production writes, customer-credit deductions, price/model/reasoning changes.

## Root fixes

- Include judge-confirmed intensity amplification in bounded restoration nominations.
- Prefer uniquely grounded operator repairs (degree, ability, purpose and displaced connective ownership), retaining fresh semantic validation and existing cost/time limits.
- Remove obsolete source/output evidence hints before reviewing the current revision, without clearing official failed verdicts.
- Restrict connective nominations to ownership/class changes instead of ordinary synonyms or omissions.
- Prevent whole-window source copying from erasing adjacent source claims legitimately merged into a candidate sentence. Ambiguity uses the existing model patch and re-audit.
- Permit first-body-sentence restoration after an identical, unique, unchanged leading structural label. Changed/repeated labels, mid-sentence boundaries and intervening structural blocks remain excluded.
- Distinguish repeated grammatical endings from content-bearing evaluative templates in the detector. No score boost, floor, taxonomy double-count or history-calibration change. Versioned cache identity uses the new detector/prompt versions.

## Verification

- Full suite with test concurrency 2: 2,430 pass, 0 fail/skip; no timing threshold relaxed.
- Final ordinary `npm test` repeat: also 2,430/2,430 pass, 0 fail/skip, 83.6 seconds. Final production import graph: 262 files, 793 edges, no violations.
- One default concurrent run: 2,429 pass and one 500ms performance assertion failed under host contention. Isolated 3-job/120-sentence benchmark passed: paragraph batch p95 236.2ms / event-loop max 33.4ms; final-layout batch p95 125.6ms / loop max 15.5ms. These are synthetic local measurements, not production latency.
- Offline replay: 456 humanizing pairs and 274 detection records; zero sentence-offset failures. This is not full manual quality certification or authorship accuracy evaluation.
- Paid test management total: KRW 2,644.11064 / 3,000, including KRW 51.049 unknown-usage reservation. No pending requests; no old-budget transfer or unknown-reservation release. Planning FX 2,000 KRW/USD, not invoiced KRW.
- Three full humanizer generations: two longer-document failures; the shorter generation initially passed its API judge but manual comparison and a separate whole-document confirmation found remaining intensity/modality changes.
- Targeted merged-claim restoration: destructive adjacent deletion no longer reproduced; unrelated semantic findings remained. Stored final findings can be locally repaired, but this is not a fresh whole-engine pass.
- Detector development controls, six short texts × three repeats per version: taxonomy clarification removed the observed 24–59 oscillation on two strong-style controls; new scores 52–63 for three strong-pattern texts and 0–8 for three concrete/procedural texts.
- Four additional controls × three repeats after prompt freeze: strong patterns 55–61; concrete/procedural 4–8. Synthetic style controls, not authorship labels or a population accuracy metric.
- A repaired stored-document confirmation was **not sent**: KRW 492.63 maximum reservation exceeded the then-remaining KRW 425.07. Do not describe it as passed.

## Release blockers

The latest integrated humanizer has not passed fresh full-document generation plus final review. First-sentence ownership and cascading-restoration fixes were added after the last full generation. Review-model omissions/false positives and the final revalidation time envelope still require verification. Broader genre generalization and 50k-character profile-classification latency also remain open.

Keep combined deployment held, as requested. Do not promote detector-only results into a combined release. No 1/6/24/72-hour post-deployment observation has been completed for this candidate because it has not been deployed. Raw source/output, identities, model responses, cost ledgers and local runners are intentionally outside Git.

Private evidence index (workspace-only): `reports/audit-final-recovery-20260928/검증결과-20260928.md`.
