'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const engine = require('../engine-gpt-prod');

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node tools/copykiller-naturalness-lab-local.js <input.txt> [blog|assignment|polish]');
    process.exit(2);
  }
  const abs = path.resolve(process.cwd(), inputPath);
  const text = fs.readFileSync(abs, 'utf8');
  const modeArg = String(process.argv[3] || 'assignment').toLowerCase();
  const mode = modeArg === 'blog' || modeArg === 'basic'
    ? 'blog'
    : modeArg === 'polish'
      ? 'polish'
      : 'assignment';
  const out = await engine.run({
    text,
    mode,
    lang: 'ko',
    styleProfile: 'copykiller_naturalness_lab',
    naturalnessLab: true,
    qualityPatternLab: false,
    niklQualityTest: false,
    layoutNlp: false
  });
  const base = abs.replace(/\.[^.]+$/, '');
  const txtPath = `${base}.naturalness.txt`;
  const jsonPath = `${base}.naturalness.json`;
  fs.writeFileSync(txtPath, out.result?.outputText || '', 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({
    status: out.status,
    mode: out.mode,
    chunkCount: out.chunkCount,
    fallbackCount: out.fallbackCount,
    humanizeMeta: out.gptEngine,
    floorReport: out.floorReport,
    naturalnessLab: out.result?.naturalnessLab,
    naturalnessDelta: out.result?.naturalnessDelta,
    naturalnessAuditTrail: out.result?.naturalnessAuditTrail,
    naturalnessProtectedTermReport: out.result?.naturalnessProtectedTermReport
  }, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    status: out.status,
    mode: out.mode,
    chunkCount: out.chunkCount,
    fallbackCount: out.fallbackCount,
    output: txtPath,
    meta: jsonPath,
    estimatedUsd: out.gptEngine?.estimatedUsd || 0,
    naturalnessAction: out.result?.naturalnessLab?.action || ''
  }, null, 2));
}

main().catch(err => {
  console.error(err && err.stack || err && err.message || String(err));
  process.exit(1);
});
