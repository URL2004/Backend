'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { logger, runWithLogContext } = require('../lib/logger');
test('research shadow does not inherit identity or text from request logging context', () => {
  const original = process.stdout.write; let output = '';
  process.stdout.write = chunk => { output += String(chunk); return true; };
  try {
    runWithLogContext({ uid: 'private-user', actorUid: 'private-actor', requestId: 'trace-id', clientHash: 'private-client', inputText: 'private-input' }, () => {
      logger.info('detect_report.evidence_shadow', { candidateScore: 77, applied: false, uid: 'explicit-private-user', text: 'explicit-private-text' });
    });
  } finally { process.stdout.write = original; }
  const record = output.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)).find(r => r.event === 'detect_report.evidence_shadow');
  assert(record); assert.equal(record.requestId, 'trace-id'); assert.equal(record.candidateScore, 77);
  for (const key of ['uid', 'actorUid', 'clientHash', 'inputText', 'text']) assert.equal(record[key], undefined);
  assert(!JSON.stringify(record).includes('private-'));
});
