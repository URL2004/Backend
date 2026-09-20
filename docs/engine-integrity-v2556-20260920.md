# Humanization v2.5.56 / detection v1.36

Production baseline: e8120d1. Builds on the previously unshipped fccdb10 whitespace-policy fixes.

## Root-cause changes

- Structure classifier recognizes reported-speech continuations and explicit numbered bracket headings with presentational copulas. A finite sentence's continuation is no longer frozen as a heading.
- Preflight and document profiling share conservative stanza/refrain evidence, including punctuated verse. Ordinary numbered reports and attributed quotations are not covered by this rule.
- Quote spacing distinguishes contracted copulas from independent demonstrative sentence starts. Addition/removal rules share the exception to avoid undoing each other.
- Paragraph layout repairs dangling enumerated topic leads and explicit activity continuations at every eligible prose boundary; it only moves whitespace. Short documents no longer skip this repair because the broader semantic-layout length gate was not met.
- Existing semantic-relation audit adds difficulty/impossibility, explicit current responsibility/past responsibility, and reflective emotion loss. Existing repair/validation and delivery policy remain in charge.
- Newly merged long sentences are audited from two aligned source sentences, rather than requiring three original sentences and three conjunctions simultaneously.
- Protected-aware spelling rules cover dependent-noun spacing and an unambiguous technical spelling error. Ambiguous words are not globally substituted.
- Detection retains authored reflective report prose inside document-wide Markdown presentation wrappers. Conservative numbered-section/experience evidence and attribution exclusions distinguish it from ordinary external quotations. Source offsets are retained.
- Detector version and input-policy/cache version change. Statistical thresholds, model choice, prices, billing, and blocking policy do not change.

## Validation

- Full test suite: 1,659 passed, zero failures/skips. Production import graph: 223 files, 658 edges, zero forbidden imports. Diff whitespace check passed.
- Local deterministic replay: 407 historical humanization pairs, 330 detection records. No preflight non-whitespace content changes, formatting fixed-point failures, or detection source-offset mismatches.
- Paid follow-up: 3 humanizations and 8 detections, without customer billing. Runtime model configuration matches production; these are direct engine tests with route-equivalent genre information, not authenticated billing/cache/history E2E.
- Broken clause now remains one sentence; punctuated poem preserves its 28 nonempty lines. A variant enumerated lead found during replay was then covered by deterministic regression and final-output replay.
- The wrapped-report detector sample previously exposed only the headings as eligible text; after repair its prose participates in scoring. Its observed score changed from 0 to 28. This is not a ground-truth accuracy result, and score fluctuation in other samples is not attributed to the patch.
- All related paid runs total USD 1.913876 in usage estimates, approximately KRW 3,828 at the conservative budget allowance of KRW 2,000/USD. Unknown cost: zero. This is not an invoice/spot exchange rate.

## Limits and release policy

The 407-pair set has only 82 full direct reviews. It must not be described as a completed human/manual semantic audit. Model grading is not human judgment. This release fixes reproduced common paths; it cannot guarantee no future semantic drift. Context-dependent collocations, conditional nuance, ambiguous original spelling, and labelled-authorship detector accuracy remain evaluation work. No artificial probability uplift is introduced.

Deploy a clean tested commit only with active/queued/auxiliary jobs and pending admissions at zero. Roll back to the prior live deployment if new structural damage or a runtime failure is observed. No feature-flag or billing changes are required.
