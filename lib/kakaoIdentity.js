'use strict';

const crypto = require('node:crypto');

function authSecret() {
  return String(process.env.KAKAO_AUTH_SALT || process.env.OPENAI_SAFETY_SALT || '').trim();
}

function customKakaoAuthEnabled(env = process.env) {
  return String(env.KAKAO_CUSTOM_TOKEN_AUTH_ENABLED || '').trim() === '1';
}

function pseudonymousKakaoSubject(kakaoId, secret = authSecret()) {
  const subject = String(kakaoId || '').trim();
  if (!subject || !secret) return '';
  return crypto.createHmac('sha256', secret)
    .update(`kakao-auth-v1\0${subject}`, 'utf8')
    .digest('hex');
}

function firebaseUidForKakao(kakaoId, secret = authSecret()) {
  const pseudonym = pseudonymousKakaoSubject(kakaoId, secret);
  if (!pseudonym) {
    const error = new Error('KAKAO_AUTH_SALT_MISSING');
    error.code = 'KAKAO_AUTH_SALT_MISSING';
    throw error;
  }
  return `kakao:${pseudonym.slice(0, 48)}`;
}

function assertKakaoAudience(tokenInfo, expectedAppId, required = false) {
  const actual = String(tokenInfo?.app_id ?? tokenInfo?.appId ?? '').trim();
  const expected = String(expectedAppId || '').trim();
  if (!actual) {
    const error = new Error('KAKAO_TOKEN_INFO_INVALID');
    error.code = 'KAKAO_TOKEN_INFO_INVALID';
    throw error;
  }
  if (!expected) {
    if (required) {
      const error = new Error('KAKAO_APP_ID_MISSING');
      error.code = 'KAKAO_APP_ID_MISSING';
      throw error;
    }
    return { actual, verified: false };
  }
  if (actual !== expected) {
    const error = new Error('KAKAO_TOKEN_AUDIENCE_MISMATCH');
    error.code = 'KAKAO_TOKEN_AUDIENCE_MISMATCH';
    throw error;
  }
  return { actual, verified: true };
}

function assertKakaoSubject(tokenInfo, userData) {
  const tokenSubject = String(tokenInfo?.id ?? '').trim();
  const userSubject = String(userData?.id ?? '').trim();
  if (!/^\d{1,32}$/u.test(tokenSubject) || tokenSubject !== userSubject) {
    const error = new Error('KAKAO_TOKEN_SUBJECT_MISMATCH');
    error.code = 'KAKAO_TOKEN_SUBJECT_MISMATCH';
    throw error;
  }
  return userSubject;
}

function cleanProfile(identity = {}) {
  const nickname = String(identity.nickname || '카카오유저').trim().slice(0, 80) || '카카오유저';
  const email = String(identity.email || '').trim().toLowerCase().slice(0, 254);
  const photo = /^https:\/\//iu.test(String(identity.photo || ''))
    ? String(identity.photo).slice(0, 2048)
    : '';
  return { nickname, email, photo };
}

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function legacyLinkIsServerVerified(data, subjectHash) {
  const link = data && data.kakaoLink;
  return Boolean(
    link
    && link.verifiedBy === 'server'
    && link.version === 2
    && String(link.subjectHash || '') === String(subjectHash || '').slice(0, 64)
  );
}

function legacyLinkMatchesVerifiedEmail(authUser, verifiedKakaoEmail) {
  const expected = normalizedEmail(verifiedKakaoEmail);
  if (!expected || normalizedEmail(authUser && authUser.email) !== expected) return false;
  const providers = Array.isArray(authUser?.providerData)
    ? authUser.providerData.map(row => String(row && row.providerId || ''))
    : [];
  // Google/타 OAuth 이메일 충돌은 자동 계정 병합 근거로 사용하지 않는다.
  return providers.length > 0
    && authUser.emailVerified === true
    && providers.every(provider => provider === 'password')
    && !providers.includes('google.com');
}

// 구 클라이언트는 Kakao subject를 `${id}@kakao.com` 합성 이메일로 Firebase
// password 계정에 매핑했다. 실제 Kakao access token으로 같은 subject를 증명한
// 사용자만 이 정확한 레거시 계정을 승계할 수 있다. 임의 이메일·Google 계정은
// 이 경로에 들어오지 않으며, kakaoId 중복 문서는 위에서 별도로 fail-close한다.
function legacySyntheticKakaoAccountMatches(authUser, kakaoId) {
  const subject = String(kakaoId || '').trim();
  if (!/^\d{1,32}$/u.test(subject)) return false;
  const providers = Array.isArray(authUser?.providerData)
    ? authUser.providerData.map(row => String(row && row.providerId || '')).filter(Boolean)
    : [];
  return authUser?.disabled !== true
    && normalizedEmail(authUser?.email) === `${subject}@kakao.com`
    && providers.length === 1
    && providers[0] === 'password';
}

async function findLinkedFirebaseUid(db, kakaoId, {
  auth,
  verifiedEmail = '',
  subjectHash = pseudonymousKakaoSubject(kakaoId)
} = {}) {
  if (!db) return '';
  const snapshot = await db.collection('users')
    .where('kakaoId', '==', String(kakaoId))
    .limit(2)
    .get();
  const docs = Array.isArray(snapshot?.docs) ? snapshot.docs : [];
  if (docs.length > 1) {
    const error = new Error('KAKAO_LINK_CONFLICT');
    error.code = 'KAKAO_LINK_CONFLICT';
    throw error;
  }
  const candidate = docs[0];
  if (!candidate) return '';
  if (!auth || typeof auth.getUser !== 'function') {
    const error = new Error('KAKAO_LINK_REVIEW_REQUIRED');
    error.code = 'KAKAO_LINK_REVIEW_REQUIRED';
    throw error;
  }
  let authUser;
  try {
    authUser = await auth.getUser(candidate.id);
  } catch {
    const error = new Error('KAKAO_LINK_REVIEW_REQUIRED');
    error.code = 'KAKAO_LINK_REVIEW_REQUIRED';
    throw error;
  }
  const data = typeof candidate.data === 'function' ? (candidate.data() || {}) : {};
  const safe = authUser.uid === candidate.id
    && authUser.disabled !== true
    && (
      legacyLinkIsServerVerified(data, subjectHash)
      || legacySyntheticKakaoAccountMatches(authUser, kakaoId)
      || legacyLinkMatchesVerifiedEmail(authUser, verifiedEmail)
    );
  if (!safe) {
    const error = new Error('KAKAO_LINK_REVIEW_REQUIRED');
    error.code = 'KAKAO_LINK_REVIEW_REQUIRED';
    throw error;
  }
  if (!legacyLinkIsServerVerified(data, subjectHash)) {
    await candidate.ref.set({
      kakaoLink: {
        version: 2,
        verifiedBy: 'server',
        subjectHash: String(subjectHash).slice(0, 64),
        verifiedAt: new Date().toISOString()
      }
    }, { merge: true });
  }
  return candidate.id;
}

function isAuthCode(error, code) {
  return String(error?.code || '') === code;
}

async function ensureFirebaseUser(auth, { uid, email, nickname, photo }) {
  try {
    return { user: await auth.getUser(uid), created: false };
  } catch (error) {
    if (!isAuthCode(error, 'auth/user-not-found')) throw error;
  }

  const base = {
    uid,
    displayName: nickname,
    disabled: false,
    ...(photo ? { photoURL: photo } : {})
  };
  if (!email) return { user: await auth.createUser(base), created: true };
  try {
    return { user: await auth.createUser({ ...base, email, emailVerified: true }), created: true };
  } catch (error) {
    // 같은 이메일의 Google/이메일 계정을 Kakao 주장만으로 합치면 계정 탈취가 된다.
    // 이메일 충돌 시 이메일 없는 별도 Kakao UID를 만들고, 명시적 계정 연결만 별도 UX에서 수행한다.
    if (!isAuthCode(error, 'auth/email-already-exists')) throw error;
    return { user: await auth.createUser(base), created: true };
  }
}

async function issueFirebaseCustomToken({ admin, db, kakaoId, email, nickname, photo } = {}) {
  if (!admin || !db) {
    const error = new Error('FIREBASE_UNAVAILABLE');
    error.code = 'FIREBASE_UNAVAILABLE';
    throw error;
  }
  const subject = String(kakaoId || '').trim();
  if (!/^\d{1,32}$/u.test(subject)) {
    const error = new Error('KAKAO_SUBJECT_INVALID');
    error.code = 'KAKAO_SUBJECT_INVALID';
    throw error;
  }
  const profile = cleanProfile({ email, nickname, photo });
  const auth = admin.auth();
  const subjectHash = pseudonymousKakaoSubject(subject);
  const linkedUid = await findLinkedFirebaseUid(db, subject, {
    auth,
    verifiedEmail: profile.email,
    subjectHash
  });
  const uid = linkedUid || firebaseUidForKakao(subject);
  const ensured = await ensureFirebaseUser(auth, { uid, ...profile });
  const user = ensured.user;
  const pseudonym = subjectHash;
  const customToken = await auth.createCustomToken(user.uid, {
    signInProvider: 'kakao',
    kakaoSubject: pseudonym.slice(0, 32)
  });
  return {
    customToken,
    firebaseUid: user.uid,
    isNewUser: ensured.created && !linkedUid,
    migratedLegacyAccount: Boolean(linkedUid),
    subjectHash: pseudonym
  };
}

module.exports = {
  customKakaoAuthEnabled,
  pseudonymousKakaoSubject,
  firebaseUidForKakao,
  assertKakaoAudience,
  assertKakaoSubject,
  cleanProfile,
  normalizedEmail,
  legacyLinkIsServerVerified,
  legacyLinkMatchesVerifiedEmail,
  legacySyntheticKakaoAccountMatches,
  findLinkedFirebaseUid,
  ensureFirebaseUser,
  issueFirebaseCustomToken
};
