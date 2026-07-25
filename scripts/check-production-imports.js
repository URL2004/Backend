'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ROOTS = ['server.js'];
const FORBIDDEN_PATHS = [
  '/labs/',
  '/experimental/',
  '/legacy/',
  '/engine-gpt/',
  '/engine/claudecode.js',
  '/engine/genretransfer.js',
  '/engine/evidence.js',
  '/engine/judge.js',
  '/engine/softguard.js',
  '/engine/outputguard.js',
  '/engine/registernormalize.js',
  '/engine/prompt.js',
  '/engine/antidetect.js',
  '/engine/b7polish.js',
  '/engine/burstiness.js',
  '/engine/columncleanup.js',
  '/engine/formalbudget.js',
  '/engine/genreframes.js',
  '/engine/grounding.js',
  '/engine/optimizer.js',
  '/engine/phrasebudget.js',
  '/engine/polish.js',
  '/engine/registerrepair.js',
  '/engine/registerscore.js',
  '/engine/basicblogtone.js',
  '/engine/flowcohesion.js',
  '/engine/koreanquality/qualitypatternlab.js',
  '/engine/koreanquality/index.js',
  '/lib/basichumanizeexperiment.js',
  '/engine-gpt-prod/local/'
];

function scanProductionImports({ root = ROOT, entries = DEFAULT_ROOTS } = {}) {
  const visited = new Set();
  const edges = [];
  const violations = [];
  const queue = entries.map(entry => path.resolve(root, entry));
  while (queue.length) {
    const file = queue.shift();
    if (!file || visited.has(file) || !fs.existsSync(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of staticSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveLocal(file, specifier);
      if (!resolved) continue;
      const normalized = resolved.replace(/\\/gu, '/').toLowerCase();
      edges.push({ from: relative(root, file), to: relative(root, resolved) });
      const forbidden = FORBIDDEN_PATHS.find(item => normalized.includes(item));
      if (forbidden) {
        violations.push({
          from: relative(root, file),
          to: relative(root, resolved),
          forbidden
        });
        continue;
      }
      queue.push(resolved);
    }
  }
  return {
    pass: violations.length === 0,
    roots: entries,
    visitedFileCount: visited.size,
    edgeCount: edges.length,
    visitedFiles: [...visited].map(file => relative(root, file)).sort(),
    edges,
    violations
  };
}

function staticSpecifiers(source) {
  const values = [];
  const patterns = [
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gu,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) values.push(match[1]);
  }
  return [...new Set(values)];
}

function resolveLocal(fromFile, specifier) {
  const candidate = path.resolve(path.dirname(fromFile), specifier);
  for (const file of [candidate, `${candidate}.js`, `${candidate}.json`, path.join(candidate, 'index.js')]) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

function relative(root, file) {
  return path.relative(root, file).replace(/\\/gu, '/');
}

if (require.main === module) {
  const report = scanProductionImports();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) process.exitCode = 2;
}

module.exports = { ROOT, DEFAULT_ROOTS, FORBIDDEN_PATHS, scanProductionImports, staticSpecifiers };
