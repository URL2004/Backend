# Backend Logging

이 백엔드는 stdout JSON 로그를 표준으로 사용한다. Render, Vercel, 로컬 터미널 어디서든 같은 이벤트 구조로 검색할 수 있게 맞춘다.

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---:|---|
| `LOG_LEVEL` | `production=info`, 그 외 `debug` | `debug`, `info`, `warn`, `error`, `fatal` |
| `LOG_FORMAT` | `json` | `json` 또는 로컬용 `pretty` |
| `LOG_STACKS` | `0` | `1`이면 에러 stack 포함 |
| `LOG_HTTP_HEALTH` | `0` | `1`이면 `/healthz`, `/api/health` 요청도 기록 |
| `LOG_MAX_STRING` | `2000` | 긴 문자열 truncate 길이 |

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
| `http.request_aborted` | 클라이언트 연결 끊김 |
| `cors.origin_rejected` | 허용되지 않은 Origin 차단 |

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
