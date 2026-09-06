'use strict';
const fs = require('node:fs');
const { buildResearchManifest } = require('../lib/detectDatasetRegistry');
const [corpusPath, optionsPath, outputPath] = process.argv.slice(2);
if (!outputPath) throw Error('Usage: node scripts/build-detect-research-manifest.js corpus.json options.json output.json');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const result = buildResearchManifest(read(corpusPath), read(optionsPath));
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ n: result.n, groups: result.groups, digest: result.digest, processCoverage: result.processCoverage, lexicalDuplicateLinks: result.nearDuplicates.links.length }));
