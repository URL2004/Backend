'use strict';

// Client-originated persistence is intentionally funneled through authenticated
// server routes. Firestore Rules can then deny direct writes while this service
// enforces bounded schemas, idempotency and durable per-UID quotas in the same
// transaction as the requested write.

const crypto = require('node:crypto');
const { accountDeletionBlocksWrites } = require('./accountActivityClaims');

const LIMITS = Object.freeze({
  history_backup: Object.freeze({ hourly: 120, daily: 500 }),
  qna_create: Object.freeze({ hourly: 5, daily: 20 }),
  qna_delete: Object.freeze({ hourly: 20, daily: 100 }),
  qna_answer: Object.freeze({ hourly: 60, daily: 300 }),
  notification_create: Object.freeze({ hourly: 120, daily: 500 }),
  account_initialize: Object.freeze({ hourly: 2, daily: 3 }),
  account_initialize_ip: Object.freeze({ hourly: 10, daily: 50 })
});

const SELF_NOTIFICATION_POLICIES = Object.freeze({
  job_done: Object.freeze({ title: '작업 완료', prefix: 'job_done_', tabs: Object.freeze(['history']) }),
  job_failed: Object.freeze({ title: '작업 확인 필요', prefix: 'job_failed_', tabs: Object.freeze(['main']) }),
  payment: Object.freeze({ title: '충전 완료', prefix: 'payment_', tabs: Object.freeze(['pricing', 'main', 'writingLab']) }),
  refund: Object.freeze({ title: '환불 요청 접수', prefix: 'refund_', tabs: Object.freeze(['mypage']) })
});

const HISTORY_TYPES = new Set(['detect', 'humanize', 'unknown']);
const BILLING_DISPOSITIONS = new Set(['charged', 'plan_unlimited', 'admin_no_charge']);
const QUALITY_STATUSES = new Set(['clean', 'needs_review']);
const CALIBRATION_KEYS = new Set([
  'version', 'applied', 'reason', 'match', 'historyId', 'historyMode',
  'matchSimilarity', 'matchLengthRatio', 'inputHash', 'outputHash',
  'rawProbability', 'calibratedProbability', 'maxReduction', 'floor', 'factor'
]);

function apiError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function cleanText(value, maxChars, field, { required = false, maxBytes = maxChars * 4, trim = true } = {}) {
  if (typeof value !== 'string') {
    if (!required && value == null) return '';
    throw apiError(400, 'INVALID_INPUT', `${field} 형식이 올바르지 않아요.`);
  }
  const repaired = value.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  const normalized = trim ? repaired.trim() : repaired;
  if (required && !normalized) throw apiError(400, 'INVALID_INPUT', `${field}을(를) 입력해 주세요.`);
  if (normalized.length > maxChars || Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw apiError(413, 'PAYLOAD_TOO_LARGE', `${field}이(가) 너무 길어요.`);
  }
  return normalized;
}

function optionalFiniteNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw apiError(400, 'INVALID_INPUT', `${field} 값이 올바르지 않아요.`);
  }
  return value;
}

function sanitizeCalibration(value) {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(400, 'INVALID_INPUT', '감지 보정 정보가 올바르지 않아요.');
  }
  const keys = Object.keys(value);
  if (keys.length > CALIBRATION_KEYS.size || keys.some(key => !CALIBRATION_KEYS.has(key))) {
    throw apiError(400, 'INVALID_INPUT', '허용되지 않은 감지 보정 필드가 있어요.');
  }
  const result = {};
  const stringLimits = {
    version: 40, reason: 80, match: 40, historyId: 160,
    historyMode: 24, inputHash: 128, outputHash: 128
  };
  for (const [key, limit] of Object.entries(stringLimits)) {
    if (value[key] != null) result[key] = cleanText(value[key], limit, key, { maxBytes: limit * 4 });
  }
  if (value.applied != null) {
    if (typeof value.applied !== 'boolean') throw apiError(400, 'INVALID_INPUT', 'applied 값이 올바르지 않아요.');
    result.applied = value.applied;
  }
  for (const key of ['matchSimilarity', 'matchLengthRatio', 'rawProbability', 'calibratedProbability', 'maxReduction', 'floor', 'factor']) {
    const number = optionalFiniteNumber(value[key], key);
    if (number !== undefined) result[key] = number;
  }
  return result;
}

function sanitizeHistoryEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw apiError(400, 'INVALID_INPUT', '저장할 이용 기록이 올바르지 않아요.');
  }
  const type = String(input.type || 'unknown').trim().toLowerCase();
  if (!HISTORY_TYPES.has(type)) throw apiError(400, 'INVALID_INPUT', '이용 기록 종류가 올바르지 않아요.');
  const credits = optionalFiniteNumber(input.credits ?? 0, 'credits', { min: 0, max: 1_000_000 });
  const result = {
    type,
    inputText: cleanText(input.inputText ?? '', 60_000, '원문', { maxBytes: 240_000, trim: false }),
    credits: credits ?? 0
  };
  const textFields = {
    summary: [10_000, 40_000], detail: [20_000, 80_000], outputText: [60_000, 240_000],
    humanSummary: [10_000, 40_000], humanDetail: [20_000, 80_000]
  };
  for (const [field, [chars, bytes]] of Object.entries(textFields)) {
    if (input[field] != null) result[field] = cleanText(input[field], chars, field, { maxBytes: bytes, trim: false });
  }
  for (const field of ['probability', 'rawProbability']) {
    const value = optionalFiniteNumber(input[field], field, { min: 0, max: 100 });
    if (value !== undefined) result[field] = value;
  }
  const calibration = sanitizeCalibration(input.probabilityCalibration);
  if (calibration !== undefined) result.probabilityCalibration = calibration;
  if (input.billingDisposition != null) {
    const value = String(input.billingDisposition || '').trim();
    if (!BILLING_DISPOSITIONS.has(value)) throw apiError(400, 'INVALID_INPUT', '과금 처리 값이 올바르지 않아요.');
    result.billingDisposition = value;
  }
  if (input.qualityStatus != null) {
    const value = String(input.qualityStatus || '').trim();
    if (!QUALITY_STATUSES.has(value)) throw apiError(400, 'INVALID_INPUT', '품질 상태 값이 올바르지 않아요.');
    result.qualityStatus = value;
  }
  if (input.qualityWarningCodes != null) {
    if (!Array.isArray(input.qualityWarningCodes) || input.qualityWarningCodes.length > 20) {
      throw apiError(400, 'INVALID_INPUT', '품질 경고 목록이 올바르지 않아요.');
    }
    result.qualityWarningCodes = [...new Set(input.qualityWarningCodes.map(code => (
      cleanText(code, 80, '품질 경고 코드', { required: true, maxBytes: 240 })
    )))].slice(0, 20);
  }
  const backupAtMs = optionalFiniteNumber(input.backupAtMs, 'backupAtMs', { min: 0, max: Date.now() + 86_400_000 });
  if (backupAtMs !== undefined) result.backupAtMs = Math.trunc(backupAtMs);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 600_000) {
    throw apiError(413, 'PAYLOAD_TOO_LARGE', '저장할 이용 기록이 너무 커요.');
  }
  return result;
}

function sanitizeRequestId(value) {
  const requestId = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(requestId)) {
    throw apiError(400, 'INVALID_REQUEST_ID', 'requestId는 8~128자 영문·숫자 식별자로 보내 주세요.');
  }
  return requestId;
}

function deterministicId(prefix, uid, requestId) {
  return `${prefix}_${crypto.createHash('sha256').update(`${uid}\0${requestId}`, 'utf8').digest('hex').slice(0, 40)}`;
}

function quotaRef(db, uid, action) {
  const id = crypto.createHash('sha256').update(`${uid}\0${action}`, 'utf8').digest('hex');
  return db.collection('clientWriteQuotas').doc(id);
}

function quotaBuckets(nowMs) {
  const iso = new Date(nowMs).toISOString();
  return { hourKey: iso.slice(0, 13), dayKey: iso.slice(0, 10) };
}

function quotaRetryAfter(scope, nowMs) {
  const now = new Date(nowMs);
  const boundary = scope === 'daily'
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1);
  return Math.max(1, Math.ceil((boundary - nowMs) / 1000));
}

async function consumeQuota(transaction, ref, { uid, action, nowMs = Date.now(), fieldValue, snapshot }) {
  const limit = LIMITS[action];
  if (!limit) throw new Error(`Unknown client write quota action: ${action}`);
  const snap = snapshot || await transaction.get(ref);
  const previous = snap.exists ? (snap.data() || {}) : {};
  const { hourKey, dayKey } = quotaBuckets(nowMs);
  const hourCount = previous.hourKey === hourKey ? Math.max(0, Number(previous.hourCount) || 0) : 0;
  const dayCount = previous.dayKey === dayKey ? Math.max(0, Number(previous.dayCount) || 0) : 0;
  if (hourCount >= limit.hourly) {
    throw apiError(429, 'WRITE_QUOTA_EXCEEDED', '잠시 후 다시 시도해 주세요.', {
      quotaScope: 'hourly', retryAfterSec: quotaRetryAfter('hourly', nowMs)
    });
  }
  if (dayCount >= limit.daily) {
    throw apiError(429, 'WRITE_QUOTA_EXCEEDED', '오늘 저장할 수 있는 횟수를 모두 사용했어요.', {
      quotaScope: 'daily', retryAfterSec: quotaRetryAfter('daily', nowMs)
    });
  }
  transaction.set(ref, {
    uid,
    action,
    hourKey,
    hourCount: hourCount + 1,
    dayKey,
    dayCount: dayCount + 1,
    updatedAt: fieldValue.serverTimestamp()
  });
  return { hourlyRemaining: limit.hourly - hourCount - 1, dailyRemaining: limit.daily - dayCount - 1 };
}

function createClientWriteService({ db, admin, now = () => Date.now() }) {
  if (!db || !admin?.firestore?.FieldValue) throw new Error('client write service requires Firebase Admin');
  const fieldValue = admin.firestore.FieldValue;

  function sanitizeAttributionTouch(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Number(value.version) !== 1) {
      throw apiError(400, 'INVALID_ATTRIBUTION', '유입 정보 형식이 올바르지 않아요.');
    }
    const limits = {
      captured_at: 40, source: 100, medium: 100, campaign: 250, content: 250,
      term: 250, napm: 500, gclid: 250, fbclid: 250, use_case: 40, landing_path: 250,
      landing_url: 500, referrer_host: 250
    };
    const allowed = new Set(['version', ...Object.keys(limits)]);
    if (Object.keys(value).some(key => !allowed.has(key))) {
      throw apiError(400, 'INVALID_ATTRIBUTION', '허용되지 않은 유입 정보가 있어요.');
    }
    const result = { version: 1 };
    for (const [key, limit] of Object.entries(limits)) {
      result[key] = cleanText(value[key] ?? '', limit, key, { maxBytes: limit * 4 });
    }
    return result;
  }

  function sanitizeSignupAttribution(value) {
    if (value == null) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw apiError(400, 'INVALID_ATTRIBUTION', '유입 정보 형식이 올바르지 않아요.');
    }
    const keys = Object.keys(value);
    if (keys.length !== 2 || !keys.includes('first_touch') || !keys.includes('last_touch')) {
      throw apiError(400, 'INVALID_ATTRIBUTION', '유입 정보 구성이 올바르지 않아요.');
    }
    return {
      first_touch: sanitizeAttributionTouch(value.first_touch),
      last_touch: sanitizeAttributionTouch(value.last_touch)
    };
  }

  function timestampMillis(value) {
    if (value == null) return 0;
    if (typeof value?.toMillis === 'function') return Number(value.toMillis()) || 0;
    if (typeof value?.toDate === 'function') return Number(value.toDate()?.getTime()) || 0;
    if (Number(value?._seconds) > 0) return Number(value._seconds) * 1000;
    return Number(value) || 0;
  }

  function accountDeletionBlocksInitialization(row, nowMs = Date.now()) {
    const value = row && typeof row === 'object' ? row : {};
    const status = String(value.status || '');
    if (['processing', 'retry_pending', 'manual_review'].includes(status)) return true;
    return status === 'completed' && timestampMillis(value.protectUntilMs) > nowMs;
  }

  async function initializeAccount({ uid, email, name, signupAttribution, clientPrincipal }) {
    const safeUid = cleanText(uid, 128, 'UID', { required: true, maxBytes: 256 });
    const safeEmail = email == null ? null : cleanText(email, 320, '이메일', { maxBytes: 640 });
    const safeName = name == null ? null : cleanText(name, 80, '이름', { maxBytes: 320 });
    const attribution = sanitizeSignupAttribution(signupAttribution);
    const principal = cleanText(clientPrincipal, 160, '접속 식별자', { required: true, maxBytes: 320 });
    const userRef = db.collection('users').doc(safeUid);
    const securityRef = db.collection('accountSecurity').doc(safeUid);
    const deletionJobRef = db.collection('accountDeletionJobs').doc(safeUid);
    const uidLimitRef = quotaRef(db, safeUid, 'account_initialize');
    const ipLimitRef = quotaRef(db, principal, 'account_initialize_ip');
    const nowMs = now();
    const createdAt = new Date(nowMs).toISOString();
    return db.runTransaction(async transaction => {
      // Firestore requires every read before the first write. Load both durable
      // quota rows with the user row, then apply both counters atomically.
      const [userSnap, deletionJobSnap, uidQuotaSnap, ipQuotaSnap] = await Promise.all([
        transaction.get(userRef),
        transaction.get(deletionJobRef),
        transaction.get(uidLimitRef),
        transaction.get(ipLimitRef)
      ]);
      if (deletionJobSnap.exists
        && accountDeletionBlocksInitialization(deletionJobSnap.data() || {}, nowMs)) {
        throw apiError(
          409,
          'ACCOUNT_DELETION_IN_PROGRESS',
          '회원 탈퇴 처리가 진행 중이라 계정을 다시 만들 수 없어요.'
        );
      }
      if (userSnap.exists) {
        const existing = userSnap.data() || {};
        return { duplicate: true, credits: Math.max(0, Number(existing.credits) || 0), createdAt: existing.createdAt || '' };
      }
      const uidQuota = await consumeQuota(transaction, uidLimitRef, {
        uid: safeUid,
        action: 'account_initialize',
        nowMs,
        fieldValue,
        snapshot: uidQuotaSnap
      });
      const ipQuota = await consumeQuota(transaction, ipLimitRef, {
        uid: principal,
        action: 'account_initialize_ip',
        nowMs,
        fieldValue,
        snapshot: ipQuotaSnap
      });
      transaction.set(userRef, {
        email: safeEmail,
        name: safeName,
        credits: 10,
        plan: 'free',
        refCode: safeUid.slice(0, 8),
        createdAt,
        ...(attribution ? { signupAttribution: attribution } : {}),
        initializedBy: 'server_api'
      });
      // 원 IP는 저장하지 않는다. 라우트가 서버 비밀로 HMAC한 접속 지문만
      // 추천인 자가보상·대량 신규 계정 징후를 판정할 서버 전용 근거로 보존한다.
      transaction.set(securityRef, {
        signupClientPrincipal: principal,
        createdAtMs: nowMs,
        createdAt: fieldValue.serverTimestamp(),
        source: 'account_initialize_v1'
      });
      return { duplicate: false, credits: 10, createdAt, quota: { uid: uidQuota, client: ipQuota } };
    });
  }

  async function createSelfNotification({ uid, clientId, type, message, action }) {
    const safeType = cleanText(type, 32, '알림 종류', { required: true, maxBytes: 64 });
    const policy = SELF_NOTIFICATION_POLICIES[safeType];
    if (!policy) throw apiError(400, 'INVALID_NOTIFICATION_TYPE', '허용되지 않은 알림 종류예요.');
    const safeClientId = cleanText(clientId, 120, '알림 ID', { required: true, maxBytes: 240 });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,119}$/u.test(safeClientId)
      || !safeClientId.startsWith(policy.prefix)
      || safeClientId.length <= policy.prefix.length) {
      throw apiError(400, 'INVALID_NOTIFICATION_ID', '알림 ID 형식이 올바르지 않아요.');
    }
    const cleanMessage = cleanText(message, 600, '알림 내용', { required: true, maxBytes: 2_400 });
    if (!action || typeof action !== 'object' || Array.isArray(action)
      || Object.keys(action).length !== 1 || typeof action.tab !== 'string') {
      throw apiError(400, 'INVALID_NOTIFICATION_ACTION', '알림 이동 정보가 올바르지 않아요.');
    }
    const safeTab = cleanText(action.tab, 32, '알림 이동 화면', { required: true, maxBytes: 64 });
    if (!policy.tabs.includes(safeTab)) {
      throw apiError(400, 'INVALID_NOTIFICATION_ACTION', '이 알림에서 열 수 없는 화면이에요.');
    }

    const notificationRef = db.collection('users').doc(uid)
      .collection('notifications').doc(safeClientId);
    const userRef = db.collection('users').doc(uid);
    const deletionJobRef = db.collection('accountDeletionJobs').doc(uid);
    const limitRef = quotaRef(db, uid, 'notification_create');
    const nowMs = now();
    return db.runTransaction(async transaction => {
      const [existing, userSnap, deletionJobSnap, quotaSnap] = await Promise.all([
        transaction.get(notificationRef),
        transaction.get(userRef),
        transaction.get(deletionJobRef),
        transaction.get(limitRef)
      ]);
      if (existing.exists) return { id: safeClientId, duplicate: true };
      if (!userSnap.exists) {
        throw apiError(409, 'ACCOUNT_NOT_INITIALIZED', '계정 준비가 끝난 뒤 다시 시도해 주세요.');
      }
      if (deletionJobSnap.exists
        && accountDeletionBlocksWrites(deletionJobSnap.data() || {}, nowMs)) {
        throw apiError(409, 'ACCOUNT_DELETION_IN_PROGRESS', '회원 탈퇴 처리 중에는 알림을 저장할 수 없어요.');
      }
      const quota = await consumeQuota(transaction, limitRef, {
        uid, action: 'notification_create', nowMs, fieldValue, snapshot: quotaSnap
      });
      transaction.set(notificationRef, {
        clientId: safeClientId,
        type: safeType,
        title: policy.title,
        message: cleanMessage,
        action: { tab: safeTab },
        read: false,
        createdAt: fieldValue.serverTimestamp(),
        createdAtMs: nowMs,
        writeSource: 'self_notification_api'
      });
      return { id: safeClientId, duplicate: false, quota };
    });
  }

  async function backupHistory({ uid, requestId, entry }) {
    const safeRequestId = sanitizeRequestId(requestId);
    const clean = sanitizeHistoryEntry(entry);
    const historyId = deterministicId('client', uid, safeRequestId);
    const historyRef = db.collection('users').doc(uid).collection('history').doc(historyId);
    const userRef = db.collection('users').doc(uid);
    const deletionJobRef = db.collection('accountDeletionJobs').doc(uid);
    const limitRef = quotaRef(db, uid, 'history_backup');
    const nowMs = now();
    return db.runTransaction(async transaction => {
      const [existing, userSnap, deletionJobSnap] = await Promise.all([
        transaction.get(historyRef),
        transaction.get(userRef),
        transaction.get(deletionJobRef),
      ]);
      if (existing.exists) return { id: historyId, duplicate: true };
      if (!userSnap.exists) {
        throw apiError(409, 'ACCOUNT_NOT_INITIALIZED', '계정 준비가 끝난 뒤 다시 시도해 주세요.');
      }
      if (deletionJobSnap.exists
        && accountDeletionBlocksWrites(deletionJobSnap.data() || {}, nowMs)) {
        throw apiError(409, 'ACCOUNT_DELETION_IN_PROGRESS', '회원 탈퇴 처리 중에는 이용 기록을 저장할 수 없어요.');
      }
      const quota = await consumeQuota(transaction, limitRef, {
        uid, action: 'history_backup', nowMs, fieldValue
      });
      transaction.set(historyRef, {
        ...clean,
        createdAt: fieldValue.serverTimestamp(),
        savedBy: 'client_backup_api',
        serverTrusted: false,
        clientRequestHash: crypto.createHash('sha256').update(safeRequestId).digest('hex')
      });
      return { id: historyId, duplicate: false, quota };
    });
  }

  async function createQuestion({ uid, requestId, title, body, isAnon, fallbackName = '' }) {
    const safeRequestId = sanitizeRequestId(requestId);
    const cleanTitle = cleanText(title, 160, '문의 제목', { required: true, maxBytes: 640 });
    const cleanBody = cleanText(body, 10_000, '문의 내용', { required: true, maxBytes: 40_000 });
    if (typeof isAnon !== 'boolean') throw apiError(400, 'INVALID_INPUT', '익명 선택값이 올바르지 않아요.');
    const questionId = deterministicId('q', uid, safeRequestId);
    const questionRef = db.collection('qna').doc(questionId);
    const userRef = db.collection('users').doc(uid);
    const deletionJobRef = db.collection('accountDeletionJobs').doc(uid);
    const limitRef = quotaRef(db, uid, 'qna_create');
    const nowMs = now();
    return db.runTransaction(async transaction => {
      const [existing, userSnap, deletionJobSnap] = await Promise.all([
        transaction.get(questionRef),
        transaction.get(userRef),
        transaction.get(deletionJobRef)
      ]);
      if (existing.exists) return { id: questionId, duplicate: true };
      if (!userSnap.exists) {
        throw apiError(409, 'ACCOUNT_NOT_INITIALIZED', '계정 준비가 끝난 뒤 다시 시도해 주세요.');
      }
      if (deletionJobSnap.exists
        && accountDeletionBlocksWrites(deletionJobSnap.data() || {}, nowMs)) {
        throw apiError(409, 'ACCOUNT_DELETION_IN_PROGRESS', '회원 탈퇴 처리 중에는 문의를 저장할 수 없어요.');
      }
      const quota = await consumeQuota(transaction, limitRef, {
        uid, action: 'qna_create', nowMs, fieldValue
      });
      const profileName = userSnap.exists ? (userSnap.data()?.name || '') : '';
      const authorName = isAnon
        ? '익명'
        : cleanText(profileName || fallbackName || '사용자', 80, '작성자 이름', { maxBytes: 320 });
      transaction.set(questionRef, {
        title: cleanTitle,
        body: cleanBody,
        authorId: uid,
        authorName,
        isAnon,
        status: 'pending',
        answer: null,
        createdAt: fieldValue.serverTimestamp(),
        views: 0,
        writeSource: 'server_api'
      });
      return { id: questionId, duplicate: false, quota };
    });
  }

  async function deleteQuestion({ actorUid, questionId, isAdmin = false }) {
    const safeId = cleanText(questionId, 160, '문의 ID', { required: true, maxBytes: 320 });
    if (!/^[A-Za-z0-9_-]+$/u.test(safeId)) throw apiError(400, 'INVALID_INPUT', '문의 ID가 올바르지 않아요.');
    const questionRef = db.collection('qna').doc(safeId);
    const deletionJobRef = db.collection('accountDeletionJobs').doc(actorUid);
    const limitRef = quotaRef(db, actorUid, 'qna_delete');
    const nowMs = now();
    return db.runTransaction(async transaction => {
      const [questionSnap, deletionJobSnap] = await Promise.all([
        transaction.get(questionRef),
        transaction.get(deletionJobRef),
      ]);
      if (!questionSnap.exists) throw apiError(404, 'QNA_NOT_FOUND', '삭제되었거나 찾을 수 없는 문의예요.');
      if (deletionJobSnap.exists
        && accountDeletionBlocksWrites(deletionJobSnap.data() || {}, nowMs)) {
        throw apiError(409, 'ACCOUNT_DELETION_IN_PROGRESS', '회원 탈퇴 처리 중에는 문의를 변경할 수 없어요.');
      }
      const question = questionSnap.data() || {};
      if (!isAdmin && question.authorId !== actorUid) {
        throw apiError(403, 'FORBIDDEN', '본인의 문의만 삭제할 수 있어요.');
      }
      const quota = await consumeQuota(transaction, limitRef, {
        uid: actorUid, action: 'qna_delete', nowMs, fieldValue
      });
      transaction.delete(questionRef);
      if (question.authorId) {
        transaction.delete(db.collection('users').doc(question.authorId)
          .collection('notifications').doc(`qna_answered_${safeId}`));
      }
      return { id: safeId, quota };
    });
  }

  async function saveAnswer({ adminUid, questionId, body, answeredBy = '운영팀' }) {
    const safeId = cleanText(questionId, 160, '문의 ID', { required: true, maxBytes: 320 });
    if (!/^[A-Za-z0-9_-]+$/u.test(safeId)) throw apiError(400, 'INVALID_INPUT', '문의 ID가 올바르지 않아요.');
    const cleanBody = cleanText(body, 20_000, '답변 내용', { required: true, maxBytes: 80_000 });
    const cleanAnsweredBy = cleanText(answeredBy || '운영팀', 80, '답변자', { required: true, maxBytes: 320 });
    const questionRef = db.collection('qna').doc(safeId);
    const limitRef = quotaRef(db, adminUid, 'qna_answer');
    const nowMs = now();
    return db.runTransaction(async transaction => {
      const questionSnap = await transaction.get(questionRef);
      if (!questionSnap.exists) throw apiError(404, 'QNA_NOT_FOUND', '삭제되었거나 찾을 수 없는 문의예요.');
      const question = questionSnap.data() || {};
      const authorDeletionSnap = question.authorId
        ? await transaction.get(db.collection('accountDeletionJobs').doc(question.authorId))
        : null;
      if (authorDeletionSnap?.exists
        && accountDeletionBlocksWrites(authorDeletionSnap.data() || {}, nowMs)) {
        throw apiError(409, 'ACCOUNT_DELETION_IN_PROGRESS', '탈퇴 처리 중인 사용자의 문의에는 답변을 저장할 수 없어요.');
      }
      const quota = await consumeQuota(transaction, limitRef, {
        uid: adminUid, action: 'qna_answer', nowMs, fieldValue
      });
      transaction.update(questionRef, {
        status: 'answered',
        answer: {
          body: cleanBody,
          answeredBy: cleanAnsweredBy,
          answeredAt: fieldValue.serverTimestamp()
        },
        answeredByUid: adminUid,
        writeSource: 'server_api'
      });
      if (question.authorId) {
        const notificationId = `qna_answered_${safeId}`;
        const notificationRef = db.collection('users').doc(question.authorId)
          .collection('notifications').doc(notificationId);
        transaction.set(notificationRef, {
          clientId: notificationId,
          type: 'qna',
          title: '문의 답변',
          message: '남겨주신 문의에 운영팀 답변이 등록됐어요.',
          action: { tab: 'qna' },
          read: false,
          createdAt: fieldValue.serverTimestamp(),
          createdAtMs: nowMs
        }, { merge: true });
      }
      return { id: safeId, quota };
    });
  }

  async function deleteAnswer({ adminUid, questionId }) {
    const safeId = cleanText(questionId, 160, '문의 ID', { required: true, maxBytes: 320 });
    if (!/^[A-Za-z0-9_-]+$/u.test(safeId)) throw apiError(400, 'INVALID_INPUT', '문의 ID가 올바르지 않아요.');
    const questionRef = db.collection('qna').doc(safeId);
    const limitRef = quotaRef(db, adminUid, 'qna_answer');
    const nowMs = now();
    return db.runTransaction(async transaction => {
      const questionSnap = await transaction.get(questionRef);
      if (!questionSnap.exists) throw apiError(404, 'QNA_NOT_FOUND', '삭제되었거나 찾을 수 없는 문의예요.');
      const question = questionSnap.data() || {};
      const quota = await consumeQuota(transaction, limitRef, {
        uid: adminUid, action: 'qna_answer', nowMs, fieldValue
      });
      transaction.update(questionRef, {
        status: 'pending',
        answer: null,
        answeredByUid: fieldValue.delete(),
        writeSource: 'server_api'
      });
      if (question.authorId) {
        transaction.delete(db.collection('users').doc(question.authorId)
          .collection('notifications').doc(`qna_answered_${safeId}`));
      }
      return { id: safeId, quota };
    });
  }

  return {
    initializeAccount,
    createSelfNotification,
    backupHistory,
    createQuestion,
    deleteQuestion,
    saveAnswer,
    deleteAnswer
  };
}

module.exports = {
  LIMITS,
  SELF_NOTIFICATION_POLICIES,
  apiError,
  sanitizeHistoryEntry,
  sanitizeRequestId,
  deterministicId,
  consumeQuota,
  createClientWriteService
};
