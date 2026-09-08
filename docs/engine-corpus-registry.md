# Existing engine corpus intake and review

The offline tools turn previously audited original/transformed text pairs into a reproducible development corpus. They do not change either engine, train a model, call a provider, or promote a detector. Unknown original authorship stays unknown. A recorded transformation is `humanized_origin_unknown`, never a human negative control or an authenticated AI original.

## Build

Run `node scripts/build-engine-corpus.js /outside/backend/build-config.json` with:

```json
{
  "version": "engine-corpus-build-v1",
  "workspaceRoot": "/workspace",
  "auditDirectory": "/workspace/reports/engine-audit-20260908",
  "outputDirectory": "/workspace/reports/engine-implementation-20260908/corpus",
  "operationalSource": "relative/path/to/operational-export.json",
  "priorManifestPaths": ["/outside/backend/training-manifest.json", "/outside/backend/previous-holdout-manifest.json"],
  "seed": "fixed-before-review",
  "reviewSampleSize": 120,
  "expectedPairs": 4437,
  "expectedExternalLinks": 161
}
```

The audit directory must contain `corpus-pair-occurrences.json`, `copykiller-source-links.json`, `corpus-inventory.json` and `corpus-structured-extraction.json`. Paths are explicit; the builder never searches other user directories. The operational export requires a `rows` array containing `inputText`, `outputText`, and `createdAtMs` for the externally linked cases.

Each occurrence includes a source-relative file, JSON/CSV row locator, registered field pair, and two NFKC hashes. The builder reads the original local file again and verifies both hashes. Unknown field-pair schemas, changed text, malformed locators, escaped paths, stale external timestamps, unknown configuration fields and changed expected totals fail before artifacts are created. Unicode whitespace matches the audit's Python definition, including its preservation of embedded U+FEFF. NFC aliases are retained for compatibility with the existing detection registry.

The CSV reader supports quoted multiline fields and UTF-8/UTF-16 exports. A duplicate header, missing pair field or unterminated quoted cell fails. Additional CSV columns are not assigned new semantic meanings; the requested columns must still match the frozen text hashes. A prior audit entry without supported pair fields or with a parse error has an explicit exclusion record. Such an entry is not silently counted as a verified pair.

File signatures distinguish RTF, HTML, OLE, PDF, ZIP containers and Office temporary lock files. A `.doc` extension is not assumed to mean binary Word. ZIP signatures alone do not establish a valid DOCX/XLSX. This step inventories binary sources; full text still comes from the hash-verified structured source, not a newly implemented PDF/OLE renderer. `~$` Office lock files are excluded with a reason. Inventory-only and extracted-pair coverage are reported separately.

Original and transformed texts share an exact-text connected family. Repeated pairs retain all source occurrences and external measurements. An output reused as another input joins the same family. No semantic, author or template near-duplicate completeness is claimed.

## Outputs and data boundaries

The output directory must be empty and outside both the active Backend checkout and its primary repository. Existing files are never overwritten. Destination checks resolve directory junctions before writing. Raw documents, individual reviews and source locations remain local and outside Git; they must not be committed or uploaded.

| File | Contents |
|---|---|
| `manifest.json` | Sealed metadata for documents, pairs, family links, occurrences and external measurements |
| `texts.local.json` | Original text keyed by document ID; contains user content |
| `exposure-manifest.json` | Existing registry-compatible `records` and their digest |
| `exposure-registry.json` | Existing `detectDatasetRegistry.buildRegistry` output, merged with prior manifests |
| `quality-review-blind.local.json` | Deterministically selected independent families; A/B text without transformation labels or scores; two reviewer slots |
| `quality-review-key.local.json` | Separate coordinator-only A/B identity key |
| `sentence-evidence-review.local.json` | Pending exact-span review across six fidelity and five relation/meaning dimensions |
| `file-intake.local.json` | Actual binary format and exclusion reasons |
| `structured-source-intake.local.json` | Verified-pair versus excluded structured-source coverage |
| `intake-summary.json` | Counts, audit artifact digests, prior manifest digests and zero provider calls |
| `evaluation-dashboard.json` | Measured coverage and unfilled evidence; no invented accuracy |

All imported documents are `development`, `priorExposure: true`, `authorshipGoldEligible: false`. Permissions allow the authorized local review only. `train`, benchmark `evaluate`, `derive` and `externalTransmit` remain false; these do not prohibit the local metadata/quality review performed here. They prohibit treating the legacy material as authorized provider evaluation or training input. No permissions or authorship evidence are invented from a filename, detector score or transformation.

To prevent legacy families from becoming a new holdout, pass `exposure-registry.json` as `registry` to the existing `buildResearchManifest`, or include `exposure-manifest.json` in its `priorManifests`. The adapter preserves both original NFC and corpus NFKC aliases. It deliberately does not pass unknown-author records to `buildManifest`, whose human/AI training contract would require stronger evidence. Existing `assertTrainingRows` and `assertNoTrainingLeakage` remain unchanged.

## External scores

CopyKiller measurements have explicit `metric: "AI작성률"`, original/result AI-writing-rate fields and `plagiarismRate: null`. The join verifies sequence, KST timestamp and matching source file existence. `bodyExactMatchVerified` remains false: matching a PDF's first-page metadata is not a full-body equality check. Repeated tests of an identical pair remain separate evidence records. These values never become authorship labels.

## Evaluate local reviews

Run `node scripts/evaluate-engine-corpus.js manifest.json new-dashboard.json [local-results.json]`. With no results it reports coverage and missing evidence, not successes. `local-results.json` may contain only `scoreRows`, `evidenceReviews`, `qualityReviews`, `textsPath`, and `candidatePath`; file references are relative to the results file. Output must again be external and new.

Each score row has `pairId`, `manifestDigest`, `detectorVersion`, `historyCalibrationApplied` and four finite 0–100 fields:

```text
beforeEngineScore, afterEngineScore, beforeDisplayScore, afterDisplayScore
```

Missing engine values are never reconstructed from display values. The dashboard reports engine and display means/deltas independently, including when required history calibration changes the displayed score. These are paired response changes, not accuracy. Duplicate rows and partial before/after pairs are rejected.

A completed sentence-evidence row has `pairId`, `manifestDigest`, two or more distinct `reviewers` IDs, and exactly these dimensions:

```text
facts, numbers, names, citations, speaker, conclusion,
agent_patient_relation, negation, modality, quantity_range, causality
```

Each dimension has `verdict` (`preserved`, `changed`, `uncertain`), `originalSpan`, `transformedSpan`, and `reviewerVerdicts` containing `{reviewerId, verdict}` for every reviewer. A span is null or `{start, end, quote}` with UTF-16 offsets and an exact contiguous quote in the frozen text. Non-preserved judgments need at least one real span. Disagreeing reviewer verdicts must remain `uncertain`; hiding disagreement is rejected. Complete agreements count as content-evidence adjudication, never authorship gold. A lexical number-token check only nominates review candidates.

A completed quality row has `pairId`, `manifestDigest`, and exactly two `{reviewerId, dimensions}` records. Each reviewer supplies the four existing dimensions `grammar`, `naturalness`, `repetition`, `genreFit`, with `winner: A|B|tie` and exact `quoteA`/`quoteB`. The evaluator reconstructs the frozen A/B order and reuses `humanizeQualityEvaluation.verifyQuality`. It reports agreement and reviewer disagreement separately. Reviewer identifiers assert distinct reviewers; the program cannot independently authenticate the people or certify a blind procedure. Keep the answer key away from reviewers.

`candidatePath` optionally loads a local model artifact with recorded training text hashes, lineage keys or groups. The evaluator calls the existing `assertNoTrainingLeakage` and reports overlaps. Missing lineage metadata is rejected rather than reported as a clean check.

Every dashboard remains `releaseEligible: false`. Actual independent human review, rights/process evidence and a new unexposed core-genre evaluation set are separate work. Creating review forms does not complete those reviews or prove better detection/humanization.

## Verification

Run `node --test test/engine-corpus-registry.test.js test/detect-validation-v3.test.js test/detect-benchmark.test.js` for intake, mutation, path/junction safety, provenance, exposure aliases, separate calibrated/unadjusted score fields, exact evidence and reviewer-disagreement checks. All fixtures are synthetic and contain no operational text.
