'use strict';

const { gzipSync, gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const diagnostics = require('../engine-gpt-prod/semanticDiagnostics');
// Server-only collection (Firestore's deny-by-default rule). List queries on
// transformJobArchive never download these private, potentially large records.
const COLLECTION = 'transformSemanticAudits';
const FORMAT = 'semantic-gzip-v1';
const MAX_COMPRESSED_BYTES = 700 * 1024;
const MAX_TOTAL_COMPRESSED_BYTES = 900 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');

function document(job, now = Date.now()) {
  if (job.semanticAuditTrace === undefined) return null;
  const identity = { uid: job.uid, jobId: job.id, updatedAtMs: now };
  if (job.semanticAuditTrace === null) return { ...identity, invalidated: true };
  const raw = Buffer.from(JSON.stringify(job.semanticAuditTrace), 'utf8');
  if (raw.length > diagnostics.MAX_BYTES) throw new Error('SEMANTIC_EVIDENCE_TOO_LARGE');
  const payload = gzipSync(raw, { level: 4 });
  if (payload.length > MAX_COMPRESSED_BYTES) throw new Error('SEMANTIC_EVIDENCE_TOO_LARGE');
  const record = { ...identity, format: FORMAT, invalidated: false, payload,
    contentDigest: digest(raw), uncompressedBytes: raw.length };
  if (job.status === 'blocked' && job.blockedAuditContext) {
    const context = Buffer.from(JSON.stringify(job.blockedAuditContext), 'utf8');
    if (context.length > diagnostics.MAX_BYTES) throw new Error('BLOCKED_EVIDENCE_TOO_LARGE');
    const blockedPayload = gzipSync(context, { level: 4 });
    if (blockedPayload.length + payload.length > MAX_TOTAL_COMPRESSED_BYTES) throw new Error('BLOCKED_EVIDENCE_TOO_LARGE');
    Object.assign(record, { blockedPayload, blockedDigest: digest(context), blockedBytes: context.length });
  }
  return record;
}

// Only the authenticated administrator endpoint may return these rejected
// texts. The public history reader below deliberately ignores this payload.
function forBlockedAdmin(record, { uid, jobId }) {
  if (!record) return { available: false, reason: 'not_recorded' };
  if (record.uid !== uid || record.jobId !== jobId) return { available: false, reason: 'owner_mismatch' };
  if (record.invalidated || !record.blockedPayload) return { available: false, reason: 'not_recorded' };
  try {
    if (record.format !== FORMAT || !(record.blockedPayload instanceof Uint8Array)
        || record.blockedPayload.length + (record.payload?.length || 0) > MAX_TOTAL_COMPRESSED_BYTES) throw Error('invalid size');
    const raw = gunzipSync(record.blockedPayload, { maxOutputLength: diagnostics.MAX_BYTES });
    if (raw.length !== record.blockedBytes || digest(raw) !== record.blockedDigest) throw Error('invalid binding');
    const context = JSON.parse(raw.toString('utf8'));
    if (context.version !== 1 || typeof context.source !== 'string' || typeof context.candidate !== 'string') throw Error('invalid content');
    const audit = forHistory(record, { uid, jobId, source: context.source, candidate: context.candidate });
    if (!audit.available) return audit;
    return { available: true, ...context, audit, delivered: false };
  } catch { return { available: false, reason: 'invalid_evidence' }; }
}

function forHistory(record, { uid, jobId, source, candidate }) {
  if (!record) return { available: false, reason: 'not_recorded' };
  if (record.uid !== uid || record.jobId !== jobId) return { available: false, reason: 'owner_mismatch' };
  if (record.invalidated) return { available: false, reason: 'output_changed' };
  try {
    if (record.format !== FORMAT || !(record.payload instanceof Uint8Array)
        || record.payload.length > MAX_COMPRESSED_BYTES) throw new Error('invalid payload');
    const raw = gunzipSync(record.payload, { maxOutputLength: diagnostics.MAX_BYTES });
    if (raw.length !== record.uncompressedBytes || digest(raw) !== record.contentDigest) throw new Error('invalid binding');
    return diagnostics.forHistory(JSON.parse(raw.toString('utf8')), source, candidate);
  } catch {
    return { available: false, reason: 'invalid_evidence' };
  }
}

module.exports = { COLLECTION, FORMAT, MAX_COMPRESSED_BYTES, document, forHistory, forBlockedAdmin };
