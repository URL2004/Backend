const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KakaoAuthError,
  authenticateKakaoIdentity,
  firebaseUidForKakao,
  normalizeKakaoProfile,
  validateKakaoTokenBinding
} = require('../lib/kakaoAuth');

function authError(code) {
  return Object.assign(new Error(code), { code });
}

class FakeAuth {
  constructor(users = []) {
    this.users = new Map();
    this.passwordUpdates = [];
    this.revocations = [];
    this.claimUpdates = [];
    this.createdInputs = [];
    for (const user of users) this.put(user);
  }

  put(user) {
    const record = {
      providerData: [],
      customClaims: {},
      disabled: false,
      ...user
    };
    this.users.set(record.uid, record);
    return record;
  }

  async getUser(uid) {
    const user = this.users.get(uid);
    if (!user) throw authError('auth/user-not-found');
    return user;
  }

  async getUserByEmail(email) {
    const normalized = String(email || '').toLowerCase();
    const user = [...this.users.values()].find(item => String(item.email || '').toLowerCase() === normalized);
    if (!user) throw authError('auth/user-not-found');
    return user;
  }

  async createUser(input) {
    this.createdInputs.push({ ...input });
    if (this.users.has(input.uid)) throw authError('auth/uid-already-exists');
    if (input.email && [...this.users.values()].some(item => item.email === input.email)) {
      throw authError('auth/email-already-exists');
    }
    return this.put({ ...input, providerData: [], customClaims: {} });
  }

  async updateUser(uid, patch) {
    const user = await this.getUser(uid);
    if (patch.password) this.passwordUpdates.push({ uid, password: patch.password });
    Object.assign(user, patch.password ? {} : patch);
    return user;
  }

  async revokeRefreshTokens(uid) {
    await this.getUser(uid);
    this.revocations.push(uid);
  }

  async setCustomUserClaims(uid, claims) {
    const user = await this.getUser(uid);
    user.customClaims = { ...claims };
    this.claimUpdates.push({ uid, claims: { ...claims } });
  }

  async createCustomToken(uid, claims) {
    await this.getUser(uid);
    return `custom-token:${uid}:${claims.kakaoAuthVersion}`;
  }
}

class FakeDocRef {
  constructor(store, id) {
    this.store = store;
    this.id = id;
  }

  async get() {
    const data = this.store.get(this.id);
    return {
      exists: data !== undefined,
      id: this.id,
      data: () => data
    };
  }

  async create(data) {
    if (this.store.has(this.id)) throw Object.assign(new Error('already exists'), { code: 6 });
    this.store.set(this.id, { ...data });
  }

  async set(data, options) {
    if (options?.merge) this.store.set(this.id, { ...(this.store.get(this.id) || {}), ...data });
    else this.store.set(this.id, { ...data });
  }
}

class FakeUsersCollection {
  constructor(store) {
    this.store = store;
  }

  doc(id) {
    return new FakeDocRef(this.store, id);
  }

  where(field, op, value) {
    assert.equal(field, 'kakaoId');
    assert.equal(op, '==');
    return {
      limit: limit => ({
        get: async () => {
          const docs = [...this.store.entries()]
            .filter(([, data]) => String(data.kakaoId || '') === value)
            .slice(0, limit)
            .map(([id, data]) => ({ id, data: () => data }));
          return { docs };
        }
      })
    };
  }
}

class FakeDb {
  constructor(users = {}) {
    this.users = new Map(Object.entries(users));
  }

  collection(name) {
    assert.equal(name, 'users');
    return new FakeUsersCollection(this.users);
  }
}

const fakeAdmin = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => 'SERVER_TIMESTAMP'
    }
  }
};

function profile(kakaoId = '123456789') {
  return normalizeKakaoProfile({
    id: kakaoId,
    kakao_account: {
      email: 'member@example.com',
      is_email_verified: true,
      is_email_valid: true,
      profile: {
        nickname: '카카오 회원',
        profile_image_url: 'https://example.com/profile.png'
      }
    }
  });
}

test('Kakao profile accepts only verified email and valid identity fields', () => {
  const verified = profile();
  assert.equal(verified.verifiedEmail, 'member@example.com');
  assert.equal(verified.legacyEmail, '123456789@kakao.com');

  const unverified = normalizeKakaoProfile({
    id: 123,
    kakao_account: { email: 'member@example.com', is_email_verified: false }
  });
  assert.equal(unverified.verifiedEmail, '');

  assert.throws(
    () => normalizeKakaoProfile({ id: '../not-an-id' }),
    err => err instanceof KakaoAuthError && err.code === 'KAKAO_ID_INVALID'
  );
});

test('new Kakao user gets an opaque UID and a custom token without a password credential', async () => {
  const auth = new FakeAuth();
  const db = new FakeDb();
  const p = profile();

  const result = await authenticateKakaoIdentity({ auth, db, admin: fakeAdmin, profile: p });

  assert.equal(result.uid, firebaseUidForKakao(p.kakaoId));
  assert.equal(result.uid.includes(p.kakaoId), false);
  assert.match(result.customToken, /^custom-token:/);
  assert.equal(result.isNewUser, true);
  assert.equal(auth.createdInputs.length, 1);
  assert.equal(Object.hasOwn(auth.createdInputs[0], 'password'), false);
  assert.equal(auth.passwordUpdates.length, 0);
  assert.equal(db.users.get(result.uid).credits, 10);
  assert.equal(db.users.get(result.uid).kakaoId, p.kakaoId);
});

test('legacy Kakao user keeps UID and credits while predictable password and sessions are invalidated once', async () => {
  const p = profile();
  const auth = new FakeAuth([{
    uid: 'legacy-uid',
    email: p.verifiedEmail,
    displayName: '기존 회원',
    providerData: [{ providerId: 'password' }]
  }]);
  const db = new FakeDb({
    'legacy-uid': { kakaoId: p.kakaoId, credits: 73, plan: 'pro', name: '기존 회원', email: p.verifiedEmail }
  });

  const first = await authenticateKakaoIdentity({ auth, db, admin: fakeAdmin, profile: p });
  const second = await authenticateKakaoIdentity({ auth, db, admin: fakeAdmin, profile: p });

  assert.equal(first.uid, 'legacy-uid');
  assert.equal(first.passwordRotated, true);
  assert.equal(second.passwordRotated, false);
  assert.equal(db.users.get('legacy-uid').credits, 73);
  assert.equal(auth.passwordUpdates.length, 1);
  assert.equal(auth.passwordUpdates[0].password.includes(p.kakaoId), false);
  assert.deepEqual(auth.revocations, ['legacy-uid']);
  assert.equal(auth.users.get('legacy-uid').customClaims.kakaoCustomAuthVersion, 2);
});

test('verified Kakao email can recover a password-only legacy account without a Firestore kakaoId', async () => {
  const p = profile();
  const auth = new FakeAuth([{
    uid: 'legacy-email-uid',
    email: p.verifiedEmail,
    providerData: [{ providerId: 'password' }]
  }]);
  const db = new FakeDb({
    'legacy-email-uid': { credits: 20, plan: 'free', email: p.verifiedEmail }
  });

  const result = await authenticateKakaoIdentity({ auth, db, admin: fakeAdmin, profile: p });

  assert.equal(result.uid, 'legacy-email-uid');
  assert.equal(result.passwordRotated, true);
  assert.equal(db.users.get('legacy-email-uid').kakaoId, p.kakaoId);
});

test('same email owned by a non-Kakao provider is never auto-linked', async () => {
  const p = profile();
  const auth = new FakeAuth([{
    uid: 'google-uid',
    email: p.verifiedEmail,
    providerData: [{ providerId: 'google.com' }]
  }]);
  const db = new FakeDb({
    'google-uid': { credits: 10, plan: 'free', email: p.verifiedEmail }
  });

  await assert.rejects(
    authenticateKakaoIdentity({ auth, db, admin: fakeAdmin, profile: p }),
    err => err instanceof KakaoAuthError && err.code === 'KAKAO_ACCOUNT_LINK_REQUIRED' && err.status === 409
  );
  assert.equal(auth.passwordUpdates.length, 0);
  assert.equal(auth.createdInputs.length, 0);
});

test('Kakao access token must belong to the configured app and same user', () => {
  const allowedAppIds = new Set(['987654']);
  assert.deepEqual(
    validateKakaoTokenBinding({
      tokenInfo: { app_id: 987654, id: 123456789, expires_in: 3600 },
      userData: { id: 123456789 },
      allowedAppIds
    }),
    { appMatches: true, userMatches: true, unexpired: true }
  );

  for (const tokenInfo of [
    { app_id: 111111, id: 123456789, expires_in: 3600 },
    { app_id: 987654, id: 999999999, expires_in: 3600 },
    { app_id: 987654, id: 123456789, expires_in: 0 }
  ]) {
    assert.throws(
      () => validateKakaoTokenBinding({ tokenInfo, userData: { id: 123456789 }, allowedAppIds }),
      err => err instanceof KakaoAuthError && err.code === 'KAKAO_TOKEN_REJECTED' && err.status === 401
    );
  }
});

test('temporary Kakao token-info failure is not treated as an invalid identity', () => {
  assert.throws(
    () => validateKakaoTokenBinding({
      tokenInfo: { code: -1 },
      userData: { id: 123456789 },
      allowedAppIds: new Set(['987654']),
      responseOk: false
    }),
    err => err instanceof KakaoAuthError
      && err.code === 'KAKAO_TOKEN_CHECK_UNAVAILABLE'
      && err.status === 502
  );
});
