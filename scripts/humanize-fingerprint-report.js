'use strict';

const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./lib/csv');

const MIN_OUTPUT_DOCUMENTS = 10;
const MIN_RATIO = 2;
const MIN_DELTA = 8;

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const input = required(args.input, '--input');
  const pairs = loadPairs(path.resolve(input));
  const report = buildReport(pairs, args);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) fs.writeFileSync(path.resolve(args.out), json, 'utf8');
  else process.stdout.write(json);
}

function buildReport(pairs, options = {}) {
  const minN = Math.max(2, Number(options.minN) || 2);
  const maxN = Math.min(8, Math.max(minN, Number(options.maxN) || 5));
  const sourceDocs = new Map();
  const outputDocs = new Map();
  for (const pair of pairs || []) {
    for (const gram of documentNgrams(pair.source, minN, maxN)) sourceDocs.set(gram, (sourceDocs.get(gram) || 0) + 1);
    for (const gram of documentNgrams(pair.output, minN, maxN)) outputDocs.set(gram, (outputDocs.get(gram) || 0) + 1);
  }
  const candidates = [];
  for (const [phrase, outputDocumentCount] of outputDocs) {
    const sourceDocumentCount = sourceDocs.get(phrase) || 0;
    const ratio = sourceDocumentCount ? outputDocumentCount / sourceDocumentCount : Infinity;
    const delta = outputDocumentCount - sourceDocumentCount;
    if (outputDocumentCount < MIN_OUTPUT_DOCUMENTS || ratio < MIN_RATIO || delta < MIN_DELTA) continue;
    candidates.push({
      phrase,
      tokenCount: phrase.split(' ').length,
      sourceDocumentCount,
      outputDocumentCount,
      ratio: Number.isFinite(ratio) ? round4(ratio) : null,
      delta,
      approvalStatus: 'candidate_requires_human_approval',
      runtimeDictionary: false
    });
  }
  candidates.sort((left, right) => right.delta - left.delta
    || right.outputDocumentCount - left.outputDocumentCount
    || right.tokenCount - left.tokenCount);
  return {
    schemaVersion: 1,
    pairCount: (pairs || []).length,
    thresholds: {
      minOutputDocumentCount: MIN_OUTPUT_DOCUMENTS,
      minSourceRatio: MIN_RATIO,
      minNetIncrease: MIN_DELTA,
      minN,
      maxN
    },
    candidateCount: candidates.length,
    candidates: candidates.slice(0, Math.max(1, Number(options.limit) || 200))
  };
}

function loadPairs(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.jsonl') {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => pairFromObject(JSON.parse(line))).filter(validPair);
  }
  if (extension === '.json') {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : (parsed.rows || parsed.results || []);
    return rows.map(pairFromObject).filter(validPair);
  }
  if (extension === '.csv') {
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    const directory = path.dirname(file);
    return rows.map(row => {
      const source = row.original_file ? readLocal(path.resolve(directory, row.original_file)) : (row.source || row.original || '');
      const output = row.humanized_file ? readLocal(path.resolve(directory, row.humanized_file)) : (row.output || row.humanized || '');
      return { source, output };
    }).filter(validPair);
  }
  throw new Error(`unsupported_input_format:${extension}`);
}

function pairFromObject(row) {
  return {
    source: row?.source || row?.original || row?.input || row?.rawText || '',
    output: row?.output || row?.humanized || row?.outputText || row?.result?.outputText || ''
  };
}

function validPair(pair) {
  return String(pair?.source || '').trim().length > 0 && String(pair?.output || '').trim().length > 0;
}

function documentNgrams(value, minN, maxN) {
  const tokens = String(value || '').normalize('NFKC').toLowerCase().match(/[가-힣]{1,}|[a-z]{2,}|\d+(?:\.\d+)?%?/gu) || [];
  const grams = new Set();
  for (let size = minN; size <= maxN; size += 1) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      const gram = tokens.slice(index, index + size).join(' ');
      if (gram.length >= 6 && gram.length <= 80) grams.add(gram);
    }
  }
  return grams;
}

function readLocal(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv || []) {
    const match = String(arg).match(/^--([^=]+)=(.*)$/u);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function required(value, name) {
  if (value) return value;
  throw new Error(`missing_required_argument:${name}`);
}

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

if (require.main === module) main();

module.exports = { buildReport, loadPairs, documentNgrams };
