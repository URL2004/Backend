// [인증] 카카오톡 OAuth 로그인 처리

const express = require('express');
const { logger } = require('../lib/logger');
const { admin, db } = require('../config');
const { issueKakaoCustomToken, parseKakaoUserPayload } = require('../lib/kakaoIdentity');
const { outboundFetch } = require('../lib/outboundPolicy');
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
    code: err?.code || err?.cause?.code || null
  };
}

async function fetchKakaoUser(accessToken) {
  let lastErr = null;
  const attempts = Math.max(1, KAKAO_FETCH_RETRIES + 1);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('kakao user fetch timeout')), KAKAO_FETCH_TIMEOUT_MS);
    try {
      const response = await outboundFetch('kakao', KAKAO_USER_URL, {
        headers: { 'Authorization': 'Bearer ' + accessToken },
        signal: ac.signal
      });
      if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
        const retryDelay = Number.isFinite(retryAfterSeconds)
          ? Math.min(2000, Math.max(0, retryAfterSeconds * 1000))
          : 200 * attempt;
        logger.warn('auth.kakao_user_fetch_retry', { attempt, attempts, status: response.status });
        await wait(retryDelay);
        continue;
      }
      return response;
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
    if (typeof accessToken !== 'string' || accessToken.length < 10 || accessToken.length > 4096) {
      return res.status(400).json({ code: 'KAKAO_TOKEN_INVALID', error: '카카오 인증 정보가 올바르지 않습니다.' });
    }

    const userRes = await fetchKakaoUser(accessToken);
    const userData = parseKakaoUserPayload(await userRes.text());

    if (!userData.id) {
      // Kakao 오류 본문에는 이메일·닉네임·프로필 URL 같은 개인정보가 섞일 수 있다.
      // 운영 로그에는 판정에 필요한 HTTP 상태만 남기고 provider 응답 원문은 보관하지 않는다.
      logger.warn('auth.kakao_user_fetch_failed', { status: userRes.status });
      const status = [400, 401, 403].includes(userRes.status) ? 401 : 502;
      return res.status(status)
        .json({ error: '카카오 사용자 정보를 가져올 수 없습니다. 다시 로그인해 주세요.' });
    }

    if (!admin) {
      logger.error('auth.kakao_firebase_unavailable');
      return res.status(503).json({ code: 'AUTH_SERVICE_UNAVAILABLE', error: '로그인 서비스가 일시적으로 준비되지 않았습니다.' });
    }

    const identity = await issueKakaoCustomToken({ admin, db, userData });

    logger.info('auth.kakao_login_succeeded', {
      hasEmail: Boolean(userData.kakao_account?.email),
      hasProfilePhoto: Boolean(identity.photo),
      created: identity.created,
      matchedBy: identity.matchedBy
    });
    res.json({ ok: true, ...identity });
  } catch(err) {
    if (err?.code === 'KAKAO_IDENTITY_CONFLICT') {
      logger.error('auth.kakao_identity_conflict');
      return res.status(409).json({ code: 'KAKAO_IDENTITY_CONFLICT', error: '계정 연결 상태를 확인해야 합니다. 고객센터로 문의해 주세요.' });
    }
    logger.error('auth.kakao_login_failed', { err: errorMeta(err) });
    res.status(503).json({ error: '카카오 서버 연결이 일시적으로 불안정합니다. 잠시 후 다시 시도해 주세요.' });
  }
});

module.exports = router;
