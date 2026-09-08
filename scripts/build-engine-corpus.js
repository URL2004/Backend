'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sha } = require('../lib/detectBenchmark');
const corpus = require('../lib/engineCorpusRegistry');

function repositoryRoots() {
  const current = path.resolve(__dirname, '..'), roots = [current], git = path.join(current, '.git');
  if (fs.existsSync(git) && fs.statSync(git).isFile()) {
    const line = fs.readFileSync(git, 'utf8').trim();
    if (line.startsWith('gitdir: ')) {
      const gitdir = path.resolve(current, line.slice(8)), marker = path.sep + '.git' + path.sep;
      if (gitdir.includes(marker)) roots.push(gitdir.slice(0, gitdir.indexOf(marker)));
    }
  }
  return roots;
}
function main(configPath) {
  if (!configPath) throw Error('Usage: node scripts/build-engine-corpus.js config.json');
  const config = corpus.readStructured(configPath);
  const allowed = new Set(['version', 'workspaceRoot', 'auditDirectory', 'outputDirectory', 'operationalSource', 'priorManifestPaths', 'seed', 'reviewSampleSize', 'expectedPairs', 'expectedExternalLinks']);
  if (config.version !== 'engine-corpus-build-v1' || Object.keys(config).some(k => !allowed.has(k))) throw Error('corpus_unknown_build_config');
  if (!config.workspaceRoot || !config.auditDirectory || !config.outputDirectory || !config.operationalSource) throw Error('corpus_build_paths_missing');
  const output = corpus.assertExternalOutput(config.outputDirectory, repositoryRoots());
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw Error('corpus_output_directory_not_empty');
  const artifacts = ['corpus-pair-occurrences.json', 'copykiller-source-links.json', 'corpus-inventory.json', 'corpus-structured-extraction.json'];
  const reads = Object.fromEntries(artifacts.map(name => [name, corpus.readStructured(path.join(config.auditDirectory, name))]));
  const priorManifests = (config.priorManifestPaths || []).map(file => corpus.readStructured(file));
  const operational = corpus.readStructured(corpus.sourcePath(config.workspaceRoot, config.operationalSource));
  if (!Array.isArray(operational.rows)) throw Error('corpus_unknown_operational_schema');
  const result = corpus.buildCorpus(reads['corpus-pair-occurrences.json'], { root: config.workspaceRoot,
    seed: config.seed, reviewSampleSize: config.reviewSampleSize, externalLinks: reads['copykiller-source-links.json'], operationalRows: operational.rows, priorManifests });
  if (config.expectedPairs !== undefined && result.manifest.pairs.length !== config.expectedPairs) throw Error('corpus_expected_pair_count_changed');
  if (config.expectedExternalLinks !== undefined && result.manifest.externalEvidence.length !== config.expectedExternalLinks) throw Error('corpus_expected_external_count_changed');
  const extractionAudit = reads['corpus-structured-extraction.json'];
  if (!Array.isArray(extractionAudit.files) || !Array.isArray(extractionAudit.errors)) throw Error('corpus_unknown_extraction_audit_schema');
  const structuredIntake = [
    ...extractionAudit.files.map(r => ({ sourceFile: r.path, status: r.records_with_pair ? 'pair_fields_verified' : 'excluded',
      reason: r.records_with_pair ? 'occurrence_hashes_verified_against_source' : 'no_registered_pair_fields_in_audit' })),
    ...extractionAudit.errors.map(r => ({ sourceFile: r.path, status: 'excluded', reason: 'prior_structured_parse_error:' + r.error }))
  ];
  const fileIntake = [];
  for (const row of reads['corpus-inventory.json']) {
    if (!['.doc', '.docx', '.pdf', '.xlsx'].includes(row.extension)) continue;
    const file = corpus.sourcePath(config.workspaceRoot, row.path), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(256);
    let count; try { count = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
    const signature = corpus.fileSignature(buffer.subarray(0, count), file);
    fileIntake.push({ sourceFile: row.path, extension: row.extension, format: signature.format,
      status: signature.exclude ? 'excluded' : 'inventoried',
      reason: signature.exclude || 'format_inventory_only_fulltext_from_verified_structured_pairs', sourceByteHashFromAudit: row.sha256 });
  }
  const summary = { version: 'engine-corpus-intake-v1', manifestDigest: result.manifest.digest,
    occurrences: reads['corpus-pair-occurrences.json'].length, pairs: result.manifest.pairs.length,
    documents: result.manifest.documents.length, families: new Set(result.manifest.documents.map(d => d.group)).size,
    externalEvidence: result.manifest.externalEvidence.length, blindReviewFamilies: result.reviewForms.length,
    sourceSchemas: [...new Set(reads['corpus-pair-occurrences.json'].map(r => r.schema))].sort(),
    auditArtifactDigests: Object.fromEntries(artifacts.map(name => [name, sha(fs.readFileSync(path.join(config.auditDirectory, name)))])),
    formats: fileIntake.reduce((s, r) => { s[r.format] = (s[r.format] || 0) + 1; return s; }, {}),
    excludedFiles: fileIntake.filter(r => r.status === 'excluded').length,
    priorManifestDigests: priorManifests.map(m => m.digest), providersCalled: 0, releaseEligible: false };
  summary.structuredSources = { files: structuredIntake.length, withVerifiedPairs: structuredIntake.filter(r => r.status === 'pair_fields_verified').length,
    excludedNoPairFields: extractionAudit.files.filter(r => !r.records_with_pair).length, priorParseErrors: extractionAudit.errors.length };
  // Build and validate everything before creating output files. Existing output is never overwritten.
  const dashboard = corpus.evaluateCorpus(result.manifest);
  fs.mkdirSync(output, { recursive: true });
  const files = { 'manifest.json': result.manifest, 'texts.local.json': result.texts,
    'exposure-manifest.json': result.exposureManifest, 'exposure-registry.json': result.registry,
    'quality-review-blind.local.json': result.reviewForms, 'quality-review-key.local.json': result.reviewKeys,
    'sentence-evidence-review.local.json': result.evidenceForms, 'file-intake.local.json': fileIntake,
    'structured-source-intake.local.json': structuredIntake,
    'intake-summary.json': summary, 'evaluation-dashboard.json': dashboard };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(output, name), JSON.stringify(body, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(summary));
  return summary;
}
if (require.main === module) {
  try { main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main, repositoryRoots };
