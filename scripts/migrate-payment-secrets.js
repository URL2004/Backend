// [마이그레이션 · C-04] 기존 orders·subscriptionOrders 의 paymentKey → paymentSecrets/{orderId} 백필.
// ────────────────────────────────────────────────────────────────────────────
// 비파괴적: 주문 문서의 paymentKey는 그대로 둔다(환불 폴백 유지). 백필 후 별도 cleanup으로 주문 문서에서 제거.
//   환불 경로는 paymentSecrets→order.paymentKey 폴백이라, 백필 없이도 환불은 동작한다. 이 스크립트는 노출 정리 준비.
// 실행: FIREBASE_SERVICE_ACCOUNT 설정 환경에서  node scripts/migrate-payment-secrets.js

const { admin, db } = require('../config');
if (!db) { console.error('Firebase 미설정 — FIREBASE_SERVICE_ACCOUNT 필요'); process.exit(1); }

(async () => {
  let moved = 0, skipped = 0, scanned = 0;
  for (const coll of ['orders', 'subscriptionOrders']) {
    const snap = await db.collection(coll).get();
    for (const doc of snap.docs) {
      scanned++;
      const pk = doc.data().paymentKey;
      if (!pk) { skipped++; continue; }
      const ref = db.collection('paymentSecrets').doc(doc.id);
      const cur = await ref.get();
      if (cur.exists && cur.data().paymentKey) { skipped++; continue; }
      await ref.set({ paymentKey: pk, uid: doc.data().uid || null, createdAt: admin.firestore.FieldValue.serverTimestamp(), migratedFrom: coll }, { merge: true });
      moved++;
    }
  }
  console.log(`paymentSecrets 백필 완료 — 스캔 ${scanned} · 이동 ${moved} · 건너뜀 ${skipped}`);
  process.exit(0);
})().catch(e => { console.error('마이그레이션 실패:', e); process.exit(1); });
