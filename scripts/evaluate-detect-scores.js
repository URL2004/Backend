#!/usr/bin/env node
'use strict';
// Offline numeric evaluation only; no API calls and no corpus text is needed.
const fs = require('node:fs');
const { evaluatePairedScores } = require('../lib/detectEvaluation');
try {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/evaluate-detect-scores.js scores.json [development|holdout]');
  const result = evaluatePairedScores(JSON.parse(fs.readFileSync(file, 'utf8')), { split: process.argv[3] || 'holdout' });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
