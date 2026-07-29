#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const VERSION = '1.0.0';
const MODES = new Set(['manual', 'pre-commit', 'post-commit', 'pre-push', 'deploy']);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRepositoryRoot(process.cwd());
  const mode = MODES.has(args.mode) ? args.mode : 'manual';
  const options = {
    mode,
    expectedBranch: String(args['expected-branch'] || '').trim(),
    remoteRef: String(args['remote-ref'] || '').trim(),
    requireEqual: args['require-equal'] === '1',
    allowDetached: args['allow-detached'] === '1' || args['all-worktrees'] === '1'
  };

  const report = args['all-worktrees'] === '1'
    ? inspectAllWorktrees(root, options)
    : evaluateRepository({ root, ...options });

  if (args.json === '1') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }
  if (!report.ok) process.exitCode = 2;
}

function evaluateRepository({
  root,
  mode = 'manual',
  expectedBranch = '',
  remoteRef = '',
  requireEqual = false,
  allowDetached = false
}) {
  const state = inspectRepository(root);
  const errors = [];
  const warnings = [];

  if (!MODES.has(mode)) errors.push(issue('invalid_mode', `지원하지 않는 모드: ${mode}`));
  if (!state.branch) {
    const detachedIssue = issue('detached_head', 'detached HEAD에서는 커밋·푸시·배포하지 않습니다.');
    if (allowDetached) warnings.push(detachedIssue);
    else errors.push(detachedIssue);
  }
  if (expectedBranch && state.branch !== expectedBranch) {
    errors.push(issue(
      'unexpected_branch',
      `예상 브랜치 ${expectedBranch}, 현재 ${state.branch || '(detached)'}`
    ));
  }
  if (state.conflicted.length) {
    errors.push(issue('merge_conflict', `${state.conflicted.length}개 충돌 파일`, state.conflicted));
  }
  if (!state.workingDiffCheck) {
    errors.push(issue('working_diff_check_failed', '작업 중인 diff에 공백 오류가 있습니다.'));
  }
  if (!state.stagedDiffCheck) {
    errors.push(issue('staged_diff_check_failed', 'staged diff에 공백 오류가 있습니다.'));
  }
  if (state.prohibitedPaths.length) {
    errors.push(issue(
      'prohibited_paths',
      `${state.prohibitedPaths.length}개 로컬·비밀 파일은 커밋할 수 없습니다.`,
      state.prohibitedPaths.map(item => `${item.path} (${item.reason})`)
    ));
  }
  if (state.secretFindings.length) {
    errors.push(issue(
      'potential_secret',
      `${state.secretFindings.length}개 staged 파일에서 비밀값 형태를 감지했습니다.`,
      state.secretFindings.map(item => `${item.path} (${item.code})`)
    ));
  }

  if (mode === 'pre-commit') {
    if (!state.staged.length) {
      errors.push(issue('nothing_staged', '커밋할 staged 파일이 없습니다.'));
    }
    if (state.unstaged.length) {
      errors.push(issue(
        'partial_commit_unstaged',
        `${state.unstaged.length}개 unstaged 파일이 남아 부분 커밋을 차단했습니다.`,
        state.unstaged
      ));
    }
    if (state.untracked.length) {
      errors.push(issue(
        'partial_commit_untracked',
        `${state.untracked.length}개 untracked 파일이 남아 부분 커밋을 차단했습니다.`,
        state.untracked
      ));
    }
  } else {
    const pending = unique([...state.staged, ...state.unstaged, ...state.untracked]);
    if (pending.length) {
      errors.push(issue(
        'uncommitted_changes',
        `${pending.length}개 미커밋 파일이 있습니다.`,
        pending
      ));
    }
  }

  let remote = null;
  if (remoteRef) {
    remote = inspectRemoteRelation(state.root, remoteRef);
    if (!remote.exists) {
      errors.push(issue('remote_ref_missing', `원격 기준 ${remoteRef}를 찾지 못했습니다.`));
    } else {
      if (remote.behind > 0) {
        errors.push(issue(
          'remote_behind',
          `${remoteRef}보다 ${remote.behind}개 커밋 뒤에 있습니다. 먼저 원격을 반영하세요.`
        ));
      }
      if (requireEqual && remote.ahead > 0) {
        errors.push(issue(
          'remote_not_pushed',
          `${remoteRef}에 아직 ${remote.ahead}개 로컬 커밋이 반영되지 않았습니다.`
        ));
      } else if (!requireEqual && remote.ahead > 0) {
        warnings.push(issue(
          'remote_push_pending',
          `${remoteRef}보다 ${remote.ahead}개 커밋 앞서 있습니다.`
        ));
      }
    }
  }

  return {
    ok: errors.length === 0,
    version: VERSION,
    mode,
    root: state.root,
    branch: state.branch || null,
    head: state.head,
    clean: state.clean,
    counts: {
      staged: state.staged.length,
      unstaged: state.unstaged.length,
      untracked: state.untracked.length,
      conflicted: state.conflicted.length
    },
    remote,
    errors,
    warnings
  };
}

function inspectRepository(root) {
  const repositoryRoot = resolveRepositoryRoot(root);
  const staged = gitNull(repositoryRoot, ['diff', '--cached', '--name-only', '-z']);
  const unstaged = gitNull(repositoryRoot, ['diff', '--name-only', '-z']);
  const untracked = gitNull(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  const conflicted = gitNull(repositoryRoot, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const changedPaths = unique([...staged, ...unstaged, ...untracked]);

  return {
    root: repositoryRoot,
    branch: git(repositoryRoot, ['branch', '--show-current']).trim(),
    head: git(repositoryRoot, ['rev-parse', 'HEAD']).trim(),
    staged,
    unstaged,
    untracked,
    conflicted,
    clean: changedPaths.length === 0 && conflicted.length === 0,
    prohibitedPaths: changedPaths
      .map(file => ({ path: file, reason: prohibitedPathReason(file) }))
      .filter(item => Boolean(item.reason)),
    secretFindings: scanStagedSecrets(repositoryRoot, staged),
    workingDiffCheck: gitCheck(repositoryRoot, ['diff', '--check']),
    stagedDiffCheck: gitCheck(repositoryRoot, ['diff', '--cached', '--check'])
  };
}

function inspectAllWorktrees(root, options = {}) {
  const repositoryRoot = resolveRepositoryRoot(root);
  const worktrees = parseWorktreeList(git(repositoryRoot, ['worktree', 'list', '--porcelain']));
  const reports = worktrees.map(item => {
    try {
      return evaluateRepository({ root: item.path, ...options });
    } catch (error) {
      return {
        ok: false,
        version: VERSION,
        mode: options.mode || 'manual',
        root: item.path,
        branch: item.branch || null,
        head: item.head || null,
        clean: false,
        counts: {},
        remote: null,
        errors: [issue('worktree_inspection_failed', sanitizeError(error))],
        warnings: []
      };
    }
  });
  return {
    ok: reports.every(report => report.ok),
    version: VERSION,
    mode: options.mode || 'manual',
    repositoryRoot,
    worktreeCount: reports.length,
    reports
  };
}

function inspectRemoteRelation(root, remoteRef) {
  if (!gitCheck(root, ['rev-parse', '--verify', '--quiet', remoteRef])) {
    return { ref: remoteRef, exists: false, ahead: null, behind: null };
  }
  const raw = git(root, ['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`]).trim();
  const [behind, ahead] = raw.split(/\s+/u).map(Number);
  return {
    ref: remoteRef,
    exists: true,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0
  };
}

function prohibitedPathReason(file) {
  const normalized = String(file || '').replace(/\\/gu, '/').replace(/^\.\/+/u, '');
  const lower = normalized.toLowerCase();
  const basename = path.posix.basename(lower);

  if (/^\.env(?:\.|$)/u.test(lower) && !lower.endsWith('.example')) return 'environment_secret';
  if (/(?:^|\/)(?:firebase-adminsdk|service-account)[^/]*\.json$/u.test(lower)) return 'service_account';
  if (/\.(?:pem|p12|pfx|key)$/u.test(lower)) return 'private_key_file';
  if (/\.local\.(?:json|jsonl|csv|txt)$/u.test(lower)) return 'local_result_data';
  if (/(?:^|\/)(?:results|samples)\/[^/]*\.(?:txt|jsonl)$/u.test(lower)) return 'raw_evaluation_data';
  if (/(?:^|\/)tools\/_run-[^/]*\.js$/u.test(lower)) return 'local_api_runner';
  if (/(?:^|\/)(?:local[-_]?copykiller|copykiller[-_]?test[-_]?api)(?:\/|$)/u.test(lower)) {
    return 'local_copykiller_api';
  }
  if (lower.includes('gemini') || normalized.includes('제미나이')) return 'excluded_experiment';
  if (basename === '.npmrc' || basename === '.pypirc') return 'package_registry_secret';
  return '';
}

function scanStagedSecrets(root, stagedPaths) {
  const patterns = [
    { code: 'private_key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
    { code: 'openai_key', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u },
    { code: 'toss_live_secret', regex: /\blive_sk_[A-Za-z0-9_-]{12,}\b/u },
    { code: 'github_token', regex: /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}\b/u }
  ];
  const findings = [];
  for (const file of stagedPaths) {
    let content;
    try {
      content = git(root, ['show', `:${file}`], { maxBuffer: 2 * 1024 * 1024 });
    } catch {
      continue;
    }
    if (content.includes('\u0000') || Buffer.byteLength(content, 'utf8') > 1024 * 1024) continue;
    for (const pattern of patterns) {
      if (pattern.regex.test(content)) {
        findings.push({ path: file, code: pattern.code });
      }
    }
  }
  return findings;
}

function parseWorktreeList(raw) {
  const records = [];
  let current = null;
  for (const line of String(raw || '').split(/\r?\n/u)) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: line.slice('worktree '.length), head: '', branch: '' };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  if (current) records.push(current);
  return records;
}

function printHumanReport(report) {
  if (Array.isArray(report.reports)) {
    console.log(`[git-harness v${report.version}] worktree ${report.worktreeCount}개: ${report.ok ? 'PASS' : 'FAIL'}`);
    for (const child of report.reports) {
      console.log(`- ${child.ok ? 'PASS' : 'FAIL'} ${child.root} (${child.branch || 'detached'})`);
      printIssues(child.errors);
    }
    return;
  }
  console.log(`[git-harness v${report.version}] ${report.ok ? 'PASS' : 'FAIL'} ${report.mode}`);
  console.log(`- ${report.branch || 'detached'}@${String(report.head || '').slice(0, 12)} · ${report.clean ? 'clean' : 'dirty'}`);
  printIssues(report.errors);
  for (const warning of report.warnings || []) {
    console.log(`  WARN ${warning.code}: ${warning.message}`);
  }
}

function printIssues(errors = []) {
  for (const error of errors) {
    console.error(`  ERROR ${error.code}: ${error.message}`);
    for (const file of error.files || []) console.error(`    - ${file}`);
  }
}

function issue(code, message, files = []) {
  return { code, message, files: unique(files) };
}

function resolveRepositoryRoot(cwd) {
  return git(path.resolve(cwd), ['rev-parse', '--show-toplevel']).trim();
}

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024
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

function gitNull(cwd, args) {
  return git(cwd, args).split('\u0000').filter(Boolean);
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function sanitizeError(error) {
  return String(error?.stderr || error?.message || error).replace(/\s+/gu, ' ').trim().slice(0, 240);
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!String(arg).startsWith('--')) continue;
    const [key, ...rest] = String(arg).slice(2).split('=');
    out[key] = rest.length ? rest.join('=') : '1';
  }
  return out;
}

module.exports = {
  VERSION,
  evaluateRepository,
  inspectRepository,
  inspectAllWorktrees,
  inspectRemoteRelation,
  prohibitedPathReason,
  scanStagedSecrets,
  parseWorktreeList,
  parseArgs
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[git-harness] ${sanitizeError(error)}`);
    process.exitCode = 1;
  }
}
