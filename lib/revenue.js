// lib/revenue.js — 매출 집계.
// 데이터 소스:
//   - orders            : 크레딧 충전. 필드 amount(KRW), status(paid|refund_requested|refunded), createdAt
//   - subscriptionOrders: 구독 결제. 필드 amount(KRW), status(paid|failed), approvedAt
// 시간대: 모든 경계는 KST(UTC+9, DST 없음) 기준. createdAt/approvedAt 은 Firestore Timestamp(UTC).
// 인덱스: 단일 필드 범위 쿼리만 사용 → 복합 인덱스 불필요. 상태별 분류는 메모리에서.

const { admin, db } = require('../config');

const KST = 9 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// 주어진 UTC ms 를 KST 달력 구성요소로 분해
function kstParts(ms) {
  const d = new Date(ms + KST);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth(),
    day: d.getUTCDate(),
    dow: d.getUTCDay() // 0=일 … 6=토
  };
}
// KST 달력의 y-m-day 00:00:00 에 해당하는 실제 UTC ms
function kstMidnightUtc(y, m, day) {
  return Date.UTC(y, m, day) - KST;
}

// 기간명 → { startMs, endMs, label }
function periodRange(name, nowMs) {
  nowMs = nowMs || Date.now();
  const p = kstParts(nowMs);
  const todayStart = kstMidnightUtc(p.y, p.m, p.day);
  switch (name) {
    case 'today':
      return { startMs: todayStart, endMs: todayStart + DAY, label: '오늘' };
    case 'yesterday':
      return { startMs: todayStart - DAY, endMs: todayStart, label: '어제' };
    case 'week': {
      const monOffset = (p.dow + 6) % 7; // 월요일 시작
      return { startMs: todayStart - monOffset * DAY, endMs: nowMs, label: '이번 주' };
    }
    case 'month': {
      const start = kstMidnightUtc(p.y, p.m, 1);
      return { startMs: start, endMs: nowMs, label: '이번 달' };
    }
    default:
      return { startMs: todayStart, endMs: todayStart + DAY, label: '오늘' };
  }
}

// 한 컬렉션을 기간으로 합산
async function sumCollection(coll, tsField, startMs, endMs) {
  const start = admin.firestore.Timestamp.fromMillis(startMs);
  const end = admin.firestore.Timestamp.fromMillis(endMs);
  const snap = await db.collection(coll)
    .where(tsField, '>=', start)
    .where(tsField, '<', end)
    .get();

  const out = { paidAmount: 0, paidCount: 0, refundAmount: 0, refundCount: 0, failCount: 0 };
  snap.forEach((doc) => {
    const o = doc.data();
    const amt = Number(o.amount) || 0;
    switch (o.status) {
      case 'paid':
      case 'refund_requested': // 환불 진행 중이지만 결제는 받은 상태 → 매출에 포함
        out.paidAmount += amt; out.paidCount += 1; break;
      case 'refunded':
        out.refundAmount += amt; out.refundCount += 1; break;
      case 'failed':
        out.failCount += 1; break;
      default:
        break;
    }
  });
  return out;
}

// 기간 매출 집계
async function getRevenue(periodName) {
  if (!db || !admin) throw new Error('Firestore가 초기화되지 않았습니다(FIREBASE_SERVICE_ACCOUNT 확인).');
  const r = periodRange(periodName);
  const [charge, sub] = await Promise.all([
    sumCollection('orders', 'createdAt', r.startMs, r.endMs),
    sumCollection('subscriptionOrders', 'approvedAt', r.startMs, r.endMs)
  ]);
  return {
    period: periodName,
    label: r.label,
    startMs: r.startMs,
    endMs: r.endMs,
    totalPaid: charge.paidAmount + sub.paidAmount,
    totalCount: charge.paidCount + sub.paidCount,
    refundAmount: charge.refundAmount + sub.refundAmount,
    refundCount: charge.refundCount + sub.refundCount,
    charge,
    sub
  };
}

function won(n) { return '₩' + Number(n || 0).toLocaleString('ko-KR'); }

// 단일 기간 상세 임베드(슬래시 커맨드/온디맨드용)
function revenueEmbed(r) {
  const fields = [
    { name: '합계', value: `**${won(r.totalPaid)}** · ${r.totalCount}건`, inline: false },
    { name: '크레딧 충전', value: `${won(r.charge.paidAmount)} · ${r.charge.paidCount}건`, inline: true },
    { name: '구독', value: `${won(r.sub.paidAmount)} · ${r.sub.paidCount}건`, inline: true }
  ];
  if (r.refundCount) fields.push({ name: '환불', value: `${won(r.refundAmount)} · ${r.refundCount}건`, inline: true });
  return { title: `📊 매출 · ${r.label}`, color: 0x3f9e63, fields, timestamp: new Date().toISOString() };
}

// 여러 기간을 한 줄씩 요약(일일 리포트용)
function revenueField(r) {
  return {
    name: r.label,
    value: `**${won(r.totalPaid)}** · ${r.totalCount}건  (충전 ${won(r.charge.paidAmount)} / 구독 ${won(r.sub.paidAmount)})`
      + (r.refundCount ? `  · 환불 ${won(r.refundAmount)}(${r.refundCount})` : ''),
    inline: false
  };
}

module.exports = { getRevenue, periodRange, won, revenueEmbed, revenueField, PERIODS: ['today', 'yesterday', 'week', 'month'] };
