// [인증] 카카오톡 OAuth 로그인 처리

const express = require('express');
const { admin, db } = require('../config');
const { logger } = require('../lib/logger');
const {
  assertKakaoAudience,
  assertKakaoSubject,
  customKakaoAuthEnabled,
  issueFirebaseCustomToken,
  pseudonymousKakaoSubject
} = require('../lib/kakaoIdentity');
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

async function fetchKakaoJson(url, accessToken) {
  let lastErr = null;
  const attempts = Math.max(1, KAKAO_FETCH_RETRIES + 1);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('kakao user fetch timeout')), KAKAO_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + accessToken },
        signal: ac.signal
      });
      const body = await response.json().catch(() => ({}));
      if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0
          ? Math.min(3000, retryAfter * 1000)
          : 200 * attempt;
        logger.warn('auth.kakao_api_retry', { endpoint: new URL(url).pathname, status: response.status, attempt, attempts });
        await wait(delayMs);
        continue;
      }
      return { response, body };
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
    if (typeof accessToken !== 'string' || accessToken.length > 4096) {
      return res.status(400).json({ error: '올바르지 않은 인증 정보입니다.', code: 'KAKAO_TOKEN_INVALID' });
    }

    const [{ response: tokenRes, body: tokenInfo }, { response: userRes, body: userData }] = await Promise.all([
      fetchKakaoJson(KAKAO_TOKEN_INFO_URL, accessToken),
      fetchKakaoJson(KAKAO_USER_URL, accessToken)
    ]);

    if (!tokenRes.ok || !userRes.ok || !userData.id) {
      logger.warn('auth.kakao_user_fetch_failed', {
        tokenStatus: tokenRes.status,
        userStatus: userRes.status,
        providerCode: String(userData?.code ?? tokenInfo?.code ?? '').slice(0, 40) || null
      });
      return res.status(userRes.status >= 400 && userRes.status < 500 ? 401 : 502)
        .json({ error: '카카오 사용자 정보를 가져올 수 없습니다. 다시 로그인해 주세요.' });
    }

    const kakaoId = assertKakaoSubject(tokenInfo, userData);
    const nickname = userData.kakao_account?.profile?.nickname || '카카오유저';
    const emailTrusted = userData.kakao_account?.is_email_valid === true
      && userData.kakao_account?.is_email_verified === true;
    const email = emailTrusted ? String(userData.kakao_account?.email || '') : '';
    const compatibilityEmail = email || (kakaoId + '@kakao.com');
    const photo = userData.kakao_account?.profile?.profile_image_url || '';
    const audience = assertKakaoAudience(
      tokenInfo,
      process.env.KAKAO_APP_ID,
      process.env.KAKAO_REQUIRE_APP_ID === '1'
    );
    // 기존 로그인 사용자를 실제 운영 스모크 없이 일괄 마이그레이션하면 계정 접근
    // 중단 위험이 있다. 기본값은 구 호환 응답이며, 환경·실사용자 검증이 끝난 뒤에만
    // custom-token 발급을 명시적으로 활성화한다.
    if (!customKakaoAuthEnabled()) {
      logger.warn('auth.kakao_custom_token_rollout_pending', {
        kakaoSubject: pseudonymousKakaoSubject(kakaoId).slice(0, 24),
        audienceVerified: audience.verified
      });
      return res.json({
        ok: true,
        authVersion: 1,
        kakaoId,
        nickname,
        email: compatibilityEmail,
        photo
      });
    }

    const issued = await issueFirebaseCustomToken({ admin, db, kakaoId, email, nickname, photo });

    logger.info('auth.kakao_login_succeeded', {
      kakaoSubject: issued.subjectHash.slice(0, 24),
      firebaseUidHash: pseudonymousKakaoSubject(issued.firebaseUid).slice(0, 24),
      audienceVerified: audience.verified,
      migratedLegacyAccount: issued.migratedLegacyAccount
    });
    res.json({
      ok: true,
      authVersion: 2,
      customToken: issued.customToken,
      uid: issued.firebaseUid,
      isNewUser: issued.isNewUser,
      profile: { nickname, email: compatibilityEmail, photo },
      firebaseUid: issued.firebaseUid,
      // 한 릴리스 동안 구 클라이언트 호환 필드를 유지한다. 신형 프런트는 customToken만 사용한다.
      kakaoId,
      nickname,
      email: compatibilityEmail,
      photo
    });
  } catch(err) {
    const authError = ['KAKAO_TOKEN_AUDIENCE_MISMATCH', 'KAKAO_TOKEN_SUBJECT_MISMATCH', 'KAKAO_TOKEN_INFO_INVALID', 'KAKAO_SUBJECT_INVALID'].includes(err?.code);
    const configError = ['KAKAO_APP_ID_MISSING', 'KAKAO_AUTH_SALT_MISSING', 'FIREBASE_UNAVAILABLE'].includes(err?.code);
    const linkReview = err?.code === 'KAKAO_LINK_REVIEW_REQUIRED';
    logger.error('auth.kakao_login_failed', { code: err?.code || null, err: errorMeta(err) });
    res.status(authError ? 401 : (linkReview ? 409 : 503)).json({
      code: err?.code || 'KAKAO_LOGIN_UNAVAILABLE',
      error: linkReview
        ? '기존 카카오 계정 연결을 안전하게 확인해야 해요. 고객센터로 문의해 주세요.'
        : configError
        ? '로그인 설정을 확인하고 있어요. 잠시 후 다시 시도해 주세요.'
        : authError
          ? '카카오 인증 정보가 올바르지 않습니다. 다시 로그인해 주세요.'
          : '카카오 서버 연결이 일시적으로 불안정합니다. 잠시 후 다시 시도해 주세요.'
    });
  }
});

module.exports = router;
