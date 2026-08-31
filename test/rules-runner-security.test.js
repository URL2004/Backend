'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-firestore-rules.ps1'), 'utf8');

test('Firebase rules runner propagates emulator test failures', () => {
  assert.match(runner, /if \(\$LASTEXITCODE -ne 0\)/u);
  assert.match(runner, /exit \$LASTEXITCODE/u);
});

test('Firebase rules runner strips debug and secret-bearing env before child process', () => {
  assert.match(runner, /\$env:DEBUG = \$null/u);
  assert.match(runner, /SECRET\|TOKEN\|PASSWORD/u);
  assert.ok(runner.indexOf('$env:DEBUG = $null') < runner.indexOf('npx firebase-tools'));
});
