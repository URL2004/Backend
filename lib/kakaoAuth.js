const crypto = require('crypto');

const KAKAO_AUTH_VERSION = 2;
const LEGACY_KAKAO_EMAIL_RE = /^(\d{1,32})@kakao\.com$/i;

class KakaoAuthError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'KakaoAuthError';
    this.code = code;
    this.status = status;
  }
}

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email || email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return '';
  return email;
}

function normalizePhotoUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.toString().length <= 2048 ? url.toString() : '';
  } catch {
    return '';
  }
}

function normalizeKakaoProfile(userData) {
  const kakaoId = String(userData?.id || '').trim();
  if (!/^\d{1,32}$/.test(kakaoId)) {
    throw new KakaoAuthError('KAKAO_ID_INVALID', '카카오 사용자 식별정보가 올바르지 않습니다.', 401);
  }

  const account = userData?.kakao_account || {};
  const rawEmail = normalizeEmail(account.email);
  const emailVerified = !!rawEmail
    && account.is_email_verified === true
    && account.is_email_valid !== false;
  const nickname = String(account.profile?.nickname || '카카오유저').trim().slice(0, 128) || '카카오유저';

  return {
    kakaoId,
    nickname,
    photo: normalizePhotoUrl(account.profile?.profile_image_url),
    verifiedEmail: emailVerified ? rawEmail : '',
    legacyEmail: `${kakaoId}@kakao.com`
  };
}

function firebaseUidForKakao(kakaoId) {
  const digest = crypto.createHash('sha256').update(`kakao:${kakaoId}`).digest('base64url').slice(0, 32);
  return `kakao_${digest}`;
}

function validateKakaoTokenBinding({ tokenInfo, userData, allowedAppIds, responseOk = true }) {
  const allowed = allowedAppIds instanceof Set ? allowedAppIds : new Set(allowedAppIds || []);
  const transientFailure = Number(tokenInfo?.code) === -1;
  const appMatches = allowed.has(String(tokenInfo?.app_id || ''));
  const userMatches = String(tokenInfo?.id || '') === String(userData?.id || '');
  const unexpired = Number(tokenInfo?.expires_in) > 0;

  if (!responseOk || !appMatches || !userMatches || !unexpired) {
    throw new KakaoAuthError(
      transientFailure ? 'KAKAO_TOKEN_CHECK_UNAVAILABLE' : 'KAKAO_TOKEN_REJECTED',
      transientFailure
        ? '카카오 인증 확인이 일시적으로 불안정합니다. 잠시 후 다시 시도해 주세요.'
        : '유효하지 않은 카카오 로그인입니다. 다시 로그인해 주세요.',
      transientFailure ? 502 : 401
    );
  }

  return { appMatches, userMatches, unexpired };
}

function firebaseErrorCode(err) {
  return String(err?.code || err?.errorInfo?.code || '');
}

function isUserNotFound(err) {
  return firebaseErrorCode(err) === 'auth/user-not-found';
}

function isUidExists(err) {
  return firebaseErrorCode(err) === 'auth/uid-already-exists';
}

function isEmailExists(err) {
  return firebaseErrorCode(err) === 'auth/email-already-exists';
}

function providerIds(userRecord) {
  return (userRecord?.providerData || []).map(item => item?.providerId).filter(Boolean);
}

function hasPasswordProvider(userRecord) {
  return providerIds(userRecord).includes('password');
}

function isLegacyPasswordOnlyUser(userRecord) {
  const ids = providerIds(userRecord);
  return ids.length > 0 && ids.every(id => id === 'password');
}

async function getUserOrNull(auth, uid) {
  try {
    return await auth.getUser(uid);
  } catch (err) {
    if (isUserNotFound(err)) return null;
    throw err;
  }
}

async function getUserByEmailOrNull(auth, email) {
  if (!email) return null;
  try {
    return await auth.getUserByEmail(email);
  } catch (err) {
    if (isUserNotFound(err)) return null;
    throw err;
  }
}

async function firestoreUserMatchesKakao(db, uid, kakaoId) {
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists && String(snap.data()?.kakaoId || '') === kakaoId;
}

async function linkedUidByKakaoId(db, kakaoId) {
  const snap = await db.collection('users').where('kakaoId', '==', kakaoId).limit(2).get();
  if (snap.docs.length > 1) {
    throw new KakaoAuthError(
      'KAKAO_LINK_CONFLICT',
      '동일한 카카오 계정에 연결된 회원이 여러 명입니다. 고객센터에 문의해 주세요.',
      409
    );
  }
  return snap.docs[0]?.id || '';
}

async function emailOwnerCanBeMigrated({ db, userRecord, profile, candidateEmail }) {
  if (!userRecord) return false;
  if (Number(userRecord.customClaims?.kakaoCustomAuthVersion) >= KAKAO_AUTH_VERSION) return true;
  if (await firestoreUserMatchesKakao(db, userRecord.uid, profile.kakaoId)) return true;

  // 이 서비스에는 일반 이메일/비밀번호 가입 UI가 없었다. password 단독 계정은
  // 기존 카카오 로그인 구현이 만든 계정이며, 검증된 카카오 이메일로만 승계한다.
  const isVerifiedKakaoEmail = !!profile.verifiedEmail && candidateEmail === profile.verifiedEmail;
  const isSyntheticLegacyEmail = candidateEmail === profile.legacyEmail;
  return isLegacyPasswordOnlyUser(userRecord) && (isVerifiedKakaoEmail || isSyntheticLegacyEmail);
}

function authUserInput(uid, profile) {
  const input = {
    uid,
    displayName: profile.nickname,
    disabled: false
  };
  if (profile.photo) input.photoURL = profile.photo;
  if (profile.verifiedEmail) {
    input.email = profile.verifiedEmail;
    input.emailVerified = true;
  }
  return input;
}

async function createAuthUser({ auth, db, uid, profile }) {
  try {
    return await auth.createUser(authUserInput(uid, profile));
  } catch (err) {
    if (isUidExists(err)) {
      const raced = await getUserOrNull(auth, uid);
      if (raced) return raced;
    }
    if (isEmailExists(err) && profile.verifiedEmail) {
      const owner = await getUserByEmailOrNull(auth, profile.verifiedEmail);
      if (await emailOwnerCanBeMigrated({
        db,
        userRecord: owner,
        profile,
        candidateEmail: profile.verifiedEmail
      })) {
        return owner;
      }
      throw new KakaoAuthError(
        'KAKAO_ACCOUNT_LINK_REQUIRED',
        '같은 이메일의 다른 로그인 계정이 있습니다. 고객센터에 계정 연결을 요청해 주세요.',
        409
      );
    }
    throw err;
  }
}

async function resolveFirebaseUser({ auth, db, profile }) {
  const linkedUid = await linkedUidByKakaoId(db, profile.kakaoId);
  if (linkedUid) {
    const linked = await getUserOrNull(auth, linkedUid);
    if (linked) return { userRecord: linked, authUserCreated: false, resolution: 'firestore_link' };
    const recreated = await createAuthUser({ auth, db, uid: linkedUid, profile });
    return { userRecord: recreated, authUserCreated: true, resolution: 'firestore_link_recreated' };
  }

  const canonicalUid = firebaseUidForKakao(profile.kakaoId);
  const canonical = await getUserOrNull(auth, canonicalUid);
  if (canonical) return { userRecord: canonical, authUserCreated: false, resolution: 'canonical_uid' };

  const candidateEmails = [...new Set([profile.legacyEmail, profile.verifiedEmail].filter(Boolean))];
  for (const candidateEmail of candidateEmails) {
    const owner = await getUserByEmailOrNull(auth, candidateEmail);
    if (!owner) continue;
    if (await emailOwnerCanBeMigrated({ db, userRecord: owner, profile, candidateEmail })) {
      return { userRecord: owner, authUserCreated: false, resolution: 'legacy_email' };
    }
    throw new KakaoAuthError(
      'KAKAO_ACCOUNT_LINK_REQUIRED',
      '같은 이메일의 다른 로그인 계정이 있습니다. 고객센터에 계정 연결을 요청해 주세요.',
      409
    );
  }

  const created = await createAuthUser({ auth, db, uid: canonicalUid, profile });
  return { userRecord: created, authUserCreated: true, resolution: 'created' };
}

function randomReplacementPassword() {
  return `${crypto.randomBytes(48).toString('base64url')}aA1!`;
}

async function secureLegacyPassword(auth, userRecord) {
  const currentVersion = Number(userRecord?.customClaims?.kakaoCustomAuthVersion) || 0;
  const needsVersionClaim = currentVersion < KAKAO_AUTH_VERSION;
  let passwordRotated = false;

  if (hasPasswordProvider(userRecord) && needsVersionClaim) {
    // Admin SDK에는 password provider 제거 API가 없으므로 추측 불가능한 값으로 교체한다.
    // 값은 저장·반환·로그하지 않으며, 이어서 기존 refresh token도 전부 폐기한다.
    await auth.updateUser(userRecord.uid, { password: randomReplacementPassword() });
    await auth.revokeRefreshTokens(userRecord.uid);
    passwordRotated = true;
  }

  if (needsVersionClaim) {
    await auth.setCustomUserClaims(userRecord.uid, {
      ...(userRecord.customClaims || {}),
      kakaoCustomAuthVersion: KAKAO_AUTH_VERSION
    });
  }

  return { passwordRotated, claimsUpdated: needsVersionClaim };
}

function serverTimestamp(admin) {
  const factory = admin?.firestore?.FieldValue?.serverTimestamp;
  return typeof factory === 'function' ? factory() : new Date().toISOString();
}

function isAlreadyExists(err) {
  const code = String(err?.code || '');
  return code === '6' || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

async function syncUserDocument({ db, admin, uid, userRecord, profile }) {
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const stamp = serverTimestamp(admin);

  if (!snap.exists) {
    const data = {
      email: userRecord.email || profile.verifiedEmail || '',
      name: userRecord.displayName || profile.nickname,
      credits: 10,
      plan: 'free',
      refCode: uid.slice(0, 8),
      createdAt: stamp,
      kakaoId: profile.kakaoId,
      authProvider: 'kakao',
      kakaoAuthVersion: KAKAO_AUTH_VERSION
    };
    try {
      if (typeof ref.create === 'function') await ref.create(data);
      else await ref.set(data);
      return { appUserCreated: true };
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }

  const currentSnap = snap.exists ? snap : await ref.get();
  const current = currentSnap.exists ? (currentSnap.data() || {}) : {};
  const patch = {};
  if (String(current.kakaoId || '') !== profile.kakaoId) patch.kakaoId = profile.kakaoId;
  if (current.authProvider !== 'kakao') patch.authProvider = 'kakao';
  if (Number(current.kakaoAuthVersion) < KAKAO_AUTH_VERSION) {
    patch.kakaoAuthVersion = KAKAO_AUTH_VERSION;
    patch.kakaoAuthMigratedAt = stamp;
  }
  if (!current.name) patch.name = userRecord.displayName || profile.nickname;
  if (!current.email && (userRecord.email || profile.verifiedEmail)) {
    patch.email = userRecord.email || profile.verifiedEmail;
  }
  if (Object.keys(patch).length) await ref.set(patch, { merge: true });
  return { appUserCreated: false };
}

async function authenticateKakaoIdentity({ auth, db, admin, profile }) {
  if (!auth || !db) {
    throw new KakaoAuthError('FIREBASE_UNAVAILABLE', '인증 서버가 준비되지 않았습니다.', 503);
  }

  const resolved = await resolveFirebaseUser({ auth, db, profile });
  const secured = await secureLegacyPassword(auth, resolved.userRecord);
  const synced = await syncUserDocument({
    db,
    admin,
    uid: resolved.userRecord.uid,
    userRecord: resolved.userRecord,
    profile
  });
  const customToken = await auth.createCustomToken(resolved.userRecord.uid, {
    kakaoAuth: true,
    kakaoAuthVersion: KAKAO_AUTH_VERSION
  });

  return {
    uid: resolved.userRecord.uid,
    customToken,
    isNewUser: synced.appUserCreated,
    passwordRotated: secured.passwordRotated,
    resolution: resolved.resolution
  };
}

function legacyKakaoIdFromEmail(email) {
  const match = normalizeEmail(email).match(LEGACY_KAKAO_EMAIL_RE);
  return match ? match[1] : '';
}

module.exports = {
  KAKAO_AUTH_VERSION,
  KakaoAuthError,
  authenticateKakaoIdentity,
  firebaseUidForKakao,
  hasPasswordProvider,
  legacyKakaoIdFromEmail,
  normalizeKakaoProfile,
  secureLegacyPassword,
  validateKakaoTokenBinding,
  _private: {
    emailOwnerCanBeMigrated,
    isLegacyPasswordOnlyUser,
    linkedUidByKakaoId,
    resolveFirebaseUser,
    syncUserDocument
  }
};
