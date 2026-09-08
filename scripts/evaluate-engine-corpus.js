'use strict';
const fs = require('node:fs');
const path = require('node:path');
const corpus = require('../lib/engineCorpusRegistry');
const { repositoryRoots } = require('./build-engine-corpus');
function main(manifestPath, outputPath, resultsPath) {
  if (!manifestPath || !outputPath) throw Error('Usage: node scripts/evaluate-engine-corpus.js manifest.json dashboard.json [local-results.json]');
  const output = corpus.assertExternalOutput(outputPath, repositoryRoots());
  const manifest = corpus.readStructured(manifestPath), results = resultsPath ? corpus.readStructured(resultsPath) : {};
  if (Object.keys(results).some(k => !['scoreRows', 'evidenceReviews', 'qualityReviews', 'textsPath', 'candidatePath'].includes(k))) throw Error('corpus_unknown_evaluation_schema');
  const result = corpus.evaluateCorpus(manifest, { scoreRows: results.scoreRows || [], evidenceReviews: results.evidenceReviews || [], qualityReviews: results.qualityReviews || [],
    texts: results.textsPath ? corpus.readStructured(path.resolve(path.dirname(resultsPath), results.textsPath)) : {},
    candidate: results.candidatePath ? corpus.readStructured(path.resolve(path.dirname(resultsPath), results.candidatePath)) : null });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result)); return result;
}
if (require.main === module) {
  try { main(...process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
