'use strict';

const express = require('express');
const config = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const discord = require('../lib/discord');
const { realClientIp } = require('../lib/clientip');
const { clientHashForLog } = require('../lib/requestLogPrivacy');
const metaConversions = require('../lib/metaConversions');
const { createClientWriteService } = require('../lib/clientWriteService');

function strictBearerToken(req) {
  const authorization = String(
    (typeof req.get === 'function' ? req.get('authorization') : '')
      || req.headers?.authorization
      || ''
  );
  return authorization.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim() || '';
}

function respondError(res, error) {
  const status = Number(error?.status) || 500;
  if (error?.retryAfterSec) res.set('Retry-After', String(error.retryAfterSec));
  return res.status(status).json({
    ok: false,
    code: error?.code || 'CLIENT_WRITE_FAILED',
    error: status >= 500 ? '저장 중 오류가 발생했어요.' : error.message,
    ...(error?.quotaScope ? { quotaScope: error.quotaScope } : {})
  });
}

function accountInitializeQuotaLogFields(error) {
  return {
    code: error?.code,
    action: error?.quotaAction,
    scope: error?.quotaScope,
    count: error?.quotaCount,
    limit: error?.quotaLimit,
    grantCredits: error?.grantCredits,
    retryAfterSec: error?.retryAfterSec,
    // 정상적인 hard-cap 차단은 추세 기록 대상이다. 개별 Discord 알림은 보내지 않는다.
    noAlert: true
  };
}

function createRouter(deps = {}) {
  const db = deps.db ?? config.db;
  const admin = deps.admin ?? config.admin;
  const verifyFirebaseIdToken = deps.verifyFirebaseIdToken ?? config.verifyFirebaseIdToken;
  const verifyAdminToken = deps.verifyAdminToken ?? config.verifyAdminToken;
  const service = deps.service || (db && admin?.firestore?.FieldValue
    ? createClientWriteService({ db, admin, now: deps.now })
    : null);
  const notifyInquiry = deps.notifyInquiry || (payload => discord.inquiry(payload));
  const clientPrincipal = deps.clientPrincipal || (req => clientHashForLog(realClientIp(req)));
  const router = express.Router();

  async function requireUser(req, res) {
    const token = strictBearerToken(req);
    if (!token) {
      res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: '로그인이 필요해요.' });
      return null;
    }
    try {
      return await verifyFirebaseIdToken(token, { checkRevoked: true });
    } catch (error) {
      logger.warn('client_data.auth_rejected', { err: error });
      res.status(401).json({ ok: false, code: 'AUTH_INVALID', error: '다시 로그인해 주세요.' });
      return null;
    }
  }

  function requireStorage(res) {
    if (service) return true;
    res.status(503).json({ ok: false, code: 'STORAGE_UNAVAILABLE', error: '저장소를 준비하지 못했어요.' });
    return false;
  }

  async function requireAdmin(req, res) {
    const token = strictBearerToken(req);
    if (!token) {
      res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: '로그인이 필요해요.' });
      return null;
    }
    const uid = await verifyAdminToken(token);
    if (uid === false) {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '관리자 권한이 없어요.' });
      return null;
    }
    if (!uid) {
      res.status(401).json({ ok: false, code: 'AUTH_INVALID', error: '다시 로그인해 주세요.' });
      return null;
    }
    return uid;
  }

  router.post('/account/initialize', async (req, res) => {
    if (!requireStorage(res)) return;
    const decoded = await requireUser(req, res);
    if (!decoded) return;
    setLogContext({ uid: decoded.uid });
    try {
      const result = await service.initializeAccount({
        uid: decoded.uid,
        email: decoded.email ?? null,
        name: decoded.name ?? null,
        signupAttribution: req.body?.signupAttribution,
        clientPrincipal: clientPrincipal(req)
      });
      const metaEventId = result.createdAt
        ? metaConversions.stableEventId('sign_up', `${decoded.uid}|${result.createdAt}`)
        : '';
      return res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result, metaEventId });
    } catch (error) {
      if (error?.code === 'WRITE_QUOTA_EXCEEDED') {
        logger.warn('account.initialize_quota_exceeded', {
          // 임계값 추세는 계정별 사건이 아니다. 요청 컨텍스트의 UID도 명시적으로 지운다.
          uid: undefined,
          ...accountInitializeQuotaLogFields(error)
        });
      } else {
        logger.warn('account.initialize_failed', { uid: decoded.uid, code: error?.code, err: error });
      }
      return respondError(res, error);
    }
  });

  router.post('/history/backup', async (req, res) => {
    if (!requireStorage(res)) return;
    const decoded = await requireUser(req, res);
    if (!decoded) return;
    setLogContext({ uid: decoded.uid });
    try {
      const result = await service.backupHistory({
        uid: decoded.uid,
        requestId: req.body?.requestId,
        entry: req.body?.entry
      });
      return res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result });
    } catch (error) {
      logger.warn('client_history.backup_failed', { uid: decoded.uid, code: error?.code, err: error });
      return respondError(res, error);
    }
  });

  router.post('/notifications/create-self', async (req, res) => {
    if (!requireStorage(res)) return;
    const decoded = await requireUser(req, res);
    if (!decoded) return;
    setLogContext({ uid: decoded.uid });
    try {
      const result = await service.createSelfNotification({
        uid: decoded.uid,
        clientId: req.body?.clientId,
        type: req.body?.type,
        message: req.body?.message,
        action: req.body?.action
      });
      return res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result });
    } catch (error) {
      logger.warn('notification.self_create_failed', { uid: decoded.uid, code: error?.code, err: error });
      return respondError(res, error);
    }
  });

  router.post('/qna/create', async (req, res) => {
    if (!requireStorage(res)) return;
    const decoded = await requireUser(req, res);
    if (!decoded) return;
    setLogContext({ uid: decoded.uid });
    try {
      const result = await service.createQuestion({
        uid: decoded.uid,
        requestId: req.body?.requestId,
        title: req.body?.title,
        body: req.body?.body,
        isAnon: req.body?.isAnon,
        fallbackName: decoded.name || ''
      });
      if (!result.duplicate) {
        try {
          notifyInquiry({
            id: result.id,
            title: String(req.body?.title || '').slice(0, 160),
            body: String(req.body?.body || '').slice(0, 10_000),
            author: req.body?.isAnon ? '익명' : (decoded.name || '회원'),
            uid: decoded.uid
          });
        } catch (error) {
          logger.warn('qna.discord_notify_failed', { uid: decoded.uid, questionId: result.id, err: error });
        }
      }
      return res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result });
    } catch (error) {
      logger.warn('qna.create_failed', { uid: decoded.uid, code: error?.code, err: error });
      return respondError(res, error);
    }
  });

  router.post('/qna/delete', async (req, res) => {
    if (!requireStorage(res)) return;
    const decoded = await requireUser(req, res);
    if (!decoded) return;
    setLogContext({ uid: decoded.uid });
    try {
      const adminUid = await verifyAdminToken(strictBearerToken(req));
      const result = await service.deleteQuestion({
        actorUid: decoded.uid,
        questionId: req.body?.id,
        isAdmin: adminUid === decoded.uid
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      logger.warn('qna.delete_failed', { uid: decoded.uid, code: error?.code, err: error });
      return respondError(res, error);
    }
  });

  router.post('/admin/qna/answer', async (req, res) => {
    if (!requireStorage(res)) return;
    const adminUid = await requireAdmin(req, res);
    if (!adminUid) return;
    setLogContext({ uid: adminUid, actorUid: adminUid });
    try {
      const result = await service.saveAnswer({
        adminUid,
        questionId: req.body?.id,
        body: req.body?.body,
        answeredBy: req.body?.answeredBy || '운영팀'
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      logger.warn('qna.answer_failed', { adminUid, code: error?.code, err: error });
      return respondError(res, error);
    }
  });

  router.post('/admin/qna/answer-delete', async (req, res) => {
    if (!requireStorage(res)) return;
    const adminUid = await requireAdmin(req, res);
    if (!adminUid) return;
    setLogContext({ uid: adminUid, actorUid: adminUid });
    try {
      const result = await service.deleteAnswer({ adminUid, questionId: req.body?.id });
      return res.json({ ok: true, ...result });
    } catch (error) {
      logger.warn('qna.answer_delete_failed', { adminUid, code: error?.code, err: error });
      return respondError(res, error);
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.accountInitializeQuotaLogFields = accountInitializeQuotaLogFields;
module.exports.createRouter = createRouter;
module.exports.strictBearerToken = strictBearerToken;
