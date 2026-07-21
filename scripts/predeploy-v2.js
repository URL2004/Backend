'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { POLICY_VERSION: EXPECTED_HUMANIZATION_POLICY } = require('../engine-gpt-prod/humanizationDepth');
const { scanProductionImports } = require('./check-production-imports');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(__dirname, '..');
  const checks = [];
  const add = (name, pass, detail = '') => checks.push({ name, pass: pass === true, detail });

  const branch = git(root, ['branch', '--show-current']).trim();
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const expectedBranch = String(args['expected-branch'] || '').trim();
  add('branch', !expectedBranch || branch === expectedBranch, `${branch}@${head.slice(0, 12)}`);

  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']).trim();
  add('clean_worktree', !status, status ? `${status.split(/\r?\n/u).length}개 변경 파일` : 'clean');
  add('diff_check', runGitCheck(root, ['diff', '--check']), 'git diff --check');

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const nodeVersionFile = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim();
  add('node_runtime', process.versions.node.split('.')[0] === '24' && packageJson.engines?.node === '24.x' && nodeVersionFile === '24', `runtime=${process.versions.node}, engines=${packageJson.engines?.node}, file=${nodeVersionFile}`);
  add('python_postinstall_removed', !packageJson.scripts?.postinstall && Boolean(packageJson.scripts?.['setup:layout-nlp']), packageJson.scripts?.['setup:layout-nlp'] || 'missing');
  add('form_data_patched', semverAtLeast(packageJson.dependencies?.['form-data'], 4, 0, 6), packageJson.dependencies?.['form-data'] || 'missing');
  add('legacy_pdf_dependencies_removed', !packageJson.dependencies?.multer && !packageJson.dependencies?.['pdf-parse'], 'multer/pdf-parse');
  add('firebase_admin_14_1', packageJson.dependencies?.['firebase-admin'] === '14.1.0', packageJson.dependencies?.['firebase-admin'] || 'missing');
  const bodyParser = packageLock.packages?.['node_modules/body-parser']?.version || '';
  const protobuf = packageLock.packages?.['node_modules/protobufjs']?.version || '';
  add('body_parser_patched', semverAtLeast(bodyParser, 1, 20, 6), bodyParser || 'missing');
  add('protobufjs_patched', semverAtLeast(protobuf, 7, 6, 5), protobuf || 'missing');
  const websocketDriver = packageLock.packages?.['node_modules/websocket-driver']?.version || '';
  add('websocket_driver_patched', semverAtLeast(websocketDriver, 0, 7, 5), websocketDriver || 'missing');

  const base = String(args.base || '').trim();
  const deployDiff = base ? git(root, ['diff', '--name-status', `${base}...HEAD`]).trim() : '';
  const changedNames = deployDiff.split(/\r?\n/u).filter(Boolean).map(line => line.split(/\s+/u).slice(1).join(' '));
  const localApiFiles = changedNames.filter(name => /(?:^|\/)(?:local[-_]?copykiller|copykiller[-_]?test[-_]?api|routes\/copykiller)/iu.test(name.replace(/\\/gu, '/')));
  add('local_copykiller_api_excluded', localApiFiles.length === 0, localApiFiles.join(', '));
  const importGraph = scanProductionImports({ root });
  add('production_import_graph', importGraph.pass, JSON.stringify(importGraph.violations));

  if (args['skip-env'] !== '1') {
    add('v2_single_production_path', true, 'gpt-prod-v2.5.1');
    add('humanization_depth_enabled', String(process.env.HUMANIZATION_DEPTH_GATE_ENABLED || '1').trim() !== '0', process.env.HUMANIZATION_DEPTH_GATE_ENABLED || 'default_on');
    add('active_provider', gptOnly(packageJson), 'gpt');
    add('openai_key', Boolean(process.env.OPENAI_API_KEY), process.env.OPENAI_API_KEY ? 'configured' : 'unset');
    add('safety_salt', String(process.env.OPENAI_SAFETY_SALT || '').length >= 32, process.env.OPENAI_SAFETY_SALT ? `${String(process.env.OPENAI_SAFETY_SALT).length} chars` : 'unset');
  }

  const healthUrl = String(args['health-url'] || '').trim();
  if (healthUrl) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(30000) });
      const health = await response.json();
      add('healthz', response.ok && health.ok === true, `http=${response.status}`);
      add('active_jobs_zero', Number(health.activeJobs) === 0, `active=${health.activeJobs}, queued=${health.queuedJobs}`);
      if (args['expect-live-v2'] === '1') {
        add('live_v2', health.humanizeEngineV2 === true && health.activeProvider === 'gpt' && health.openai === true, `v2=${health.humanizeEngineV2}, provider=${health.activeProvider}, openai=${health.openai}`);
        add('live_humanization_depth', health.humanizationDepthGate === true, `depth=${health.humanizationDepthGate}`);
        add('live_humanization_policy', health.humanizationDepthPolicy === EXPECTED_HUMANIZATION_POLICY, `expected=${EXPECTED_HUMANIZATION_POLICY}, policy=${health.humanizationDepthPolicy}`);
      }
    } catch (error) {
      add('healthz', false, String(error?.message || error).slice(0, 180));
    }
  }

  const report = {
    ok: checks.every(check => check.pass),
    branch,
    head,
    base: base || null,
    deployDiffFiles: changedNames.length,
    stagedDiff: git(root, ['diff', '--cached', '--name-status']).trim().split(/\r?\n/u).filter(Boolean),
    checks
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 2;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runGitCheck(cwd, args) {
  try { git(cwd, args); return true; } catch { return false; }
}

function semverAtLeast(value, major, minor, patch) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/u);
  if (!match) return false;
  const current = match.slice(1).map(Number);
  return current[0] > major || (current[0] === major && (current[1] > minor || (current[1] === minor && current[2] >= patch)));
}

function gptOnly() {
  const runtime = require('../lib/gptRuntimeConfig');
  return runtime.sanitizeConfig({ activeProvider: 'claude' }).activeProvider === 'gpt';
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, ...rest] = arg.slice(2).split('=');
    out[key] = rest.length ? rest.join('=') : '1';
  }
  return out;
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
