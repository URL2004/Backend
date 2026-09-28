# Audit completion candidate v2.5.83 / detector v1.47

Status: **HOLD — not deployed** (2026-09-28). Baseline: f1b5b85, engine v2.5.82 / detector v1.46.

## Implementation

- Let a confirmed failure on the current final candidate enter a grounded, integrity-checked local restoration. Do not rejudge unchanged failures for a different answer. Revalidate edited text and preserve failure/uncertainty.
- Preserve completed section usage, interrupted review costs, and completion counts on cancellation. Unfinished sections cannot pass. Only bounded numeric progress is newly archived, not submitted text.
- Nominate newly introduced contrast and lost comparison qualifications for semantic review; nominations are not verdicts.
- Avoid treating constrained productive relative clauses before classifier nouns as introduced proper names. Quoted titles and actual introduced targets still require support.
- For documents above 6,000 characters, allow earlier joint review segmentation only at complete, unique, ordered, exact section labels. Circled standalone labels keep their global list role but can authorize section ownership when followed by prose. Ambiguous/missing/duplicate labels retain whole-document review.
- Preserve final-audit control signals across every section.
- Give high-reasoning escalated generation one bounded default 100-second timeout attempt instead of two 60-second attempts. Explicit timeout configuration and caller deadlines remain authoritative. Other retry classes and model choices remain unchanged.
- Recognize explicit Korean finite endings followed by a period without a space. Preserve source offsets and decimal, initial, quotation and code boundaries. Input analysis version advances to v10-terminal-spacing.
- Explain in detector prompting that sample length constrains confidence, not the style score. Permit evidence review for 2–7 units only with two distinct, strong, recurring/pervasive content categories grounded across at least 80% of eligible units. No score boost or floor is introduced. History correction, prices, billing, delivery and UI remain unchanged.

## Evidence and limits

- Final complete backend suite: 2,390 passed, zero failed/skipped. Production import graph: zero violations. A timing-sensitive cancellation fixture was replaced with an explicit two-worker barrier before this final run.
- Synthetic and mocked tests cover cancellation, cost retention, final failed-candidate restoration, section ownership, privacy projection, and sentence boundaries.
- Private replay: 456 historical humanizing pairs plus 274 detector inputs. Specificity results on original pairs unchanged; one previously regenerated false positive resolves without changes to five other regenerated results. Source-offset checks pass; sentence counts change on 20 records. This is not full semantic certification of all documents.
- Real evaluation: two humanizing runs attempted. One completed with three residual semantic errors; one ended after transport timeouts and budget admission denial. Neither certifies the latest integrated long-form candidate. The section/timeout follow-up has only local/mock validation.
- Detection: 48 uncached evaluations, including six length-controlled inputs and six recent inputs, baseline once and candidate three times each. The controlled inputs are two correlated document families, not six independent authorship examples. Strong four/eight-sentence signals separate from concrete, uneven controls. A two-sentence input varies from 23 to 53, and two recent examples also vary materially. Short-input stability is **not solved**. No accuracy claim is made on unknown-authorship user records.
- New short evidence-tension routing is covered synthetically; the real two-sentence escalation used the existing cause-mismatch route, not the new trigger.
- Approved paid cap KRW 5,000; accounted KRW 4,226.27 (known usage KRW 724.30, conservative unknown reservations KRW 3,501.97). No user-credit deductions or Firestore writes. Do not release unknown reservations without billing evidence. Remaining KRW 773.73 cannot reserve another full long-form validation.
- Local isolated benchmark, ten rounds: three-job paragraph batch p95 262.4 ms versus baseline 343.1 ms; event-loop p95 84.0 ms versus baseline 113.2 ms. Order, content and queued cancellation pass. These are local samples, not production percentiles or proven performance improvement; the prior 50 ms event-loop target is still unmet.

## Deployment gate

Do not publish this candidate as a completed production patch. Require full long-form regeneration and final validation with the integrated section/timeout changes, resolution of remaining relation errors without weakening safety, and independent short-style/genre repeat tests. Current production must be rechecked before any merge/deploy. Keep private inputs, responses, runners, IDs and cost ledgers outside Git.

The previous production deployment's first-hour snapshot was checked; later 6/24/72-hour windows are not yet complete. No scheduled monitoring task was registered. A private read-only aggregate collector is available; it must be run again at the actual checkpoint times.
