// [메인] 서버 초기화, 미들웨어 설정, 라우트 연결을 담당하는 진입점

// 1. dotenv 설정을 최상단에 추가 (이게 있어야 .env 파일을 읽습니다)
require('dotenv').config();
const express = require('express');
const { corsMiddleware, limiter } = require('./config');

const app = express();
app.set('trust proxy', 1);

// 미들웨어
app.use(corsMiddleware);
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - IP: ${ip}`);
  next();
});

// Rate Limiter
app.use('/analyze', limiter);
app.use('/analyze-pdf', limiter);
app.use('/diagnose', limiter);
app.use('/detect-report', limiter);   // 무료 감지 — 일일 한도는 라우트 내부(uid/IP), 분당 폭주는 여기서
// /transform은 POST(시작·취소·승인)만 제한 — GET 폴링은 90분 job 동안 수백 회가 정상이라 제외.
app.use('/transform', (req, res, next) => (req.method === 'POST' ? limiter(req, res, next) : next()));

// 헬스체크(배포 플랫폼용 — Render 등은 이 경로로 살아있는지 판단)
const transformRouter = require('./routes/transform');
app.get(['/healthz', '/api/health'], (req, res) => {
  res.json({
    ok: true,
    llm: process.env.LLM_BACKEND || 'api',
    firebase: !!process.env.FIREBASE_SERVICE_ACCOUNT,
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

// ★ 안전망: 서버를 claudecode 백엔드로 돌리면 호출당 ~45초·직렬(동시성 1)이라 UI 변환이 수십 분 걸려
//   프런트 타임아웃으로 전부 실패한다(2026-06-11 실사고 — .env의 LLM_BACKEND=claudecode가 원인).
if (process.env.LLM_BACKEND === 'claudecode') {
  console.warn('⚠️⚠️ LLM_BACKEND=claudecode로 서버 구동 중 — UI 변환은 타임아웃 난다. 서버는 LLM_BACKEND 미설정(API)이 정상. claudecode는 engine-test 전용.');
}

const server = app.listen(process.env.PORT || 3000, () => console.log(`서버 시작! (LLM=${process.env.LLM_BACKEND || 'api'}, 인증=${process.env.FIREBASE_SERVICE_ACCOUNT ? 'Firebase' : (process.env.DEV_NO_AUTH === '1' ? 'DEV 우회' : '비활성(요청 시 401)')})`));

// ── graceful shutdown: 배포(Render는 SIGTERM)·Ctrl+C 시 새 작업 거부 → 진행 중 LLM 중단(비용 차단) →
//   job 상태 영속화 후 종료. 영속화 덕에 폴링 클라이언트는 재시작 후에도 404 대신 정확한 상태를 받는다.
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${sig} 수신 — 새 작업 거부, job 영속화 후 종료`);
  try { await transformRouter.shutdown(); } catch (e) { console.error('[shutdown] job 영속화 실패:', e?.message); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();   // close가 keep-alive 연결에 막혀도 5초 내 종료 보장
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
