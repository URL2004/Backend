// [인증] 카카오톡 OAuth 로그인 처리

const express = require('express');
const { admin, db, limiter } = require('../config');
const { logger } = require('../lib/logger');
const {
  KakaoAuthError,
  authenticateKakaoIdentity,
  normalizeKakaoProfile,
  validateKakaoTokenBinding
} = require('../lib/kakaoAuth');
const router = express.Router();

const KAKAO_USER_URL = 'https://kapi.kakao.com/v2/user/me';
const KAKAO_TOKEN_INFO_URL = 'https://kapi.kakao.com/v1/user/access_token_info';
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

function accessTokenFrom(req) {
  const accessToken = typeof req.body?.accessToken === 'string' ? req.body.accessToken.trim() : '';
  if (!accessToken) throw new KakaoAuthError('KAKAO_TOKEN_MISSING', '토큰이 없습니다.', 400);
  if (accessToken.length > 4096 || /[\r\n\0]/.test(accessToken)) {
    throw new KakaoAuthError('KAKAO_TOKEN_INVALID', '토큰 형식이 올바르지 않습니다.', 400);
  }
  return accessToken;
}

async function fetchKakao(url, accessToken, retryEvent) {
  let lastErr = null;
  const attempts = Math.max(1, KAKAO_FETCH_RETRIES + 1);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('kakao user fetch timeout')), KAKAO_FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + accessToken },
        signal: ac.signal
      });
    } catch (err) {
      lastErr = err;
      logger.warn(retryEvent, {
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

function allowedKakaoAppIds() {
  return new Set(
    String(process.env.KAKAO_APP_ID || '')
      .split(',')
      .map(value => value.trim())
      .filter(value => /^\d+$/.test(value))
  );
}

async function verifiedKakaoProfile(req, { requireAppMatch = false } = {}) {
  const accessToken = accessTokenFrom(req);
  const allowedAppIds = requireAppMatch ? allowedKakaoAppIds() : new Set();
  if (requireAppMatch && allowedAppIds.size === 0) {
    throw new KakaoAuthError(
      'KAKAO_APP_ID_NOT_CONFIGURED',
      '카카오 인증 서버 설정이 완료되지 않았습니다.',
      503
    );
  }

  const [userRes, tokenInfoRes] = await Promise.all([
    fetchKakao(KAKAO_USER_URL, accessToken, 'auth.kakao_user_fetch_retry'),
    requireAppMatch
      ? fetchKakao(KAKAO_TOKEN_INFO_URL, accessToken, 'auth.kakao_token_info_fetch_retry')
      : Promise.resolve(null)
  ]);
  const userData = await userRes.json().catch(() => ({}));
  const tokenInfo = tokenInfoRes ? await tokenInfoRes.json().catch(() => ({})) : null;

  if (!userRes.ok || !userData.id) {
    logger.warn('auth.kakao_user_fetch_failed', {
      status: userRes.status,
      kakaoErrorCode: userData?.code || null
    });
    throw new KakaoAuthError(
      'KAKAO_TOKEN_REJECTED',
      '카카오 사용자 정보를 가져올 수 없습니다. 다시 로그인해 주세요.',
      userRes.status >= 400 && userRes.status < 500 ? 401 : 502
    );
  }

  if (requireAppMatch) {
    const appMatches = allowedAppIds.has(String(tokenInfo?.app_id || ''));
    const userMatches = String(tokenInfo?.id || '') === String(userData.id);
    const unexpired = Number(tokenInfo?.expires_in) > 0;
    if (!tokenInfoRes.ok || !appMatches || !userMatches || !unexpired) {
      logger.warn('auth.kakao_token_binding_failed', {
        status: tokenInfoRes.status,
        kakaoErrorCode: tokenInfo?.code || null,
        appMatches,
        userMatches,
        unexpired
      });
    }
    validateKakaoTokenBinding({
      tokenInfo,
      userData,
      allowedAppIds,
      responseOk: tokenInfoRes.ok
    });
  }

  return { profile: normalizeKakaoProfile(userData), userData };
}

function noStore(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
}

function handleKakaoError(err, res, event) {
  const isClientError = err instanceof KakaoAuthError && err.status < 500;
  (isClientError ? logger.warn : logger.error)(event, { err: errorMeta(err) });
  if (err instanceof KakaoAuthError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  return res.status(503).json({ error: '카카오 서버 연결이 일시적으로 불안정합니다. 잠시 후 다시 시도해 주세요.' });
}

// 단계적 배포 호환용 구 경로. 이 응답은 Firebase 로그인 토큰을 발급하지 않는다.
// 백엔드 선배포 호환 시간에만 KAKAO_LEGACY_LOGIN_ENABLED=1로 열고, 새 프런트 배포 후 닫는다.
router.post('/kakao-login', limiter, async (req, res) => {
  noStore(res);
  if (process.env.KAKAO_LEGACY_LOGIN_ENABLED !== '1') {
    return res.status(426).json({
      error: '보안 업데이트가 적용되었습니다. 페이지를 새로고침한 뒤 다시 로그인해 주세요.',
      code: 'KAKAO_CLIENT_UPGRADE_REQUIRED'
    });
  }

  try {
    const { profile, userData } = await verifiedKakaoProfile(req);
    const legacyEmail = typeof userData.kakao_account?.email === 'string'
      ? userData.kakao_account.email.trim().slice(0, 320)
      : profile.legacyEmail;
    logger.warn('auth.kakao_legacy_profile_issued', { clientUpgradeRequired: true });
    return res.json({
      ok: true,
      kakaoId: profile.kakaoId,
      nickname: profile.nickname,
      email: legacyEmail || profile.legacyEmail,
      photo: profile.photo
    });
  } catch (err) {
    return handleKakaoError(err, res, 'auth.kakao_legacy_login_failed');
  }
});

router.post('/kakao-login-v2', limiter, async (req, res) => {
  noStore(res);
  try {
    if (!admin || !db) return res.status(503).json({ error: '인증 서버가 준비되지 않았습니다.' });

    const { profile } = await verifiedKakaoProfile(req, { requireAppMatch: true });
    const result = await authenticateKakaoIdentity({
      auth: admin.auth(),
      db,
      admin,
      profile
    });

    logger.info('auth.kakao_login_succeeded', {
      uid: result.uid,
      isNewUser: result.isNewUser,
      legacyPasswordRotated: result.passwordRotated,
      resolution: result.resolution
    });
    res.json({
      ok: true,
      customToken: result.customToken,
      isNewUser: result.isNewUser,
      profile: { nickname: profile.nickname, photo: profile.photo }
    });
  } catch (err) {
    return handleKakaoError(err, res, 'auth.kakao_login_failed');
  }
});

module.exports = router;
