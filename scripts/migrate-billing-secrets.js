// [일회성 마이그레이션 · C-03] users/{uid}.subscription.billingKey → billingSecrets/{uid}
// ────────────────────────────────────────────────────────────────────────────
// 비파괴적: subscription.billingKey는 그대로 둔다(읽기 경로 전환·정리는 결제 무결성 단계에서).
//   목적: 서버 전용 billingSecrets 컬렉션에 기존 구독자 빌링키를 백필 → Phase 1 읽기 전환의 사전 준비.
// 실행: FIREBASE_SERVICE_ACCOUNT 가 설정된 환경에서
//   node scripts/migrate-billing-secrets.js
// 멱등: 이미 billingSecrets 가 있는 uid 는 건너뛴다. 여러 번 실행해도 안전.

const { admin, db } = require('../config');
if (!db) { console.error('Firebase 미설정 — FIREBASE_SERVICE_ACCOUNT 가 필요합니다.'); process.exit(1); }

(async () => {
  let moved = 0, skipped = 0, scanned = 0;
  const snap = await db.collection('users').get();
  for (const doc of snap.docs) {
    scanned++;
    const sub = doc.data().subscription || {};
    if (!sub.billingKey) { skipped++; continue; }
    const ref = db.collection('billingSecrets').doc(doc.id);
    const cur = await ref.get();
    if (cur.exists && cur.data().billingKey) { skipped++; continue; }
    await ref.set({
      billingKey: sub.billingKey,
      cardCompany: sub.cardCompany || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      migratedFrom: 'users.subscription'
    }, { merge: true });
    moved++;
  }
  console.log(`billingSecrets 마이그레이션 완료 — 스캔 ${scanned} · 이동 ${moved} · 건너뜀 ${skipped}`);
  process.exit(0);
})().catch(e => { console.error('마이그레이션 실패:', e); process.exit(1); });
