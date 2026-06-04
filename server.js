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

// 라우트
app.use('/', require('./routes/analyze'));
app.use('/', require('./routes/kakaoLogin'));
app.use('/', require('./routes/payment'));
app.use('/', require('./routes/subscription'));
app.use('/', require('./routes/coupon'));

app.listen(process.env.PORT || 3000, () => console.log('서버 시작!'));
