'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  issueKakaoCustomToken,
  parseKakaoUserPayload,
  verifiedKakaoEmail
} = require('../lib/kakaoIdentity');

test('Kakao 64-bit ids are preserved without JavaScript number rounding', () => {
  const parsed = parseKakaoUserPayload('{"id":9223372036854775807,"kakao_account":{}}');
  assert.equal(parsed.id, '9223372036854775807');
});

function authFixture(seed = {}) {
  const byUid = new Map(Object.entries(seed).map(([uid, email]) => [uid, { uid, email }]));
  const byEmail = new Map([...byUid.values()].map(user => [user.email, user]));
  const calls = { created: [], tokens: [] };
  return {
    calls,
    async getUser(uid) {
      const user = byUid.get(uid);
      if (!user) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' });
      return user;
    },
    async getUserByEmail(email) {
      const user = byEmail.get(email);
      if (!user) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' });
      return user;
    },
    async createUser(input) {
      calls.created.push(input);
      const user = { uid: `new-${calls.created.length}`, email: input.email };
      byUid.set(user.uid, user);
      byEmail.set(user.email, user);
      return user;
    },
    async createCustomToken(uid, claims) {
      calls.tokens.push({ uid, claims });
      return `custom:${uid}`;
    }
  };
}

function dbFixture(matches = []) {
  const writes = [];
  const identities = new Map();
  const existingUsers = new Set(matches.map(item => item.uid));
  return {
    writes,
    collection(name) {
      if (name === 'authIdentities') {
        return {
          doc(id) {
            return {
              async get() {
                const data = identities.get(id);
                return { exists: Boolean(data), data: () => data || {} };
              },
              async set(data, options) {
                identities.set(id, { ...(identities.get(id) || {}), ...data });
                writes.push({ collection: name, id, data, options });
              }
            };
          }
        };
      }
      assert.equal(name, 'users');
      return {
        where(field, op, value) {
          assert.deepEqual([field, op], ['kakaoId', '==']);
          const ids = matches.filter(item => item.kakaoId === value).map(item => item.uid);
          return {
            limit() {
              return {
                async get() {
                  return { empty: ids.length === 0, size: ids.length, docs: ids.map(id => ({ id })) };
                }
              };
            }
          };
        },
        doc(uid) {
          return {
            async get() { return { exists: existingUsers.has(uid), data: () => ({}) }; },
            async set(data, options) { writes.push({ collection: name, uid, data, options }); }
          };
        }
      };
    }
  };
}

function adminFixture(auth) {
  return {
    auth: () => auth,
    firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TIME' } }
  };
}

function kakaoUser({ id = '12345', email = 'member@example.com', verified = true } = {}) {
  return {
    id,
    kakao_account: {
      email,
      is_email_valid: verified,
      is_email_verified: verified,
      profile: { nickname: '테스트', profile_image_url: 'https://example.com/photo.png' }
    }
  };
}

test('verified Kakao email reuses the existing Firebase uid and issues a custom token', async () => {
  const auth = authFixture({ existingUid: 'member@example.com' });
  const db = dbFixture();
  const result = await issueKakaoCustomToken({ admin: adminFixture(auth), db, userData: kakaoUser() });

  assert.equal(result.uid, 'existingUid');
  assert.equal(result.customToken, 'custom:existingUid');
  assert.equal(result.created, false);
  assert.equal(result.matchedBy, 'verified_email');
  assert.equal(auth.calls.created.length, 0);
  assert.deepEqual(auth.calls.tokens, [{ uid: 'existingUid', claims: { signInProvider: 'kakao' } }]);
  assert.equal(db.writes[0].data.providerUserId, '12345');
});

test('a verified Kakao email wins over an untrusted legacy users.kakaoId field', async () => {
  const auth = authFixture({ linkedUid: '12345@kakao.com', otherUid: 'member@example.com' });
  const db = dbFixture([{ uid: 'linkedUid', kakaoId: '12345' }]);
  const result = await issueKakaoCustomToken({ admin: adminFixture(auth), db, userData: kakaoUser() });
  assert.equal(result.uid, 'otherUid');
  assert.equal(result.matchedBy, 'verified_email');
});

test('the historical Kakao-id email preserves an existing legacy account when no verified email is supplied', async () => {
  const auth = authFixture({ linkedUid: '12345@kakao.com' });
  const db = dbFixture([{ uid: 'linkedUid', kakaoId: '12345' }]);
  const result = await issueKakaoCustomToken({
    admin: adminFixture(auth),
    db,
    userData: kakaoUser({ email: '', verified: false })
  });
  assert.equal(result.uid, 'linkedUid');
  assert.equal(result.matchedBy, 'legacy_email');
});

test('a client-written kakaoId cannot bind an unrelated Firebase account', async () => {
  const auth = authFixture({ attackerUid: 'attacker@example.com' });
  const db = dbFixture([{ uid: 'attackerUid', kakaoId: '12345' }]);
  await assert.rejects(
    issueKakaoCustomToken({
      admin: adminFixture(auth),
      db,
      userData: kakaoUser({ email: '', verified: false })
    }),
    error => error?.code === 'KAKAO_IDENTITY_CONFLICT'
  );
});

test('an unverified Kakao email is never linked to an existing Firebase email account', async () => {
  const auth = authFixture({ protectedUid: 'member@example.com' });
  const db = dbFixture();
  const result = await issueKakaoCustomToken({
    admin: adminFixture(auth),
    db,
    userData: kakaoUser({ verified: false })
  });

  assert.notEqual(result.uid, 'protectedUid');
  assert.equal(result.email, '12345@kakao.com');
  assert.equal(auth.calls.created[0].emailVerified, false);
  assert.equal(verifiedKakaoEmail(kakaoUser({ verified: false }).kakao_account), '');
});

test('the server-only identity ledger keeps later logins on the originally bound uid', async () => {
  const auth = authFixture();
  const db = dbFixture();
  const first = await issueKakaoCustomToken({ admin: adminFixture(auth), db, userData: kakaoUser() });
  const later = await issueKakaoCustomToken({
    admin: adminFixture(auth),
    db,
    userData: kakaoUser({ email: 'changed@example.com', verified: true })
  });
  assert.equal(later.uid, first.uid);
  assert.equal(later.matchedBy, 'kakao_id');
  assert.equal(auth.calls.created.length, 1);
});

test('duplicate kakaoId bindings fail closed instead of choosing an arbitrary account', async () => {
  const auth = authFixture({ first: 'first@example.com', second: 'second@example.com' });
  const db = dbFixture([
    { uid: 'first', kakaoId: '12345' },
    { uid: 'second', kakaoId: '12345' }
  ]);
  await assert.rejects(
    issueKakaoCustomToken({ admin: adminFixture(auth), db, userData: kakaoUser() }),
    error => error?.code === 'KAKAO_IDENTITY_CONFLICT'
  );
});

test('Kakao route no longer returns a deterministic password contract or logs provider PII', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'kakaoLogin.js'), 'utf8');
  assert.match(source, /issueKakaoCustomToken/u);
  assert.doesNotMatch(source, /password|kakao_.*_pw|JSON\.stringify\(userData\)/iu);
  assert.doesNotMatch(source, /logger\.(?:info|warn|error)\([^\n]+(?:email|nickname|profile_image_url)/iu);
});
