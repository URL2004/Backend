// [계정] 회원 탈퇴 — Admin SDK로 Firestore 데이터 + Firebase Auth 계정을 서버 권한으로 삭제.
// ★ 기존 클라이언트 재인증(카카오 비밀번호 패턴 추측) 의존 제거.
//   추측 패턴이 안 맞는 카카오 계정은 구조적으로 탈퇴 불가했던 민원(#40·#61·#62·#91)을 해결한다.
//   Admin SDK는 재인증 없이 삭제 가능하므로 팝업 차단·비밀번호 불일치 환경에서도 동작한다.

const express = require('express');
const { admin, db } = require('../config');

const router = express.Router();

router.post('/delete-account', async (req, res) => {
  if (!admin || !db) return res.status(503).json({ error: '인증 서버가 비활성 상태예요. 잠시 후 다시 시도해주세요.' });

  const idToken = req.body && req.body.idToken;
  if (!idToken) return res.status(401).json({ error: '로그인이 필요해요.' });

  let uid;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
  catch { return res.status(401).json({ error: '인증이 만료됐어요. 다시 로그인 후 시도해주세요.' }); }

  try {
    const userRef = db.collection('users').doc(uid);

    // 활성/해지예정 구독이 있으면 탈퇴 차단(전자상거래법 청약철회권 + 토스 심사 요건)
    const snap = await userRef.get();
    if (snap.exists) {
      const sub = snap.data().subscription;
      const nextMs = sub && sub.nextBillingAt && sub.nextBillingAt.toMillis ? sub.nextBillingAt.toMillis() : 0;
      if (sub && (sub.status === 'active' || (sub.status === 'cancelled' && nextMs > Date.now()))) {
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

    await userRef.delete();

    // Auth 계정 삭제 — Admin 권한이라 재인증 불필요. 이미 없으면(중복 호출 등) 성공으로 간주.
    try { await admin.auth().deleteUser(uid); }
    catch (e) { if (e.code !== 'auth/user-not-found') throw e; }

    return res.json({ ok: true });
  } catch (e) {
    console.error('❌ /delete-account 실패 uid=' + uid + ':', e && e.message);
    return res.status(500).json({ error: '탈퇴 처리 중 오류가 발생했어요. 잠시 후 다시 시도하거나 고객센터로 문의해주세요.' });
  }
});

module.exports = router;
