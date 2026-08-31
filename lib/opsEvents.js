// lib/opsEvents.js — 장애 심각도 카탈로그(단일 진실 원천).
//
// 왜 이 파일이 필요한가(2026-08-29 운영 로그 감사):
//   기존에는 알림 조건이 "logger level이 error/fatal인가" 하나뿐이었다. 그 결과
//     · 결제 실패 대부분이 warn이라 디스코드로 한 건도 안 갔고(client.payment_error 등),
//     · 반대로 미출시 기능의 일상적 실패가 돈 사고와 똑같은 🚨로 쏟아졌다.
//   레벨(level)은 "로그를 남길지"를 정하고, 심각도(severity)는 "깨울지"를 정한다. 둘은 다른 축이다.
//
// 운영 원칙:
//   SEV1 — 돈·데이터 정합성이 이미 깨졌거나 깨질 수 있음. 사람이 지금 확인해야 함(멘션).
//   SEV2 — 사용자가 기능을 못 쓰는 중. 오늘 안에 확인.
//   SEV3 — 기록은 남기되 깨우지 않음. 추세로 본다(다이제스트).
//   미등록 이벤트는 레벨로 폴백한다(fatal→SEV1, error→SEV2, 그 외 알림 없음).
//   → 등급 조정은 코드가 아니라 이 표만 고치면 된다.
//
// action: 알림에 그대로 실리는 "다음 행동" 한 줄. 새벽에 알림을 봐도 바로 움직일 수 있게 쓴다.

const SEV1 = 'SEV1';
const SEV2 = 'SEV2';
const SEV3 = 'SEV3';

// domain: 알림 제목과 관리자 로그 필터에 쓰인다.
const CATALOG = {
  // ── 결제: 돈이 오간 뒤의 실패 ─────────────────────────────────────────
  'payment.apply_failed_reconciliation_required': { sev: SEV1, domain: 'payment', action: '결제는 승인됐고 크레딧이 미지급. orders/paymentIntents에서 orderId 확인 후 수동 지급.' },
  'payment.reconciliation_mismatch': { sev: SEV1, domain: 'payment', action: '승인 정보와 주문 정보 불일치. 지급 보류됨 — Toss 콘솔에서 실제 결제 대조.' },
  'payment.existing_order_conflict': { sev: SEV1, domain: 'payment', action: '같은 orderId에 다른 uid/금액. 도용 또는 중복 발급 가능성 — 즉시 확인.' },
  'payment.status_unknown': { sev: SEV1, domain: 'payment', action: '결제 상태 불명(네트워크/5xx). 재시도 시 자동 복구되지만, 미복구 시 수동 대조 필요.' },
  'payment.intent_prepare_failed': { sev: SEV2, domain: 'payment', action: '결제 준비 실패 — 사용자는 결제 불가. Firestore 상태 확인.' },
  'payment.intent_update_failed': { sev: SEV2, domain: 'payment', action: '결제 상태 기록 실패 — 정산 추적이 끊길 수 있음.' },
  'payment.precheck_failed': { sev: SEV2, domain: 'payment', action: '결제 전 조회 실패(Firestore). 반복되면 DB 장애 의심.' },
  'payment.toss_secret_missing': { sev: SEV1, domain: 'payment', action: 'TOSS_SECRET_KEY 미설정 — 전체 결제 불능. env 즉시 확인.' },
  'payment.toss_confirm_failed': { sev: SEV2, domain: 'payment', action: '토스 승인 실패. code가 카드사 거절(REJECT_*)이면 정상 이탈, 그 외 반복되면 우리 쪽 장애.' },
  'payment.provider_not_done': { sev: SEV2, domain: 'payment', action: '승인 응답이 DONE이 아님 — 지급 보류. 반복 시 Toss 상태 확인.' },
  'payment.uid_mismatch_blocked': { sev: SEV1, domain: 'payment', action: '요청 uid와 인증 uid 불일치. 버그 또는 부정 시도 — 로그의 두 uid 대조.' },
  'payment.secret_read_failed': { sev: SEV2, domain: 'payment', action: '결제 시크릿 읽기 실패 — 환불 처리 불능 가능. paymentSecrets 확인.' },
  'payment.secret_recovery_unavailable': { sev: SEV2, domain: 'payment', action: 'paymentKey 없어 환불 불가(구주문). 수동 환불 필요.' },
  'payment.secret_recovery_persist_failed': { sev: SEV2, domain: 'payment', action: '복구한 결제 시크릿 저장 실패.' },
  'client.payment_error': { sev: SEV2, domain: 'payment', action: '사용자 화면에서 결제 실패(우리 쪽 원인 추정). stage로 SDK 로드·네트워크·승인 API 중 어디서 끊겼는지 확인.' },
  'client.payment_declined': { sev: SEV3, domain: 'payment', action: '카드사 거절 등 정상 이탈. 개별 대응 불필요하나 급증하면 결제사 장애 의심.' },
  'client.payment_error_flood': { sev: SEV1, domain: 'payment', action: '결제 오류 리포트가 한도를 넘겨 일부만 기록됨 = 대량 결제 장애 가능성. 관리자 로그에서 payment 도메인 최근 건 확인.' },

  // ── 환불 ─────────────────────────────────────────────────────────────
  'refund.compensation_failed_manual_action': { sev: SEV1, domain: 'refund', action: '크레딧 차감 후 보상 롤백 실패 — 사용자 크레딧이 증발했을 수 있음. 즉시 수동 복구.' },
  'refund.toss_cancel_failed': { sev: SEV1, domain: 'refund', action: 'Toss 환불 API 실패. 고객에게 환불 약속된 상태일 수 있음 — Toss 콘솔에서 직접 처리.' },
  'refund.toss_cancel_status_unknown': { sev: SEV1, domain: 'refund', action: 'Toss 환불 응답이 유실됐고 조회로도 확정하지 못함. 주문의 refundProcessing과 Toss 누적 취소액을 즉시 대조.' },
  'refund.approve_failed': { sev: SEV2, domain: 'refund', action: '환불 승인 처리 실패. 요청 상태 확인 후 재시도.' },
  'refund.reject_failed': { sev: SEV3, domain: 'refund', action: '환불 거절 처리 실패. 재시도.' },
  'refund.request_failed': { sev: SEV2, domain: 'refund', action: '환불 요청 접수 실패 — 고객이 요청을 못 남김.' },
  'payment.cancellation_reconciled_with_unrecovered_credits': { sev: SEV1, domain: 'refund', action: '환불은 됐는데 크레딧 회수 실패 = 실손해. 해당 uid 잔액 수동 조정.' },
  'payment.cancellation_inbox_retry_failed': { sev: SEV2, domain: 'refund', action: '취소 재정산 재시도 실패. 누적되면 정산 불일치.' },
  'payment.cancellation_review_required': { sev: SEV1, domain: 'refund', action: '취소 웹훅과 크레딧 지급 순서가 충돌해 자동 지급을 잠금. paymentIntents·webhookInbox·Toss 결제 상태를 대조 후 수동 종결.' },
  'payment.credit_grant_blocked_by_cancellation': { sev: SEV3, domain: 'refund', action: '이미 취소 격리된 주문의 크레딧 지급 재시도를 차단함. 기존 SEV1 수동 검토 건을 확인.' },
  'credit_lot.inconsistent': { sev: SEV1, domain: 'billing', action: '주문별 크레딧 잔액과 사용자 추적 잔액이 불일치해 변동을 중단함. uid의 creditLots·orders·creditLotV1Balance를 즉시 대조.' },

  // ── 구독 ─────────────────────────────────────────────────────────────
  'subscription.apply_failed_manual_action': { sev: SEV1, domain: 'subscription', action: '첫 결제는 됐는데 구독 미적용. 수동으로 플랜/쿠폰 지급.' },
  'subscription.cycle_apply_failed_manual_action': { sev: SEV1, domain: 'subscription', action: '갱신 결제됐는데 사이클 미적용. 수동 지급.' },
  'subscription.charge_failed': { sev: SEV2, domain: 'subscription', action: '정기결제 최종 실패 → past_due. 고객 안내 필요.' },
  'subscription.first_charge_failed': { sev: SEV2, domain: 'subscription', action: '구독 첫 결제 실패 — 신규 전환 실패. code로 카드 문제인지 확인.' },
  'subscription.billing_key_issue_failed': { sev: SEV2, domain: 'subscription', action: '빌링키 발급 실패 — 카드 등록 불가.' },
  'subscription.charge_no_billing_key': { sev: SEV1, domain: 'subscription', action: '빌링키 분실로 청구 불가 — 구독이 조용히 멈춤. billingSecrets 확인.' },
  'subscription.charge_retrying': { sev: SEV3, domain: 'subscription', action: '1차 실패 후 재시도 중. 추세만 관찰.' },
  'subscription.cron_secret_missing': { sev: SEV1, domain: 'cron', action: 'CRON_SECRET 미설정 — 구독 갱신 전체 중단. env 확인.' },
  // 공개 엔드포인트의 인증 거부 한 건만으로 실제 스케줄러 중단을 단정하지 않는다.
  // 실제 중단은 subscription.process_due heartbeat 부재가 SEV1로 알린다.
  'subscription.cron_secret_rejected': { sev: SEV3, domain: 'cron', action: '구버전 인증 거부 기록. 실제 중단 여부는 구독 갱신 heartbeat에서 판정.' },
  'subscription.cron_auth_rejected': { sev: SEV3, domain: 'cron', action: 'cron 인증이 거부됨. 반복 추세는 관찰하되 실제 중단은 heartbeat SEV1로 판정.' },
  'subscription.cron_process_due_failed': { sev: SEV1, domain: 'cron', action: '구독 갱신 배치 전체 실패. 다음 주기까지 갱신 없음.' },
  'subscription.cron_charge_request_failed': { sev: SEV2, domain: 'cron', action: '개별 청구 호출 실패. 다수 발생 시 self-call 경로(포트/네트워크) 확인.' },
  'subscription.cron_due_failure_rate_high': { sev: SEV1, domain: 'cron', action: '갱신 배치 실패율이 임계 초과. 결제사/빌링키 광범위 문제 의심.' },

  // ── 웹훅 ─────────────────────────────────────────────────────────────
  'toss.webhook_handler_failed': { sev: SEV1, domain: 'webhook', action: '웹훅 후처리 실패. inbox 재처리 큐 확인.' },
  'toss.webhook_verification_unavailable': { sev: SEV2, domain: 'webhook', action: '웹훅 진위 확인 불가(Toss 조회 실패). 503으로 재전송 유도됨.' },
  'toss.webhook_inbox_persist_failed': { sev: SEV2, domain: 'webhook', action: '웹훅 저장 실패 — 503 반환으로 재전송 유도됨.' },
  'toss.webhook_ignored': { sev: SEV2, domain: 'webhook', action: '검증 실패로 200 IGNORED 반환 = 재전송 없음, 이벤트 영구 소실. reason 확인.' },
  'toss.webhook_subscription_closed': { sev: SEV2, domain: 'webhook', action: '외부 취소로 유료회원이 free 강등됨. 고객 커뮤니케이션 필요 여부 판단.' },
  'toss.webhook_billing_deleted': { sev: SEV3, domain: 'webhook', action: '카드 삭제로 구독 해지. 이탈 신호.' },

  // ── 과금(휴머나이징·감지) ─────────────────────────────────────────────
  'transform.humanize_billing_failed_manual_action': { sev: SEV1, domain: 'billing', action: '결과는 전달됐는데 차감 실패. jobId로 재정산.' },
  'transform.blog_fallback_billing_failed_manual_action': { sev: SEV1, domain: 'billing', action: '폴백 결과 전달 후 차감 실패. jobId로 재정산.' },
  'transform.refine_credit_deduct_failed_manual_action': { sev: SEV2, domain: 'billing', action: '문단 보강 차감 실패. 소액이나 누적 확인.' },
  'analyze.restore_failed_manual_action': { sev: SEV1, domain: 'billing', action: '차감 후 복구 실패 — 사용자가 돈만 잃음. 즉시 수동 환급.' },
  'detect_report.paid_deduct_failed_manual_action': { sev: SEV1, domain: 'billing', action: '감지 차감 실패. 수동 확인.' },

  // ── 결과 보존(유실 위험) ───────────────────────────────────────────────
  'transform.persist_failed': { sev: SEV2, domain: 'engine', action: '작업 영속화 실패 — 재시작 시 결과 유실 가능.' },
  'transform.history_save_failed': { sev: SEV2, domain: 'engine', action: '결과 이력 저장 실패 — 사용자가 결과를 다시 못 찾음.' },
  'analyze.history_persist_failed': { sev: SEV2, domain: 'engine', action: '분석 이력 저장 실패.' },
  'transform.jobs_restore_failed': { sev: SEV2, domain: 'engine', action: '재시작 후 작업 복원 실패 — 진행 중이던 작업이 사라짐.' },
  'transform.restart_recovery_exhausted': { sev: SEV2, domain: 'engine', action: '자동 재개 한도 소진. 해당 사용자에게 안내/환급 판단.' },
  'server.shutdown_persist_failed': { sev: SEV2, domain: 'infra', action: '종료 시 작업 영속화 실패 — 진행 중 작업 유실.' },

  // ── 인증·인프라 ───────────────────────────────────────────────────────
  'auth.kakao_user_fetch_failed': { sev: SEV2, domain: 'auth', action: '카카오 로그인 실패 — 신규 유입이 막힐 수 있음. 카카오 API 상태 확인.' },
  'server.health_runtime_config_failed': { sev: SEV1, domain: 'infra', action: '런타임 설정 조회 실패 → /healthz 503. 엔진 전체 불능 가능.' },
  'process.uncaught_exception': { sev: SEV1, domain: 'infra', action: '프로세스가 죽는 중. 재시작 후 원인 스택 확인.' },
  'process.unhandled_rejection': { sev: SEV2, domain: 'infra', action: '처리되지 않은 Promise 거부. 누적되면 메모리/상태 오염.' },
  'server.started': { sev: SEV3, domain: 'infra', action: '서버 시작(배포 또는 재시작). 예상치 못한 재시작이 잦으면 크래시 루프 의심.' },
  'ops.watchdog_stale_heartbeat': { sev: SEV1, domain: 'cron', action: '예정된 주기 작업이 멈춤. 스케줄러(cron-job.org/Render Cron) 등록 상태와 시크릿 확인.' },
  'ops.watchdog_failed': { sev: SEV2, domain: 'cron', action: '워치독 자체가 실패 — 부재 감지가 동작하지 않는 상태.' },
  'ops.digest_failed': { sev: SEV3, domain: 'ops', action: '일일 다이제스트 생성 실패.' },
  'ops.cron_secret_missing': { sev: SEV1, domain: 'cron', action: 'CRON_SECRET 미설정 — 워치독·다이제스트 중단.' },
  // 워치독은 다른 heartbeat의 부재를 판정하는 감시 장치다. 이 인증 실패까지
  // SEV3로 낮추면 감시 장치 자체가 멈춘 상황을 놓치므로 SEV2를 유지한다.
  'ops.cron_auth_rejected': { sev: SEV2, domain: 'cron', action: '운영 워치독·다이제스트 인증 실패. 스케줄러 시크릿과 최근 실행 상태 확인.' },
  'ops.incident_ack_failed': { sev: SEV3, domain: 'ops', action: '관리자 확인 처리 실패.' },
  'subscription.cron_charge_rejected': { sev: SEV3, domain: 'cron', action: '개별 구독 청구가 거부됨. 다수면 failure_rate 경보가 따로 뜬다.' },
  'ops.rate_threshold_exceeded': { sev: SEV1, domain: 'infra', action: '단시간 실패 급증. 같은 창에 찍힌 개별 이벤트를 관리자 로그에서 확인.' },
  'client.app_error': { sev: SEV3, domain: 'frontend', action: '사용자 브라우저 JS 오류. 같은 message가 급증하면 프론트 배포 사고 의심.' },
  'discord.webhook_failed': { sev: SEV3, domain: 'infra', action: '알림 전송 자체가 실패. 웹훅 URL 유효성 확인(이 알림도 못 갔을 수 있음).' },
  'security.durable_rate_limit_unavailable': { sev: SEV2, domain: 'security', action: '영속 속도 제한 설정이 불완전함. enforce 상태라면 Firestore와 RATE_LIMIT_HMAC_SECRET을 확인.' },
  'security.durable_rate_limit_failed_open': { sev: SEV2, domain: 'security', action: '영속 속도 제한 저장소 오류로 메모리 제한만 동작 중. Firestore 상태를 확인.' },
  'security.durable_rate_limit_exceeded': { sev: SEV3, domain: 'security', action: '결제·AI 고비용 요청의 영속 한도 초과. 반복 출처와 정상 사용자 오탐 여부를 확인.' },
  'security.durable_rate_limit_shadow_exceeded': { sev: SEV3, domain: 'security', action: 'shadow 한도 초과 관측. enforce 전환 전에 정상 사용 패턴인지 확인.' },
  'auth.idtoken_in_body_deprecated': { sev: SEV3, domain: 'auth', action: '구형 body.idToken 호출이 남아 있음. 호출 화면을 Authorization Bearer로 전환.' },
  'auth.idtoken_in_body_rejected': { sev: SEV3, domain: 'auth', action: 'body.idToken 전환 완료 후 거절된 구형 호출. 오래된 캐시 클라이언트 여부 확인.' },

  // ── 조용히 둘 것(명시적 SEV3) ─────────────────────────────────────────
  'meta.capi_failed': { sev: SEV3, domain: 'marketing', action: '광고 전환 전송 실패. 누적되면 광고 최적화 저하.' },
  'meta.capi_rejected': { sev: SEV3, domain: 'marketing', action: 'Meta가 이벤트 거부. 파라미터 확인.' },
  'revenue.cron_failed': { sev: SEV2, domain: 'cron', action: '일일 매출 리포트 실패.' },
  'revenue.cron_auth_rejected': { sev: SEV3, domain: 'cron', action: '매출 cron 인증 거부 기록. 실제 중단은 매출 리포트 heartbeat로 판정.' },
  'revenue.cron_secret_missing': { sev: SEV1, domain: 'cron', action: 'CRON_SECRET 미설정 — 매출 리포트 중단. env 확인.' },
  'revenue.admin_token_missing': { sev: SEV2, domain: 'ops', action: 'ADMIN_TOKEN 미설정 — 관리자 매출 조회 불가.' },
  'revenue.admin_auth_rejected': { sev: SEV3, domain: 'ops', action: '관리자 토큰 불일치. 반복되면 외부 스캔 의심.' },
  'revenue.admin_failed': { sev: SEV3, domain: 'ops', action: '관리자 매출 조회 실패.' },
  'public_metrics.read_failed': { sev: SEV3, domain: 'ops', action: '공개 지표 조회 실패.' },
  'writinglab.v2.charge_failed': { sev: SEV2, domain: 'writinglab', action: '글쓰기 랩 과금 실패(미출시 기능).' },
  'writinglab.v2.generate_failed': { sev: SEV3, domain: 'writinglab', action: '글쓰기 랩 생성 실패(미출시 기능).' }
};

// 등록되지 않은 이벤트의 폴백: 레벨만으로 판단한다.
function fallbackSeverity(level) {
  if (level === 'fatal') return SEV1;
  if (level === 'error') return SEV2;
  return null;   // warn/info/debug는 카탈로그에 없으면 알리지 않는다
}

function domainFromEvent(event) {
  const head = String(event || '').split('.')[0];
  const map = {
    payment: 'payment', refund: 'refund', subscription: 'subscription', toss: 'webhook',
    transform: 'engine', analyze: 'engine', detect: 'engine', detect_report: 'engine',
    auth: 'auth', server: 'infra', process: 'infra', http: 'infra', cors: 'infra',
    writinglab: 'writinglab', meta: 'marketing', client: 'frontend', ops: 'ops',
    credit_cancellation: 'refund', credit_lot: 'billing', billing: 'billing', revenue: 'ops', admin: 'ops',
    security: 'security'
  };
  return map[head] || 'ops';
}

// 이벤트 + 레벨 → { sev, domain, action } (알림 대상이 아니면 sev=null)
function classify(event, level) {
  const hit = CATALOG[event];
  if (hit) return { sev: hit.sev, domain: hit.domain, action: hit.action, cataloged: true };
  return { sev: fallbackSeverity(level), domain: domainFromEvent(event), action: '', cataloged: false };
}

const SEVERITY_RANK = { SEV1: 3, SEV2: 2, SEV3: 1 };

module.exports = {
  SEV1,
  SEV2,
  SEV3,
  CATALOG,
  classify,
  domainFromEvent,
  SEVERITY_RANK,
  isAtLeast: (sev, min) => (SEVERITY_RANK[sev] || 0) >= (SEVERITY_RANK[min] || 0)
};
