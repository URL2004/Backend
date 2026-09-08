#!/usr/bin/env node
'use strict';

const { buildHistoryLookupFields } = require('../lib/detectHistoryIndex');
const { accountDeletionBlocksWrites } = require('../lib/accountActivityClaims');
const { secret } = require('../lib/historyLinkIntegrity');

function failure(code) { return Object.assign(new Error(code), { code }); }
function validUid(uid) {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 128
    && uid.trim() === uid && !['.', '..'].includes(uid) && !/[\/\\\u0000-\u001f\u007f]/u.test(uid);
}
function parseArgs(args) {
  const options = { uid: '', apply: false, pageSize: 100 };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const match = /^(--[a-z-]+)(?:=(.*))?$/u.exec(args[i]);
    if (!match || seen.has(match[1])) throw failure('INVALID_ARGUMENTS');
    const [, flag, inline] = match; seen.add(flag);
    if (flag === '--apply' && inline === undefined) { options.apply = true; continue; }
    if (!['--uid', '--page-size'].includes(flag)) throw failure('INVALID_ARGUMENTS');
    const value = inline === undefined ? args[++i] : inline;
    if (typeof value !== 'string' || value.startsWith('--')) throw failure('INVALID_ARGUMENTS');
    if (flag === '--uid') options.uid = value;
    else {
      if (!/^[1-9]\d*$/u.test(value) || Number(value) > 500) throw failure('INVALID_ARGUMENTS');
      options.pageSize = Number(value);
    }
  }
  if (!validUid(options.uid)) throw failure('EXPLICIT_UID_REQUIRED');
  return options;
}
function requireWritableAccount(user, deletion) {
  if (!user.exists) throw failure('USER_MISSING');
  if (deletion.exists && accountDeletionBlocksWrites(deletion.data() || {})) throw failure('ACCOUNT_DELETION_IN_PROGRESS');
}
function changedFields(record, fields) {
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => record[key] !== value));
}

async function runBackfill({ db, uid, apply = false, pageSize = 100, onProgress = () => {} }) {
  if (!validUid(uid)) throw failure('EXPLICIT_UID_REQUIRED');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) throw failure('INVALID_ARGUMENTS');
  if (!secret()) throw failure('HISTORY_SECRET_REQUIRED');
  const counts = { mode: apply === true ? 'apply' : 'dry_run', pages: 0, scanned: 0, eligible: 0,
    planned: 0, updated: 0, unchanged: 0, skipped: 0, changedDuringScan: 0, deletedDuringScan: 0 };
  const userRef = db.collection('users').doc(uid);
  const deletionRef = db.collection('accountDeletionJobs').doc(uid);
  const history = userRef.collection('history');
  let cursor = null;
  try {
    while (true) {
      requireWritableAccount(...await Promise.all([userRef.get(), deletionRef.get()]));
      let query = history.orderBy('__name__').limit(pageSize);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (!page.docs.length) break;
      counts.pages++;
      for (const scanned of page.docs) {
        counts.scanned++;
        const record = scanned.data() || {};
        const fields = buildHistoryLookupFields(uid, record);
        if (!Object.keys(fields).length) { counts.skipped++; continue; }
        counts.eligible++;
        if (!Object.keys(changedFields(record, fields)).length) { counts.unchanged++; continue; }
        counts.planned++;
        if (apply !== true) continue;
        const outcome = await db.runTransaction(async transaction => {
          const currentRef = history.doc(scanned.id);
          const [user, deletion, current] = await Promise.all([
            transaction.get(userRef), transaction.get(deletionRef), transaction.get(currentRef)
          ]);
          requireWritableAccount(user, deletion);
          if (!current.exists) return 'deletedDuringScan';
          // Firestore retries concurrent writes. On retry, skip any version
          // different from the scanned record rather than overwriting it.
          if (!scanned.updateTime?.isEqual || !current.updateTime
            || !scanned.updateTime.isEqual(current.updateTime)) return 'changedDuringScan';
          const latest = current.data() || {};
          const verified = buildHistoryLookupFields(uid, latest);
          if (!Object.keys(verified).length) return 'changedDuringScan';
          const update = changedFields(latest, verified);
          if (!Object.keys(update).length) return 'unchanged';
          transaction.update(currentRef, update);
          return 'updated';
        });
        counts[outcome]++;
      }
      cursor = page.docs.at(-1);
      onProgress({ phase: 'progress', ...counts });
      if (page.docs.length < pageSize) break;
    }
    onProgress({ phase: 'complete', ...counts });
    return counts;
  } catch (error) {
    // Never include IDs, text, document references, or provider error strings.
    error.backfillCounts = { ...counts };
    throw error;
  }
}

async function main() {
  let app;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!secret()) throw failure('HISTORY_SECRET_REQUIRED');
    // Lazy SDK initialization: importing this script and pure tests never
    // initialize credentials, enumerate accounts, or contact Firestore.
    const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
    const { getFirestore } = require('firebase-admin/firestore');
    const credential = process.env.FIREBASE_SERVICE_ACCOUNT
      ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) : applicationDefault();
    app = initializeApp({ credential }, 'detect-history-index-backfill');
    await runBackfill({ ...options, db: getFirestore(app), onProgress: value => console.log(JSON.stringify(value)) });
  } catch (error) {
    const known = new Set(['INVALID_ARGUMENTS', 'EXPLICIT_UID_REQUIRED', 'HISTORY_SECRET_REQUIRED', 'USER_MISSING', 'ACCOUNT_DELETION_IN_PROGRESS']);
    console.error(JSON.stringify({ phase: 'failed', code: known.has(error?.code) ? error.code : 'BACKFILL_FAILED', ...(error?.backfillCounts || {}) }));
    process.exitCode = 1;
  } finally {
    if (app) {
      try { await require('firebase-admin/app').deleteApp(app); }
      catch { process.exitCode = 1; }
    }
  }
}

if (require.main === module) main();
module.exports = { parseArgs, runBackfill };
