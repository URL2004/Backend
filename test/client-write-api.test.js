'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  LIMITS,
  SIGNUP_GRANT_CREDITS,
  consumeQuota,
  sanitizeHistoryEntry,
  createClientWriteService
} = require('../lib/clientWriteService');
const { EVENT_RETENTION_MS, SIGNUP_CREDIT_EVENT_COLLECTION } = require('../lib/signupCreditMonitoring');
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

test('signed detection backup preserves analysis interpretation while forged descriptors remain untrusted', async t => {
  const { buildDetectInterpretation } = require('../lib/detectInterpretation');
  const { signDetectInterpretation } = require('../lib/detectHistoryPresentation');
  const previous = process.env.OPENAI_SAFETY_SALT;
  process.env.OPENAI_SAFETY_SALT = 'backup-proof-test-secret-at-least-thirty-two-characters';
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_SAFETY_SALT; else process.env.OPENAI_SAFETY_SALT = previous; });
  const inputText = '합성 자료의 관찰 결과와 검토 절차를 구분하여 기록했다. '.repeat(20);
  const interpretation = buildDetectInterpretation({ probability: 32, probSource: 'llm', confidence: 'high', textLength: inputText.length, sentenceTotal: 20, causeCoverageStatus: 'aligned', signalEvidence: [{ category: 'ending_repetition', strength: 'strong', scope: 'recurring', locationStatus: 'source_range_verified', locations: [{ sentenceIndex: 0, start: 0, end: 28 }, { sentenceIndex: 1, start: 29, end: 57 }] }] });
  const interpretationProof = signDetectInterpretation('user-a', inputText, interpretation);
  assert.ok(interpretationProof);
  assert.equal(typeof interpretationProof, 'string', 'the public API and browser backup forward one opaque string');
  assert.match(interpretationProof, /^detect-interpretation-proof-v1\.[A-Za-z0-9_-]{43}$/u);
  const original = { type: 'detect', inputText, probability: 32, interpretation, interpretationProof, credits: 3 };
  const store = createStore({ 'users/user-a': { credits: 10 }, 'users/user-b': { credits: 10 } });
  const service = createClientWriteService({ db: store.db, admin: fakeAdmin });
  const saved = await service.backupHistory({ uid: 'user-a', requestId: 'signed-history-001', entry: original });
  const readback = store.row(`users/user-a/history/${saved.id}`);
  assert.deepEqual(readback.interpretation, interpretation);
  assert.equal(readback.serverTrusted, false, 'presentation proof does not promote unrelated billing/history provenance');
  assert.equal(readback.interpretationProof, undefined);
  for (const [name, uid, entry] of [
    ['unsigned', 'user-a', { ...original, interpretationProof: undefined }],
    ['tampered', 'user-a', { ...original, interpretation: { ...interpretation, headline: 'AI 작성 확률 100%' } }],
    ['other-owner', 'user-b', original],
    ['changed-source', 'user-a', { ...original, inputText: inputText.replace('합성', '수정') }],
    ['changed-score', 'user-a', { ...original, probability: 90 }],
    ['wrong-version', 'user-a', { ...original, interpretationProof: interpretationProof.replace('-v1.', '-v2.') }],
    ['object-proof', 'user-a', { ...original, interpretationProof: { version: 'detect-interpretation-proof-v1', signature: interpretationProof.split('.')[1] } }],
    ['trailing-proof', 'user-a', { ...original, interpretationProof: `${interpretationProof}.extra` }]
  ]) {
    const result = await service.backupHistory({ uid, requestId: `signed-history-${name}`, entry });
    const row = store.row(`users/${uid}/history/${result.id}`);
    assert.equal(row.interpretation.status, 'unavailable', name);
    assert.equal(row.interpretation.evidence.level, 'limited', name);
    assert.equal(row.interpretation.pattern, null, name);
    assert.equal(row.inputText, entry.inputText);
    assert.doesNotMatch(row.interpretation.headline, /작성 확률/);
  }
  delete process.env.OPENAI_SAFETY_SALT;
  assert.equal(signDetectInterpretation('user-a', inputText, interpretation), null, 'missing optional key must not block a result');
});

test('HTTP signed backup preserves exact CRLF source bytes and analysis locations through storage', async t => {
  const { buildDetectInterpretation } = require('../lib/detectInterpretation');
  const { signDetectInterpretation, verifiedBackupInterpretation } = require('../lib/detectHistoryPresentation');
  const { groundSignals, sourceSentences } = require('../lib/detectGrounding');
  const { locatePublicEvidence } = require('../lib/detectInputDocument');
  const previous = process.env.OPENAI_SAFETY_SALT;
  process.env.OPENAI_SAFETY_SALT = 'http-crlf-backup-proof-secret-at-least-thirty-two-characters';
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_SAFETY_SALT; else process.env.OPENAI_SAFETY_SALT = previous; });
  const paragraph = '합성 검증 자료의 관찰 결과와 검토 절차를 구분하여 기록했다. '.repeat(10);
  const inputText = `\r\n  ${paragraph}\r\n\r\n${paragraph}  \r\n`;
  const signalEvidence = locatePublicEvidence(groundSignals([{ category: 'ending_repetition', strength: 'strong', scope: 'recurring', evidenceSentences: [0, 12] }], inputText.trim()), inputText);
  const interpretation = buildDetectInterpretation({ probability: 32, probSource: 'llm', confidence: 'high', textLength: inputText.length, sentenceTotal: sourceSentences(inputText).length, causeCoverageStatus: 'aligned', signalEvidence });
  const interpretationProof = signDetectInterpretation('user-crlf', inputText, interpretation);
  const entry = { type: 'detect', inputText, probability: 32, interpretation, interpretationProof, credits: 3 };
  assert.ok(sanitizeHistoryEntry(entry).inputText.length < inputText.length, 'fixture exercises normalization before the signed override');
  const store = createStore({ 'users/user-crlf': { credits: 100 } });
  const service = createClientWriteService({ db: store.db, admin: fakeAdmin });
  const router = createRouter({ service, verifyFirebaseIdToken: async () => ({ uid: 'user-crlf' }) });
  const { server, baseUrl } = await listen(router, '1mb');
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function postBackup(requestId, value) {
    const response = await fetch(`${baseUrl}/history/backup`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer crlf-token' }, body: JSON.stringify({ requestId, entry: value }) });
    return { status: response.status, body: await response.json() };
  }
  const response = await postBackup('http-crlf-signed-001', entry);
  assert.equal(response.status, 201);
  const readback = store.row(`users/user-crlf/history/${response.body.id}`);
  assert.equal(readback.inputText, inputText);
  assert.equal(Buffer.compare(Buffer.from(readback.inputText), Buffer.from(inputText)), 0);
  assert.equal(readback.inputText.length, interpretation.sample.characters);
  assert.deepEqual(readback.interpretation, interpretation);
  assert.deepEqual(verifiedBackupInterpretation('user-crlf', { ...readback, interpretationProof }), interpretation);
  for (const loc of signalEvidence[0].locations) assert.equal(readback.inputText.slice(loc.start, loc.end), inputText.slice(loc.start, loc.end));
  const changed = await postBackup('http-crlf-tampered-001', { ...entry, inputText: inputText.replace('합성', '수정') });
  assert.equal(changed.status, 201);
  assert.equal(store.row(`users/user-crlf/history/${changed.body.id}`).interpretation.status, 'unavailable');
  const oversized = await postBackup('http-crlf-too-long-001', { ...entry, inputText: '\r\n'.repeat(30001) });
  assert.equal(oversized.status, 413, 'raw chars remain bounded even if normalization would halve their length');
  const invalid = await postBackup('http-crlf-invalid-001', { ...entry, inputText: ['not a string'] });
  assert.equal(invalid.status, 400);
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

test('account principal hard quota error exposes only structured threshold fields', async () => {
  const nowMs = Date.UTC(2026, 7, 30, 5, 10);
  const iso = new Date(nowMs).toISOString();
  await assert.rejects(
    consumeQuota({ get: async () => null }, { path: 'unused' }, {
      uid: 'never-return-this-principal',
      action: 'account_initialize_ip',
      nowMs,
      fieldValue: fakeAdmin.firestore.FieldValue,
      snapshot: {
        exists: true,
        data: () => ({
          hourKey: iso.slice(0, 13),
          hourCount: LIMITS.account_initialize_ip.hourly,
          dayKey: iso.slice(0, 10),
          dayCount: 20
        })
      }
    }),
    error => error?.status === 429
      && error.quotaAction === 'account_initialize_ip'
      && error.quotaScope === 'hourly'
      && error.quotaCount === 10
      && error.quotaLimit === 10
      && error.grantCredits === SIGNUP_GRANT_CREDITS
      && !JSON.stringify(error).includes('never-return-this-principal')
  );
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
  assert.equal(first.credits, SIGNUP_GRANT_CREDITS);
  assert.equal(second.duplicate, true);
  assert.equal(store.row('users/new-user-123').email, 'new@example.test');
  assert.equal(store.row('users/new-user-123').signupAttribution.first_touch.use_case, 'assignment');
  assert.deepEqual(store.row('users/new-user-123').signupCreditGrant, {
    schemaVersion: 1,
    grantCredits: SIGNUP_GRANT_CREDITS,
    remainingCredits: SIGNUP_GRANT_CREDITS,
    netUsedCredits: 0,
    spendEventCount: 0,
    restoreEventCount: 0,
    grantedAtMs: Date.UTC(2026, 7, 30, 7),
    lastEventAtMs: Date.UTC(2026, 7, 30, 7),
    source: 'account_initialize_v1'
  });
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
  const eventPaths = store.paths().filter(path => path.startsWith(`${SIGNUP_CREDIT_EVENT_COLLECTION}/`));
  assert.equal(eventPaths.length, 1, '가입 재시도에도 grant 측정 이벤트는 하나여야 한다');
  const event = store.row(eventPaths[0]);
  assert.equal(event.eventType, 'grant');
  assert.equal(event.creditAmount, SIGNUP_GRANT_CREDITS);
  assert.ok(event.expireAt instanceof Date);
  assert.equal(event.expireAt.getTime() - event.occurredAtMs, EVENT_RETENTION_MS);
  assert.match(event.accountKey, /^account_v1_[a-f0-9]{32}$/u);
  assert.match(event.principalKey, /^principal_v1_[a-f0-9]{32}$/u);
  assert.doesNotMatch(JSON.stringify(event), /new-user-123|new@example\.test|client_v1_hash/u);
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
  assert.equal(expired.row('users/deleting-user').credits, SIGNUP_GRANT_CREDITS);
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

async function listen(router, jsonLimit = '100kb') {
  const app = express();
  app.use(express.json({ limit: jsonLimit }));
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
    initializeAccount: async input => { calls.push(['account', input]); return { duplicate: false, credits: SIGNUP_GRANT_CREDITS, createdAt: '2026-08-30T00:00:00.000Z' }; }
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
