// [계정] 회원 탈퇴 — 최근 인증 + 서버 전용 재시도 작업표를 거쳐 개인정보를 정리한다.

'use strict';

const express = require('express');
const { admin, db } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const { hasRecentAuthentication } = require('../lib/recentAuth');
const { executeAccountDeletion } = require('../lib/accountDeletion');

const router = express.Router();

function authorizationToken(req) {
  const authorization = (typeof req.get === 'function' ? req.get('authorization') : '')
    || (req.headers && req.headers.authorization) || '';
  const match = String(authorization).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

router.post('/delete-account', async (req, res) => {
  if (!admin || !db) return res.status(503).json({ error: '인증 서버가 비활성 상태예요. 잠시 후 다시 시도해주세요.' });
  const idToken = authorizationToken(req);
  if (!idToken) return res.status(401).json({ error: '로그인이 필요해요.' });

  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken, true); }
  catch { return res.status(401).json({ error: '인증이 만료됐어요. 다시 로그인 후 시도해주세요.' }); }
  const uid = decoded.uid;
  setLogContext({ uid });

  if (!hasRecentAuthentication(decoded)) {
    logger.warn('account.delete_recent_auth_required', { uid });
    return res.status(401).json({
      code: 'ACCOUNT_RECENT_LOGIN_REQUIRED',
      error: '안전한 탈퇴 처리를 위해 다시 로그인해 주세요.',
    });
  }
  if (req.body?.confirm !== true) {
    return res.status(400).json({
      code: 'ACCOUNT_DELETION_CONFIRMATION_REQUIRED',
      error: '탈퇴 확인 후 다시 시도해 주세요.',
    });
  }

  try {
    const result = await executeAccountDeletion({ admin, db, logger, uid });
    return res.json({
      ok: true,
      alreadyCompleted: result.alreadyCompleted === true,
      deletionState: 'completed',
    });
  } catch (error) {
    if ([
      'ACCOUNT_ACTIVE_SUBSCRIPTION',
      'ACCOUNT_SUBSCRIPTION_OPERATION_PENDING',
      'ACCOUNT_PAYMENT_OPERATION_PENDING',
      'ACCOUNT_CONTENT_OPERATION_PENDING',
      'ACCOUNT_REFUND_OPERATION_PENDING',
      'ACCOUNT_FINANCIAL_REVIEW_REQUIRED',
      'ACCOUNT_DELETION_IN_PROGRESS',
    ].includes(error.code)) {
      logger.warn('account.delete_blocked_active_operation', { uid, code: error.code });
      return res.status(409).json({ code: error.code, error: error.message });
    }
    logger.error('account.delete_failed', { uid, code: error.code || 'ACCOUNT_DELETION_FAILED', err: error });
    const progress = error.deletionProgress && typeof error.deletionProgress === 'object'
      ? error.deletionProgress
      : {};
    return res.status(503).json({
      code: 'ACCOUNT_DELETION_PENDING',
      partial: progress.cleanupStarted === true,
      accountDeleted: progress.authDeleted === true,
      userDocumentDeleted: progress.userDeleted === true,
      cleanupPhase: String(progress.phase || 'not_started').slice(0, 40),
      retryScheduled: progress.cleanupStarted === true,
      error: '일부 데이터 정리가 지연되고 있어 탈퇴 완료 처리를 보류했어요. 자동으로 다시 처리하며, 계속되면 사이트 내 고객센터로 문의해 주세요.',
    });
  }
});

module.exports = router;
