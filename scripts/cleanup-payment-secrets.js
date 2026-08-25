// [마이그레이션 · C-04] 서버 전용 paymentSecrets와 정확히 일치하는 원문 paymentKey만 주문 문서에서 제거한다.
// 기본은 dry-run. 실제 반영: node scripts/cleanup-payment-secrets.js --apply

'use strict';

const { admin, db } = require('../config');

const BATCH_SIZE = 400;

async function commitBatch(pending) {
  if (!pending.length) return;
  const batch = db.batch();
  for (const item of pending) batch.update(item.ref, item.patch);
  await batch.commit();
  pending.length = 0;
}

async function main(argv = process.argv.slice(2)) {
  if (!db) throw new Error('Firebase 미설정 — FIREBASE_SERVICE_ACCOUNT 필요');
  const apply = argv.includes('--apply');
  const secretSnapshot = await db.collection('paymentSecrets').get();
  const secrets = new Map(secretSnapshot.docs.map(doc => [doc.id, doc.data() || {}]));
  const pending = [];
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    scanned: 0,
    eligible: 0,
    cleaned: 0,
    missingSecret: 0,
    conflicts: 0,
    alreadyClean: 0
  };

  for (const collectionName of ['orders', 'subscriptionOrders']) {
    const snapshot = await db.collection(collectionName).get();
    for (const doc of snapshot.docs) {
      summary.scanned++;
      const order = doc.data() || {};
      if (!order.paymentKey) {
        summary.alreadyClean++;
        continue;
      }
      const secret = secrets.get(doc.id);
      if (!secret?.paymentKey) {
        summary.missingSecret++;
        continue;
      }
      if (secret.paymentKey !== order.paymentKey || (secret.uid && order.uid && secret.uid !== order.uid)) {
        summary.conflicts++;
        continue;
      }
      summary.eligible++;
      if (!apply) continue;
      pending.push({
        ref: doc.ref,
        patch: {
          paymentKey: admin.firestore.FieldValue.delete(),
          paymentKeyPresent: true,
          paymentKeyMigratedAt: admin.firestore.FieldValue.serverTimestamp()
        }
      });
      summary.cleaned++;
      if (pending.length >= BATCH_SIZE) await commitBatch(pending);
    }
  }
  await commitBatch(pending);
  console.log(JSON.stringify(summary));
  if (apply && (summary.conflicts > 0 || summary.missingSecret > 0)) {
    throw new Error(`정리 안전조건 실패 — 누락 ${summary.missingSecret}건, 충돌 ${summary.conflicts}건`);
  }
  return summary;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(error => {
    console.error('정리 실패:', error.message);
    process.exit(1);
  });
}

module.exports = { BATCH_SIZE, main };
