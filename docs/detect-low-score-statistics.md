# Low-score statistical support (detector v1.29)

The optional independent path addresses some low LLM scores on Korean explanatory prose. It uses the existing `korean-style-statistics-v1` weights. It is not a new authorship model, probability calibration, or a uniform score increase.

## Release controls and scope

Both `DETECT_STATISTICAL_ASSIST_ENABLED=1` and `DETECT_INDEPENDENT_STATISTICS_ENABLED=1` are required. The independent flag defaults off. Disable the second flag to retain the previous evidence-backed assistance. Cache variants include this flag and the statistical policy version, so a new request does not reuse an incompatible cached score. Completed request-ID replay remains unchanged.

The existing assistance remains available for 21–49 scores with located recurring model evidence. The additional path covers 0–49 scores only when all of these hold:

- Korean is at least half the letters, input is 500–2,600 characters, and the server profile is general, report assignment, or long explainer.
- There are at least four source sentences and model confidence is not low.
- The input has no detected block quote, table, code fence, reference section, or long double-quoted passage. These checks are conservative exclusions, not a complete document parser.
- At least 100 trained features match, and the statistical margin above the existing classifier boundary is at least 0.05.

The existing bounded statistical score mapping is retained, with a maximum of 74. Scores already at least 50 are unchanged. No extra model request, charge, retry, or refund policy is introduced. Failed or unavailable optional statistics preserve the completed LLM result.

## Evidence and presentation

Keep model raw score, cause-aligned score, statistical support, and final display score separate internally. Independent support carries `basis: independent_statistics`; it must not create model cause categories or sentence highlights. The report explains that statistical signals contribute while sentence-level explanations can remain partial. No history-correction badge or before/after correction values are added.

Historical `statistical-assist-v1` metadata remains readable. Current support uses `statistical-assist-v2`. Prompt, model selection, history calibration and humanization behavior are unchanged.

## Evaluation, 2026-09-06

The baseline was production commit `8408889`. Result caches and humanization-history adjustments were excluded from evaluation.

Two candidates were rejected: the prompt-only candidate reduced development AI recall; a selective Terra recheck improved development recall by 10 percentage points but showed no recall improvement on its held-out set. The rejected recheck was removed from the implementation.

The independent-statistics candidate was frozen on development data. Development results at threshold 50: human false positives 2/40 → 2/40; AI detection 8/40 → 14/40.

A new validation set excluded previously used document/title/hash groups: 30 KLUE-MRC prose references and 20 NSMC reviews, plus 50 independently generated Luna/Terra texts matched to the reference lengths within 15%. The generation subjects did not use reference passages as rewrite prompts. Length repair preceded scoring. These references are source-backed human controls, not individually verified writing histories; exact/title grouping does not guarantee absence of semantic overlap.

| Threshold 50 | Baseline | Candidate |
|---|---:|---:|
| Human false positives | 3/50 (6%) | 3/50 (6%) |
| AI detection | 23/50 (46%) | 27/50 (54%) |
| AI explanatory prose | 23/30 | 27/30 |
| AI short reviews | 0/20 | 0/20 |

The point criteria (no observed FPR increase and recall gain at least 5 percentage points) passed. Only four AI cases changed: 8→54, 12→52, 19→56, 12→55. Production implementation replay reproduced all 100 predictions. Its additional multiline-quotation exclusion did not change these predictions.

The sample is small. Four paired gains and zero losses give an exact two-sided McNemar p-value of 0.125; this is not statistical proof of a population-wide improvement. The 60-point positive count did not improve. Very short AI reviews and the user-reported experiment write-up remain unresolved. Generalization to student assignments, applications, mixed writing, other languages and other generators is not established.

Source and evaluation references: [KLUE](https://github.com/KLUE-benchmark/KLUE), [NSMC](https://github.com/e9t/nsmc), [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices). Raw text, generated samples, per-case outputs and local API runners are deliberately excluded from this repository.
