#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(__dirname, '..');
  const requestedRepos = args.repos.length
    ? args.repos
    : args.workspace
      ? [sourceRoot, path.resolve(sourceRoot, '..', 'Frontend')]
      : [sourceRoot];

  const reports = [];
  for (const requested of requestedRepos) {
    const absolute = path.resolve(process.cwd(), requested);
    if (!fs.existsSync(absolute)) {
      reports.push({ ok: false, requested: absolute, error: 'path_not_found' });
      continue;
    }
    try {
      reports.push(installHooksForRepo({ sourceRoot, repositoryPath: absolute }));
    } catch (error) {
      reports.push({
        ok: false,
        requested: absolute,
        error: String(error?.stderr || error?.message || error).replace(/\s+/gu, ' ').trim().slice(0, 300)
      });
    }
  }

  console.log(JSON.stringify({
    ok: reports.every(report => report.ok),
    reports
  }, null, 2));
  if (reports.some(report => !report.ok)) process.exitCode = 2;
}

function installHooksForRepo({ sourceRoot, repositoryPath }) {
  const root = git(repositoryPath, ['rev-parse', '--show-toplevel']).trim();
  const rawHookPath = git(root, ['rev-parse', '--git-path', 'hooks']).trim();
  const hooksPath = path.isAbsolute(rawHookPath) ? rawHookPath : path.resolve(root, rawHookPath);
  const hookNames = ['pre-commit', 'post-commit', 'pre-push'];

  fs.mkdirSync(hooksPath, { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'scripts', 'git-harness.js'), path.join(hooksPath, 'git-harness.cjs'));
  for (const hookName of hookNames) {
    const destination = path.join(hooksPath, hookName);
    fs.copyFileSync(path.join(sourceRoot, '.githooks', hookName), destination);
    try {
      fs.chmodSync(destination, 0o755);
    } catch {
      // Git for Windows executes shebang hooks even when POSIX mode bits are unavailable.
    }
  }
  git(root, ['config', 'core.hooksPath', hooksPath]);

  return {
    ok: true,
    root,
    hooksPath,
    installed: ['git-harness.cjs', ...hookNames],
    configuredHooksPath: git(root, ['config', '--get', 'core.hooksPath']).trim()
  };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024
  });
}

function parseArgs(argv) {
  const repos = [];
  let workspace = false;
  for (const arg of argv) {
    if (arg === '--workspace=1' || arg === '--workspace') workspace = true;
    if (String(arg).startsWith('--repo=')) repos.push(String(arg).slice('--repo='.length));
  }
  return { repos, workspace };
}

module.exports = {
  installHooksForRepo,
  parseArgs
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
