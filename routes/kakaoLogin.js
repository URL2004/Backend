// [인증] 카카오톡 OAuth 로그인 처리

const express = require('express');
const { logger } = require('../lib/logger');
const router = express.Router();

const KAKAO_USER_URL = 'https://kapi.kakao.com/v2/user/me';
const KAKAO_FETCH_TIMEOUT_MS = Number(process.env.KAKAO_FETCH_TIMEOUT_MS) || 5000;
const KAKAO_FETCH_RETRIES = Number(process.env.KAKAO_FETCH_RETRIES) || 2;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMeta(err) {
  return {
    name: err?.name || 'Error',
    message: err?.message || String(err),
    code: err?.code || err?.cause?.code || null,
    cause: err?.cause?.message || null
  };
}

async function fetchKakaoUser(accessToken) {
  let lastErr = null;
  const attempts = Math.max(1, KAKAO_FETCH_RETRIES + 1);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('kakao user fetch timeout')), KAKAO_FETCH_TIMEOUT_MS);
    try {
      return await fetch(KAKAO_USER_URL, {
        headers: { 'Authorization': 'Bearer ' + accessToken },
        signal: ac.signal
      });
    } catch (err) {
      lastErr = err;
      logger.warn('auth.kakao_user_fetch_retry', {
        attempt,
        attempts,
        err: errorMeta(err)
      });
      if (attempt < attempts) await wait(200 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

router.post('/kakao-login', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ error: '토큰이 없습니다.' });

    const userRes = await fetchKakaoUser(accessToken);
    const userData = await userRes.json();

    if (!userData.id) {
      // Kakao 오류 본문에는 이메일·닉네임·프로필 URL 같은 개인정보가 섞일 수 있다.
      // 운영 로그에는 판정에 필요한 HTTP 상태만 남기고 provider 응답 원문은 보관하지 않는다.
      logger.warn('auth.kakao_user_fetch_failed', { status: userRes.status });
      return res.status(userRes.status >= 400 && userRes.status < 500 ? 401 : 502)
        .json({ error: '카카오 사용자 정보를 가져올 수 없습니다. 다시 로그인해 주세요.' });
    }

    const kakaoId = String(userData.id);
    const nickname = userData.kakao_account?.profile?.nickname || '카카오유저';
    const email = userData.kakao_account?.email || (kakaoId + '@kakao.com');
    const photo = userData.kakao_account?.profile?.profile_image_url || '';

    logger.info('auth.kakao_login_succeeded', {
      hasEmail: Boolean(userData.kakao_account?.email),
      hasProfilePhoto: Boolean(photo)
    });
    res.json({ ok: true, kakaoId, nickname, email, photo });
  } catch(err) {
    logger.error('auth.kakao_login_failed', { err: errorMeta(err) });
    res.status(503).json({ error: '카카오 서버 연결이 일시적으로 불안정합니다. 잠시 후 다시 시도해 주세요.' });
  }
});

module.exports = router;
