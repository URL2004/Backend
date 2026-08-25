// [마이그레이션 · C-04] 기존 orders·subscriptionOrders 의 paymentKey → paymentSecrets/{orderId} 백필.
// ────────────────────────────────────────────────────────────────────────────
// 비파괴적: 주문 문서의 paymentKey는 그대로 둔다(환불 폴백 유지). 백필 후 별도 cleanup으로 주문 문서에서 제거.
//   환불 경로는 paymentSecrets→order.paymentKey 폴백이라, 백필 없이도 환불은 동작한다. 이 스크립트는 노출 정리 준비.
// 실행: FIREBASE_SERVICE_ACCOUNT 설정 환경에서  node scripts/migrate-payment-secrets.js

const { admin, db } = require('../config');

const BATCH_SIZE = 400;

async function commitBatch(pending) {
  if (!pending.length) return;
  const batch = db.batch();
  for (const item of pending) {
    batch.set(item.ref, item.data, { merge: true });
  }
  await batch.commit();
  pending.length = 0;
}

async function main() {
  if (!db) throw new Error('Firebase 미설정 — FIREBASE_SERVICE_ACCOUNT 필요');

  const existingSnapshot = await db.collection('paymentSecrets').get();
  const existing = new Map(existingSnapshot.docs.map(doc => [doc.id, doc.data() || {}]));
  const pending = [];
  let moved = 0;
  let skipped = 0;
  let scanned = 0;
  let conflicts = 0;

  for (const collectionName of ['orders', 'subscriptionOrders']) {
    const snapshot = await db.collection(collectionName).get();
    for (const doc of snapshot.docs) {
      scanned++;
      const order = doc.data() || {};
      const paymentKey = order.paymentKey;
      if (!paymentKey) {
        skipped++;
        continue;
      }
      const current = existing.get(doc.id);
      if (current?.paymentKey) {
        if (current.paymentKey !== paymentKey || (current.uid && order.uid && current.uid !== order.uid)) conflicts++;
        else skipped++;
        continue;
      }
      const data = {
        paymentKey,
        uid: order.uid || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        migratedFrom: collectionName
      };
      pending.push({ ref: db.collection('paymentSecrets').doc(doc.id), data });
      existing.set(doc.id, data);
      moved++;
      if (pending.length >= BATCH_SIZE) await commitBatch(pending);
    }
  }
  await commitBatch(pending);

  const summary = { scanned, moved, skipped, conflicts };
  console.log(JSON.stringify(summary));
  if (conflicts > 0) throw new Error(`paymentSecrets 충돌 ${conflicts}건 — 원문 정리 중단 필요`);
  return summary;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(error => {
    console.error('마이그레이션 실패:', error.message);
    process.exit(1);
  });
}

module.exports = { BATCH_SIZE, main };
