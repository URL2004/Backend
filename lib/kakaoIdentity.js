'use strict';

const KAKAO_PROVIDER = 'kakao';

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function verifiedKakaoEmail(account = {}) {
  const email = cleanText(account.email, 320).toLowerCase();
  if (!email || account.is_email_valid !== true || account.is_email_verified !== true) return '';
  return email;
}

function legacyKakaoEmail(kakaoId) {
  return `${String(kakaoId)}@kakao.com`;
}

function parseKakaoUserPayload(raw) {
  const text = String(raw || '');
  if (!text || Buffer.byteLength(text, 'utf8') > 256 * 1024) {
    const error = new Error('KAKAO_RESPONSE_INVALID');
    error.code = 'KAKAO_RESPONSE_INVALID';
    throw error;
  }
  const data = JSON.parse(text);
  // Kakao's id is a 64-bit integer. JSON.parse can round it before String()
  // on values above Number.MAX_SAFE_INTEGER, so preserve the response digits.
  const exactId = text.match(/"id"\s*:\s*(?:"(\d{1,64})"|(\d{1,64}))/u);
  if (exactId) data.id = exactId[1] || exactId[2];
  return data;
}

function isAuthNotFound(error) {
  return error?.code === 'auth/user-not-found';
}

function isAuthConflict(error) {
  return error?.code === 'auth/email-already-exists'
    || error?.code === 'auth/email-already-in-use'
    || error?.code === 'auth/uid-already-exists';
}

async function findUserByEmail(auth, email) {
  if (!email) return null;
  try {
    return await auth.getUserByEmail(email);
  } catch (error) {
    if (isAuthNotFound(error)) return null;
    throw error;
  }
}

async function findUserByKakaoId(db, kakaoId) {
  if (!db) return null;
  const identitySnapshot = await db.collection('authIdentities').doc(`kakao_${kakaoId}`).get();
  if (identitySnapshot.exists) {
    const uid = cleanText(identitySnapshot.data()?.uid, 128);
    if (!uid) {
      const error = new Error('KAKAO_IDENTITY_CONFLICT');
      error.code = 'KAKAO_IDENTITY_CONFLICT';
      throw error;
    }
    return uid;
  }
  return null;
}

async function findVerifiedLegacyBinding({ auth, db, kakaoId, allowedEmails }) {
  if (!db) return null;
  const snapshot = await db.collection('users').where('kakaoId', '==', String(kakaoId)).limit(2).get();
  if (snapshot.empty) return null;
  const candidates = [];
  for (const document of snapshot.docs) {
    try {
      const user = await auth.getUser(document.id);
      if (allowedEmails.has(String(user.email || '').toLowerCase())) candidates.push(user);
    } catch (error) {
      if (!isAuthNotFound(error)) throw error;
    }
  }
  if (candidates.length !== 1) {
    const error = new Error('KAKAO_IDENTITY_CONFLICT');
    error.code = 'KAKAO_IDENTITY_CONFLICT';
    throw error;
  }
  return candidates[0];
}

async function bindKakaoIdentity({ admin, db, kakaoId, uid }) {
  if (!db) return;
  const identityRef = db.collection('authIdentities').doc(`kakao_${kakaoId}`);
  const binding = {
    uid,
    provider: KAKAO_PROVIDER,
    providerUserId: kakaoId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (typeof db.runTransaction === 'function') {
    await db.runTransaction(async transaction => {
      const existing = await transaction.get(identityRef);
      const existingUid = existing.exists ? cleanText(existing.data()?.uid, 128) : '';
      if (existingUid && existingUid !== uid) {
        const error = new Error('KAKAO_IDENTITY_CONFLICT');
        error.code = 'KAKAO_IDENTITY_CONFLICT';
        throw error;
      }
      transaction.set(identityRef, binding, { merge: true });
    });
  } else {
    const existing = await identityRef.get();
    const existingUid = existing.exists ? cleanText(existing.data()?.uid, 128) : '';
    if (existingUid && existingUid !== uid) {
      const error = new Error('KAKAO_IDENTITY_CONFLICT');
      error.code = 'KAKAO_IDENTITY_CONFLICT';
      throw error;
    }
    await identityRef.set(binding, { merge: true });
  }

  // Never create a partial users/{uid} document before the frontend's normal
  // new-user initializer. Existing profiles may receive the server-owned link.
  const userRef = db.collection('users').doc(uid);
  const userSnapshot = await userRef.get();
  if (userSnapshot.exists) {
    await userRef.set({
      kakaoId,
      authProvider: KAKAO_PROVIDER,
      kakaoLinkedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
}

async function createOrResolveUser({ auth, db, kakaoId, email, nickname, photo }) {
  const byKakaoUid = await findUserByKakaoId(db, kakaoId);
  if (byKakaoUid) return { user: await auth.getUser(byKakaoUid), created: false, matchedBy: 'kakao_id' };

  const verifiedEmail = cleanText(email, 320).toLowerCase();
  const legacyEmail = legacyKakaoEmail(kakaoId);
  const byVerifiedEmail = await findUserByEmail(auth, verifiedEmail);
  if (byVerifiedEmail) return { user: byVerifiedEmail, created: false, matchedBy: 'verified_email' };

  const byLegacyEmail = verifiedEmail === legacyEmail ? null : await findUserByEmail(auth, legacyEmail);
  if (byLegacyEmail) return { user: byLegacyEmail, created: false, matchedBy: 'legacy_email' };

  // users.kakaoId used to be client-writable. Never trust that field by itself:
  // only migrate a legacy binding when the Firebase Auth email independently
  // matches this verified Kakao email or the historical Kakao-id email.
  const allowedLegacyEmails = new Set([verifiedEmail, legacyEmail].filter(Boolean));
  const verifiedLegacy = await findVerifiedLegacyBinding({ auth, db, kakaoId, allowedEmails: allowedLegacyEmails });
  if (verifiedLegacy) return { user: verifiedLegacy, created: false, matchedBy: 'verified_legacy_binding' };

  const createEmail = verifiedEmail || legacyEmail;
  try {
    const user = await auth.createUser({
      email: createEmail,
      emailVerified: Boolean(verifiedEmail),
      displayName: cleanText(nickname, 128) || undefined,
      photoURL: /^https:\/\//iu.test(String(photo || '')) ? cleanText(photo, 2048) : undefined
    });
    return { user, created: true, matchedBy: 'created' };
  } catch (error) {
    if (!isAuthConflict(error)) throw error;
    const raced = await findUserByEmail(auth, createEmail);
    if (!raced) throw error;
    return { user: raced, created: false, matchedBy: 'concurrent_create' };
  }
}

async function issueKakaoCustomToken({ admin, db, userData }) {
  if (!admin) {
    const error = new Error('FIREBASE_AUTH_UNAVAILABLE');
    error.code = 'FIREBASE_AUTH_UNAVAILABLE';
    throw error;
  }
  const kakaoId = cleanText(userData?.id, 64);
  if (!/^\d{1,64}$/u.test(kakaoId)) {
    const error = new Error('KAKAO_IDENTITY_INVALID');
    error.code = 'KAKAO_IDENTITY_INVALID';
    throw error;
  }

  const account = userData.kakao_account || {};
  const profile = account.profile || {};
  const nickname = cleanText(profile.nickname, 128) || '카카오유저';
  const photo = /^https:\/\//iu.test(String(profile.profile_image_url || ''))
    ? cleanText(profile.profile_image_url, 2048)
    : '';
  const email = verifiedKakaoEmail(account);
  const auth = admin.auth();
  const resolved = await createOrResolveUser({ auth, db, kakaoId, email, nickname, photo });

  await bindKakaoIdentity({ admin, db, kakaoId, uid: resolved.user.uid });

  const customToken = await auth.createCustomToken(resolved.user.uid, { signInProvider: KAKAO_PROVIDER });
  return {
    customToken,
    uid: resolved.user.uid,
    kakaoId,
    nickname,
    email: resolved.user.email || email || legacyKakaoEmail(kakaoId),
    photo,
    created: resolved.created,
    matchedBy: resolved.matchedBy
  };
}

module.exports = {
  createOrResolveUser,
  bindKakaoIdentity,
  issueKakaoCustomToken,
  legacyKakaoEmail,
  parseKakaoUserPayload,
  verifiedKakaoEmail
};
