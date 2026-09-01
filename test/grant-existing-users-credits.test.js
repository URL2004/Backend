'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GRANT_CREDITS,
  GRANT_DETAIL,
  GRANT_ID,
  NOTIFICATION_MESSAGE,
  buildGrantDocuments,
  failureFilePayload,
  grantOneUser,
  hasCurrentSignupGrant,
  parseArgs,
  runCreditGrant
} = require('../scripts/grant-existing-users-credits');

const SERVER_TIMESTAMP = Object.freeze({ serverTimestamp: true });
const DOCUMENT_ID = Object.freeze({ documentId: true });
const fakeAdmin = {
  firestore: {
    FieldValue: { serverTimestamp: () => SERVER_TIMESTAMP },
    FieldPath: { documentId: () => DOCUMENT_ID }
  }
};

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function fakeFirestore(seed = {}, options = {}) {
  let rows = new Map(Object.entries(seed).map(([key, value]) => [key, clone(value)]));
  const observations = { pages: [] };
  let transactionTail = Promise.resolve();

  function snapshot(ref, sourceRows) {
    const value = sourceRows.get(ref.path);
    return {
      id: ref.id,
      ref,
      exists: value !== undefined,
      data: () => clone(value)
    };
  }

  function documentRef(docPath) {
    return {
      id: docPath.split('/').at(-1),
      path: docPath,
      collection(name) {
        return collectionRef(`${docPath}/${name}`);
      }
    };
  }

  function queryFor(collectionPath, field) {
    const state = { field, limit: Infinity, afterId: '' };
    return {
      limit(value) {
        state.limit = value;
        return this;
      },
      startAfter(value) {
        state.afterId = value;
        return this;
      },
      async get() {
        observations.pages.push({
          collectionPath,
          field: state.field,
          limit: state.limit,
          afterId: state.afterId
        });
        const prefix = `${collectionPath}/`;
        const ids = [...rows.keys()]
          .filter(key => key.startsWith(prefix) && key.slice(prefix.length).split('/').length === 1)
          .map(key => key.slice(prefix.length))
          .filter(id => !state.afterId || id > state.afterId)
          .sort()
          .slice(0, state.limit);
        return { docs: ids.map(id => snapshot(documentRef(`${collectionPath}/${id}`), rows)) };
      }
    };
  }

  function collectionRef(collectionPath) {
    return {
      path: collectionPath,
      doc(id) {
        return documentRef(`${collectionPath}/${id}`);
      },
      orderBy(field) {
        return queryFor(collectionPath, field);
      }
    };
  }

  const db = {
    collection: collectionRef,
    async runTransaction(callback) {
      const previous = transactionTail;
      let release;
      transactionTail = new Promise(resolve => { release = resolve; });
      await previous;
      const draft = new Map([...rows].map(([key, value]) => [key, clone(value)]));
      const transaction = {
        async get(ref) {
          if (options.failPaths?.has(ref.path)) throw new Error('simulated firestore failure');
          return snapshot(ref, draft);
        },
        update(ref, data) {
          if (!draft.has(ref.path)) throw new Error('missing document');
          draft.set(ref.path, { ...draft.get(ref.path), ...clone(data) });
        },
        set(ref, data, setOptions = {}) {
          const next = setOptions.merge
            ? { ...(draft.get(ref.path) || {}), ...clone(data) }
            : clone(data);
          draft.set(ref.path, next);
        }
      };
      try {
        const result = await callback(transaction);
        rows = draft;
        return result;
      } finally {
        release();
      }
    }
  };

  return {
    db,
    observations,
    row: key => clone(rows.get(key)),
    paths: () => [...rows.keys()].sort()
  };
}

test('CLI는 기본 dry-run이며 쓰기는 정확히 --apply=1에서만 연다', () => {
  assert.deepEqual(parseArgs([]), { apply: false, uid: '', failureFile: '', help: false });
  assert.equal(parseArgs(['--apply=0']).apply, false);
  assert.deepEqual(parseArgs(['--uid=user-1', '--apply=1']), {
    apply: true,
    uid: 'user-1',
    failureFile: '',
    help: false
  });
  assert.throws(() => parseArgs(['--apply=true']), /지원하지 않는 인자/u);
  assert.throws(() => parseArgs(['--uid=bad/id']), /문서 ID/u);
});

test('지급 문서는 +15 원장·알림·마커를 만들고 lot 필드를 만들지 않는다', () => {
  const documents = buildGrantDocuments({
    currentCredits: 10,
    nowMs: 1234,
    serverTimestamp: fakeAdmin.firestore.FieldValue.serverTimestamp
  });
  assert.equal(GRANT_CREDITS, 15);
  assert.deepEqual(documents.userUpdate, {
    credits: 25,
    lastAdminCreditAdjustedAt: SERVER_TIMESTAMP
  });
  assert.equal(Object.hasOwn(documents.userUpdate, 'creditLotV1Balance'), false);
  assert.deepEqual(documents.history, {
    type: 'admin_adjust', amount: 15, used: 0, remaining: 25,
    detail: GRANT_DETAIL, adminUid: 'system', createdAt: SERVER_TIMESTAMP
  });
  assert.deepEqual(documents.notification, {
    clientId: GRANT_ID,
    type: 'event',
    title: '크레딧 지급',
    message: NOTIFICATION_MESSAGE,
    action: { tab: 'main' },
    read: false,
    createdAt: SERVER_TIMESTAMP,
    createdAtMs: 1234
  });
  assert.equal(documents.marker.grantId, GRANT_ID);
  assert.deepEqual([documents.marker.balanceBefore, documents.marker.balanceAfter], [10, 25]);
});

test('현재 가입 지급 메타는 schema·source·25크레딧 조건을 모두 만족할 때만 신규 계정으로 판정한다', () => {
  assert.equal(hasCurrentSignupGrant({
    signupCreditGrant: { schemaVersion: 1, source: 'account_initialize_v1', grantCredits: 25 }
  }), true);
  assert.equal(hasCurrentSignupGrant({
    signupCreditGrant: { schemaVersion: 1, source: 'account_initialize_v1', grantCredits: 40 }
  }), true);
  assert.equal(hasCurrentSignupGrant({
    signupCreditGrant: { schemaVersion: 1, source: 'legacy', grantCredits: 25 }
  }), false);
  assert.equal(hasCurrentSignupGrant({
    signupCreditGrant: { schemaVersion: 0, source: 'account_initialize_v1', grantCredits: 25 }
  }), false);
  assert.equal(hasCurrentSignupGrant({
    signupCreditGrant: { schemaVersion: 1, source: 'account_initialize_v1', grantCredits: 24 }
  }), false);
});

test('dry-run은 문서 ID로 페이지네이션하고 탈퇴·기지급 계정을 구분하되 쓰지 않는다', async () => {
  const nowMs = Date.UTC(2026, 8, 1);
  const store = fakeFirestore({
    'users/a': { credits: 10 },
    'users/b': { credits: 12 },
    'users/c': { credits: 20 },
    'users/d': {
      credits: 25,
      signupCreditGrant: { schemaVersion: 1, source: 'account_initialize_v1', grantCredits: 25 }
    },
    'accountDeletionJobs/b': { status: 'processing' },
    [`users/c/creditGrants/${GRANT_ID}`]: { grantId: GRANT_ID }
  });
  const before = store.paths();
  const result = await runCreditGrant({
    db: store.db,
    admin: fakeAdmin,
    options: parseArgs([]),
    now: () => nowMs,
    pageSize: 3
  });

  assert.deepEqual(result.summary, {
    mode: 'dry-run', scanned: 4, eligible: 1, granted: 0,
    'skipped-deletion': 1, 'skipped-already': 1, 'skipped-new-grant': 1,
    'skipped-missing': 0, failed: 0
  });
  assert.deepEqual(store.observations.pages, [
    { collectionPath: 'users', field: DOCUMENT_ID, limit: 3, afterId: '' },
    { collectionPath: 'users', field: DOCUMENT_ID, limit: 3, afterId: 'c' }
  ]);
  assert.deepEqual(store.paths(), before);
  assert.equal(store.row('users/a').credits, 10);
});

test('Backend 배포 뒤 생성된 25크레딧 신규 계정은 apply에서도 40크레딧으로 과지급하지 않는다', async () => {
  const store = fakeFirestore({
    'users/new-user': {
      credits: 25,
      signupCreditGrant: {
        schemaVersion: 1,
        source: 'account_initialize_v1',
        grantCredits: 25,
        remainingCredits: 25
      }
    }
  });
  const result = await grantOneUser({
    db: store.db,
    admin: fakeAdmin,
    uid: 'new-user',
    apply: true,
    now: () => Date.UTC(2026, 8, 1, 2)
  });

  assert.equal(result.outcome, 'skipped-new-grant');
  assert.equal(store.row('users/new-user').credits, 25);
  assert.equal(store.row(`users/new-user/creditGrants/${GRANT_ID}`), undefined);
  assert.equal(store.row(`users/new-user/creditHistory/${GRANT_ID}`), undefined);
  assert.equal(store.row(`users/new-user/notifications/${GRANT_ID}`), undefined);
});

test('apply는 결정론 ID로 원자 지급하며 재실행과 동시 실행에도 한 번만 반영한다', async () => {
  const nowMs = Date.UTC(2026, 8, 1, 1);
  const store = fakeFirestore({
    'users/user-a': { credits: 10, creditLotV1Balance: 7 },
    'accountDeletionJobs/user-a': { status: 'completed', protectUntilMs: nowMs - 1 }
  });

  const [first, second] = await Promise.all([
    grantOneUser({ db: store.db, admin: fakeAdmin, uid: 'user-a', apply: true, now: () => nowMs }),
    grantOneUser({ db: store.db, admin: fakeAdmin, uid: 'user-a', apply: true, now: () => nowMs })
  ]);
  assert.deepEqual([first.outcome, second.outcome].sort(), ['granted', 'skipped-already']);
  assert.equal(store.row('users/user-a').credits, 25);
  assert.equal(store.row('users/user-a').creditLotV1Balance, 7, '유료 lot 추적 잔액은 불변이어야 한다');
  assert.equal(store.row(`users/user-a/creditHistory/${GRANT_ID}`).remaining, 25);
  assert.equal(store.row(`users/user-a/notifications/${GRANT_ID}`).clientId, GRANT_ID);
  assert.equal(store.row(`users/user-a/creditGrants/${GRANT_ID}`).amount, 15);
});

test('단건 missing과 개별 실패를 요약하고 실패 파일에는 UID만 직렬화한다', async () => {
  const missingStore = fakeFirestore();
  const missing = await runCreditGrant({
    db: missingStore.db,
    admin: fakeAdmin,
    options: parseArgs(['--uid=missing']),
    now: () => 1000
  });
  assert.equal(missing.summary['skipped-missing'], 1);

  const failedStore = fakeFirestore({
    'users/good': { credits: 10 },
    'users/will-fail': { credits: 10, email: 'never-copy@example.test' }
  }, { failPaths: new Set(['users/will-fail']) });
  let saved = null;
  const failed = await runCreditGrant({
    db: failedStore.db,
    admin: fakeAdmin,
    options: parseArgs(['--failure-file=failed-uids.json']),
    now: () => 2000,
    writeFailures: async (filePath, uids) => {
      saved = { filePath, body: failureFilePayload(uids) };
    }
  });
  assert.equal(failed.summary.failed, 1);
  assert.deepEqual(failed.failedUids, ['will-fail']);
  assert.deepEqual(JSON.parse(saved.body), { failedUids: ['will-fail'] });
  assert.doesNotMatch(saved.body, /never-copy|firestore failure/u);
});
