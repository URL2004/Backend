'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  LIMITS,
  sanitizeHistoryEntry,
  createClientWriteService
} = require('../lib/clientWriteService');
const { createRouter } = require('../routes/clientData');

const SERVER_TIMESTAMP = Object.freeze({ __op: 'serverTimestamp' });
const DELETE_FIELD = Object.freeze({ __op: 'delete' });
const fakeAdmin = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => SERVER_TIMESTAMP,
      delete: () => DELETE_FIELD
    }
  }
};

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createStore(seed = {}) {
  let nextId = 1;
  const rows = new Map(Object.entries(seed).map(([key, value]) => [key, clone(value)]));
  function ref(path) {
    return {
      path,
      collection(name) { return collection(`${path}/${name}`); }
    };
  }
  function collection(path) {
    return {
      path,
      doc(id) { return ref(`${path}/${id || `auto-${nextId++}`}`); }
    };
  }
  function snapshot(path, state) {
    return {
      exists: state.has(path),
      data: () => clone(state.get(path))
    };
  }
  function applyPatch(current, patch) {
    const result = { ...(current || {}) };
    for (const [key, value] of Object.entries(patch || {})) {
      if (value && value.__op === 'delete') delete result[key];
      else result[key] = clone(value);
    }
    return result;
  }
  const db = {
    collection,
    async runTransaction(callback) {
      const draft = new Map([...rows.entries()].map(([key, value]) => [key, clone(value)]));
      const transaction = {
        get: async item => snapshot(item.path, draft),
        set(item, value, options = {}) {
          draft.set(item.path, options.merge ? applyPatch(draft.get(item.path), value) : clone(value));
        },
        update(item, value) {
          if (!draft.has(item.path)) throw new Error('not found');
          draft.set(item.path, applyPatch(draft.get(item.path), value));
        },
        delete(item) { draft.delete(item.path); }
      };
      const result = await callback(transaction);
      rows.clear();
      for (const [key, value] of draft) rows.set(key, value);
      return result;
    }
  };
  return { db, rows, row: path => clone(rows.get(path)), paths: () => [...rows.keys()] };
}

test('history backup strips untrusted fields, preserves document whitespace, and is idempotent', async () => {
  const store = createStore({ 'users/user-a': { name: '사용자', credits: 10 } });
  const service = createClientWriteService({ db: store.db, admin: fakeAdmin, now: () => Date.UTC(2026, 7, 30, 5) });
  const request = {
    uid: 'user-a',
    requestId: 'history-request-0001',
    entry: {
      type: 'humanize',
      inputText: '  원문\n',
      outputText: '\n결과  ',
      credits: 10,
      qualityStatus: 'clean',
      historyLinkIntegrity: 'forged',
      savedBy: 'server'
    }
  };
  const first = await service.backupHistory(request);
  const second = await service.backupHistory(request);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  const history = store.row(`users/user-a/history/${first.id}`);
  assert.equal(history.inputText, '  원문\n');
  assert.equal(history.outputText, '\n결과  ');
  assert.equal(history.historyLinkIntegrity, undefined);
  assert.equal(history.savedBy, 'client_backup_api');
  assert.equal(history.serverTrusted, false);
  const quota = store.paths().filter(path => path.startsWith('clientWriteQuotas/')).map(path => store.row(path));
  assert.equal(quota.length, 1);
  assert.equal(quota[0].hourCount, 1, '멱등 재시도는 quota를 두 번 쓰지 않아야 한다');
});

test('history validation rejects oversized fields and non-finite numeric values', () => {
  assert.throws(
    () => sanitizeHistoryEntry({ type: 'humanize', inputText: 'x'.repeat(60_001), credits: 1 }),
    error => error?.status === 413
  );
  assert.throws(
    () => sanitizeHistoryEntry({ type: 'detect', inputText: '글', credits: Number.NaN }),
    error => error?.code === 'INVALID_INPUT'
  );
  assert.throws(
    () => sanitizeHistoryEntry({ type: 'detect', inputText: '글', credits: 0, qualityWarningCodes: ['x'.repeat(81)] }),
    error => error?.status === 413
  );
});

test('durable hourly and daily quotas reject writes inside the Firestore transaction', async () => {
  const nowMs = Date.UTC(2026, 7, 30, 5, 10);
  const hourKey = new Date(nowMs).toISOString().slice(0, 13);
  const dayKey = new Date(nowMs).toISOString().slice(0, 10);
  const quotaSeed = {
    uid: 'user-a', action: 'history_backup', hourKey,
    hourCount: LIMITS.history_backup.hourly, dayKey, dayCount: 1
  };
  // Quota document IDs are UID-bound. Seed the exact target ID by first deriving
  // it through an allowed write, then replace its row.
  const derive = createStore({ 'users/user-a': { name: '사용자', credits: 10 } });
  const deriveService = createClientWriteService({ db: derive.db, admin: fakeAdmin, now: () => nowMs });
  await deriveService.backupHistory({ uid: 'user-a', requestId: 'derive-history-01', entry: { type: 'unknown', inputText: '', credits: 0 } });
  const exactQuotaPath = derive.paths().find(path => path.startsWith('clientWriteQuotas/'));
  const blockedStore = createStore({
    'users/user-a': { name: '사용자', credits: 10 },
    [exactQuotaPath]: quotaSeed,
  });
  const blocked = createClientWriteService({ db: blockedStore.db, admin: fakeAdmin, now: () => nowMs });
  await assert.rejects(
    blocked.backupHistory({ uid: 'user-a', requestId: 'blocked-history-01', entry: { type: 'unknown', inputText: '', credits: 0 } }),
    error => error?.status === 429 && error?.quotaScope === 'hourly' && error.retryAfterSec > 0
  );
  assert.equal(blockedStore.paths().some(path => path.includes('/history/')), false, '거절된 요청은 이력을 쓰지 않아야 한다');
});

test('Q&A creation trusts server profile, owner delete is enforced, and answer creates server notification', async () => {
  const store = createStore({
    'users/owner': { name: '실제 사용자', credits: 10 },
    'users/other': { name: '다른 사용자', credits: 10 }
  });
  const service = createClientWriteService({ db: store.db, admin: fakeAdmin, now: () => Date.UTC(2026, 7, 30, 6) });
  const created = await service.createQuestion({
    uid: 'owner', requestId: 'question-request-01', title: ' 문의 ', body: ' 내용 ', isAnon: false, fallbackName: '위조 이름'
  });
  const question = store.row(`qna/${created.id}`);
  assert.equal(question.authorName, '실제 사용자');
  assert.equal(question.title, '문의');
  await assert.rejects(
    service.deleteQuestion({ actorUid: 'other', questionId: created.id, isAdmin: false }),
    error => error?.status === 403
  );
  await service.saveAnswer({ adminUid: 'admin', questionId: created.id, body: '답변', answeredBy: '운영팀' });
  assert.equal(store.row(`qna/${created.id}`).status, 'answered');
  const notice = store.row(`users/owner/notifications/qna_answered_${created.id}`);
  assert.equal(notice.type, 'qna');
  assert.equal(notice.read, false);
  await service.deleteAnswer({ adminUid: 'admin', questionId: created.id });
  assert.equal(store.row(`qna/${created.id}`).status, 'pending');
  assert.equal(store.row(`users/owner/notifications/qna_answered_${created.id}`), undefined);
  await service.deleteQuestion({ actorUid: 'owner', questionId: created.id, isAdmin: false });
  assert.equal(store.row(`qna/${created.id}`), undefined);
});

test('account initialization is server-owned, idempotent, and records both UID and client quotas', async () => {
  const store = createStore();
  const service = createClientWriteService({ db: store.db, admin: fakeAdmin, now: () => Date.UTC(2026, 7, 30, 7) });
  const input = {
    uid: 'new-user-123', email: 'new@example.test', name: '신규', clientPrincipal: 'client_v1_hash',
    signupAttribution: {
      first_touch: {
        version: 1, captured_at: '2026-08-30T00:00:00.000Z', source: 'meta', medium: 'cpc',
        campaign: 'signup', content: '', term: '', napm: '', gclid: '', fbclid: 'click-1',
        use_case: 'assignment', landing_path: '/', landing_url: 'https://gpkorea.ai.kr/', referrer_host: ''
      },
      last_touch: {
        version: 1, captured_at: '2026-08-30T00:00:00.000Z', source: 'meta', medium: 'cpc',
        campaign: 'signup', content: '', term: '', napm: '', gclid: '', fbclid: 'click-1',
        use_case: 'assignment', landing_path: '/', landing_url: 'https://gpkorea.ai.kr/', referrer_host: ''
      }
    }
  };
  const first = await service.initializeAccount(input);
  const second = await service.initializeAccount({ ...input, email: 'attacker@example.test' });
  assert.equal(first.duplicate, false);
  assert.equal(first.credits, 10);
  assert.equal(second.duplicate, true);
  assert.equal(store.row('users/new-user-123').email, 'new@example.test');
  assert.equal(store.row('users/new-user-123').signupAttribution.first_touch.use_case, 'assignment');
  assert.deepEqual(store.row('accountSecurity/new-user-123'), {
    signupClientPrincipal: 'client_v1_hash',
    createdAtMs: Date.UTC(2026, 7, 30, 7),
    createdAt: SERVER_TIMESTAMP,
    source: 'account_initialize_v1'
  });
  const quotaRows = store.paths().filter(path => path.startsWith('clientWriteQuotas/')).map(path => store.row(path));
  assert.equal(quotaRows.length, 2);
  assert.deepEqual(new Set(quotaRows.map(row => row.action)), new Set(['account_initialize', 'account_initialize_ip']));
  assert.ok(quotaRows.every(row => row.hourCount === 1), '멱등 재호출은 추가 quota를 소모하지 않는다');
});

test('account initialization cannot recreate an account while deletion is active or protected', async () => {
  const nowMs = Date.UTC(2026, 7, 30, 7);
  for (const [status, protectUntilMs] of [
    ['processing', 0],
    ['retry_pending', 0],
    ['manual_review', 0],
    ['completed', nowMs + 60_000]
  ]) {
    const store = createStore({
      'accountDeletionJobs/deleting-user': { status, protectUntilMs }
    });
    const service = createClientWriteService({ db: store.db, admin: fakeAdmin, now: () => nowMs });
    await assert.rejects(
      service.initializeAccount({
        uid: 'deleting-user', email: 'new@example.test', name: '신규',
        clientPrincipal: 'client_v1_hash', signupAttribution: null
      }),
      error => error?.status === 409 && error?.code === 'ACCOUNT_DELETION_IN_PROGRESS'
    );
    assert.equal(store.row('users/deleting-user'), undefined, `${status} 상태에서 user를 재생성하면 안 된다`);
    assert.equal(
      store.paths().some(path => path.startsWith('clientWriteQuotas/')),
      false,
      `${status} 거절은 quota도 소비하면 안 된다`
    );
  }

  const expired = createStore({
    'accountDeletionJobs/deleting-user': { status: 'completed', protectUntilMs: nowMs - 1 }
  });
  const expiredService = createClientWriteService({ db: expired.db, admin: fakeAdmin, now: () => nowMs });
  const created = await expiredService.initializeAccount({
    uid: 'deleting-user', email: 'new@example.test', name: '신규',
    clientPrincipal: 'client_v1_hash', signupAttribution: null
  });
  assert.equal(created.duplicate, false);
  assert.equal(expired.row('users/deleting-user').credits, 10);
});

test('client-originated history, notification, and Q&A writes cannot race account deletion', async () => {
  const store = createStore({
    'users/deleting-user': { name: '탈퇴 사용자', credits: 10 },
    'accountDeletionJobs/deleting-user': { status: 'processing', leaseUntilMs: Date.now() + 60_000 },
    'qna/existing-question': {
      authorId: 'deleting-user', authorName: '탈퇴 사용자', title: '문의', body: '본문', status: 'pending'
    },
  });
  const service = createClientWriteService({ db: store.db, admin: fakeAdmin, now: () => Date.UTC(2026, 7, 30, 7, 30) });
  const blocked = error => error?.status === 409 && error?.code === 'ACCOUNT_DELETION_IN_PROGRESS';
  await assert.rejects(
    service.backupHistory({
      uid: 'deleting-user', requestId: 'history-delete-race',
      entry: { type: 'humanize', inputText: '원문', outputText: '결과', credits: 1 }
    }),
    blocked
  );
  await assert.rejects(
    service.createSelfNotification({
      uid: 'deleting-user', clientId: 'job_done_delete-race', type: 'job_done',
      message: '완료', action: { tab: 'history' }
    }),
    blocked
  );
  await assert.rejects(
    service.createQuestion({
      uid: 'deleting-user', requestId: 'question-delete-race', title: '문의', body: '본문', isAnon: false
    }),
    blocked
  );
  await assert.rejects(
    service.deleteQuestion({ actorUid: 'deleting-user', questionId: 'existing-question', isAdmin: false }),
    blocked
  );
  await assert.rejects(
    service.saveAnswer({ adminUid: 'admin', questionId: 'existing-question', body: '답변' }),
    blocked
  );
  assert.equal(store.paths().some(path => path.startsWith('clientWriteQuotas/')), false);
  assert.equal(store.paths().some(path => path.includes('/history/')), false);
  assert.equal(store.paths().some(path => path.includes('/notifications/')), false);
  assert.equal(store.row('qna/existing-question').status, 'pending');
});

test('self notifications enforce type-bound IDs and tabs, stay idempotent, and use a durable quota', async () => {
  const store = createStore({ 'users/user-a': { credits: 10 } });
  const service = createClientWriteService({ db: store.db, admin: fakeAdmin, now: () => Date.UTC(2026, 7, 30, 8) });
  const request = {
    uid: 'user-a',
    clientId: 'payment_order-123456',
    type: 'payment',
    message: '105크레딧이 충전됐어요.',
    action: { tab: 'pricing' }
  };
  const first = await service.createSelfNotification(request);
  const second = await service.createSelfNotification(request);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual(store.row('users/user-a/notifications/payment_order-123456'), {
    clientId: 'payment_order-123456',
    type: 'payment',
    title: '충전 완료',
    message: '105크레딧이 충전됐어요.',
    action: { tab: 'pricing' },
    read: false,
    createdAt: SERVER_TIMESTAMP,
    createdAtMs: Date.UTC(2026, 7, 30, 8),
    writeSource: 'self_notification_api'
  });
  const quotas = store.paths().filter(path => path.startsWith('clientWriteQuotas/')).map(path => store.row(path));
  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].action, 'notification_create');
  assert.equal(quotas[0].hourCount, 1, '멱등 재시도는 알림 quota를 두 번 쓰지 않아야 한다');

  await assert.rejects(
    service.createSelfNotification({ ...request, clientId: 'refund_order-123456' }),
    error => error?.code === 'INVALID_NOTIFICATION_ID'
  );
  await assert.rejects(
    service.createSelfNotification({ ...request, action: { tab: 'mypage' } }),
    error => error?.code === 'INVALID_NOTIFICATION_ACTION'
  );
  await assert.rejects(
    service.createSelfNotification({ ...request, message: 'x'.repeat(601) }),
    error => error?.status === 413
  );

  const quotaPath = store.paths().find(path => path.startsWith('clientWriteQuotas/'));
  store.rows.set(quotaPath, {
    uid: 'user-a', action: 'notification_create',
    hourKey: '2026-08-30T08', hourCount: LIMITS.notification_create.hourly,
    dayKey: '2026-08-30', dayCount: 1
  });
  await assert.rejects(
    service.createSelfNotification({ ...request, clientId: 'payment_order-654321' }),
    error => error?.status === 429 && error?.code === 'WRITE_QUOTA_EXCEEDED'
  );
  assert.equal(store.row('users/user-a/notifications/payment_order-654321'), undefined);
});

async function listen(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server, baseUrl: `http://127.0.0.1:${server.address().port}`
    }));
  });
}

test('write routes require Authorization Bearer and enforce user/admin permissions', async t => {
  const calls = [];
  const service = {
    backupHistory: async input => { calls.push(['history', input]); return { id: 'h1', duplicate: false }; },
    createQuestion: async input => { calls.push(['create', input]); return { id: 'q1', duplicate: false }; },
    deleteQuestion: async input => { calls.push(['delete', input]); return { id: input.questionId }; },
    saveAnswer: async input => { calls.push(['answer', input]); return { id: input.questionId }; },
    deleteAnswer: async input => { calls.push(['answer-delete', input]); return { id: input.questionId }; },
    createSelfNotification: async input => { calls.push(['notification', input]); return { id: input.clientId, duplicate: false }; },
    initializeAccount: async input => { calls.push(['account', input]); return { duplicate: false, credits: 10, createdAt: '2026-08-30T00:00:00.000Z' }; }
  };
  const router = createRouter({
    service,
    verifyFirebaseIdToken: async (token, options) => {
      assert.equal(options.checkRevoked, true);
      if (token === 'bad') throw new Error('revoked');
      return { uid: token, email: `${token}@example.test`, name: token };
    },
    verifyAdminToken: async token => !token ? null : (token === 'admin' ? 'admin' : false),
    clientPrincipal: () => 'client-hash',
    notifyInquiry: () => {}
  });
  const { server, baseUrl } = await listen(router);
  t.after(() => new Promise(resolve => server.close(resolve)));

  async function post(path, body, token, bodyToken) {
    const response = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ ...(body || {}), ...(bodyToken ? { idToken: bodyToken } : {}) })
    });
    return { status: response.status, body: await response.json() };
  }

  assert.equal((await post('/history/backup', {}, null, 'user-in-body')).status, 401, '바디 토큰 폴백을 허용하면 안 된다');
  assert.equal((await post('/history/backup', {}, 'bad')).status, 401);
  assert.equal((await post('/history/backup', { requestId: 'request-01', entry: {} }, 'user-a')).status, 201);
  assert.equal((await post('/notifications/create-self', {
    clientId: 'job_done_job-123456', type: 'job_done', message: '완료', action: { tab: 'history' }
  }, 'user-a')).status, 201);
  assert.equal((await post('/admin/qna/answer', { id: 'q1', body: '답변' }, 'user-a')).status, 403);
  assert.equal((await post('/admin/qna/answer', { id: 'q1', body: '답변' }, 'admin')).status, 200);
  assert.equal(calls.some(([name]) => name === 'history'), true);
  assert.equal(calls.some(([name]) => name === 'notification'), true);
  assert.equal(calls.some(([name]) => name === 'answer'), true);
});
