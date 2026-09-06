'use strict';
const fs = require('node:fs');
const { buildManifest } = require('../lib/detectBenchmark');
const [input, output, seed] = process.argv.slice(2);
if (!input || !output || !seed) throw Error('Usage: node scripts/build-detect-benchmark.js local-corpus.json local-manifest.json seed');
const manifest = buildManifest(JSON.parse(fs.readFileSync(input, 'utf8')), { seed });
fs.writeFileSync(output, JSON.stringify(manifest, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ n: manifest.n, groups: manifest.groups, digest: manifest.digest, coverage: manifest.coverage }));
