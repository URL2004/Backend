// [메인] 서버 초기화, 미들웨어 설정, 라우트 연결을 담당하는 진입점

// 1. dotenv 설정을 최상단에 추가 (이게 있어야 .env 파일을 읽습니다)
require('dotenv').config();
const express = require('express');
const { logger, captureProcessErrors } = require('./lib/logger');
captureProcessErrors();
const { corsMiddleware, limiter, db } = require('./config');
const requestContext = require('./middleware/requestContext');
const errorHandler = require('./middleware/errorHandler');
const maintenanceMode = require('./middleware/maintenanceMode');
const gptRuntimeConfig = require('./lib/gptRuntimeConfig');
const { evaluateHumanizeRuntime } = require('./lib/runtimeCompatibility');
const { POLICY_VERSION: HUMANIZATION_DEPTH_POLICY } = require('./engine-gpt-prod/humanizationDepth');
const { isV248FeatureEnabled } = require('./lib/humanizeV248Flags');
const { VERSION: HUMANIZE_ENGINE_VERSION } = require('./engine-gpt-prod');

const app = express();
app.set('trust proxy', 1);

// 미들웨어
app.use(requestContext);
app.use(corsMiddleware);

// Discord 슬래시 커맨드(Interactions) — Ed25519 서명검증에 raw body가 필요하므로
// express.json 보다 먼저, 자체 raw 파서로 마운트한다. maintenanceMode보다도 앞이라 점검 모드에도 응답.
app.post('/discord/interactions', express.raw({ type: '*/*' }), require('./routes/discordBot').handleInteractions);

app.use(express.json({ limit: '10mb' }));
app.use(maintenanceMode);

// Rate Limiter
app.use('/analyze', limiter);
app.use('/analyze-pdf', limiter);
app.use('/diagnose', limiter);
app.use('/detect-report', limiter);   // 무료 감지 — 일일 한도는 라우트 내부(uid/IP), 분당 폭주는 여기서
app.use('/coach-suggest', limiter);   // 자동 코칭 후보 — 무인증 LLM 1콜이라 분당 폭주 방지(과금 대신 rate-limit)
// /transform은 POST(시작·취소·승인)만 제한 — GET 폴링은 90분 job 동안 수백 회가 정상이라 제외.
app.use('/transform', (req, res, next) => (req.method === 'POST' ? limiter(req, res, next) : next()));
app.use('/events', limiter);   // 알림 중계 — 인증 전 폭주 방지

// 헬스체크(배포 플랫폼용 — Render 등은 이 경로로 살아있는지 판단)
const transformRouter = require('./routes/transform');
app.get(['/healthz', '/api/health'], async (req, res) => {
  // v2.5 is the only production engine. Rollback is performed by restoring
  // the previous Render live deployment, not by enabling legacy code.
  const humanizeEngineV2 = true;
  const humanizationDepthGate = String(process.env.HUMANIZATION_DEPTH_GATE_ENABLED || '1').trim() !== '0';
  try {
    const runtimeConfig = await gptRuntimeConfig.getRuntimeConfig({ db, logger });
    const compatibility = evaluateHumanizeRuntime({ activeProvider: runtimeConfig.activeProvider });
    res.status(compatibility.ok ? 200 : 503).json({
      ok: compatibility.ok,
      activeProvider: compatibility.activeProvider,
      providerCompatible: compatibility.providerCompatible,
      ...(compatibility.code ? { code: compatibility.code } : {}),
      runtimeConfigSource: runtimeConfig.source || 'unknown',
      humanizeEngineV2,
      humanizeEngineVersion: HUMANIZE_ENGINE_VERSION,
      humanizationDepthGate,
      humanizationDepthPolicy: HUMANIZATION_DEPTH_POLICY,
      sectionRecoveryEnabled: isV248FeatureEnabled('sectionRecovery'),
      fingerprintAuditEnabled: isV248FeatureEnabled('fingerprintAudit'),
      effectConfirmationEnabled: isV248FeatureEnabled('effectConfirmation'),
      ...niklHealthMeta(),
      firebase: !!process.env.FIREBASE_SERVICE_ACCOUNT,
      openai: !!process.env.OPENAI_API_KEY,
      maintenance: maintenanceMode.isMaintenanceEnabled(),
      uptimeSec: Math.round(process.uptime()),
      ...transformRouter.stats()
    });
  } catch (err) {
    logger.error('server.health_runtime_config_failed', { err });
    res.status(503).json({
      ok: false,
      code: 'RUNTIME_CONFIG_UNAVAILABLE',
      humanizeEngineV2,
      humanizeEngineVersion: HUMANIZE_ENGINE_VERSION,
      humanizationDepthGate,
      humanizationDepthPolicy: HUMANIZATION_DEPTH_POLICY,
      sectionRecoveryEnabled: isV248FeatureEnabled('sectionRecovery'),
      fingerprintAuditEnabled: isV248FeatureEnabled('fingerprintAudit'),
      effectConfirmationEnabled: isV248FeatureEnabled('effectConfirmation'),
      ...niklHealthMeta(),
      firebase: !!process.env.FIREBASE_SERVICE_ACCOUNT,
      openai: !!process.env.OPENAI_API_KEY,
      maintenance: maintenanceMode.isMaintenanceEnabled(),
      uptimeSec: Math.round(process.uptime()),
      ...transformRouter.stats()
    });
  }
});

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
app.use('/', require('./routes/revenue'));   // 매출 조회: 관리자 온디맨드(/admin/revenue) + 일일 리포트 cron(/cron/daily-revenue)
app.use('/', require('./routes/writinglab'));   // 관리자 실험: 자소서 생성 랩(생성→휴머나이징 결합 프로토타입, 관리자 전용·무과금)

app.use(errorHandler);

const server = app.listen(process.env.PORT || 3000, async () => {
  const runtimeConfig = await gptRuntimeConfig.getRuntimeConfig({ db, logger, force: true });
  logger.info('server.started', {
    port: Number(process.env.PORT || 3000),
    activeProvider: runtimeConfig.activeProvider,
    runtimeConfigSource: runtimeConfig.source,
    auth: process.env.FIREBASE_SERVICE_ACCOUNT ? 'firebase' : (process.env.DEV_NO_AUTH === '1' ? 'dev_no_auth' : 'disabled')
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
