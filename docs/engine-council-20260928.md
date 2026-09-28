# Engine council validation — 2026-09-28 (UNRELEASED)

Production baseline: `f1b5b85`. This candidate includes the prior archived v2.5.83 / detector v1.48 work. It is **not cleared for production**. Humanizer and detector must remain a combined release gate.

## Actual review and scope

Codex implemented the changes. Authenticated Claude Code calls to `claude-fable-5-1` and `claude-opus-5-5` completed two review rounds each. Only deidentified synthetic examples and code contracts were shared. First-round CLI capture retained the final continuation; second-round streaming retained complete responses. All usage was counted.

## Implemented

- Source-anchored review obligations survive later empty verdicts and candidate rewriting. Missing, duplicate, ungrounded or overflow reviews cannot grant a pass. Same-anchor reviewer paraphrases share an ID while retaining all prior questions. Explicit false-positive dismissal requires the confirming model.
- Source-only omission grounding is not incorrectly required to occur in the result.
- A source-window restoration cannot erase adjacent source contributions, including short neighboring sentences.
- Lexical coverage uncertainty cannot insert original text into an already occupied candidate gap or tail. This prevented a reproduced duplicate insertion in a stored real response.
- Explicit uncertainty in one member no longer vetoes separately confirmed repair targets. Unexplained global uncertainty and incomplete verdicts remain ineligible. Every proposal still needs fresh semantic validation.
- Mandatory semantic transport is bounded by its caller deadline/parent cancellation rather than an earlier implicit 100-second cutoff. Final audit remains 120 seconds; no extra retry, model change, billing change or new delivery block.
- Old safe-candidate selection cannot resurrect a verdict that never adjudicated a later known error.

## Validation

- Entire backend suite: **2,450 passed; 0 failed; 0 skipped**.
- Production imports: **263 files, 800 edges, 0 violations**.
- Local historical replay: 456 humanization pairs and 274 detections, zero source-offset failures. Changed heuristic outputs are not accuracy labels.
- Long document A (8,689 chars), run 1: 656.130 s; final 3/3 sections complete, needs_review. Seven pre-final restorations did not resolve all meaning/duplicate defects.
- Long document A, run 2 after fixes: 553.974 s; duplicate source insertion zero, final 2/3 sections passed, one 100-second timeout. Kept uncertain, never converted to pass.
- Fresh audit of that unchanged incomplete section with timeout fix: **115.813 s**, completed, three substantive findings. This proves a response can arrive after 100 seconds, not that meaning is fixed. It is not a full pipeline rerun or a production partial-cache implementation.
- Document B: 150.405 s; result generated, final confirming audit was **not sent** because maximum cost reservation exceeded the remaining ceiling. Not a pass.
- Short detection: four previously used synthetic controls × three uncached runs. Strong-signal scores 53–64; weak-signal scores 4–8. Not a new blind set, authorship accuracy estimate, generalization result or live history-calibration audit.

## Budget and release gate

User ceiling KRW 5,000, conservative FX 2,000/USD; total **KRW 4,559.30**, including KRW 1,120.22 reserved for three unknown-usage failures. Claude subscription usage is counted at API-equivalent list cost. Remaining KRW 440.70 is below the next required long-audit reservation. No user credit deductions or production database writes.

Unresolved: temporal/possibility/contrast meaning shifts in long generations, judge misses, document B final confirmation, a full long rerun with the final timeout setting, broader genre validation. No score-distribution boosting was added. Do not describe this candidate as fully fixed or deploy it. Preserve on a tested `archive/wip-*` branch; private source/outputs, budgets, CLI responses and runners remain outside Git.
