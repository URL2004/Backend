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

// 라우트
app.use('/', require('./routes/analyze'));
app.use('/', require('./routes/diagnose'));
app.use('/', require('./routes/kakaoLogin'));
app.use('/', require('./routes/payment'));
app.use('/', require('./routes/subscription'));
app.use('/', require('./routes/coupon'));

// ★ 안전망: 서버를 claudecode 백엔드로 돌리면 호출당 ~45초·직렬(동시성 1)이라 UI 변환이 수십 분 걸려
//   프런트 타임아웃으로 전부 실패한다(2026-06-11 실사고 — .env의 LLM_BACKEND=claudecode가 원인).
if (process.env.LLM_BACKEND === 'claudecode') {
  console.warn('⚠️⚠️ LLM_BACKEND=claudecode로 서버 구동 중 — UI 변환은 타임아웃 난다. 서버는 LLM_BACKEND 미설정(API)이 정상. claudecode는 engine-test 전용.');
}

app.listen(process.env.PORT || 3000, () => console.log(`서버 시작! (LLM=${process.env.LLM_BACKEND || 'api'}, 인증=${process.env.FIREBASE_SERVICE_ACCOUNT ? 'Firebase' : (process.env.DEV_NO_AUTH === '1' ? 'DEV 우회' : '비활성(요청 시 401)')})`));
