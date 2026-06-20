// [계정] 회원 탈퇴 — Admin SDK로 Firestore 데이터 + Firebase Auth 계정을 서버 권한으로 삭제.
// ★ 기존 클라이언트 재인증(카카오 비밀번호 패턴 추측) 의존 제거.
//   추측 패턴이 안 맞는 카카오 계정은 구조적으로 탈퇴 불가했던 민원(#40·#61·#62·#91)을 해결한다.
//   Admin SDK는 재인증 없이 삭제 가능하므로 팝업 차단·비밀번호 불일치 환경에서도 동작한다.

const express = require('express');
const { admin, db } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const { bearerToken } = require('../lib/reqtoken');   // idToken: 헤더 우선·body 폴백(deprecated)

const router = express.Router();

router.post('/delete-account', async (req, res) => {
  if (!admin || !db) return res.status(503).json({ error: '인증 서버가 비활성 상태예요. 잠시 후 다시 시도해주세요.' });

  const idToken = bearerToken(req);   // 헤더 우선(body.idToken 폴백)
  if (!idToken) return res.status(401).json({ error: '로그인이 필요해요.' });

  let uid;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
  catch { return res.status(401).json({ error: '인증이 만료됐어요. 다시 로그인 후 시도해주세요.' }); }
  setLogContext({ uid });

  try {
    const userRef = db.collection('users').doc(uid);

    // 활성/해지예정 구독이 있으면 탈퇴 차단(전자상거래법 청약철회권 + 토스 심사 요건)
    const snap = await userRef.get();
    if (snap.exists) {
      const sub = snap.data().subscription;
      const nextMs = sub && sub.nextBillingAt && sub.nextBillingAt.toMillis ? sub.nextBillingAt.toMillis() : 0;
      if (sub && (sub.status === 'active' || (sub.status === 'cancelled' && nextMs > Date.now()))) {
        logger.warn('account.delete_blocked_active_subscription', { uid, subscriptionStatus: sub.status });
        return res.status(409).json({
          error: '진행 중이거나 해지 예정인 구독이 있어 탈퇴할 수 없어요. 마이페이지에서 구독을 먼저 정리해주세요.'
        });
      }
    }

    // 하위 컬렉션 삭제(배치 — 400건 단위 커밋으로 Firestore 배치 한도 안전)
    const subcols = ['creditHistory', 'couponHistory', 'history', 'notifications'];
    for (const name of subcols) {
      const docs = await userRef.collection(name).get();
      let batch = db.batch();
      let n = 0;
      for (const d of docs.docs) {
        batch.delete(d.ref);
        n++;
        if (n % 400 === 0) { await batch.commit(); batch = db.batch(); }
      }
      if (n % 400 !== 0) await batch.commit();
    }

    // ★ H-10: 결제 비밀·UGC 정리 (재무 기록 orders/subscriptionOrders는 전자상거래법상 보존 위해 유지).
    //   billingSecrets는 재결제 자격증명이라 반드시 삭제(C-03 분리로 새로 생긴 컬렉션 — 누락돼 있던 갭).
    await db.collection('billingSecrets').doc(uid).delete().catch(() => {});
    //   UGC는 best-effort: 인덱스 부재 등으로 실패해도 탈퇴 자체는 진행(개인정보 핵심은 위 user 문서·Auth).
    const deleteByQuery = async (label, snapPromise, withComments = false) => {
      try {
        const docs = (await snapPromise).docs;
        let batch = db.batch(), n = 0;
        const flush = async () => { if (n % 400 === 0) { await batch.commit(); batch = db.batch(); } };
        for (const d of docs) {
          if (withComments) {
            const cs = await d.ref.collection('comments').get();
            for (const c of cs.docs) { batch.delete(c.ref); n++; await flush(); }
          }
          batch.delete(d.ref); n++; await flush();
        }
        if (n % 400 !== 0) await batch.commit();
      } catch (e) { logger.warn('account.ugc_cleanup_failed', { uid, label, err: e && e.message }); }
    };
    await deleteByQuery('posts', db.collection('posts').where('authorId', '==', uid).get(), true);
    await deleteByQuery('qna', db.collection('qna').where('authorId', '==', uid).get());
    await deleteByQuery('comments', db.collectionGroup('comments').where('authorId', '==', uid).get());
    // 주의: Storage 업로드 이미지는 경로가 UID 네임스페이스가 아니라 일괄삭제 보류 — storage.rules 작업에서 함께 처리.

    await userRef.delete();

    // Auth 계정 삭제 — Admin 권한이라 재인증 불필요. 이미 없으면(중복 호출 등) 성공으로 간주.
    try { await admin.auth().deleteUser(uid); }
    catch (e) { if (e.code !== 'auth/user-not-found') throw e; }

    logger.info('account.deleted', { uid, deletedSubcollections: subcols, billingSecrets: true, ugc: ['posts', 'qna', 'comments'] });
    return res.json({ ok: true });
  } catch (e) {
    logger.error('account.delete_failed', { uid, err: e });
    return res.status(500).json({ error: '탈퇴 처리 중 오류가 발생했어요. 잠시 후 다시 시도하거나 고객센터로 문의해주세요.' });
  }
});

module.exports = router;
