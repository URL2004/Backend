# Audit resolution v2.5.83 / detection v1.47

2026-09-28 — **HOLD, not deployed**. Production baseline `f1b5b85` remains unchanged.

## Changes

- Final relation repair preserves independently safe literal restorations and patches remaining exact, grounded windows once. Locations are recomputed after replacement; a fresh final verdict is still mandatory.
- A stale later pass no longer erases unchanged, unique, confirmed prior findings. A current exact pass is not reopened. Nominations cannot grant a pass.
- Interrupted final review retains completed sections and usage instead of leaving the old report in the response. Confirmed current findings constrain fallback selection even if a different section is unfinished. Incomplete reports cannot pass despite contradictory flags.
- High-reasoning `repair` calls share the bounded single-attempt timeout policy. Explicit caller/environment deadlines remain authoritative. Real calls can still exceed this limit; this is not a promise to eliminate provider latency.
- Explicit first-line attribution/separator/title layouts protect sentence-shaped cover titles. An exactly attested organization name split by horizontal whitespace or one line break is not treated as a new fact. No numeric/negation safeguards are weakened.
- Layout line analysis is cached per request with cloned records. Synchronous and asynchronous callers share one generator of layout decisions; production yields between preparation stages and bounded alignment slices. No process-global user-text cache.
- Short detector inputs may invoke the existing secondary review when two independent, moderate/strong recurring content patterns have verified locations covering at least 80% of eligible units. Prompt v9e defines consistent strength/scope bands. Length affects confidence, not an automatic score penalty or boost.
- Earlier candidate changes remain: shared terminal sentence boundaries, specificity false-positive fix, exact ordered-heading review ownership, cancellation/cost preservation, and bounded observation fields.

Models, prices, delivery/billing policy, history calibration, frontend UI and production configuration are unchanged.

## Free validation

- Final complete backend suite including the interrupted-report follow-up: **2,414 passed, zero failures/skips**. Follow-up targeted tests: 29 passed.
- Production import scan: zero violations.
- Private replay: 456 humanizing pairs and 274 detector inputs. Zero invalid source offsets; 20 sentence counts corrected. This is not full manual semantic certification of the entire archive.
- Structure/fact replay: one historical spaced-organization false positive and cover-title role corrected; no increased novelty flags or other role changes in the 456-pair comparison. One generated specificity false positive resolved; five other generated cases unchanged.
- Isolated 10-round, three-job benchmark: paragraph batch p95 173.0ms, event-loop p95 11.5ms; production final-layout wrapper batch p95 155.4ms, loop p95 9.5ms, maximum 15.5ms. Order/content/cancellation checks pass. These are local measurements, not production percentiles.

## Paid validation

The first additional KRW 3,000 approval accounted for KRW 2,234.06: known usage KRW 986.86 plus unknown reservations KRW 1,247.20. The earlier separate KRW 5,000 approval remains unchanged at KRW 4,226.27. Unknown reservations were never released without billing evidence.

The subsequently approved **separate KRW 3,000** run accounted for **KRW 2,441.87**, including known usage **KRW 788.43** and unknown reservations **KRW 1,653.45**. Remaining KRW 558.13 is unused. Planning FX is KRW 2,000/USD; every generation call reserves maximum cost before transmission. No user-credit deductions or Firestore writes.

### Long humanizing

- The latest full 8,689-character run returned in 573.2s, `needs_review`, with seven confirmed relations restored. It did **not** pass final validation: only one of three final sections completed.
- Real high-reasoning repair exceeded 100s. Another optional repair reached its existing recovery deadline. In the private cost guard, waiting for another reservation also consumed a final judge's deadline; the last judge reservation (KRW 812.88) exceeded the remaining KRW 640.96 and was never sent.
- The completed final section identified remaining intensity, modality and connective-scope changes. These must not be dismissed as mere judging noise or hidden behind an earlier pass. Stored corrected outputs from earlier runs do not certify this new generation.
- The second scheduled full document was not started after budget admission failed. Its earlier full run had three real defects, with saved-output local repairs tested separately. It still needs integrated full validation.
- The private evaluation guard now rejects unreservable requests immediately without waiting inside the engine's timer or aborting another admitted request. Mock concurrency tests pass. This is evaluation infrastructure, not a production engine change; the old results are preserved and not relabeled.

### Short detector inputs

Frozen v9e candidate, no cache, three repetitions per constructed STYLE control:

| Control pair | Repeated abstract/pattern-heavy prose | Concrete/progressive prose |
|---|---|---|
| Business, two sentences | 64 / 64 / 54 | 8 / 7 / 5 |
| Letter, three sentences | 67 / 70 / 68 | 0 / 4 / 4 |
| Debate, three sentences | 82 / 82 / 61 | 7 / 8 / 4 |

These new-topic controls were fixed before their first call. They show separation without raising ordinary genre conventions, not authorship accuracy or broad generalization. Variation remains (including 21 points on one strong control). Earlier controls scored 53/62/54 versus 4/4/5 and 8/0/7; an older development input varied 54/35/53. Do not claim universal short-input stability.

## Production observations and remaining gate

Read-only snapshot at 2026-09-28 11:27 KST, 6.17h after the **prior production** deployment: first six hours had 37 humanizing records, 21 detector records, six review records and zero recorded structure-fail flags. Health was 200 ready, authenticated internal health showed zero active/queued jobs. One referral failure and one client payment error were recorded; no outage-free guarantee is inferred. 24h/72h checkpoints are not yet due and no scheduler was registered.

Deployment remains blocked by the failed/incomplete long-form gate, not by local tests or Git permissions. The interrupted-final-report follow-up needs integrated real validation; independent short-style/genre generalization and actual provider latency remain limitations. Do not change scores, models, price, validation standards or production to force a pass.

OpenAI Docs informed the separation of task-specific controls, replay, fresh generation and uncertainty. [Evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices) and [input-token counting](https://developers.openai.com/api/docs/guides/token-counting) were consulted. Provider token pre-counting was researched but **not introduced** into the cost guard; conservative byte-based admission remains in force.

All raw texts, responses, private runners, cost ledgers and user identifiers stay outside Git. Preserve this tested unfinished candidate on an archive branch; do not merge it to production.
