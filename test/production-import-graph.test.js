'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scanProductionImports } = require('../scripts/check-production-imports');

test('production import graph excludes labs, experimental, and legacy engines', () => {
  const report = scanProductionImports();
  assert.equal(report.pass, true, JSON.stringify(report.violations, null, 2));
  assert.equal(report.violations.length, 0);
  assert.ok(report.visitedFileCount > 10);
  for (const forbidden of [
    'engine/softguard.js',
    'engine/outputguard.js',
    'engine/registernormalize.js',
    'engine/prompt.js',
    'engine/claudecode.js',
    'engine/koreanQuality/qualityPatternLab.js',
    'engine/koreanQuality/index.js',
    'lib/basicHumanizeExperiment.js',
    'engine-gpt-prod/local/index.js'
  ]) {
    assert.equal(report.visitedFiles.includes(forbidden), false, forbidden);
  }
  assert.equal(
    report.edges.some(edge => edge.from === 'routes/detectreport.js' && edge.to === 'routes/transform.js'),
    false,
    'detect report must not load the entire transform route for pricing'
  );
  assert.equal(
    report.edges.some(edge => edge.from === 'routes/detectreport.js' && edge.to === 'routes/diagnose.js'),
    false,
    'detect report must not load the diagnose router for presentation constants'
  );
});

test('production engine has one path and cannot re-enable dormant prompt or judge branches', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'engine-gpt-prod', 'index.js'), 'utf8');
  for (const token of [
    'v2Enabled',
    'qualityPatternLab',
    'runSemanticJudge',
    'GPT_QUALITY_PATTERN_ENABLED',
    'GPT_QUALITY_PATTERN_LAB_ENABLED'
  ]) {
    assert.equal(source.includes(token), false, token);
  }
});

test('retired provider and duplicate engine executables are physically absent', () => {
  for (const retired of [
    'engine-gpt',
    'engine/claudecode.js',
    'engine/genretransfer.js',
    'engine/evidence.js',
    'engine/judge.js',
    'engine/softguard.js',
    'engine/outputguard.js',
    'engine/registernormalize.js',
    'engine/prompt.js',
    'engine-test.js',
    'engine-sweep.js',
    'genre-test.js',
    'judge-test.js',
    'make-md.js'
  ]) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', retired)), false, retired);
  }
});

test('운영 설정 예시는 제거된 provider·엔진·무차감 스위치를 다시 노출하지 않는다', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  for (const retiredSetting of [
    'ANTHROPIC_API_KEY',
    'LLM_ACTIVE_PROVIDER',
    'ENABLE_LEGACY_ANALYZE_PDF',
    'HUMANIZE_ENGINE_V2_ENABLED',
    'HUMANIZE_BILLING_PROTECTION_ENABLED',
    'OPENAI_TEXT_VERBOSITY'
  ]) {
    assert.equal(example.includes(retiredSetting), false, retiredSetting);
  }
});
