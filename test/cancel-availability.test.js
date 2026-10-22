const test = require('node:test'), assert = require('node:assert/strict');
const { cancellationAvailability } = require('../lib/transformCancellation');
test('queued work remains cancellable after long waits; running window starts at execution, not admission', () => {
 const base = { uid: 'synthetic-user', createdAt: 1000 };
 assert.equal(cancellationAvailability({ ...base, status: 'queued' }, { nowMs: 1000000 }).canCancel, true);
 const running = { ...base, status: 'running', startedAt: 995000 };
 assert.equal(cancellationAvailability(running, { nowMs: 1000000 }).cancelRemainingSec, 40);
 assert.equal(cancellationAvailability(running, { nowMs: 1100000 }).cancelReason, 'TRANSFORM_CANCEL_WINDOW_CLOSED');
 for (const extra of [{ deducted: true }, { pendingCompletion: { outputText: 'synthetic' } }]) {
  assert.equal(cancellationAvailability({ ...running, ...extra }, { nowMs: 1000000 }).canCancel, false);
 }
 for (const status of ['done', 'blocked', 'error', 'cancelled']) assert.equal(cancellationAvailability({ ...base, status }).canCancel, false);
});
