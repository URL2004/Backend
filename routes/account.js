// [계정] 회원 탈퇴 — 최근 인증과 미결 업무를 확인한 뒤 단계별·멱등 삭제.

'use strict';

const express = require('express');
const { admin, db } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const { bearerToken } = require('../lib/reqtoken');
const { assertRecentAuth, recentAuthMaxAgeSeconds } = require('../lib/accountDeletionPolicy');
const { accountDeletionHash, deleteAccountData, deletionSecret } = require('../lib/accountDeletionService');

const router = express.Router();

function pendingWorkMessage(reasonCodes) {
  const reasons = new Set(reasonCodes || []);
  if (reasons.has('active_subscription')) return '진행 중이거나 사용 기간이 남은 구독을 먼저 정리해 주세요.';
  if (reasons.has('refund_pending')) return '처리 중인 환불이 끝난 뒤 탈퇴할 수 있어요.';
  if (reasons.has('partial_refund_unsettled')) return '부분 환불 정산이 끝난 뒤 탈퇴할 수 있어요.';
  if (reasons.has('refundable_order_open')) return '최근 결제의 환불 신청 기간이 끝나거나 환불 처리가 완료된 뒤 탈퇴할 수 있어요.';
  if (reasons.has('payment_confirmation_pending')) return '확인 중인 결제가 끝난 뒤 다시 시도해 주세요.';
  if (reasons.has('transform_job_active')) return '진행 중인 글 작업이 끝난 뒤 다시 시도해 주세요.';
  if (reasons.has('referral_reward_pending')) return '확정 대기 중인 추천 보상이 처리된 뒤 다시 시도해 주세요.';
  return '처리 중인 업무가 끝난 뒤 다시 시도해 주세요.';
}

router.post('/delete-account', async (req, res) => {
  if (!admin || !db) {
    return res.status(503).json({ error: '인증 서버가 비활성 상태예요. 잠시 후 다시 시도해 주세요.' });
  }
  const idToken = bearerToken(req);
  if (!idToken) return res.status(401).json({ error: '로그인이 필요해요.' });

  let decoded;
  try {
    // checkRevoked=true: 탈취·폐기된 토큰으로 개인정보 삭제를 시작하지 않는다.
    decoded = await admin.auth().verifyIdToken(idToken, true);
    assertRecentAuth(decoded, { maxAgeSeconds: recentAuthMaxAgeSeconds(process.env) });
  } catch (error) {
    const recentLogin = error && error.code === 'RECENT_LOGIN_REQUIRED';
    return res.status(401).json({
      error: recentLogin
        ? '계정을 안전하게 삭제하려면 다시 로그인해 주세요.'
        : '인증이 만료됐어요. 다시 로그인 후 시도해 주세요.',
      code: recentLogin ? 'RECENT_LOGIN_REQUIRED' : 'AUTH_INVALID',
      ...(recentLogin ? { maxAgeSeconds: error.maxAgeSeconds } : {})
    });
  }

  const uid = decoded.uid;
  setLogContext({ uid });
  let deletionId = '';
  try {
    deletionId = accountDeletionHash(uid, deletionSecret()).slice(0, 16);
    const result = await deleteAccountData({
      admin,
      db,
      uid,
      secret: deletionSecret(),
      logger
    });
    logger.info('account.deleted', {
      deletionId: result.deletionId,
      alreadyDeleted: result.alreadyDeleted === true
    });
    return res.json({ ok: true, alreadyDeleted: result.alreadyDeleted === true });
  } catch (error) {
    if (error && error.code === 'ACCOUNT_DELETE_PENDING_WORK') {
      logger.warn('account.delete_blocked_pending_work', {
        deletionId,
        reasonCodes: error.reasonCodes
      });
      return res.status(409).json({
        error: pendingWorkMessage(error.reasonCodes),
        code: 'ACCOUNT_DELETE_PENDING_WORK',
        reasonCodes: error.reasonCodes
      });
    }
    const unavailable = error && error.code === 'ACCOUNT_DELETION_SECRET_MISSING';
    logger.error('account.delete_failed', { deletionId, err: error });
    return res.status(unavailable ? 503 : 500).json({
      error: '탈퇴 처리 중 오류가 발생했어요. 잠시 후 다시 시도하거나 고객센터로 문의해 주세요.',
      code: unavailable ? 'ACCOUNT_DELETE_UNAVAILABLE' : 'ACCOUNT_DELETE_FAILED',
      retryable: true
    });
  }
});

router.accountDeletionPolicy = { pendingWorkMessage };

module.exports = router;
