// [메인] 서버 초기화, 미들웨어 설정, 라우트 연결을 담당하는 진입점

// 1. dotenv 설정을 최상단에 추가 (이게 있어야 .env 파일을 읽습니다)
require('dotenv').config();
const express = require('express');
const { logger, captureProcessErrors } = require('./lib/logger');
captureProcessErrors();
const {
  corsMiddleware,
  limiter,
  kakaoAuthLimiter,
  discordInteractionLimiter,
  db,
  verifyAppCheck,
  verifyFirebaseIdToken,
  ADMIN_UIDS
} = require('./config');
const requestContext = require('./middleware/requestContext');
const errorHandler = require('./middleware/errorHandler');
const maintenanceMode = require('./middleware/maintenanceMode');
const { apiSecurityHeaders, protectPublicHealthPayload } = require('./middleware/httpSecurity');
const { createAppCheckProtection } = require('./middleware/appCheckProtection');
const gptRuntimeConfig = require('./lib/gptRuntimeConfig');
const { evaluateHumanizeRuntime } = require('./lib/runtimeCompatibility');
const { POLICY_VERSION: HUMANIZATION_DEPTH_POLICY } = require('./engine-gpt-prod/humanizationDepth');
const { isV248FeatureEnabled } = require('./lib/humanizeV248Flags');
const { VERSION: HUMANIZE_ENGINE_VERSION } = require('./engine-gpt-prod');
const { registrySnapshot: writingPolicyRegistrySnapshot } = require('./engine-writing-v1/policy/registry');
const { verifyDetailedHealthRequest } = require('./lib/healthAuth');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// 미들웨어
app.use(requestContext);
app.use(corsMiddleware);
app.use(apiSecurityHeaders);

// Discord 슬래시 커맨드(Interactions) — Ed25519 서명검증에 raw body가 필요하므로
// express.json 보다 먼저, 자체 raw 파서로 마운트한다. maintenanceMode보다도 앞이라 점검 모드에도 응답.
app.post(
  '/discord/interactions',
  discordInteractionLimiter,
  express.raw({ type: '*/*', limit: process.env.DISCORD_BODY_LIMIT || '256kb' }),
  require('./routes/discordBot').handleInteractions
);

app.post('/csp-report', limiter, express.json({ type: ['application/csp-report', 'application/json'], limit: '16kb' }), (req, res) => {
  logger.info('security.csp_violation', require('./lib/cspReport').summarizeReport(req.body));
  res.status(204).end();
});
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));
app.use(maintenanceMode);

// App Check boundary is prepared but disabled by default. It is intentionally
// activated only through APPCHECK_MODE after the matching web client ships.
// Verified admins remain exempt when the boundary is explicitly activated.
const highCostAppCheck = createAppCheckProtection({
  verifyAppCheck,
  verifyFirebaseIdToken,
  adminUids: ADMIN_UIDS,
  allowAdmin: true,
  allowCron: false
});
app.use([
  '/analyze',
  '/analyze-pdf',
  '/diagnose',
  '/detect-report',
  '/coach-suggest',
  '/transform',
  '/writing-lab'
], highCostAppCheck);

// Rate Limiter
app.use('/analyze', limiter);
app.use('/analyze-pdf', limiter);
app.use('/diagnose', limiter);
app.use('/detect-report', limiter);   // 무료 감지 — 일일 한도는 라우트 내부(uid/IP), 분당 폭주는 여기서
app.use('/coach-suggest', limiter);   // 자동 코칭 후보 — 무인증 LLM 1콜이라 분당 폭주 방지(과금 대신 rate-limit)
// /transform은 POST(시작·취소·승인)만 제한 — GET 폴링은 90분 job 동안 수백 회가 정상이라 제외.
app.use('/transform', (req, res, next) => (req.method === 'POST' ? limiter(req, res, next) : next()));
app.use('/events', limiter);   // 알림 중계 — 인증 전 폭주 방지
app.use('/kakao-login', kakaoAuthLimiter);
app.use('/history/backup', limiter); // 클라이언트 이력 폴백 저장(추가로 Firestore UID quota 적용)
app.use('/qna', limiter);       // 1:1 문의 쓰기는 서버 API에서만 허용
app.use('/admin/qna', limiter); // 관리자 답변 API도 인증 검증 전 IP 폭주를 제한
app.use('/account/initialize', limiter); // 초기 무료 크레딧은 UID·접속지 지속 quota를 통과해야 지급
app.use('/notifications/create-self', limiter); // 작업·결제·환불 본인 알림만 서버 검증 후 저장

// Public liveness exposes no runtime configuration. Detailed readiness is
// available only with HEALTH_CHECK_SECRET via /internal/health.
const transformRouter = require('./routes/transform');

async function detailedHealth() {
  const humanizeEngineV2 = true;
  const humanizationDepthGate = String(process.env.HUMANIZATION_DEPTH_GATE_ENABLED || '1').trim() !== '0';
  try {
    const runtimeConfig = await gptRuntimeConfig.getRuntimeConfig({ db, logger });
    const compatibility = evaluateHumanizeRuntime({ activeProvider: runtimeConfig.activeProvider });
    return {
      status: compatibility.ok ? 200 : 503,
      payload: protectPublicHealthPayload({
        ok: compatibility.ok,
        activeProvider: compatibility.activeProvider,
        providerCompatible: compatibility.providerCompatible,
        ...(compatibility.code ? { code: compatibility.code } : {}),
        runtimeConfigSource: runtimeConfig.source || 'unknown',
        humanizeEngineV2,
        humanizeEngineVersion: HUMANIZE_ENGINE_VERSION,
        humanizationDepthGate,
        humanizationDepthPolicy: HUMANIZATION_DEPTH_POLICY,
        paragraphRefineEnabled: process.env.PARAGRAPH_REFINE === '1',
        sectionRecoveryEnabled: isV248FeatureEnabled('sectionRecovery'),
        fingerprintAuditEnabled: isV248FeatureEnabled('fingerprintAudit'),
        effectConfirmationEnabled: isV248FeatureEnabled('effectConfirmation'),
        ...writingLabHealthMeta(),
        ...niklHealthMeta(),
        firebase: !!process.env.FIREBASE_SERVICE_ACCOUNT,
        openai: !!process.env.OPENAI_API_KEY,
        maintenance: maintenanceMode.isMaintenanceEnabled(),
        uptimeSec: Math.round(process.uptime()),
        ...transformRouter.stats()
      })
    };
  } catch (err) {
    logger.error('server.health_runtime_config_failed', { err });
    return {
      status: 503,
      payload: protectPublicHealthPayload({
        ok: false,
        code: 'RUNTIME_CONFIG_UNAVAILABLE',
        humanizeEngineV2,
        humanizeEngineVersion: HUMANIZE_ENGINE_VERSION,
        humanizationDepthGate,
        humanizationDepthPolicy: HUMANIZATION_DEPTH_POLICY,
        paragraphRefineEnabled: process.env.PARAGRAPH_REFINE === '1',
        sectionRecoveryEnabled: isV248FeatureEnabled('sectionRecovery'),
        fingerprintAuditEnabled: isV248FeatureEnabled('fingerprintAudit'),
        effectConfirmationEnabled: isV248FeatureEnabled('effectConfirmation'),
        ...writingLabHealthMeta(),
        ...niklHealthMeta(),
        firebase: !!process.env.FIREBASE_SERVICE_ACCOUNT,
        openai: !!process.env.OPENAI_API_KEY,
        maintenance: maintenanceMode.isMaintenanceEnabled(),
        uptimeSec: Math.round(process.uptime()),
        ...transformRouter.stats()
      })
    };
  }
}

const readiness = require('./lib/readiness').createReadiness({
  configured: () => !!db && !!process.env.OPENAI_API_KEY && !!process.env.OPENAI_SAFETY_SALT,
  probe: async () => {
    await db.collection('runtimeConfig').doc('readiness').get();
    const config = await gptRuntimeConfig.getRuntimeConfig({ db, logger });
    if (!evaluateHumanizeRuntime({ activeProvider: config.activeProvider }).ok) throw new Error('provider');
  }
});
app.get('/livez', (_req, res) => res.status(200).json({ ok: true, status: 'up' }));
app.get(['/healthz', '/api/health'], async (_req, res) => {
  const state = transformRouter.stats();
  const health = state.draining || !state.restorationReady ? { ok: false, status: 'unavailable' } : await readiness();
  res.set('Cache-Control', 'no-store').status(health.ok ? 200 : 503).json(health);
});

app.get('/internal/health', async (req, res) => {
  const auth = verifyDetailedHealthRequest(req);
  if (!auth.ok) {
    return res.status(auth.reason === 'secret_missing' ? 503 : 401).json({
      ok: false,
      code: auth.reason === 'secret_missing' ? 'HEALTH_DETAIL_UNAVAILABLE' : 'UNAUTHORIZED'
    });
  }
  const health = await detailedHealth();
  return res.status(health.status).json(health.payload);
});

function writingLabHealthMeta() {
  const registry = writingPolicyRegistrySnapshot();
  return {
    writingLabV2: {
      accessMode: 'public_paid',
      enabled: process.env.WRITING_LAB_V2_ENABLED !== '0',
      rolloutPercent: Math.max(0, Math.min(100, Number(process.env.WRITING_LAB_V2_ROLLOUT_PERCENT ?? 100) || 0)),
      disabledGenres: String(process.env.WRITING_LAB_V2_DISABLED_GENRES || '').split(',').map(value => value.trim()).filter(Boolean),
      engineVersion: 'gp-writing-engine-v1',
      policyRegistryVersion: registry.version,
      policyLaunchEligible: registry.launchEligible,
      pendingPolicyDomains: registry.pendingDomains,
      invalidPolicyPackIds: registry.invalidPackIds
    },
    appCheckMode: require('./middleware/appCheckProtection').appCheckMode()
  };
}

function niklHealthMeta() {
  const aliases = {
    stdict: ['NIKL_STDICT_API_KEY', 'STDICT_API_KEY', 'STANDARD_KOREAN_DICT_API_KEY'],
    opendict: ['NIKL_OPENDICT_API_KEY', 'OPENDICT_API_KEY', 'WOORIMALSAEM_API_KEY'],
    term: ['NIKL_TERM_API_KEY', 'TERM_API_KEY', 'KOREAN_TERM_API_KEY']
  };
  const requested = new Set(String(process.env.GPT_NIKL_API_PROVIDERS || 'opendict,stdict,term')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(value => Object.hasOwn(aliases, value)));
  const configured = [...requested]
    .filter(provider => aliases[provider].some(name => Boolean(String(process.env[name] || '').trim())))
    .length;
  const externalRequested = String(process.env.GPT_NIKL_EXTERNAL_API_ENABLED || '1').trim() === '1';
  return {
    niklLocalResourceEnabled: String(process.env.GPT_NIKL_LOCAL_RESOURCE_ENABLED || '1').trim() !== '0',
    niklExternalApiRequested: externalRequested,
    niklExternalApiEnabled: externalRequested && configured > 0,
    niklExternalProviderCount: configured
  };
}

// 라우트
app.use('/', require('./routes/analyze'));
app.use('/', require('./routes/diagnose'));
app.use('/', require('./routes/detectreport'));   // AI 감지 분리: 무료 감지 보고서(전환 퍼널)
app.use('/', transformRouter);   // 회피모드 P3: 재구성 job (POST는 자체 검증, GET 폴링은 limiter 제외)
app.use('/', require('./routes/kakaoLogin'));
app.use('/', require('./routes/account'));   // 회원 탈퇴(Admin SDK — 클라 재인증 의존 제거)
app.use('/', require('./routes/payment'));
app.use('/', require('./routes/subscription'));
app.use('/', require('./routes/coupon'));
app.use('/', require('./routes/events'));   // 클라이언트발 이벤트(문의·가입·초대) → Discord 운영 알림 중계
app.use('/', require('./routes/clientData')); // 서버 전용 이력 백업·1:1 문의 쓰기(인증·트랜잭션 quota)
app.use('/', require('./routes/publicMetrics'));   // 검증된 누적 처리량 공개 지표(미검증 시 503)
app.use('/', require('./routes/revenue'));   // 매출 조회: 관리자 온디맨드(/admin/revenue) + 일일 리포트 cron(/cron/daily-revenue)
app.use('/', require('./routes/writinglab'));   // Public paid writing feature; authentication, quotas and billing are enforced in the router.
app.use('/', require('./routes/opsLogs'));   // 장애 로그: 관리자 조회·확인(/admin/ops-*) + 부재 감지 워치독·다이제스트 cron
app.use('/', require('./routes/signupCreditMonitoring')); // 신규 가입 무료 크레딧 소진 코호트(관리자 전용)

app.use(errorHandler);

const server = app.listen(process.env.PORT || 3000, async () => {
  const runtimeConfig = await gptRuntimeConfig.getRuntimeConfig({ db, logger, force: true });
  // 재시작은 SEV3로 남긴다 — 배포면 정상이지만, 짧은 간격으로 반복되면 크래시 루프(과거 OOM 사고)다.
  logger.info('server.started', {
    port: Number(process.env.PORT || 3000),
    activeProvider: runtimeConfig.activeProvider,
    runtimeConfigSource: runtimeConfig.source,
    auth: process.env.FIREBASE_SERVICE_ACCOUNT ? 'firebase' : (process.env.DEV_NO_AUTH === '1' ? 'dev_no_auth' : 'disabled'),
    message: `서버가 시작됐어요(provider=${runtimeConfig.activeProvider}).`
  });
});

// ── graceful shutdown: 배포(Render는 SIGTERM)·Ctrl+C 시 새 작업 거부 → 진행 중 LLM 중단 →
//   같은 job ID를 자동 재개 대기로 영속화한다. 다음 인스턴스가 이어받아 사용자가 다시 제출할 필요가 없다.
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn('server.shutdown_started', { signal: sig });
  try { await transformRouter.shutdown(); } catch (e) { logger.error('server.shutdown_persist_failed', { err: e }); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();   // close가 keep-alive 연결에 막혀도 5초 내 종료 보장
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
