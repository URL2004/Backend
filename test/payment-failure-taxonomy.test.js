// 결제 실패 분류·알림 증폭 회귀 테스트(2026-09-04 사고).
//
// 사고 요약: 한 사용자가 계좌 잔액부족으로 3번 거절당했을 뿐인데
//   · payment.toss_confirm_failed(SEV2) 3건
//   · payment.provider_not_done(SEV2) 3건   ← 같은 실패의 두 번째 기록
//   · client.payment_error(SEV2) 3건        ← 프런트가 되돌려 보낸 같은 실패
//   · ops.rate_threshold_exceeded(SEV1 @here) 1건
// 총 10건이 나갔고, 거절된 주문 3건은 정산 후보로 남아 매시간 워커가 다시 집었다.
//
// 여기서 잠그는 계약:
//   ① 고객 사유 거절은 SEV3 한 줄이다(우리 장애로 올리지 않는다).
//   ② 모르는 코드·설정 오류는 절대 SEV3으로 내려가지 않는다.
//   ③ 급증 판정은 "서로 다른 주체 수"로 센다. 한 사람의 재시도는 급증이 아니다.
//   ④ 거절로 끝난 주문은 정산 후보에서 빠진다.
//   ⑤ 돈 관련 이벤트는 전부 심각도 카탈로그에 등록돼 있다.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const taxonomy = require('../lib/paymentFailureTaxonomy');
const opsEvents = require('../lib/opsEvents');
const opsLog = require('../lib/opsLog');

const paymentSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payment.js'), 'utf8');

// ── ① 고객 사유 거절 ────────────────────────────────────────────────────
test('잔액부족 거절은 고객 사유로 분류되고 돈이 나가지 않았음을 명시한다', () => {
  const failure = taxonomy.classifyPaymentFailure({
    providerCode: 'REJECT_ACCOUNT_PAYMENT',
    providerMessage: '잔액부족으로 결제에 실패했습니다.',
    httpStatus: 403,
    providerStatus: 'ABORTED',
    lookupHttpStatus: 200
  });

  assert.equal(failure.outcome, taxonomy.OUTCOME_CUSTOMER_DECLINED);
  assert.equal(failure.category, 'insufficient_funds');
  assert.equal(failure.customerDecline, true);
  assert.equal(failure.moneyAtRisk, false);
  assert.equal(failure.actionRequired, 'none');
  assert.equal(failure.severityHint, 'SEV3');
  // 재시도해도 DONE이 되지 않는다 → 정산 워커가 다시 집으면 안 된다.
  assert.equal(failure.reconcilable, false);
  // 사용자에게는 결제사 원문을 그대로 보여 준다("충전을 마치지 못했어요"가 아니라).
  assert.equal(failure.userMessage, '잔액부족으로 결제에 실패했습니다.');
});

test('주문 조회의 failure.code가 승인 응답보다 우선한다', () => {
  const failure = taxonomy.classifyPaymentFailure({
    providerCode: 'PAY_PROCESS_ABORTED',
    providerMessage: '결제가 중단됐습니다.',
    httpStatus: 400,
    providerStatus: 'ABORTED',
    providerFailureCode: 'EXCEED_MAX_ONE_DAY_AMOUNT',
    providerFailureMessage: '1일 결제 한도를 초과했습니다.',
    lookupHttpStatus: 200
  });

  assert.equal(failure.category, 'limit_exceeded');
  assert.equal(failure.customerDecline, true);
  assert.equal(failure.userMessage, '1일 결제 한도를 초과했습니다.');
});

test('사유 코드가 없어도 주문 상태가 ABORTED·EXPIRED면 정상 이탈로 종결한다', () => {
  for (const [status, category] of [['ABORTED', 'checkout_aborted'], ['EXPIRED', 'session_expired']]) {
    const failure = taxonomy.classifyPaymentFailure({
      httpStatus: 400,
      providerStatus: status,
      lookupHttpStatus: 200
    });
    assert.equal(failure.category, category, status);
    assert.equal(failure.customerDecline, true, status);
    assert.equal(failure.reconcilable, false, status);
  }
});

// ── ② 안전한 쪽으로 기우는 판정 ─────────────────────────────────────────
test('시크릿 키·가맹점 설정 오류는 문자열에 INVALID이 있어도 SEV1이다', () => {
  const failure = taxonomy.classifyPaymentFailure({
    providerCode: 'UNAUTHORIZED_KEY',
    providerMessage: '인증되지 않은 시크릿 키입니다.',
    httpStatus: 401
  });

  assert.equal(failure.outcome, taxonomy.OUTCOME_OPERATOR_FAULT);
  assert.equal(failure.customerDecline, false);
  assert.equal(failure.severityHint, 'SEV1');
  // 결제사 원문에 키 정보가 실릴 수 있어 사용자에게는 일반 문구만 나간다.
  assert.notEqual(failure.userMessage, '인증되지 않은 시크릿 키입니다.');
});

test('응답 유실·5xx·ALREADY_PROCESSED는 돈 위험으로 본다', () => {
  const lost = taxonomy.classifyPaymentFailure({ networkError: 'socket hang up' });
  assert.equal(lost.outcome, taxonomy.OUTCOME_PROVIDER_AMBIGUOUS);
  assert.equal(lost.moneyAtRisk, true);
  assert.equal(lost.reconcilable, true);

  const already = taxonomy.classifyPaymentFailure({
    providerCode: 'ALREADY_PROCESSED_PAYMENT',
    httpStatus: 400
  });
  assert.equal(already.moneyAtRisk, true);
  assert.equal(already.category, 'already_processed');

  const upstream = taxonomy.classifyPaymentFailure({ providerCode: 'PROVIDER_ERROR', httpStatus: 500 });
  assert.equal(upstream.moneyAtRisk, true);
});

test('조회 자체가 실패하면 거절 코드가 있어도 상태 불명으로 남긴다', () => {
  // 거절로 보이지만 조회로 확인하지 못했다. 돈이 나갔을 가능성을 배제할 수 없다.
  const failure = taxonomy.classifyPaymentFailure({
    providerCode: 'REJECT_ACCOUNT_PAYMENT',
    httpStatus: 403,
    lookupHttpStatus: 503
  });
  assert.equal(failure.outcome, taxonomy.OUTCOME_PROVIDER_AMBIGUOUS);
  assert.equal(failure.moneyAtRisk, true);
});

test('모르는 실패 코드는 정상 이탈이 아니라 우리 장애로 본다', () => {
  const failure = taxonomy.classifyPaymentFailure({ providerCode: 'SOME_NEW_CODE_2027', httpStatus: 400 });
  assert.equal(failure.customerDecline, false);
  assert.equal(failure.severityHint, 'SEV2');
});

test('READY·IN_PROGRESS는 종료 상태가 아니라 정산 대상으로 남긴다', () => {
  const failure = taxonomy.classifyPaymentFailure({ httpStatus: 400, providerStatus: 'IN_PROGRESS', lookupHttpStatus: 200 });
  assert.equal(failure.outcome, taxonomy.OUTCOME_PROVIDER_PENDING);
  assert.equal(failure.reconcilable, true);
  assert.equal(taxonomy.isTerminalAbandonedStatus('IN_PROGRESS'), false);
});

// ── 재시도 상관관계 ─────────────────────────────────────────────────────
test('같은 회원의 반복 거절은 재시도 이력으로 드러난다', () => {
  taxonomy.resetFailureHistory();
  const base = { uid: 'uid_repeat', category: 'insufficient_funds', outcome: taxonomy.OUTCOME_CUSTOMER_DECLINED };
  taxonomy.trackFailure({ ...base, orderId: 'order_a' });
  taxonomy.trackFailure({ ...base, orderId: 'order_b' });
  const third = taxonomy.trackFailure({ ...base, orderId: 'order_c' });

  assert.equal(third.uidFailures5m, 3);
  assert.equal(third.uidDistinctOrders5m, 3);
  assert.equal(third.repeatedDecline, true);

  // 읽기 전용 조회는 집계를 늘리지 않는다(프런트 보고가 같은 실패를 두 번 세지 않게).
  const peek = taxonomy.peekFailures({ uid: 'uid_repeat' });
  assert.equal(peek.uidFailures5m, 3);
  assert.equal(taxonomy.peekFailures({ uid: 'uid_repeat' }).uidFailures5m, 3);
  taxonomy.resetFailureHistory();
});

// ── ③ 급증 판정은 주체 수로 센다 ────────────────────────────────────────
test('한 회원의 반복 실패는 급증(SEV1)으로 승격되지 않는다', () => {
  const classification = { sev: 'SEV2', domain: 'billing', action: 'x', cataloged: true };
  let surge = null;
  // billing 임계는 3이다. 같은 uid로 10번 실패해도 주체는 1명이다.
  for (let i = 0; i < 10; i++) {
    const outcome = opsLog.record(
      { event: 'billing.test_repeat', level: 'warn', uid: 'uid_single', orderId: `order_${i}` },
      classification
    );
    if (outcome.surge) surge = outcome.surge;
  }
  assert.equal(surge, null, '한 사람의 반복은 급증이 아니다');
});

test('서로 다른 회원의 실패가 임계를 넘으면 급증으로 승격된다', () => {
  const classification = { sev: 'SEV2', domain: 'refund', action: 'x', cataloged: true };
  let surge = null;
  for (let i = 0; i < 4; i++) {
    const outcome = opsLog.record(
      { event: 'refund.test_spread', level: 'error', uid: `uid_${i}` },
      classification
    );
    if (outcome.surge) surge = outcome.surge;
  }
  assert.ok(surge, 'refund 임계 3명을 넘으면 급증이어야 한다');
  assert.equal(surge.domain, 'refund');
  assert.ok(surge.subjects >= 3, `주체 수가 실려야 한다: ${JSON.stringify(surge)}`);
});

test('SEV3(정상 이탈)은 급증 판정에서 아예 빠진다', () => {
  const classification = { sev: 'SEV3', domain: 'payment', action: 'x', cataloged: true };
  for (let i = 0; i < 20; i++) {
    const outcome = opsLog.record(
      { event: 'payment.customer_declined', level: 'warn', uid: `decline_uid_${i}` },
      classification
    );
    assert.equal(outcome.surge, null, 'SEV3은 급증을 만들지 않는다');
  }
});

test('결제 실패는 사유별로 다른 문서에 쌓인다', () => {
  const classification = { sev: 'SEV3', domain: 'payment', action: 'x', cataloged: true };
  const a = opsLog.record({ event: 'payment.customer_declined', level: 'warn', failureCategory: 'insufficient_funds' }, classification);
  const b = opsLog.record({ event: 'payment.customer_declined', level: 'warn', failureCategory: 'limit_exceeded' }, classification);
  assert.equal(a.entry.failureCategory, 'insufficient_funds');
  assert.equal(b.entry.failureCategory, 'limit_exceeded');
  // 잔액부족과 한도초과가 한 문서로 합쳐지면 관리자 화면에서 "무엇이 몰리는지"가 사라진다.
  assert.notEqual(a.entry.failureCategory, b.entry.failureCategory);
});

// ── ④ 거절 주문은 정산 후보에서 빠진다 ──────────────────────────────────
test('승인 경로는 종료 상태 주문을 abandoned로 닫고 정산 후보에서 제외한다', () => {
  assert.match(
    paymentSource,
    /const abandoned = !identityMismatch && paymentFailures\.isTerminalAbandonedStatus\(approval\.status\)/u,
    '종료 상태 판정이 승인 검증 경로에 있어야 한다'
  );
  assert.match(
    paymentSource,
    /reconciliationCandidate: !identityMismatch && !abandoned/u,
    'ABORTED 주문이 정산 후보로 남으면 매시간 워커가 다시 집는다'
  );
  assert.match(paymentSource, /status: 'abandoned'/u, '정산 워커도 종료 상태를 abandoned로 닫아야 한다');
  assert.match(paymentSource, /payment\.reconciliation_abandoned_closed/u);
});

test('거절 응답에는 결제사 원문과 declined 표시가 실린다', () => {
  assert.match(paymentSource, /declined: true/u);
  assert.match(paymentSource, /error: failure\.userMessage/u, '거절 사유를 사용자에게 그대로 전달해야 한다');
});

test('승인 실패는 조회를 끝낸 뒤 한 번만 기록한다', () => {
  // 예전에는 toss_confirm_failed(승인 실패) + provider_not_done(조회 결과)이 각각 나가
  // 같은 실패 한 건이 알림 2건으로 보였다. 이제 기록 지점은 헬퍼 한 곳뿐이다.
  const helperAt = paymentSource.indexOf('function logPaymentConfirmFailure');
  const handlerAt = paymentSource.indexOf('async function handleCreditPaymentConfirmation');
  assert.ok(helperAt > 0 && handlerAt > helperAt, 'logPaymentConfirmFailure 헬퍼가 있어야 한다');

  const handlerBody = paymentSource.slice(handlerAt);
  assert.equal(
    handlerBody.includes("logger.warn('payment.toss_confirm_failed'"),
    false,
    '승인 실패 기록은 logPaymentConfirmFailure 한 곳으로 모은다'
  );
  // 거절이면 이미 남긴 줄이 있으므로 provider_not_done을 다시 남기지 않는다.
  assert.match(paymentSource, /if \(!failure\) \{\s*\n\s*logPaymentConfirmFailure\(/u);
  // 돈 위험 건은 바로 뒤 status_unknown(SEV1)이 알리므로 여기서는 중복 알림을 만들지 않는다.
  assert.match(paymentSource, /noAlert: true \}\);\s*\n\s*return retry;/u);
});

// ── 실제로 나가는 로그 한 줄 ────────────────────────────────────────────
test('잔액부족 거절 로그는 SEV3 이벤트 하나에 판단 재료를 모두 담는다', () => {
  // 2026-09-04 실제 사고와 같은 입력(승인 403 REJECT_ACCOUNT_PAYMENT → 조회 ABORTED)으로
  // 실제 로그 함수를 호출해, 나가는 이벤트명과 필드를 값으로 잠근다.
  const paymentRouter = require('../routes/payment');
  const logger = require('../lib/logger').logger;
  const captured = [];
  const originalWarn = logger.warn;
  const originalError = logger.error;
  logger.warn = (event, fields) => captured.push({ level: 'warn', event, fields });
  logger.error = (event, fields) => captured.push({ level: 'error', event, fields });

  try {
    taxonomy.resetFailureHistory();
    const failure = taxonomy.classifyPaymentFailure({
      providerCode: 'REJECT_ACCOUNT_PAYMENT',
      providerMessage: '잔액부족으로 결제에 실패했습니다.',
      httpStatus: 403,
      providerStatus: 'ABORTED',
      lookupHttpStatus: 200
    });
    const call = () => paymentRouter.creditGrantPolicy.logPaymentConfirmFailure({
      failure,
      uid: 'uid_decline',
      orderId: 'order_decline_1',
      amount: 5900,
      credits: 200,
      purchaseKind: 'credit_package',
      resolvedByLookup: true,
      confirmSummary: { code: 'REJECT_ACCOUNT_PAYMENT', message: '잔액부족으로 결제에 실패했습니다.', status: null },
      orderSummary: { status: 'ABORTED', failureCode: 'REJECT_ACCOUNT_PAYMENT', method: '계좌이체' },
      confirmLatencyMs: 820,
      lookupLatencyMs: 310,
      elapsedMs: 3250
    });
    call();

    assert.equal(captured.length, 1, '거절 한 건은 로그도 한 줄이다');
    const [line] = captured;
    assert.equal(line.event, 'payment.customer_declined');
    assert.equal(line.fields.outcome, 'customer_declined');
    assert.equal(line.fields.failureCategory, 'insufficient_funds');
    assert.equal(line.fields.moneyAtRisk, false);
    assert.equal(line.fields.creditsGranted, 0);
    assert.equal(line.fields.actionRequired, 'none');
    assert.equal(line.fields.code, 'REJECT_ACCOUNT_PAYMENT');
    assert.equal(line.fields.providerStatus, 'ABORTED');
    assert.equal(line.fields.providerMethod, '계좌이체');
    assert.equal(line.fields.confirmLatencyMs, 820);
    assert.match(line.fields.message, /잔액부족/u);
    assert.match(line.fields.message, /5,900원/u);

    // 두 번째 시도부터는 "이 회원의 반복"이 로그에 드러난다.
    captured.length = 0;
    call();
    assert.equal(captured[0].fields.retryUidFailures5m, 2);
    assert.equal(captured[0].fields.repeatedDecline, true);
    assert.match(captured[0].fields.message, /2번째/u);
  } finally {
    logger.warn = originalWarn;
    logger.error = originalError;
    taxonomy.resetFailureHistory();
  }
});

test('설정 오류는 같은 헬퍼에서 error 레벨 SEV1 이벤트로 나간다', () => {
  const paymentRouter = require('../routes/payment');
  const logger = require('../lib/logger').logger;
  const captured = [];
  const originalWarn = logger.warn;
  const originalError = logger.error;
  logger.warn = (event, fields) => captured.push({ level: 'warn', event, fields });
  logger.error = (event, fields) => captured.push({ level: 'error', event, fields });

  try {
    paymentRouter.creditGrantPolicy.logPaymentConfirmFailure({
      failure: taxonomy.classifyPaymentFailure({ providerCode: 'UNAUTHORIZED_KEY', httpStatus: 401 }),
      uid: 'uid_ops',
      orderId: 'order_ops_1',
      amount: 5900,
      confirmSummary: {},
      orderSummary: null
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].level, 'error');
    assert.equal(captured[0].event, 'payment.provider_rejected_request');
    assert.equal(opsEvents.CATALOG['payment.provider_rejected_request'].sev, 'SEV1');
  } finally {
    logger.warn = originalWarn;
    logger.error = originalError;
    taxonomy.resetFailureHistory();
  }
});

// ── ⑤ 돈 관련 이벤트는 전부 등급이 정해져 있어야 한다 ────────────────────
test('결제·환불·구독·웹훅·정산 이벤트는 빠짐없이 심각도 카탈로그에 등록돼 있다', () => {
  // 왜: 카탈로그에 없는 warn은 디스코드는 물론 관리자 장애 로그에도 남지 않는다.
  // 2026-09-04 감사에서 billing.secret_read_failed 등 36건이 이렇게 조용히 묻히고 있었다.
  const roots = ['routes', 'lib', 'middleware'];
  const moneyDomains = new Set(['payment', 'refund', 'subscription', 'webhook', 'billing']);
  const missing = [];
  const files = [];
  for (const dir of roots) {
    const full = path.join(__dirname, '..', dir);
    for (const name of fs.readdirSync(full)) if (name.endsWith('.js')) files.push(path.join(full, name));
  }
  files.push(path.join(__dirname, '..', 'server.js'));

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /logger(?:[A-Za-z]*)?\.(warn|error|fatal)\(\s*['"`]([a-z0-9_.]+)['"`]/g;
    let match;
    while ((match = re.exec(src))) {
      const event = match[2];
      if (!moneyDomains.has(opsEvents.domainFromEvent(event))) continue;
      if (!opsEvents.CATALOG[event]) missing.push(`${event} (${path.basename(file)})`);
    }
  }
  assert.deepEqual(missing, [], `카탈로그 미등록 돈 이벤트:\n  ${missing.join('\n  ')}`);
});

test('새 결제 실패 이벤트는 등급과 대응 안내를 모두 갖는다', () => {
  const required = [
    ['payment.customer_declined', 'SEV3'],
    ['payment.confirm_recovered_by_lookup', 'SEV3'],
    ['payment.provider_rejected_request', 'SEV1'],
    ['payment.reconciliation_abandoned_closed', 'SEV3'],
    ['payment.reconciliation_worker_failed', 'SEV2'],
    ['payment.checkout_preclaim_conflict', 'SEV3']
  ];
  for (const [event, sev] of required) {
    const entry = opsEvents.CATALOG[event];
    assert.ok(entry, `${event} 미등록`);
    assert.equal(entry.sev, sev, event);
    assert.ok(entry.action && entry.action.length > 10, `${event} 대응 안내 부실`);
  }
});
