#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { parseWorktreeList } = require('./git-harness');

function main() {
  const apply = process.argv.includes('--apply') || process.argv.includes('--apply=1');
  const remoteRefArg = process.argv.find(arg => arg.startsWith('--remote-ref='));
  const remoteRef = remoteRefArg
    ? remoteRefArg.slice('--remote-ref='.length)
    : 'origin/release/prod-maintenance-test';
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const worktrees = parseWorktreeList(git(root, ['worktree', 'list', '--porcelain']));
  const primary = path.resolve(worktrees[0]?.path || root);
  const current = path.resolve(root);
  const workspace = path.dirname(primary);
  const candidates = [];
  const skipped = [];

  if (!gitCheck(root, ['rev-parse', '--verify', '--quiet', remoteRef])) {
    throw new Error(`원격 기준 ${remoteRef}를 찾지 못했습니다. git fetch origin --prune 후 다시 실행하세요.`);
  }

  for (const item of worktrees.slice(1)) {
    const target = path.resolve(item.path);
    const safePrefix = `${workspace}${path.sep}`.toLowerCase();
    if (target === current || !target.toLowerCase().startsWith(safePrefix)) {
      skipped.push({ path: target, reason: target === current ? 'current_worktree' : 'outside_workspace' });
      continue;
    }
    if (git(target, ['status', '--porcelain']).trim()) {
      skipped.push({ path: target, reason: 'dirty' });
      continue;
    }
    if (!gitCheck(root, ['merge-base', '--is-ancestor', item.head, remoteRef])) {
      skipped.push({ path: target, reason: 'not_merged_to_release' });
      continue;
    }
    candidates.push({ path: target, branch: item.branch || null, head: item.head });
  }

  if (apply) {
    for (const candidate of candidates) {
      git(root, ['worktree', 'remove', candidate.path]);
    }
    git(root, ['worktree', 'prune']);
  }

  console.log(JSON.stringify({
    ok: true,
    mode: apply ? 'apply' : 'dry-run',
    remoteRef,
    primary,
    removed: apply ? candidates : [],
    candidates: apply ? [] : candidates,
    skipped
  }, null, 2));
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024
  });
}

function gitCheck(cwd, args) {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[git-worktree-cleanup] ${String(error?.message || error)}`);
    process.exitCode = 1;
  }
}
