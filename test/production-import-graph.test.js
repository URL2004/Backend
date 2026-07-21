'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scanProductionImports } = require('../scripts/check-production-imports');

test('production import graph excludes labs, experimental, and legacy engines', () => {
  const report = scanProductionImports();
  assert.equal(report.pass, true, JSON.stringify(report.violations, null, 2));
  assert.equal(report.violations.length, 0);
  assert.ok(report.visitedFileCount > 10);
});
