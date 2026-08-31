'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  isFreshTimestamp,
  rememberInteraction,
  revenueActorDecision,
  verifySignature
} = require('../routes/discordBot');

test('Discord signature timestamp rejects stale and far-future requests', () => {
  const now = Date.UTC(2026, 7, 30, 12, 0, 0);
  assert.equal(isFreshTimestamp(String(now / 1000), now), true);
  assert.equal(isFreshTimestamp(String((now - 301000) / 1000), now), false);
  assert.equal(isFreshTimestamp(String((now + 61000) / 1000), now), false);
  assert.equal(isFreshTimestamp('not-a-time', now), false);
});

test('Discord Ed25519 verifier validates exact timestamp plus body', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const body = Buffer.from('{"type":1}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.sign(null, Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString('hex');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const rawPublicKeyHex = der.subarray(der.length - 32).toString('hex');
  assert.equal(verifySignature(body, signature, timestamp, rawPublicKeyHex), true);
  assert.equal(verifySignature(Buffer.from('{"type":2}'), signature, timestamp, rawPublicKeyHex), false);
});

test('revenue command is fail-closed without actor allowlist', () => {
  const body = { guild_id: 'g1', member: { user: { id: 'u1' }, roles: ['r1'] } };
  assert.deepEqual(revenueActorDecision(body, {}), { ok: false, reason: 'actor_allowlist_missing' });
});

test('revenue command accepts an allowed user or role only in an allowed guild', () => {
  const env = {
    DISCORD_REVENUE_ALLOWED_GUILD_IDS: 'g1,g2',
    DISCORD_REVENUE_ALLOWED_USER_IDS: 'u1',
    DISCORD_REVENUE_ALLOWED_ROLE_IDS: 'finance-role'
  };
  assert.equal(revenueActorDecision({ guild_id: 'g1', member: { user: { id: 'u1' }, roles: [] } }, env).ok, true);
  assert.equal(revenueActorDecision({ guild_id: 'g2', member: { user: { id: 'u9' }, roles: ['finance-role'] } }, env).ok, true);
  assert.equal(revenueActorDecision({ guild_id: 'evil', member: { user: { id: 'u1' }, roles: [] } }, env).ok, false);
  assert.equal(revenueActorDecision({ guild_id: 'g1', member: { user: { id: 'u9' }, roles: [] } }, env).ok, false);
});

test('Discord interaction replay cache accepts once within TTL', () => {
  const id = `interaction-${crypto.randomUUID()}`;
  assert.equal(rememberInteraction(id, 1000), true);
  assert.equal(rememberInteraction(id, 2000), false);
  assert.equal(rememberInteraction('', 2000), false);
});
