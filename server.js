// [메인] 서버 초기화, 미들웨어 설정, 라우트 연결을 담당하는 진입점

// 1. dotenv 설정을 최상단에 추가 (이게 있어야 .env 파일을 읽습니다)
require('dotenv').config();
const express = require('express');
const { logger, captureProcessErrors } = require('./lib/logger');
captureProcessErrors();
const { corsMiddleware, limiter } = require('./config');
const requestContext = require('./middleware/requestContext');
const errorHandler = require('./middleware/errorHandler');
const maintenanceMode = require('./middleware/maintenanceMode');

const app = express();
app.set('trust proxy', 1);

// 미들웨어
app.use(requestContext);
app.use(corsMiddleware);
app.use(express.json({ limit: '10mb' }));
app.use(maintenanceMode);

// Rate Limiter
app.use('/analyze', limiter);
app.use('/analyze-pdf', limiter);
app.use('/diagnose', limiter);
app.use('/detect-report', limiter);   // 무료 감지 — 일일 한도는 라우트 내부(uid/IP), 분당 폭주는 여기서
// /transform은 POST(시작·취소·승인)만 제한 — GET 폴링은 90분 job 동안 수백 회가 정상이라 제외.
app.use('/transform', (req, res, next) => (req.method === 'POST' ? limiter(req, res, next) : next()));
app.use('/events', limiter);   // 알림 중계 — 인증 전 폭주 방지

// 헬스체크(배포 플랫폼용 — Render 등은 이 경로로 살아있는지 판단)
const transformRouter = require('./routes/transform');
app.get(['/healthz', '/api/health'], (req, res) => {
  res.json({
    ok: true,
    llm: process.env.LLM_BACKEND || 'api',
    firebase: !!process.env.FIREBASE_SERVICE_ACCOUNT,
    maintenance: maintenanceMode.isMaintenanceEnabled(),
    uptimeSec: Math.round(process.uptime()),
    ...transformRouter.stats()
  });
});

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

// ★ 안전망: 서버를 claudecode 백엔드로 돌리면 호출당 ~45초·직렬(동시성 1)이라 UI 변환이 수십 분 걸려
//   프런트 타임아웃으로 전부 실패한다(2026-06-11 실사고 — .env의 LLM_BACKEND=claudecode가 원인).
if (process.env.LLM_BACKEND === 'claudecode') {
  logger.warn('server.llm_claudecode_warning', {
    message: 'LLM_BACKEND=claudecode로 서버 구동 중입니다. UI 변환은 타임아웃 가능성이 높습니다.'
  });
}

app.use(errorHandler);

const server = app.listen(process.env.PORT || 3000, () => {
  logger.info('server.started', {
    port: Number(process.env.PORT || 3000),
    llm: process.env.LLM_BACKEND || 'api',
    auth: process.env.FIREBASE_SERVICE_ACCOUNT ? 'firebase' : (process.env.DEV_NO_AUTH === '1' ? 'dev_no_auth' : 'disabled')
  });
});

// ── graceful shutdown: 배포(Render는 SIGTERM)·Ctrl+C 시 새 작업 거부 → 진행 중 LLM 중단(비용 차단) →
//   job 상태 영속화 후 종료. 영속화 덕에 폴링 클라이언트는 재시작 후에도 404 대신 정확한 상태를 받는다.
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
