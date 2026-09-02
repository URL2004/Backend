// lib/revenue.js — 매출 집계.
// 데이터 소스:
//   - orders            : 크레딧 충전. 필드 amount(KRW), status(paid|refund_requested|refund_rejected|partially_refunded|refunded), createdAt
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
    case 'all':
      return { startMs: 0, endMs: nowMs, label: '오픈 이후' };
    default:
      return { startMs: todayStart, endMs: todayStart + DAY, label: '오늘' };
  }
}

// 실제 환불액: refundedAmount(누적) 우선, 없으면 레거시 refundAmount, 그것도 없으면 전액으로 간주.
function refundedOf(o, amt) {
  const r = Number(o.refundedAmount);
  if (Number.isFinite(r) && r > 0) return Math.min(amt, r);
  const legacy = Number(o.refundAmount);
  if (Number.isFinite(legacy) && legacy > 0) return Math.min(amt, legacy);
  return amt;
}

// 주문 문서 배열을 합산한다(순수 함수 — 테스트와 sumCollection이 공유).
// byAmount: 결제 금액(=상품)별 건수·매출·환불. 2026-09 요금제 개편 전후 비교(스탠다드 비중·상품별 환불율)에 쓴다.
// firstPurchaseCount: isFirstPurchase=true로 저장된 주문 중 결제가 유지된 건수(첫 구매 전환율 분자).
function aggregateOrderDocs(rows) {
  const out = { paidAmount: 0, paidCount: 0, refundAmount: 0, refundCount: 0, failCount: 0, byAmount: {}, firstPurchaseCount: 0 };
  const bucket = (amt) => {
    const key = String(amt);
    if (!out.byAmount[key]) out.byAmount[key] = { paidAmount: 0, paidCount: 0, refundAmount: 0, refundCount: 0 };
    return out.byAmount[key];
  };
  for (const o of rows || []) {
    if (!o) continue;
    const amt = Number(o.amount) || 0;
    let counted = false;
    switch (o.status) {
      case 'paid':
      case 'refund_requested': // 환불 진행 중이지만 결제는 받은 상태 → 매출에 포함
      case 'refund_rejected': { // 환불 거절 후 결제가 유지된 상태 → 매출에 포함
        out.paidAmount += amt; out.paidCount += 1;
        const b = bucket(amt); b.paidAmount += amt; b.paidCount += 1;
        counted = true;
        break;
      }
      case 'partially_refunded': {
        // 부분 환불: 남은(보유) 금액은 매출, 환불한 만큼만 환불로 집계
        const refunded = refundedOf(o, amt);
        out.paidAmount += (amt - refunded); out.paidCount += 1;
        out.refundAmount += refunded; out.refundCount += 1;
        const b = bucket(amt);
        b.paidAmount += (amt - refunded); b.paidCount += 1;
        b.refundAmount += refunded; b.refundCount += 1;
        counted = true;
        break;
      }
      case 'refunded': {
        // 전액 환불(또는 누적 전액): 환불액만 집계, 남은 매출은 0
        const refunded = refundedOf(o, amt);
        out.refundAmount += refunded; out.refundCount += 1;
        out.paidAmount += (amt - refunded); // 보통 0
        const b = bucket(amt);
        b.refundAmount += refunded; b.refundCount += 1;
        b.paidAmount += (amt - refunded);
        break;
      }
      case 'failed':
        out.failCount += 1; break;
      default:
        break;
    }
    if (counted && o.isFirstPurchase === true) out.firstPurchaseCount += 1;
  }
  return out;
}

// 한 컬렉션을 기간으로 합산
async function sumCollection(coll, tsField, startMs, endMs) {
  const start = admin.firestore.Timestamp.fromMillis(startMs);
  const end = admin.firestore.Timestamp.fromMillis(endMs);
  const snap = await db.collection(coll)
    .where(tsField, '>=', start)
    .where(tsField, '<', end)
    .get();
  const rows = [];
  snap.forEach((doc) => { rows.push(doc.data()); });
  return aggregateOrderDocs(rows);
}

// 상품별 요약 한 줄: "5,900×3 · 14,500×2 (환불 1)". 건수 0인 상품은 생략한다.
function formatByAmount(byAmount) {
  if (!byAmount || typeof byAmount !== 'object') return '';
  const parts = Object.keys(byAmount)
    .map((key) => [Number(key), byAmount[key]])
    .filter(([amount, b]) => Number.isFinite(amount) && b && ((b.paidCount || 0) > 0 || (b.refundCount || 0) > 0))
    .sort((a, b) => a[0] - b[0])
    .map(([amount, b]) => `${amount.toLocaleString('ko-KR')}×${b.paidCount || 0}`
      + ((b.refundCount || 0) > 0 ? `(환불 ${b.refundCount})` : ''));
  return parts.join(' · ');
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
  // 상품별·첫 구매 줄은 byAmount가 있을 때만 붙인다(getRevenue를 주입하는 테스트 픽스처와 호환).
  const byAmountLine = formatByAmount(r.charge && r.charge.byAmount);
  if (byAmountLine) {
    const firstPurchase = Number(r.charge.firstPurchaseCount) || 0;
    fields.push({ name: '상품별 충전', value: byAmountLine + (firstPurchase ? ` · 첫 구매 ${firstPurchase}건` : ''), inline: false });
  }
  return { title: `📊 매출 · ${r.label}`, color: 0x3f9e63, fields, timestamp: new Date().toISOString() };
}

// 여러 기간을 한 줄씩 요약(일일 리포트용)
function revenueField(r) {
  const byAmountLine = formatByAmount(r.charge && r.charge.byAmount);
  const firstPurchase = Number(r.charge && r.charge.firstPurchaseCount) || 0;
  return {
    name: r.label,
    value: `**${won(r.totalPaid)}** · ${r.totalCount}건  (충전 ${won(r.charge.paidAmount)} / 구독 ${won(r.sub.paidAmount)})`
      + (r.refundCount ? `  · 환불 ${won(r.refundAmount)}(${r.refundCount})` : '')
      + (byAmountLine ? `\n상품별 ${byAmountLine}` + (firstPurchase ? ` · 첫 구매 ${firstPurchase}건` : '') : ''),
    inline: false
  };
}

module.exports = {
  getRevenue,
  periodRange,
  won,
  revenueEmbed,
  revenueField,
  aggregateOrderDocs,
  formatByAmount,
  PERIODS: ['today', 'yesterday', 'week', 'month', 'all']
};
