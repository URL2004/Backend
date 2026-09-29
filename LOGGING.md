# Backend Logging &amp; 장애 감지

이 백엔드는 stdout JSON 로그를 표준으로 사용한다. Render, Vercel, 로컬 터미널 어디서든 같은 이벤트 구조로 검색할 수 있게 맞춘다.

## 핵심 개념: 레벨과 심각도는 다른 축이다 (2026-08-29 개편)

- **레벨(level)** = 기록할지 여부. `debug|info|warn|error|fatal`
- **심각도(severity)** = 사람을 깨울지 여부. `SEV1|SEV2|SEV3`

개편 전에는 "level이 error/fatal인가"만으로 알림을 보냈다. 그 결과 결제 실패 대부분이 `warn`이라
**디스코드로 한 건도 가지 않았고**(대표 사례: `client.payment_error`), 반대로 미출시 기능의 일상적
실패가 돈 사고와 똑같은 🚨로 쏟아졌다. 지금은 **[`lib/opsEvents.js`](lib/opsEvents.js) 카탈로그**가
이벤트별 등급·도메인·대응 안내를 정한다. **등급 조정은 코드가 아니라 이 표만 고친다.**

| 등급 | 뜻 | 라우팅 |
|---|---|---|
| `SEV1` | 돈·데이터 정합성이 깨졌거나 깨질 수 있음 | 전용 채널 + `@here` 멘션 |
| `SEV2` | 사용자가 기능을 못 쓰는 중 | alert 채널 |
| `SEV3` | 기록만, 추세로 관찰 | 조용한 채널 |
| (미등록) | `fatal`→SEV1, `error`→SEV2, 그 외 알림 없음 | 폴백 |

새 이벤트를 추가할 때 카탈로그에 넣지 않으면 `warn`은 조용히 묻힌다. **결제·정산·인증 관련
이벤트는 반드시 카탈로그에 등록한다.** 모든 항목이 `action`(다음 행동 한 줄)을 갖는지는
`test/ops-alerting.test.js`가 강제한다.

## 흐름

```
logger.warn/error(event, fields)
  └→ stdout JSON (항상)
  └→ opsEvents.classify(event, level) → severity 없으면 여기서 종료
       └→ opsLog.record()   → Firestore `opsLogs` (관리자 페이지·사후 분석·급증 탐지)
       └→ discord.opsAlert() → 등급별 채널 (noAlert면 생략 — 아래 참고)
       └→ 도메인 실패가 5분 임계 초과 시 `ops.rate_threshold_exceeded`(SEV1) 자동 생성
         (임계는 **서로 다른 주체 수**로 센다 — 아래 급증 판정 참고)
```

`noAlert: true`의 의미는 **"디스코드 중복 발송 금지"**이지 "기록 금지"가 아니다. 접근 로그(`http.request` 5xx)나
바로 앞에서 `discord.billingFailure()`를 직접 호출한 과금 실패가 여기 해당한다 — 알림은 한 번만 가지만
관리자 화면과 급증 탐지에는 그대로 반영된다.

## 관리자 로그에만 남기기 — `discord: false` (2026-09-29 로그 위생 개편)

9/29 하루치 Render 로그(error 6건·warn 11,550줄)를 전수 확인한 결과 두 가지 문제가 있었다.

1. **알아보는 데 필요한 사건이 관리자 화면에 없었다.** 중복 입력 차단, "편집할 본문 없음" 422, 모델 타임아웃,
   품질 게이트 차단, 재시작 복구 같은 사건은 카탈로그에 없어 `warn`으로 stdout에만 남았다. 관리자 장애 로그
   (`opsLogs`)는 카탈로그에 등록된 사건만 저장하므로, Render 로그를 직접 뒤지지 않으면 볼 수 없었다.
2. **정상 동작이 알림을 만들었다.** 추천 규칙 거절(409)이 `error`라 SEV2 알림이 매일 나갔고, CSP 보고가
   CORS에 걸려 하루 10,350줄의 warn을, 검증 전 `/public/metrics` 503이 779줄의 warn을 만들었다.

그래서 카탈로그 항목에 `discord: false`를 둘 수 있게 했다. **기록(opsLogs)은 하되 Discord 발송만 건너뛴다.**
관리자 화면에서는 `action`(설명·대응)과 함께 보이고, 알림 채널은 조용하다. `discord: false`는 SEV3에만 허용한다
(깨워야 하는 등급을 조용히 두면 안 되므로 `test/ops-alerting.test.js`가 강제).

| 이벤트 | 뜻 | 로그에서 볼 것 |
|---|---|---|
| `transform.duplicate_input_blocked` | 같은 내용이 반복된 입력을 차감 전 400으로 막음 | `dupMethod`(paragraph_repeat / half_window), `dupRatio`, `repeatedBlocks`, `textDigest`(같은 글 반복 여부) |
| `transform.no_editable_content` | 표·제목·참고문헌 같은 보존 구조만 있어 422 | `lockTypes`(잠금 종류별 청크 수), `documentProfile`, `textDigest` |
| `transform.humanize_blocked` | 품질 게이트가 결과 전달을 막음(무차감) | `gates`, `gateDetail` |
| `transform.humanize_technical_recovery_queued` | 모델 타임아웃 등으로 자동 재시도 큐에 넣음 | `reason`, 이후 `humanize_done` 유무 |
| `transform.restart_recovery_queued` | 배포·재시작으로 끊긴 작업을 자동 재개 | 배포 직후 1~2건은 정상 |
| `gpt_prod.call_failed` | 모델 호출 1회 실패(대개 60초 타임아웃) | 단건은 자체 복구. 한 시간에 여러 uid면 OpenAI 장애 의심 |
| `detect_report.preview_failed` | 감지 보고서의 예문 생성만 실패(점수는 정상 전달) | 같은 시각 `detect_report.completed` |
| `coupon.invalid_code_format` | 허용되지 않은 문자가 든 쿠폰 코드를 400으로 거절 | `invalidCharKinds`, `length` (코드 원문은 싣지 않음) |
| `referral.rejected` | 추천 규칙 거절(본인·동일 가입 환경·이미 적용·한도) — 정상 | `code` |
| `public_metrics.unavailable` | 공개 지표가 503인 이유(사유별 1시간 1회) | `reason`: not_initialized / not_verified |
| `security.csp_violation_summary` | 지난 1시간 CSP 위반 보고 집계 | `top[]`의 `blockedOrigin`이 chrome-extension이면 무시 |

관리자 화면은 `message`(한 줄 요약)·`action`(대응)·`reason`을 그대로 보여주므로, 위 사건은 모두 사람이 읽을 수 있는
`message`를 함께 남긴다. 판단 근거 숫자(`dupRatio`, `lockTypes`, `gates`, `model` 등)는 `opsLogs` 문서의
`details`(JSON 문자열, 800자 상한)에 보존된다 — 화면에 칸이 없어도 Firestore·다이제스트에서 읽을 수 있다.

같은 개편에서 바뀐 것:

- `referral.failed`는 이제 **5xx(진짜 실패)만** 쓴다. 4xx 규칙 거절은 `referral.rejected`(SEV3, 조용함).
- `/csp-report`는 `corsMiddleware`보다 앞에 마운트한다. 브라우저는 CSP 보고를 `Origin: null`로 보내므로
  CORS 뒤에 두면 전부 403이 된다(9/29까지 실제로 그랬다). 건별 보고는 `security.csp_violation`(info, stdout만).
- `http.request_aborted`에 `method`·`path`·`requestId`·`headersSent`가 실린다. `headersSent:false`면 서버가
  응답을 못 만든 채 클라이언트가 포기한 것(핸들러가 멈춘 요청) — 9/29 쿠폰 사고가 이 유형이었다.
- 라우트가 `res.locals.logExpectedStatus = true`를 두면 4xx/503 접근 로그가 warn 대신 info(`expectedStatus:true`)로 남는다.
  검증 전 `/public/metrics` 503이 첫 사용처다.
- 공개 지표 검증: `POST /admin/public-metrics` `{ "action": "inspect" | "verify" | "unverify" }` (관리자 ID 토큰).
  `verified`는 "숫자를 사람이 확인했다"는 운영 결정이라 코드가 자동으로 켜지 않는다.

## 결제 실패는 세 갈래다 (2026-09-04 개편)

결제 실패를 성공/실패 한 축으로만 보면 "돈이 없어서 되돌아간 사람"과 "전 사용자 결제 불능"이
같은 🚨로 나간다. 실제로 2026-09-04에 한 사용자의 잔액부족 거절 3건이 알림 10건으로 증폭됐다.

분류는 [`lib/paymentFailureTaxonomy.js`](lib/paymentFailureTaxonomy.js)가 하고, 등급은 카탈로그가 정한다.

| outcome | 뜻 | 돈 | 이벤트 | 등급 |
|---|---|---|---|---|
| `customer_declined` | 잔액부족·한도초과·사용자 취소·세션 만료 | 안 나감 | `payment.customer_declined` | SEV3 |
| `provider_ambiguous` | 응답 유실·5xx·ALREADY_PROCESSED | **나갔을 수 있음** | `payment.status_unknown` | SEV1 |
| `operator_fault` | 시크릿 키·가맹점 설정·요청 형식 | 안 나감 | `payment.provider_rejected_request` | SEV1 |
| `provider_pending` | READY·IN_PROGRESS | 안 나감 | `payment.provider_not_done` | SEV2 |

**판정 철칙: 애매하면 우리 잘못 쪽으로 기운다.** 거절은 화이트리스트로만 인정하고, 모르는 코드는
절대 SEV3으로 내리지 않는다. `INVALID_API_KEY`처럼 문자열에 `INVALID`이 들어 있어도
`OPERATOR_FAULT_CODES`가 항상 먼저 걸러진다 — 이걸 거절로 분류하면 전 사용자 결제 불능이 조용히 묻힌다.

세 가지 규칙이 따라온다.

1. **한 실패는 한 줄.** 승인 호출과 주문 조회를 모두 끝낸 뒤 `logPaymentConfirmFailure`가 한 번만 기록한다.
   예전에는 `payment.toss_confirm_failed` + `payment.provider_not_done`으로 갈려 건수가 두 배로 보였다.
2. **종료 상태는 정산 대상이 아니다.** `ABORTED`·`EXPIRED`는 재시도해도 `DONE`이 되지 않으므로
   intent를 `abandoned`로 닫고 `reconciliationCandidate=false`로 만든다. 이 처리가 없던 때는
   거절 주문 하나가 매시간 정산 워커에 다시 잡혀 "불일치=수동검토" 알림을 만들어 냈다.
3. **거절 사유는 사용자에게 그대로 간다.** 응답에 `declined: true`와 결제사 원문이 실린다.
   화면에 "결제가 됐는데 크레딧이 안 보이면 문의해 주세요"만 띄우면 사용자가 같은 결제를 되풀이한다.
   단 `operator_fault`의 원문은 키·가맹점 정보가 실릴 수 있어 일반 문구로 바꿔 내보낸다.

### 급증 판정은 "몇 건"이 아니라 "몇 명"

`RATE_THRESHOLDS`의 값은 **창 안에서 서로 다른 주체(uid 우선, 없으면 orderId) 수**와 비교한다.
같은 사람이 5번 재시도해도 주체는 1이라 급증이 아니고, 서로 다른 5명이 실패하면 급증이다.
`uid`도 `orderId`도 없는 사건(인프라 등)은 종전처럼 건별로 센다.
**SEV3은 급증 판정에서 아예 빠진다** — 정상 이탈이 모여 SEV1을 만들면 알림이 스스로를 깨운다.

### 결제 실패 로그에 항상 실리는 필드

| 필드 | 쓰임 |
|---|---|
| `outcome` · `failureCategory` | 위 표의 분류. 이 두 개만 봐도 깨울 일인지 결정된다 |
| `moneyAtRisk` | `false`면 돈이 안 나갔다는 뜻. 새벽 판단의 핵심 |
| `actionRequired` | `none` / `monitor` / `manual` |
| `code` · `providerMessage` | 결제사 원문. 고객 문의에 그대로 인용한다 |
| `providerStatus` · `providerMethod` | 주문 상태(ABORTED 등)와 결제수단 |
| `retryUidFailures5m` · `retryUidDistinctOrders5m` | **한 사람의 반복인지 여러 사람의 장애인지** |
| `repeatedDecline` | 같은 사람이 같은 사유로 되풀이 중 |
| `confirmLatencyMs` · `lookupLatencyMs` · `elapsedMs` | 결제사 지연과 우리 지연 분리 |

주문 조회가 실패로 끝난 경우 top-level `code`/`message`는 비어 있고 진짜 사유는 `failure` 안에 있다.
`providerResultSummary`가 이를 `failureCode`/`failureMessage`로 꺼내므로 Toss 콘솔을 따로 열 필요가 없다.

### 돈 관련 이벤트는 반드시 카탈로그에 등록한다

카탈로그에 없는 `warn`은 디스코드는 물론 **관리자 장애 로그에도 남지 않는다**. 2026-09-04 감사에서
`billing.secret_read_failed`를 비롯한 36건이 이렇게 조용히 묻히고 있었다. 지금은
`test/payment-failure-taxonomy.test.js`가 payment·refund·subscription·webhook·billing 도메인 이벤트를
전수 조사해 미등록이 하나라도 있으면 실패시킨다.

## 관리자 화면

관리자 페이지 → **장애 로그** 탭에서 등급·도메인·미확인 여부·검색어(uid/주문번호/requestId)로 조회하고
확인(ack) 처리까지 한다. 데이터는 Firestore `opsLogs`이며 **클라이언트가 직접 읽지 않고**
`/admin/ops-*` API를 거친다(firestore.rules에서 직접 접근 차단).

| 엔드포인트 | 인증 | 용도 |
|---|---|---|
| `POST /admin/ops-logs` | 관리자 idToken | 목록(필터: severity·domain·onlyOpen·q·hours) |
| `POST /admin/ops-summary` | 관리자 idToken | 등급 합계·미확인 SEV1·하트비트·알림 상태 |
| `POST /admin/ops-ack` | 관리자 idToken | 확인 처리(`{id, acked, note}`) |
| `POST /cron/ops-watchdog` | `x-cron-secret` | 주기 작업 중단 감지 → SEV1 |
| `POST /cron/ops-digest` | `x-cron-secret` | 일일 운영 다이제스트 → Discord |

## 부재 감지 (dead man's switch)

알림은 앱이 스스로 보내므로 **앱이 죽으면 알림도 죽는다.** 그래서 두 겹으로 감시한다.

1. **하트비트** — 주기 작업이 성공할 때마다 `opsHeartbeat.beat(name)`으로 도장을 찍고,
   `/cron/ops-watchdog`이 기대 주기를 넘긴 항목을 SEV1으로 올린다.
   감시 대상: `subscription.process_due`(구독 갱신), `revenue.daily_report`, `ops.digest`.
   → 과거 "cron이 매시간 403으로 조용히 죽어 구독 갱신이 멈춘" 사고가 이 방식으로 잡힌다.
2. **외부 업타임 모니터** — 앱 밖에서 `/healthz`를 1~5분 간격으로 폴링해야 한다(필수, 아래 운영 설정 참고).
   앱이 통째로 죽거나 OOM으로 재시작 루프에 빠지면 1번도 못 돌기 때문이다.

### Render 구독 cron 정본

Render의 image-backed Cron Job은 Docker Command에서 `${CRON_SECRET}`을 셸처럼 자동 확장하지 않는다.
따옴표를 이용한 `/bin/sh -c` 우회도 Render의 인수 파서가 따옴표를 보존할 수 있어 사용하지 않는다.
`curl` 자체의 환경변수 확장 기능을 사용한 아래 명령을 정본으로 유지한다.

```text
curl --fail-with-body --silent --show-error --variable %CRON_SECRET --expand-header x-cron-secret:{{CRON_SECRET}} -X POST https://ai-backend-3xtk.onrender.com/subscription/process-due -H Content-Type:application/json -d {}
```

- 웹 서비스와 Cron Job의 `CRON_SECRET`은 같은 64자리 무작위 값을 사용한다.
- 어느 한쪽 값을 바꿀 때는 양쪽을 함께 갱신하고 **웹 서비스와 Cron Job을 모두 재배포**한다.
- 변경 후 Render의 `POST /v1/cron-jobs/{id}/runs` 또는 대시보드 `Trigger Run`으로 실제 Cron 실행을 검증한다.
- 합격 신호는 Cron의 `finished successfully`, 서버의 `subscription.cron_process_due_completed`,
  `subscription.process_due` heartbeat 갱신 세 가지다.
- `subscription.cron_auth_rejected` 한 건은 외부 오인증 요청일 수 있으므로 SEV3 관측으로 남긴다.
  실제 중단은 heartbeat가 150분 이상 갱신되지 않을 때 `ops.watchdog_stale_heartbeat` SEV1로 판단한다.

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---:|---|
| `LOG_LEVEL` | `production=info`, 그 외 `debug` | `debug`, `info`, `warn`, `error`, `fatal` |
| `LOG_FORMAT` | `json` | `json` 또는 로컬용 `pretty` |
| `LOG_STACKS` | `0` | `1`이면 에러 stack 포함 |
| `LOG_HTTP_HEALTH` | `0` | `1`이면 `/healthz`, `/api/health` 요청도 기록 |
| `LOG_MAX_STRING` | `2000` | 긴 문자열 truncate 길이 |
| `DISCORD_WEBHOOK_SEV1` | `DISCORD_WEBHOOK_ALERT` | SEV1 전용 채널(분리 권장) |
| `DISCORD_WEBHOOK_SEV3` | `DISCORD_WEBHOOK_ALERT` | SEV3 조용한 채널(분리 권장) |
| `DISCORD_ALERT_MENTION` | `@here` | SEV1 멘션. 빈 문자열이면 멘션 없음 |
| `CRON_SECRET` | (필수) | 워치독·다이제스트·구독 갱신 cron 공통 |

## 공통 필드

모든 로그는 다음 필드를 기본으로 가진다.

```json
{
  "ts": "2026-06-13T01:42:54.602Z",
  "level": "info",
  "service": "ai-backend",
  "env": "staging",
  "event": "http.request",
  "requestId": "34718f5f-c289-4199-9b24-6566bcd54166",
  "method": "POST",
  "path": "/analyze",
  "uid": "firebase-uid",
  "statusCode": 200,
  "durationMs": 8312
}
```

`requestId`는 요청마다 자동 발급되고 응답 헤더 `x-request-id`에도 내려간다. 프론트/고객문의/Render 로그를 연결할 때 이 값을 우선 사용한다.

## 마스킹

아래 값은 자동 마스킹된다.

- `authorization`, `cookie`, `password`, `secret`
- `idToken`, `access_token`, `refresh_token`
- `paymentKey`, `billingKey`, `authKey`, `customerKey`, `cardNumber`
- `email`, `phone`

본문 원문과 결과문은 로그에 넣지 않는다. 길이, 모드, requestId, jobId만 남긴다.

## 주요 이벤트

### HTTP

| 이벤트 | 의미 |
|---|---|
| `http.request` | 요청 완료. `statusCode`, `durationMs` 포함 |
| `http.request_error` | 4xx 처리 에러 |
| `http.unhandled_error` | 5xx 미처리 에러 |
| `http.request_aborted` | 클라이언트 연결 끊김. `headersSent:false`면 서버가 응답을 못 만든 요청 |
| `cors.origin_rejected` | 허용되지 않은 Origin 차단(`/csp-report`는 CORS 앞이라 여기 안 잡힘) |
| `security.csp_violation` | 브라우저 CSP 위반 보고 1건(info, stdout만) |
| `security.csp_violation_summary` | CSP 위반 1시간 집계(관리자 로그) |

### Analyze / Credit

| 이벤트 | 의미 |
|---|---|
| `analyze.started` | 분석/휴머나이즈 시작 |
| `analyze.precheck_failed` | 로그인/잔액/쿠폰 사전 검증 실패 |
| `analyze.floor_blocked` | FLOOR 품질 게이트 차단, 무차감 |
| `analyze.llm_failed` | LLM 실패, 무차감 |
| `analyze.deducted` | 크레딧/쿠폰 차감 성공 |
| `analyze.restore_triggered` | 차감 후 응답 실패 가능성으로 복구 시작 |
| `analyze.restore_completed` | 복구 완료 |
| `analyze.restore_failed_manual_action` | 복구 실패. 수동 보정 필요 |
| `analyze.completed` | 정상 응답 직전 |

### Transform

| 이벤트 | 의미 |
|---|---|
| `transform.started` | job 생성 |
| `transform.awaiting_evidence_approval` | 근거 후보 검수 대기 |
| `transform.evidence_approved` | 사용자 근거 승인 |
| `transform.blocked` | 품질 게이트 차단, 무차감 |
| `transform.done` | formal 재구성 완료 |
| `transform.humanize_done` | blog/polish job 완료 |
| `transform.credit_deduct_failed_manual_action` | 결과 생성 후 차감 실패. 수동 확인 필요 |
| `transform.cancelled_by_user` | 사용자 취소 |
| `transform.duplicate_input_blocked` | 중복 입력 차단(무차감). `method`·`textDigest`로 오탐·반복 판단 |
| `transform.no_editable_content` | 편집할 본문 없음 422(무차감). `lockTypes`로 오분류 판단 |
| `transform.humanize_blocked` | 품질 게이트 차단(무차감). `gates` |
| `transform.humanize_technical_recovery_queued` | 모델 타임아웃 등 기술 원인 자동 재시도 |
| `transform.restart_recovery_queued` | 재시작으로 끊긴 작업 자동 재개 |

### Payment / Refund / Subscription

| 이벤트 | 의미 |
|---|---|
| `payment.confirmed` | Toss confirm + 크레딧 지급 완료 |
| `payment.duplicate_confirm_blocked` | 중복 결제 confirm 차단 |
| `payment.toss_confirm_failed` | Toss confirm 실패 |
| `refund.requested` | 환불 요청 접수 |
| `refund.credit_approved` | 크레딧 부분환불 완료 |
| `refund.subscription_approved` | 구독 환불 완료 |
| `refund.compensation_failed_manual_action` | 환불 보상 실패. 수동 복구 필요 |
| `subscription.started` | 구독 첫 결제/쿠폰 지급 완료 |
| `subscription.charge_failed` | 정기결제 실패 |
| `subscription.cron_process_due_completed` | cron 처리 요약 |
| `toss.webhook_received` | Toss webhook 수신 |
| `toss.webhook_handler_failed` | webhook 후처리 실패 |

## 운영 설정 (배포 후 1회, 필수)

장애 감지의 절반은 **앱 밖**에 있다. 아래 3개를 등록해야 부재 감지가 완성된다.

1. **외부 업타임 모니터** — UptimeRobot·Better Stack 등에서 `https://<host>/healthz`를 1~5분 간격 폴링,
   실패 시 디스코드 알림. *앱이 죽으면 앱이 보내는 알림도 죽으므로 이것만이 유일한 감지 수단이다.*
2. **워치독 cron** — 15~30분 간격
   ```
   POST https://<host>/cron/ops-watchdog
   Header: x-cron-secret: <CRON_SECRET>
   ```
3. **일일 다이제스트 cron** — 하루 1회(예: KST 09:00)
   ```
   POST https://<host>/cron/ops-digest
   Header: x-cron-secret: <CRON_SECRET>
   ```

> 워치독 자체가 등록되지 않으면 하트비트가 쌓이기만 하고 아무도 보지 않는다. 등록 후
> 한 번 수동 호출해 `{"ok":true}`와 `beats` 배열을 확인할 것.

## 사고 대응 순서

1. 디스코드 알림의 **대응** 필드가 첫 행동을 알려준다(카탈로그의 `action`).
2. 알림의 `requestId`·`주문`·`회원`을 관리자 페이지 → 장애 로그 검색창에 넣어 전후 사건을 본다.
3. 조치 후 **확인 처리**를 눌러 미확인 목록에서 제거한다(누가 언제 봤는지 기록된다).
4. 같은 사건이 반복되면 카탈로그에서 등급을 조정하거나 임계치(`lib/opsLog.js RATE_THRESHOLDS`)를 손본다.

## 운영 검색 예시

Render 로그에서 우선 볼 쿼리:

```text
event:analyze.restore_failed_manual_action
event:transform.credit_deduct_failed_manual_action
event:refund.compensation_failed_manual_action
event:subscription.charge_failed
event:toss.webhook_handler_failed
requestId:<고객이 보낸 x-request-id>
uid:<Firebase uid>
jobId:<transform job id>
orderId:<Toss order id>
```

> 대부분의 경우 Render 로그보다 **관리자 페이지 → 장애 로그**가 빠르다. Render는 보존 기간이 짧아
> 며칠 지난 사고는 남아 있지 않지만, `opsLogs`는 30일 보관한다(`lib/opsLog.js RETENTION_DAYS`).

### 결제가 실패했는데 알림이 안 왔다면

개편 전 사고 유형이라 먼저 이걸 확인한다.

1. 관리자 → 장애 로그에서 `payment` 도메인 필터. `client.payment_error`(우리 쪽)와
   `client.payment_declined`(카드사 거절)는 **다른 이벤트**로 분리돼 있다.
2. 요약 줄의 **알림 정상 / 전송 실패 N건** 배지를 본다 — 웹훅 자체가 죽었을 수 있다.
3. `client.payment_error_flood`(SEV1)가 보이면 리포트가 한도를 넘겨 **일부만 기록된 상태**다.
   실제 실패는 표시된 수보다 많다.

## 로컬 확인

```powershell
$env:LOG_FORMAT="json"
$env:LOG_LEVEL="debug"
$env:DEV_NO_AUTH="1"
$env:PORT="3107"
npm start
```

다른 터미널:

```powershell
Invoke-RestMethod http://127.0.0.1:3107/healthz
Invoke-WebRequest http://127.0.0.1:3107/toss/webhook -Method POST -ContentType "application/json" -Body '{"eventType":"PAYMENT_STATUS_CHANGED"}'
```
