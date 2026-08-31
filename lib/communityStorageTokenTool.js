'use strict';

const crypto = require('node:crypto');

const COMMUNITY_PREFIX = 'community_photos/';
const TOKEN_KEY = 'firebaseStorageDownloadTokens';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorCode(error) {
  const raw = error && (error.code ?? error.statusCode ?? error.status);
  return raw == null ? 'operation_failed' : String(raw).slice(0, 40);
}

function retryable(error) {
  const code = errorCode(error).toUpperCase();
  const numeric = Number(code);
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(numeric)
    || /^(EAI_AGAIN|ECONNRESET|ETIMEDOUT|EPIPE|ENETUNREACH)$/u.test(code);
}

async function withRetry(operation, options = {}) {
  const attempts = Math.max(1, Math.min(6, Number(options.attempts) || 3));
  const baseDelayMs = Math.max(0, Math.min(5000, Number(options.baseDelayMs) || 150));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !retryable(error)) throw error;
      await (options.sleep || sleep)(baseDelayMs * (2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

function fingerprintName(name, salt) {
  return crypto.createHmac('sha256', salt).update(String(name || ''), 'utf8').digest('hex').slice(0, 16);
}

function downloadToken(metadata) {
  const value = metadata && metadata.metadata && metadata.metadata[TOKEN_KEY];
  return typeof value === 'string' && value.trim() ? value : '';
}

function preconditionedFile(bucket, entry) {
  if (!bucket || typeof bucket.file !== 'function') return entry.file;
  const metageneration = Number(entry.metageneration);
  const generation = entry.generation == null ? undefined : String(entry.generation);
  const options = {};
  if (generation) options.generation = generation;
  if (Number.isFinite(metageneration)) {
    options.preconditionOpts = { ifMetagenerationMatch: metageneration };
  }
  return bucket.file(entry.name, options);
}

async function listFilesPaginated(bucket, options = {}) {
  const prefix = options.prefix || COMMUNITY_PREFIX;
  const maxResults = Math.max(1, Math.min(1000, Number(options.pageSize) || 500));
  const files = [];
  const seenTokens = new Set();
  let pageToken;
  do {
    const query = { prefix, maxResults, autoPaginate: false };
    if (pageToken) query.pageToken = pageToken;
    const response = await withRetry(() => bucket.getFiles(query), options.retry);
    const pageFiles = Array.isArray(response && response[0]) ? response[0] : [];
    files.push(...pageFiles.filter(file => String(file && file.name || '').startsWith(prefix)));
    const nextQuery = response && response[1];
    const next = nextQuery && String(nextQuery.pageToken || '').trim();
    if (next && seenTokens.has(next)) throw Object.assign(new Error('pagination_loop'), { code: 'pagination_loop' });
    if (next) seenTokens.add(next);
    pageToken = next || undefined;
  } while (pageToken);
  return files;
}

async function scanTokenFiles(bucket, options = {}) {
  const salt = options.salt || crypto.randomBytes(32);
  const files = await listFilesPaginated(bucket, options);
  const entries = [];
  const failures = [];
  for (const file of files) {
    try {
      const response = await withRetry(() => file.getMetadata(), options.retry);
      const metadata = response && response[0] ? response[0] : {};
      const token = downloadToken(metadata);
      if (!token) continue;
      entries.push({
        name: String(file.name),
        token,
        generation: metadata.generation == null ? null : String(metadata.generation),
        metageneration: metadata.metageneration == null ? null : String(metadata.metageneration)
      });
    } catch (error) {
      failures.push({ id: fingerprintName(file && file.name, salt), code: errorCode(error) });
    }
  }
  return { scanned: files.length, entries, failures, salt };
}

async function revokeTokens(bucket, entries, options = {}) {
  const salt = options.salt || crypto.randomBytes(32);
  const failures = [];
  let changed = 0;
  for (const entry of entries) {
    try {
      const file = preconditionedFile(bucket, entry);
      await withRetry(() => file.setMetadata({ metadata: { [TOKEN_KEY]: null } }), options.retry);
      changed += 1;
    } catch (error) {
      failures.push({ id: fingerprintName(entry.name, salt), code: errorCode(error) });
    }
  }
  return { changed, failures };
}

async function restoreTokens(bucket, entries, options = {}) {
  const salt = options.salt || crypto.randomBytes(32);
  const failures = [];
  let restored = 0;
  for (const entry of entries) {
    try {
      if (!String(entry.name || '').startsWith(COMMUNITY_PREFIX) || typeof entry.token !== 'string' || !entry.token) {
        throw Object.assign(new Error('invalid_manifest_entry'), { code: 'invalid_manifest_entry' });
      }
      const currentFile = bucket.file(entry.name);
      const response = await withRetry(() => currentFile.getMetadata(), options.retry);
      const current = response && response[0] ? response[0] : {};
      const existing = downloadToken(current);
      if (existing && existing !== entry.token) {
        throw Object.assign(new Error('token_conflict'), { code: 'token_conflict' });
      }
      if (existing === entry.token) {
        restored += 1;
        continue;
      }
      const file = preconditionedFile(bucket, {
        ...entry,
        generation: current.generation,
        metageneration: current.metageneration
      });
      await withRetry(() => file.setMetadata({ metadata: { [TOKEN_KEY]: entry.token } }), options.retry);
      restored += 1;
    } catch (error) {
      failures.push({ id: fingerprintName(entry.name, salt), code: errorCode(error) });
    }
  }
  return { restored, failures };
}

function manifestPayload(input) {
  return {
    schemaVersion: 1,
    operation: 'community_storage_download_token_revoke',
    bucket: String(input.bucket),
    prefix: COMMUNITY_PREFIX,
    createdAt: input.createdAt || new Date().toISOString(),
    idSalt: Buffer.from(input.salt).toString('base64'),
    entries: input.entries.map(entry => ({
      name: entry.name,
      token: entry.token,
      generation: entry.generation,
      metageneration: entry.metageneration
    }))
  };
}

function signManifest(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function sealManifest(payload) {
  return { ...payload, integritySha256: signManifest(payload) };
}

function verifyManifest(manifest) {
  if (!manifest
      || manifest.schemaVersion !== 1
      || manifest.operation !== 'community_storage_download_token_revoke'
      || manifest.prefix !== COMMUNITY_PREFIX
      || typeof manifest.bucket !== 'string'
      || !manifest.bucket
      || typeof manifest.idSalt !== 'string'
      || Buffer.from(manifest.idSalt, 'base64').length !== 32
      || !Array.isArray(manifest.entries)
      || manifest.entries.some(entry => !String(entry && entry.name || '').startsWith(COMMUNITY_PREFIX)
        || typeof entry.token !== 'string' || !entry.token)) {
    return false;
  }
  const { integritySha256, ...payload } = manifest;
  const expected = signManifest(payload);
  return typeof integritySha256 === 'string'
    && integritySha256.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(integritySha256), Buffer.from(expected));
}

module.exports = {
  COMMUNITY_PREFIX,
  TOKEN_KEY,
  downloadToken,
  errorCode,
  fingerprintName,
  listFilesPaginated,
  manifestPayload,
  restoreTokens,
  retryable,
  revokeTokens,
  scanTokenFiles,
  sealManifest,
  verifyManifest,
  withRetry
};
