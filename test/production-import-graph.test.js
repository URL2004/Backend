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
    'prompts.js',
    'engine-gpt',
    'engine/claudecode.js',
    'engine/genretransfer.js',
    'engine/evidence.js',
    'engine/judge.js',
    'engine/softguard.js',
    'engine/outputguard.js',
    'engine/registernormalize.js',
    'engine/prompt.js',
    'engine/koreanQuality/index.js',
    'engine/koreanQuality/gate.js',
    'engine-test.js',
    'engine-sweep.js',
    'genre-test.js',
    'judge-test.js',
    'make-md.js'
  ]) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', retired)), false, retired);
  }
});

test('동적 운영 자산과 관리자 lab 경계를 데드코드로 오인하지 않는다', () => {
  const liveDynamicFiles = [
    'engine/copykiller_proxy_model.json',
    'engine/copykiller_airate_model.json',
    'engine/koreanQuality/officialApi.js',
    'engine/koreanQuality/officialResources.js',
    'engine-gpt-prod/naturalnessShadow.js',
    'labs/adminHumanizeEngines.js'
  ];
  for (const liveFile of liveDynamicFiles) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', liveFile)), true, liveFile);
  }

  const proxySource = fs.readFileSync(
    path.join(__dirname, '..', 'engine', 'copykiller-proxy.js'),
    'utf8'
  );
  assert.match(proxySource, /copykiller_proxy_model\.json/u);
  assert.match(proxySource, /copykiller_airate_model\.json/u);
  assert.match(proxySource, /fs\.readFileSync/u);

  const niklSource = fs.readFileSync(
    path.join(__dirname, '..', 'engine-gpt-prod', 'niklAdvisor.js'),
    'utf8'
  );
  assert.match(niklSource, /function loadOfficialApi\(\)/u);
  assert.match(niklSource, /function loadOfficialResources\(\)/u);
  assert.match(niklSource, /module\.require\(\['\.\.', 'engine', 'koreanQuality'/u);

  const finalQualitySource = fs.readFileSync(
    path.join(__dirname, '..', 'engine-gpt-prod', 'finalQualityV2.js'),
    'utf8'
  );
  assert.match(finalQualitySource, /require\('\.\/naturalnessShadow'\)/u);

  const transformSource = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'transform.js'),
    'utf8'
  );
  assert.match(transformSource, /function loadAdminHumanizeEngines\(\)/u);
  assert.match(transformSource, /adminLabUid = await verifyAdminToken\(idToken\)/u);
  assert.match(transformSource, /if \(adminLabUid === false\) return res\.status\(403\)/u);
  assert.match(transformSource, /\['\.\.', 'labs', 'adminHumanizeEngines'\]\.join\('\/'\)/u);
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
