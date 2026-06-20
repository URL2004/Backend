// [정리 마이그레이션 · C-03] 기존 users/{uid}.subscription 에서 billingKey·customerKey 필드 삭제.
// ────────────────────────────────────────────────────────────────────────────
// ⚠️ 파괴적 — 반드시 아래를 먼저 확인한 뒤 실행:
//   1) migrate-billing-secrets.js 로 billingSecrets/{uid} 백필 완료
//   2) 새 코드 배포 후 정기결제가 billingSecrets 에서 읽어 정상 청구되는지 1사이클 확인
//   (읽기 경로는 billingSecrets→sub.billingKey 폴백이므로, 백필이 끝났으면 이 정리는 안전)
// 실행: node scripts/cleanup-billing-secrets.js

const { admin, db } = require('../config');
if (!db) { console.error('Firebase 미설정 — FIREBASE_SERVICE_ACCOUNT 가 필요합니다.'); process.exit(1); }

(async () => {
  let cleaned = 0, skipped = 0, scanned = 0;
  const snap = await db.collection('users').get();
  for (const doc of snap.docs) {
    scanned++;
    const sub = doc.data().subscription;
    if (!sub || (sub.billingKey == null && sub.customerKey == null)) { skipped++; continue; }
    // 안전장치: billingSecrets 백필이 안 된 사용자는 건너뛴다(폴백 의존하므로 삭제하면 청구 불가).
    const bs = await db.collection('billingSecrets').doc(doc.id).get();
    if (sub.billingKey && !(bs.exists && bs.data().billingKey)) {
      console.warn(`SKIP ${doc.id} — billingSecrets 미백필(먼저 migrate 실행)`);
      skipped++; continue;
    }
    await doc.ref.update({
      'subscription.billingKey': admin.firestore.FieldValue.delete(),
      'subscription.customerKey': admin.firestore.FieldValue.delete()
    });
    cleaned++;
  }
  console.log(`subscription 결제키 정리 완료 — 스캔 ${scanned} · 삭제 ${cleaned} · 건너뜀 ${skipped}`);
  process.exit(0);
})().catch(e => { console.error('정리 실패:', e); process.exit(1); });
