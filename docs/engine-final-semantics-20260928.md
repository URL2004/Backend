# Engine integrity candidate — 2026-09-28

Status: **NOT RELEASED; paid end-to-end qualification incomplete.**

Base: production `f1b5b85`, prior tested candidate `70aceed`.
Candidate versions: humanizer `gpt-prod-v2.5.84`, detector `v1.49`, detection input policy `v11-quoted-owner`.
Models, user prices, credit deductions and delivery policy are unchanged. No score inflation was introduced.

## Implemented in this candidate

| Cause | Change | Verification boundary |
|---|---|---|
| A question inside quotation marks was detached from its thought/utterance predicate | Shared sentence analyzer preserves the quoted owner relationship and source offsets | Synthetic quote styles, independent quotations and blank-line guards; full suite |
| Small time, sole-cause, onset/intensity and connective changes disappeared inside empty semantic verdicts | Explicit paired operator questions in the existing semantic call, with IDs, unique current quotes and required dispositions | Five changed controls rejected; four of five proposed equivalent controls passed; one disputed case remains |
| The first 12 generic candidates concealed later operator candidates | Internal review retrieves all candidates; unreviewed overflow remains unconfirmed, never pass | Overflow, wrong/duplicate ID and invalid evidence regressions |
| Long primary semantic JSON exhausted a shared 6k reasoning/output envelope | Reserve 6k–10k based on selected explicit questions and prior obligations; confirming envelope remains 10k | The previously truncated pair completed in a fresh review, but that single run does not prove completion probability or latency |
| One unfinished document section discarded completed sections' valid repair evidence | Nominate only complete, non-uncertain child findings with exact unique current windows | Incomplete parents and unfinished child responses remain ineligible; proposal always needs a fresh whole-document verdict |
| Generation and local repair did not share short-qualifier constraints | Common preservation contract used in both stages | Regression suite; complete regeneration still has residual meaning changes |

No heuristic is treated as a semantic verdict. No unfinished validation is relabelled as normal. No extra review-only call was added by the operator contract.

## Tests

- Backend: **2,465 passed / 0 failed / 0 skipped**.
- Production import graph: 265 files, 804 edges, no forbidden imports.
- Private history replay: 456 humanizer records and 274 detector records, no source-offset failures. Changes to 23 sentence boundaries and 105 candidate sets are not confirmed quality improvements or accuracy statistics.
- Synthetic 120-sentence candidate calculation: 10 runs, maximum 116.2 ms. This is not production p95 or an event-loop latency result.
- Actual complete regeneration: two private documents, followed by full direct source/result reading. Neither is qualified as an end-to-end pass.
- Larger document: 3 final sections, 2 completed within the 120s deadline. Real scope/causality/omission issues remain. Later partial-repair selection is tested locally but has not completed a new whole generation + final audit.
- Smaller document: generation and local repair completed; final audit first failed cost admission, then a separate standard-tier audit timed out at 120s. Prior saved output passing a fresh review is a different result and does not qualify the latest output.
- A restored source sentence can reintroduce inherited PDF word-spacing defects. This remains a quality limitation, not a newly solved issue.

## Short detector controls

Six newly written synthetic style controls, twice each, cache bypassed:

| Style pair | Strong-signal scores | Concrete/weak-signal scores |
|---|---|---|
| Reflection | 28, 27 | 8, 5 |
| Report | 63, 54 | 7, 7 |
| Application | 34, 52 | 8, 3 |

All paired strong signals scored higher, but the application varied by 18 points and some strong-signal samples stayed below 50. This is not authorship ground truth, blind certification or population accuracy. No arbitrary minimum score was added.

## Spend control

This turn's independent approval: KRW3,000, planning FX KRW2,000/USD.
Before every HTTP attempt reserve model input, maximum output and processing-tier cost. Failed/unknown usage retains its reservation; retries are not free.

Final conservative total: **KRW2,822.90584**, comprising usage-priced KRW1,913.00784 and unknown reserves KRW909.898 (4 attempts). 62 paid HTTP attempts; none active. Remaining KRW177.09416 cannot reserve another required full audit. Ledger closed. These are conservative estimates, not invoice totals.

OpenAI Docs informed the last test-only explicit `service_tier: default` setting, without changing model, reasoning or output limits. The request timed out, so actual tier and token usage are unknown; full reservation is retained. Earlier reservations were not discounted. Reference: https://developers.openai.com/api/reference/cli/resources/responses/methods/create

## Release gate / remaining work

1. Resolve remaining relation changes in the larger full regeneration without reverting valid improvements.
2. Qualify complete final semantic validation under the existing deadline; do not relax the verdict to fit time.
3. Link meaning restoration to verified formatting so inherited word-spacing damage is not reintroduced.
4. Investigate short-input repeat variation on independent genre controls; do not force an artificial score distribution.
5. Re-run the latest integrated full pipeline before combined humanizer/detector release. No production rollout, configuration writes or user-credit charging occurred in this round; post-release observation has not started.

Unfinished tested code is archived and pushed according to AGENTS.md. Private source text, identifiers, model responses, cost ledger and local API runners remain outside Git.
