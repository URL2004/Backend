'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const paymentRouter = require('../routes/payment');

const { resolveCreditPackageCheckout, RETIRED_PRODUCT_MESSAGE } = paymentRouter.creditGrantPolicy;
const ENV = {};

test('종료 상품(2,900·8,700)과 문의 전용 상품(116,000)은 새 결제 상품으로 해석되지 않는다', () => {
  for (const amount of [2900, 8700]) {
    const resolved = resolveCreditPackageCheckout({ amount, env: ENV });
    assert.equal(resolved.product, null);
    assert.equal(resolved.reason, 'PRODUCT_RETIRED');
    assert.equal(resolved.inquiryOnly, false);
  }
  const inquiry = resolveCreditPackageCheckout({ amount: 116000, env: ENV });
  assert.equal(inquiry.product, null);
  assert.equal(inquiry.reason, 'PRODUCT_RETIRED');
  assert.equal(inquiry.inquiryOnly, true);
});

test('구매 가능 상품은 그대로 통과하고 미지 금액은 INVALID_PRODUCT다', () => {
  const starter = resolveCreditPackageCheckout({ amount: 5900, env: ENV });
  assert.equal(starter.reason, null);
  assert.equal(starter.product.paidCredits, 200);
  assert.equal(starter.product.eventBonusCredits, 0);
  assert.equal(starter.product.totalCredits, 200);
  assert.equal(starter.product.offerPolicyVersion, 'credit-offer-v4-202609');
  assert.equal(starter.product.label, '스타터');
  for (const amount of [14500, 29000, 58000]) {
    assert.equal(resolveCreditPackageCheckout({ amount, env: ENV }).reason, null);
  }
  assert.deepEqual(resolveCreditPackageCheckout({ amount: 1234, env: ENV }), { product: null, reason: 'INVALID_PRODUCT' });
  assert.deepEqual(resolveCreditPackageCheckout({ amount: '5900.5', env: ENV }), { product: null, reason: 'INVALID_PRODUCT' });
  assert.deepEqual(resolveCreditPackageCheckout({}), { product: null, reason: 'INVALID_PRODUCT' });
});

test('배포 직전 선점된 종료 상품 intent는 같은 uid·금액일 때만 약속 이행을 위해 통과한다', () => {
  const viaIntent = resolveCreditPackageCheckout({
    amount: 2900, uid: 'u1', existingIntent: { uid: 'u1', amount: 2900, paidCredits: 100 }, env: ENV
  });
  assert.equal(viaIntent.reason, null);
  assert.equal(viaIntent.viaIntent, true);
  assert.equal(viaIntent.product.amount, 2900);

  assert.equal(resolveCreditPackageCheckout({
    amount: 2900, uid: 'u1', existingIntent: { uid: 'someone-else', amount: 2900 }, env: ENV
  }).reason, 'PRODUCT_RETIRED', '다른 uid의 intent로는 못 연다');
  assert.equal(resolveCreditPackageCheckout({
    amount: 2900, uid: 'u1', existingIntent: { uid: 'u1', amount: 8700 }, env: ENV
  }).reason, 'PRODUCT_RETIRED', '금액이 다른 intent로는 못 연다');
  assert.equal(resolveCreditPackageCheckout({
    amount: 116000, uid: 'u1', existingIntent: { uid: 'u1', amount: 116000 }, env: ENV
  }).reason, 'PRODUCT_RETIRED', '문의 전용은 intent가 있어도 온라인 결제 불가');
});

test('비상 복귀 스위치는 종료 상품만 다시 열고 문의 전용 상품은 열지 않는다', () => {
  const env = { CREDIT_LEGACY_CHECKOUT_ENABLED: '1' };
  assert.equal(resolveCreditPackageCheckout({ amount: 2900, env }).reason, null);
  assert.equal(resolveCreditPackageCheckout({ amount: 8700, env }).reason, null);
  assert.equal(resolveCreditPackageCheckout({ amount: 116000, env }).reason, 'PRODUCT_RETIRED');
});

test('prepare/confirm 라우트는 공용 게이트를 쓰고 사용자 안내 문구·코드가 고정돼 있다', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payment.js'), 'utf8');
  assert.match(RETIRED_PRODUCT_MESSAGE, /요금제가 바뀌어/u);
  const prepareStart = source.indexOf("router.post('/prepare-payment'");
  const prepareBody = source.slice(prepareStart, source.indexOf('preclaimPaymentIntent({', prepareStart));
  assert.match(prepareBody, /resolveCreditPackageCheckout\(\{ amount \}\)/u, 'prepare는 공용 게이트로 상품을 해석한다');
  assert.match(prepareBody, /code: 'PRODUCT_RETIRED'/u);
  assert.doesNotMatch(prepareBody, /product = getCreditProduct\(amount\)/u, 'prepare가 종료 상품을 그대로 통과시키던 경로 재유입');

  const confirmStart = source.indexOf('async function handleCreditPaymentConfirmation');
  const confirmBody = source.slice(confirmStart, source.indexOf('// An already-applied order is a successful idempotent retry', confirmStart));
  assert.match(confirmBody, /resolveCreditPackageCheckout\(\{ amount: safeAmount, existingIntent, uid: verifiedUid \}\)/u);
  assert.match(confirmBody, /payment\.product_retired_rejected/u);
  // 과거 주문 해석(리컨실 재적용·업그레이드 재생·checkout-context)은 getCreditProduct를 그대로 써야 한다.
  assert.match(source, /paymentIntentGrant\(intent, getCreditProduct\(STARTER_UPGRADE\.targetAmount\)\)/u);
  assert.match(source, /getCreditProduct\(Number\(order\.amount\)/u);
});

test('결제 오류 분류는 PRODUCT_RETIRED를 정상 이탈(SEV3)로 본다', () => {
  // 2026-09-04: 판정 규칙이 routes/events.js의 정규식에서 lib/paymentFailureTaxonomy로 옮겼다.
  // 정규식 문자열이 아니라 판정 결과를 잠근다 — 규칙이 어디에 있든 계약은 같아야 한다.
  const taxonomy = require('../lib/paymentFailureTaxonomy');
  assert.ok(taxonomy.declineCategoryForCode('PRODUCT_RETIRED'), 'PRODUCT_RETIRED는 정상 이탈');
  // PAY_PROCESS_ABORTED는 코드만으로 원인을 알 수 없다 → 우리 쪽 장애로 본다(놓치는 것보다 낫다).
  assert.equal(taxonomy.declineCategoryForCode('PAY_PROCESS_ABORTED'), null);
  // 프런트가 되돌려 보내는 우리 코드(주문 상태가 ABORTED로 확정된 뒤에만 나간다)는 정상 이탈이다.
  assert.equal(taxonomy.declineCategoryForCode('PAYMENT_ABORTED'), 'checkout_aborted');
  // 설정 오류는 문자열에 INVALID이 있어도 절대 정상 이탈로 내리지 않는다.
  assert.equal(taxonomy.declineCategoryForCode('INVALID_API_KEY'), null);
  const events = fs.readFileSync(path.join(__dirname, '..', 'routes', 'events.js'), 'utf8');
  assert.match(events, /paymentFailures\.declineCategoryForCode/u, '프런트 보고도 같은 표를 써야 한다');
  const catalog = require('../lib/opsEvents');
  const entry = (catalog.CATALOG || catalog.catalog || catalog)['payment.product_retired_rejected'];
  assert.ok(entry, 'opsEvents 카탈로그에 payment.product_retired_rejected 등록');
});
