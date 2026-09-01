'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { accountDeletionBlocksWrites } = require('../lib/accountActivityClaims');

const GRANT_ID = 'signup_credit_increase_20260901';
const GRANT_CREDITS = 15;
const PAGE_SIZE = 200;
const GRANT_DETAIL = '가입 무료 크레딧 10→25 상향 소급 지급';
const NOTIFICATION_MESSAGE = '가입 크레딧 상향에 맞춰 15크레딧을 지급했어요.';
const CURRENT_SIGNUP_GRANT = Object.freeze({
  schemaVersion: 1,
  source: 'account_initialize_v1',
  minimumCredits: 25
});

function cliError(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT', expose: true });
}

function validUid(value) {
  const uid = String(value || '').trim();
  return uid.length > 0 && uid.length <= 128 && !uid.includes('/');
}

function parseArgs(argv = []) {
  const options = { apply: false, uid: '', failureFile: '', help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--apply=1') {
      options.apply = true;
      continue;
    }
    if (arg === '--apply=0') continue;
    if (arg.startsWith('--uid=')) {
      const uid = arg.slice('--uid='.length).trim();
      if (!validUid(uid)) throw cliError('--uid는 슬래시가 없는 1~128자 문서 ID여야 합니다.');
      options.uid = uid;
      continue;
    }
    if (arg.startsWith('--failure-file=')) {
      const failureFile = arg.slice('--failure-file='.length).trim();
      if (!failureFile) throw cliError('--failure-file 경로가 비어 있습니다.');
      options.failureFile = path.resolve(failureFile);
      continue;
    }
    throw cliError(`지원하지 않는 인자입니다: ${arg}`);
  }
  return Object.freeze(options);
}

function normalizedCredits(value) {
  if (value === undefined || value === null || value === '') return 0;
  const credits = Number(value);
  if (!Number.isSafeInteger(credits) || credits < 0 || credits > Number.MAX_SAFE_INTEGER - GRANT_CREDITS) {
    throw Object.assign(new Error('INVALID_CREDIT_BALANCE'), { code: 'INVALID_CREDIT_BALANCE' });
  }
  return credits;
}

function hasCurrentSignupGrant(userData) {
  const grant = userData && typeof userData.signupCreditGrant === 'object'
    ? userData.signupCreditGrant
    : null;
  return Number(grant?.schemaVersion) === CURRENT_SIGNUP_GRANT.schemaVersion
    && grant?.source === CURRENT_SIGNUP_GRANT.source
    && Number(grant?.grantCredits) >= CURRENT_SIGNUP_GRANT.minimumCredits;
}

function buildGrantDocuments({ currentCredits, nowMs, serverTimestamp }) {
  const current = normalizedCredits(currentCredits);
  const next = current + GRANT_CREDITS;
  const createdAt = serverTimestamp();
  return Object.freeze({
    current,
    next,
    userUpdate: Object.freeze({
      credits: next,
      lastAdminCreditAdjustedAt: createdAt
    }),
    history: Object.freeze({
      type: 'admin_adjust',
      amount: GRANT_CREDITS,
      used: 0,
      remaining: next,
      detail: GRANT_DETAIL,
      adminUid: 'system',
      createdAt
    }),
    notification: Object.freeze({
      clientId: GRANT_ID,
      type: 'event',
      title: '크레딧 지급',
      message: NOTIFICATION_MESSAGE,
      action: Object.freeze({ tab: 'main' }),
      read: false,
      createdAt,
      createdAtMs: nowMs
    }),
    marker: Object.freeze({
      grantId: GRANT_ID,
      amount: GRANT_CREDITS,
      balanceBefore: current,
      balanceAfter: next,
      detail: GRANT_DETAIL,
      adminUid: 'system',
      createdAt,
      createdAtMs: nowMs
    })
  });
}

function createSummary(apply) {
  return {
    mode: apply ? 'apply' : 'dry-run',
    scanned: 0,
    eligible: 0,
    granted: 0,
    'skipped-deletion': 0,
    'skipped-already': 0,
    'skipped-new-grant': 0,
    'skipped-missing': 0,
    failed: 0
  };
}

function applyOutcome(summary, outcome) {
  if (outcome === 'eligible') summary.eligible += 1;
  else if (outcome === 'granted') {
    summary.eligible += 1;
    summary.granted += 1;
  } else if (Object.hasOwn(summary, outcome)) {
    summary[outcome] += 1;
  } else {
    throw new Error(`UNKNOWN_GRANT_OUTCOME:${outcome}`);
  }
}

function defaultFailureFile(nowMs, tempDir = os.tmpdir()) {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/gu, '-');
  return path.join(tempDir, `grant-existing-users-credits-failed-uids-${stamp}.json`);
}

function failureFilePayload(failedUids) {
  return `${JSON.stringify({ failedUids: [...failedUids] }, null, 2)}\n`;
}

async function writeFailureUids(filePath, failedUids, writeFile = fs.writeFile, mkdir = fs.mkdir) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, failureFilePayload(failedUids), { encoding: 'utf8', mode: 0o600 });
}

async function grantOneUser({ db, admin, uid, apply, now = Date.now }) {
  if (!validUid(uid)) throw cliError('유효하지 않은 사용자 문서 ID입니다.');
  const serverTimestamp = admin?.firestore?.FieldValue?.serverTimestamp;
  if (typeof serverTimestamp !== 'function') throw new Error('FIRESTORE_FIELD_VALUE_UNAVAILABLE');

  const userRef = db.collection('users').doc(uid);
  const deletionRef = db.collection('accountDeletionJobs').doc(uid);
  const markerRef = userRef.collection('creditGrants').doc(GRANT_ID);
  const historyRef = userRef.collection('creditHistory').doc(GRANT_ID);
  const notificationRef = userRef.collection('notifications').doc(GRANT_ID);

  return db.runTransaction(async transaction => {
    const [userSnapshot, deletionSnapshot, markerSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(deletionRef),
      transaction.get(markerRef)
    ]);

    if (!userSnapshot.exists) return { outcome: 'skipped-missing' };
    const userData = userSnapshot.data() || {};
    // Backend 배포 뒤 생성된 25크레딧 계정에는 소급분을 더해 40으로 만들면 안 된다.
    // 판정과 지급을 같은 트랜잭션의 user snapshot에 묶어 생성 경합에도 fail-safe로 닫는다.
    if (hasCurrentSignupGrant(userData)) return { outcome: 'skipped-new-grant' };
    const nowMs = Number(now());
    if (deletionSnapshot.exists
      && accountDeletionBlocksWrites(deletionSnapshot.data() || {}, nowMs)) {
      return { outcome: 'skipped-deletion' };
    }
    if (markerSnapshot.exists) return { outcome: 'skipped-already' };

    const documents = buildGrantDocuments({
      currentCredits: userData.credits,
      nowMs,
      serverTimestamp
    });
    if (!apply) return { outcome: 'eligible', current: documents.current, next: documents.next };

    // 무료 소급분은 의도적으로 lot에 넣지 않는다. 이 update에는 creditLotV1Balance가 없어야 한다.
    transaction.update(userRef, documents.userUpdate);
    transaction.set(historyRef, documents.history);
    transaction.set(notificationRef, documents.notification);
    transaction.set(markerRef, documents.marker);
    return { outcome: 'granted', current: documents.current, next: documents.next };
  });
}

async function fetchUserPage({ db, documentIdField, afterId = '', pageSize = PAGE_SIZE }) {
  let query = db.collection('users').orderBy(documentIdField).limit(pageSize);
  if (afterId) query = query.startAfter(afterId);
  return query.get();
}

async function runCreditGrant({
  db,
  admin,
  options,
  now = Date.now,
  pageSize = PAGE_SIZE,
  tempDir = os.tmpdir(),
  writeFailures = writeFailureUids
}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new Error('FIRESTORE_UNAVAILABLE');
  }
  const documentId = admin?.firestore?.FieldPath?.documentId;
  if (!options.uid && typeof documentId !== 'function') throw new Error('FIRESTORE_FIELD_PATH_UNAVAILABLE');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('INVALID_PAGE_SIZE');

  const summary = createSummary(options.apply);
  const failedUids = [];
  const processUid = async uid => {
    summary.scanned += 1;
    try {
      const result = await grantOneUser({ db, admin, uid, apply: options.apply, now });
      applyOutcome(summary, result.outcome);
    } catch (_) {
      summary.failed += 1;
      failedUids.push(uid);
    }
  };

  if (options.uid) {
    await processUid(options.uid);
  } else {
    const documentIdField = documentId();
    let afterId = '';
    while (true) {
      const snapshot = await fetchUserPage({ db, documentIdField, afterId, pageSize });
      const docs = Array.isArray(snapshot?.docs) ? snapshot.docs : [];
      for (const doc of docs) await processUid(doc.id);
      if (docs.length < pageSize) break;
      afterId = docs[docs.length - 1].id;
    }
  }

  let failedUidFile = '';
  if (failedUids.length > 0) {
    failedUidFile = options.failureFile || defaultFailureFile(Number(now()), tempDir);
    await writeFailures(failedUidFile, failedUids);
  }
  return { summary, failedUids, failedUidFile };
}

function usage() {
  return [
    '기본 실행은 Firestore를 변경하지 않는 dry-run입니다.',
    '  node scripts/grant-existing-users-credits.js',
    '  node scripts/grant-existing-users-credits.js --uid=<uid> --apply=1',
    '  node scripts/grant-existing-users-credits.js --apply=1',
    '선택: --failure-file=<path> (내용은 실패 UID 목록만 저장)'
  ].join('\n');
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    (deps.stdout || console.log)(usage());
    return { help: true };
  }

  const runtime = deps.runtime || require('../config');
  const result = await runCreditGrant({
    db: deps.db || runtime.db,
    admin: deps.admin || runtime.admin,
    options,
    now: deps.now || Date.now,
    pageSize: deps.pageSize || PAGE_SIZE,
    tempDir: deps.tempDir || os.tmpdir(),
    writeFailures: deps.writeFailures || writeFailureUids
  });
  const output = {
    ...result.summary,
    grantId: GRANT_ID,
    creditsPerUser: GRANT_CREDITS,
    ...(result.failedUidFile ? { failedUidFile: result.failedUidFile } : {})
  };
  (deps.stdout || console.log)(JSON.stringify(output));
  return result;
}

if (require.main === module) {
  main().then(result => {
    if (result?.summary?.failed > 0) process.exitCode = 1;
  }).catch(error => {
    const message = error?.expose ? error.message : '소급 지급 실행에 실패했습니다. 설정과 권한을 확인하세요.';
    console.error(message);
    process.exitCode = 1;
  });
}

module.exports = {
  GRANT_CREDITS,
  GRANT_DETAIL,
  GRANT_ID,
  NOTIFICATION_MESSAGE,
  PAGE_SIZE,
  CURRENT_SIGNUP_GRANT,
  applyOutcome,
  buildGrantDocuments,
  createSummary,
  defaultFailureFile,
  failureFilePayload,
  fetchUserPage,
  grantOneUser,
  hasCurrentSignupGrant,
  main,
  normalizedCredits,
  parseArgs,
  runCreditGrant,
  validUid,
  writeFailureUids
};
