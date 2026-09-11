# NIKL writing corpus intake and local diagnostics

These offline tools preserve raw writing, scoring annotations and instruction examples as different data roles. They import no provider or database and are not referenced by `server.js`. They do not tune a detector, train a model, replace the production corpus statistics, or authorize publication.

## Build

Run `python scripts/build-nikl-writing-corpus.py /private/build-config.local.json`. Python 3.10+ standard library and the existing Node 24 project runtime suffice. Keep the config and all input/output artifacts outside Git repositories.

The config has version `nikl-writing-intake-v1`, a fixed `seed`, an **absent** `outputDirectory`, and `approval` with `institution`, `documentNumber`, ISO `validFrom`/`validThrough`, and `localEvaluationAuthorized: true`. The validity check uses Korean local time. Record external publication permission separately; local authorization does not establish it.

`archives` must contain exactly one of each kind:

| kind | data role |
|---|---|
| `raw2023`, `raw2024` | Source essays |
| `score2023_1`, `score2023_2`, `score2024` | Essays with rater annotations |
| `instruction2024` | Inputs, model tasks, expert comments and reference norms |

Each archive entry specifies `kind`, `corpusId`, an explicit `path`, expected file `sha256` and `expectedDocuments`. Counts must come from the received edition. `priorManifests` is a list of explicit `{path, sha256}` objects containing the previous `records` arrays. `developmentDocumentIds` lists source IDs already inspected as examples. No file discovery is performed by this builder.

All six archive hashes, CRCs, JSON files, required fields and expected counts are validated before output is created. Duplicate JSON keys, nonfinite JSON values, duplicate record IDs, duplicate ZIP entries, unsafe ZIP paths, encryption, excessive expanded sizes, changed input files and unknown top-level config fields fail closed. ZIP content is read in memory from the hashed bytes; no archive paths are extracted. A hash-verified copy of each ZIP is preserved.

Destinations are resolved through symlinks/junctions and must be outside any `.git` ancestor. Builds use a temporary sibling directory and rename after completion. Existing destinations are never overwritten. A failed build can leave a `.pending-*` directory for diagnosis; do not consume it as a completed corpus.

## Data roles and lineage

All records retain unknown writing process and `authorshipGoldEligible: false`. The code does not infer AI-free writing from student authorship. Training and external transmission permissions stay false; only the specifically authorized local evaluation is enabled.

Source header fields and every original document field are preserved in `documents.local.jsonl`, including all rater roles, re-evaluations, absent total-score fields, `original_form`, `form`, `edited`, model `task1`–`task3`, `expert_comment` and `reference_norm`. Input text for instruction diagnostics comes from the supplied `instruction.input_data`. Expert comments can contain explanations rather than a rewritten passage and are never guessed to be gold output text. Unexpected multiple input/output/instruction objects require review instead of silently choosing the first.

Raw/score candidates join by author plus normalized prompt. Differences in essay body remain separate text records and receive a review issue. Instruction source document references are linked while conflicts with stated authors, missing IDs and inferred fallback parents are reported. Exact NFKC text and author connections propagate transitively through the whole family. Conflicting families remain development-only and are excluded from diagnostics.

The seeded partition is 60% development, 20% validation and 20% holdout **candidates**, before forcing prior exposure, known examples and review families into development. Related records cannot cross splits. These percentages are family hash partitions, not guaranteed document quotas. This is an author/family split; prompts can occur on both sides. A separate unseen-prompt evaluation must be specified before claiming prompt generalization. No split is automatically certified as an untouched authorship benchmark.

## Lexical duplicate screen

Run `python scripts/screen-nikl-writing-duplicates.py /private/screen-config.local.json` after the initial build. Config fields:

- `manifest`: `{path, sha256}` for the initial manifest.
- `priorTexts`: explicit `{path, sha256}` files containing maps of IDs to text strings, such as the legacy corpus `texts.local.json`.
- `output`: a new private file path.

This checks normalized character 5-gram similarity between unique current texts and the supplied prior texts. Candidate generation uses bottom-16 hashed anchors, at least three shared anchors, a maximum anchor frequency of 200 and length ratio at least .25. Texts shorter than 100 characters are not screened. Candidate comparisons are capped at 250,000; hitting the cap marks `complete: false` and stops the command with an error. Links require Jaccard >= .85 or containment >= .95. This is a bounded lexical screen, not exhaustive semantic deduplication or proof of common authorship.

For the final build, set `nearDuplicateScreen: {path, sha256}` to this result, use a new output directory, and include any earlier diagnostic exposure manifest in `priorManifests`. The builder checks the source archive hashes, link text hashes and completion status before merging linked families or propagating prior exposure. A complete run means the configured screen finished, not that no paraphrases remain.

## Outputs

| File | Purpose |
|---|---|
| `archives/*.zip` | Hash-verified received originals |
| `manifest.local.json` | Record lineage, permissions, preserved scoring roles, splits and SHA-256 references |
| `texts.local.json` | Exact analysis input strings; private source content |
| `documents.local.jsonl` | Full source headers and documents; private source content |
| `lineage-issues.local.json` | Explicit unresolved relationships/differences |
| `summary.local.json` | Counts and incomplete evidence |

The manifest records file-byte hashes of the private artifacts. Do not copy any of these outputs into public commits, frontend assets or provider requests.

## Local diagnostics

Run `node scripts/evaluate-nikl-writing-corpus.js /private/manifest.local.json /private/new-baseline.local.json MANIFEST_SHA256`.

The evaluator verifies the manifest byte hash, referenced artifact hashes, source text hashes, local permission and agreement dates. It scores development records only and skips all review families. It uses `koreanQuality/detector.analyzeText` and `detectStatisticalAssist.marginFor`. Neither is the full live AI detection response; their numbers are **not** displayed scores or calibrated authorship probabilities. The live humanizer is not called.

Results include source/type-specific distributions, pattern counts and descriptive Spearman correlations between local quality risk and the first two named rater totals when both are finite. Extra/final raters remain in the input manifest and are not substituted silently. Correlations are not accuracy or final adjudicated grades. Model task responses and expert comments do not become paired rewrite-quality measurements. Human review completion stays zero until independently performed; release eligibility remains false.

The output's `exposureManifest` is compatible with `detectDatasetRegistry.buildRegistry`. Save that object as a new private JSON file and include its file hash in future build configs to keep measured families from reappearing as untouched holdout data. It includes both NFC/JavaScript-whitespace and NFKC/Python-whitespace text aliases.

## Tests

`python -m unittest discover -s test -p test_nikl_writing_corpus.py`

`node --test test/nikl-writing-evaluation.test.js test/engine-corpus-registry.test.js test/corpus-engine-regression.test.js`

Fixtures are synthetic. Tests cover input tampering, duplicate JSON, path/ZIP safety, expired authorization, preserved uncommon raters and comments, deterministic family splits, conflicts, prior/near exposure propagation, holdout exclusion and existing registry compatibility. No private corpus is required by the test suite.
