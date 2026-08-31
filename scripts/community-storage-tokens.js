'use strict';

require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const appApi = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');
const tool = require('../lib/communityStorageTokenTool');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_DIR = path.join(ROOT, '.security-manifests');

function parseArgs(argv) {
  const out = { apply: false, rollback: '', bucket: '', pageSize: 500 };
  for (const arg of argv) {
    if (arg === '--apply') out.apply = true;
    else if (arg.startsWith('--rollback=')) out.rollback = arg.slice('--rollback='.length).trim();
    else if (arg.startsWith('--bucket=')) out.bucket = arg.slice('--bucket='.length).trim();
    else if (arg.startsWith('--page-size=')) out.pageSize = Number(arg.slice('--page-size='.length));
    else if (arg === '--help') out.help = true;
    else throw Object.assign(new Error('unknown_argument'), { code: 'unknown_argument' });
  }
  if (out.apply && out.rollback) throw Object.assign(new Error('conflicting_modes'), { code: 'conflicting_modes' });
  if (!Number.isFinite(out.pageSize) || out.pageSize < 1 || out.pageSize > 1000) {
    throw Object.assign(new Error('invalid_page_size'), { code: 'invalid_page_size' });
  }
  return out;
}

function safeManifestPath(value) {
  const candidate = path.resolve(MANIFEST_DIR, String(value || ''));
  const relative = path.relative(MANIFEST_DIR, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(candidate).toLowerCase() !== '.json') {
    throw Object.assign(new Error('invalid_manifest_path'), { code: 'invalid_manifest_path' });
  }
  return candidate;
}

function writeManifest(manifest) {
  fs.mkdirSync(MANIFEST_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const filename = `community-storage-token-backup-${stamp}-${crypto.randomBytes(4).toString('hex')}.json`;
  const target = safeManifestPath(filename);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, target);
  return target;
}

function readManifest(value) {
  const target = safeManifestPath(value);
  const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (!tool.verifyManifest(manifest)) throw Object.assign(new Error('manifest_integrity_failed'), { code: 'manifest_integrity_failed' });
  return { target, manifest };
}

function createBucket(bucketName) {
  if (!/^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/u.test(String(bucketName || ''))) {
    throw Object.assign(new Error('invalid_bucket'), { code: 'invalid_bucket' });
  }
  let app;
  try { app = appApi.getApp('community-storage-token-tool'); }
  catch {
    const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
    const credential = raw ? appApi.cert(JSON.parse(raw)) : appApi.applicationDefault();
    app = appApi.initializeApp({ credential, storageBucket: bucketName }, 'community-storage-token-tool');
  }
  return getStorage(app).bucket(bucketName);
}

function publicFailures(failures) {
  return (failures || []).slice(0, 20).map(item => ({ id: item.id, code: item.code }));
}

function summary(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    summary({
      usage: 'node scripts/community-storage-tokens.js [--bucket=<bucket>] [--apply | --rollback=<manifest.json>] [--page-size=500]',
      defaultMode: 'dry-run',
      fixedPrefix: tool.COMMUNITY_PREFIX
    });
    return 0;
  }

  if (args.rollback) {
    const { target, manifest } = readManifest(args.rollback);
    if (args.bucket && args.bucket !== manifest.bucket) throw Object.assign(new Error('bucket_mismatch'), { code: 'bucket_mismatch' });
    const bucket = createBucket(manifest.bucket);
    const salt = Buffer.from(manifest.idSalt, 'base64');
    const result = await tool.restoreTokens(bucket, manifest.entries, { salt });
    summary({ mode: 'rollback', manifest: path.basename(target), total: manifest.entries.length, restored: result.restored, failed: result.failures.length, failures: publicFailures(result.failures) });
    return result.failures.length ? 2 : 0;
  }

  const bucketName = args.bucket || String(process.env.FIREBASE_STORAGE_BUCKET || '').trim();
  if (!bucketName) throw Object.assign(new Error('bucket_required'), { code: 'bucket_required' });
  const bucket = createBucket(bucketName);
  const salt = crypto.randomBytes(32);
  const scan = await tool.scanTokenFiles(bucket, { pageSize: args.pageSize, salt });
  if (scan.failures.length) {
    summary({ mode: args.apply ? 'apply_preflight' : 'dry-run', scanned: scan.scanned, tokenBearing: scan.entries.length, failed: scan.failures.length, failures: publicFailures(scan.failures) });
    return 2;
  }
  if (!args.apply) {
    summary({ mode: 'dry-run', prefix: tool.COMMUNITY_PREFIX, scanned: scan.scanned, tokenBearing: scan.entries.length, changed: 0 });
    return 0;
  }

  const manifest = tool.sealManifest(tool.manifestPayload({ bucket: bucketName, entries: scan.entries, salt }));
  const manifestPath = writeManifest(manifest);
  const result = await tool.revokeTokens(bucket, scan.entries, { salt });
  summary({ mode: 'apply', manifest: path.basename(manifestPath), scanned: scan.scanned, tokenBearing: scan.entries.length, changed: result.changed, failed: result.failures.length, failures: publicFailures(result.failures) });
  return result.failures.length ? 2 : 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: tool.errorCode(error) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { MANIFEST_DIR, main, parseArgs, readManifest, safeManifestPath, writeManifest };
