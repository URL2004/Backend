'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  evaluateRepository,
  prohibitedPathReason
} = require('../scripts/git-harness');
const { installHooksForRepo } = require('../scripts/install-git-hooks');

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function makeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-harness-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Git Harness Test']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

test('clean 저장소만 manual·deploy 게이트를 통과한다', () => {
  const root = makeRepository();
  assert.equal(evaluateRepository({ root, mode: 'manual' }).ok, true);
  assert.equal(evaluateRepository({ root, mode: 'deploy' }).ok, true);

  fs.appendFileSync(path.join(root, 'tracked.txt'), 'dirty\n');
  const dirty = evaluateRepository({ root, mode: 'manual' });
  assert.equal(dirty.ok, false);
  assert.ok(dirty.errors.some(item => item.code === 'uncommitted_changes'));
});

test('전체 worktree 감사에서는 clean detached 작업공간을 경고로만 분리한다', () => {
  const root = makeRepository();
  git(root, ['checkout', '--detach']);
  const report = evaluateRepository({ root, mode: 'manual', allowDetached: true });
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some(item => item.code === 'detached_head'));
});

test('pre-commit은 unstaged·untracked 잔여 파일이 있는 부분 커밋을 차단한다', () => {
  const root = makeRepository();
  fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n');
  fs.writeFileSync(path.join(root, 'forgotten.txt'), 'forgotten\n');
  git(root, ['add', 'staged.txt']);

  const partial = evaluateRepository({ root, mode: 'pre-commit' });
  assert.equal(partial.ok, false);
  assert.ok(partial.errors.some(item => item.code === 'partial_commit_untracked'));

  git(root, ['add', 'forgotten.txt']);
  const complete = evaluateRepository({ root, mode: 'pre-commit' });
  assert.equal(complete.ok, true);
});

test('환경 비밀·로컬 결과·개인키·실험 파일 경로는 커밋 대상에서 제외한다', () => {
  assert.equal(prohibitedPathReason('.env'), 'environment_secret');
  assert.equal(prohibitedPathReason('.env.production'), 'environment_secret');
  assert.equal(prohibitedPathReason('.env.example'), '');
  assert.equal(prohibitedPathReason('results/replay.local.jsonl'), 'local_result_data');
  assert.equal(prohibitedPathReason('samples/user-original.txt'), 'raw_evaluation_data');
  assert.equal(prohibitedPathReason('secret/private.pem'), 'private_key_file');
  assert.equal(prohibitedPathReason('results/gemini-local-runs/a.json'), 'excluded_experiment');
});

test('staged 콘텐츠에 실제 비밀키 형태가 있으면 파일명과 무관하게 차단한다', () => {
  const root = makeRepository();
  fs.writeFileSync(
    path.join(root, 'config.txt'),
    `OPENAI_API_KEY=sk-proj-${'A'.repeat(32)}\n`
  );
  git(root, ['add', 'config.txt']);
  const report = evaluateRepository({ root, mode: 'pre-commit' });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(item => item.code === 'potential_secret'));
});

test('설치기는 저장소 공통 hooks 경로에 세 훅과 독립 하네스를 설치한다', () => {
  const root = makeRepository();
  const sourceRoot = path.resolve(__dirname, '..');
  const result = installHooksForRepo({ sourceRoot, repositoryPath: root });
  assert.equal(result.ok, true);
  assert.equal(git(root, ['config', '--get', 'core.hooksPath']).trim(), result.hooksPath);
  for (const name of ['git-harness.cjs', 'pre-commit', 'post-commit', 'pre-push']) {
    assert.equal(fs.existsSync(path.join(result.hooksPath, name)), true);
  }
});
