'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pseudonymousKakaoSubject,
  firebaseUidForKakao,
  assertKakaoAudience,
  assertKakaoSubject,
  customKakaoAuthEnabled,
  legacyLinkMatchesVerifiedEmail,
  legacySyntheticKakaoAccountMatches,
  issueFirebaseCustomToken
} = require('../lib/kakaoIdentity');

test('custom-token Kakao 전환은 운영 스모크 전 기본 OFF다', () => {
  assert.equal(customKakaoAuthEnabled({}), false);
  assert.equal(customKakaoAuthEnabled({ KAKAO_CUSTOM_TOKEN_AUTH_ENABLED: '0' }), false);
  assert.equal(customKakaoAuthEnabled({ KAKAO_CUSTOM_TOKEN_AUTH_ENABLED: '1' }), true);
});

test('카카오 subject는 HMAC으로 가명화하고 원본 ID를 UID에 노출하지 않는다', () => {
  const a = pseudonymousKakaoSubject('123456789', 'unit-secret');
  const b = pseudonymousKakaoSubject('123456789', 'unit-secret');
  const other = pseudonymousKakaoSubject('987654321', 'unit-secret');
  assert.equal(a, b);
  assert.notEqual(a, other);
  assert.equal(a.includes('123456789'), false);
  assert.match(firebaseUidForKakao('123456789', 'unit-secret'), /^kakao:[a-f0-9]{48}$/u);
});

test('access token app_id audience 불일치와 필수 설정 누락은 fail-close한다', () => {
  assert.deepEqual(assertKakaoAudience({ app_id: 42 }, '42', true), { actual: '42', verified: true });
  assert.deepEqual(assertKakaoAudience({ app_id: 42 }, '', false), { actual: '42', verified: false });
  assert.throws(() => assertKakaoAudience({ app_id: 41 }, '42', true), { code: 'KAKAO_TOKEN_AUDIENCE_MISMATCH' });
  assert.throws(() => assertKakaoAudience({ app_id: 42 }, '', true), { code: 'KAKAO_APP_ID_MISSING' });
  assert.throws(() => assertKakaoAudience({}, '42', true), { code: 'KAKAO_TOKEN_INFO_INVALID' });
});

test('token-info와 user-info의 Kakao subject가 다르면 계정을 발급하지 않는다', () => {
  assert.equal(assertKakaoSubject({ id: 12345 }, { id: '12345' }), '12345');
  assert.throws(() => assertKakaoSubject({ id: 12345 }, { id: 99999 }), { code: 'KAKAO_TOKEN_SUBJECT_MISMATCH' });
  assert.throws(() => assertKakaoSubject({}, { id: 12345 }), { code: 'KAKAO_TOKEN_SUBJECT_MISMATCH' });
});

test('Kakao 이메일이 같아도 Firebase 미인증 password 계정은 legacy 링크 근거가 아니다', () => {
  assert.equal(legacyLinkMatchesVerifiedEmail({
    email: 'same@example.com',
    emailVerified: false,
    providerData: [{ providerId: 'password' }]
  }, 'same@example.com'), false);
});

test('실제 Kakao subject와 정확히 같은 구 합성 password 계정은 안전하게 승계한다', () => {
  assert.equal(legacySyntheticKakaoAccountMatches({
    email: '12345@kakao.com',
    emailVerified: false,
    disabled: false,
    providerData: [{ providerId: 'password' }]
  }, '12345'), true);
  assert.equal(legacySyntheticKakaoAccountMatches({
    email: '12345@kakao.com',
    providerData: [{ providerId: 'google.com' }]
  }, '12345'), false);
  assert.equal(legacySyntheticKakaoAccountMatches({
    email: 'attacker@example.com',
    providerData: [{ providerId: 'password' }]
  }, '12345'), false);
});

test('구 합성 Kakao 계정은 verified 이메일 동의가 없어도 같은 UID로 마이그레이션한다', async t => {
  const previous = process.env.KAKAO_AUTH_SALT;
  process.env.KAKAO_AUTH_SALT = 'kakao-synthetic-migration-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.KAKAO_AUTH_SALT;
    else process.env.KAKAO_AUTH_SALT = previous;
  });
  const auth = {
    async getUser(uid) {
      return {
        uid,
        email: '12345@kakao.com',
        emailVerified: false,
        disabled: false,
        providerData: [{ providerId: 'password' }]
      };
    },
    async createUser() { throw new Error('must not create'); },
    async createCustomToken(uid) { return `token:${uid}`; }
  };
  const result = await issueFirebaseCustomToken({
    admin: { auth: () => auth },
    db: fakeDb('legacy-synthetic-uid', { kakaoId: '12345' }),
    kakaoId: '12345',
    email: '',
    nickname: '기존 사용자'
  });
  assert.equal(result.firebaseUid, 'legacy-synthetic-uid');
  assert.equal(result.migratedLegacyAccount, true);
});

function fakeDb(linkedUid = '', linkedData = {}) {
  return {
    collection(name) {
      assert.equal(name, 'users');
      return {
        where(field, op, value) {
          assert.deepEqual([field, op, value], ['kakaoId', '==', '12345']);
          return {
            limit(n) {
              assert.equal(n, 2);
              return {
                async get() {
                  return {
                    docs: linkedUid ? [{
                      id: linkedUid,
                      data: () => linkedData,
                      ref: { async set() {} }
                    }] : []
                  };
                }
              };
            }
          };
        }
      };
    }
  };
}

test('기존 kakaoId 링크는 동일 Firebase UID로 custom token을 발급한다', async t => {
  const previous = process.env.KAKAO_AUTH_SALT;
  process.env.KAKAO_AUTH_SALT = 'kakao-identity-unit-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.KAKAO_AUTH_SALT;
    else process.env.KAKAO_AUTH_SALT = previous;
  });
  const calls = [];
  const auth = {
    async getUser(uid) {
      calls.push(['get', uid]);
      return {
        uid,
        email: 'verified@example.com',
        emailVerified: true,
        disabled: false,
        providerData: [{ providerId: 'password' }]
      };
    },
    async createUser() { throw new Error('must not create'); },
    async createCustomToken(uid, claims) { calls.push(['token', uid, claims]); return 'firebase-custom-token'; }
  };
  const result = await issueFirebaseCustomToken({
    admin: { auth: () => auth },
    db: fakeDb('legacy-firebase-uid'),
    kakaoId: '12345',
    email: 'verified@example.com',
    nickname: '테스터',
    photo: 'https://example.com/a.png'
  });

  assert.equal(result.firebaseUid, 'legacy-firebase-uid');
  assert.equal(result.customToken, 'firebase-custom-token');
  assert.equal(result.migratedLegacyAccount, true);
  assert.equal(result.isNewUser, false);
  const tokenCall = calls.find(call => call[0] === 'token');
  assert.equal(tokenCall[2].signInProvider, 'kakao');
  assert.equal(String(tokenCall[2].kakaoSubject).includes('12345'), false);
});

test('과거 클라이언트가 임의로 심은 kakaoId는 고유 1건이어도 서버 승계하지 않는다', async t => {
  const previous = process.env.KAKAO_AUTH_SALT;
  process.env.KAKAO_AUTH_SALT = 'kakao-forged-link-unit-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.KAKAO_AUTH_SALT;
    else process.env.KAKAO_AUTH_SALT = previous;
  });
  const auth = {
    async getUser(uid) {
      return { uid, email: 'attacker@example.com', disabled: false, providerData: [{ providerId: 'password' }] };
    }
  };
  await assert.rejects(
    issueFirebaseCustomToken({
      admin: { auth: () => auth },
      db: fakeDb('forged-firebase-uid', { kakaoId: '12345' }),
      kakaoId: '12345',
      email: 'victim@example.com',
      nickname: '피해 사용자'
    }),
    { code: 'KAKAO_LINK_REVIEW_REQUIRED' }
  );
});

test('Google provider 이메일 충돌은 Kakao verified email이 같아도 자동 승계하지 않는다', async t => {
  const previous = process.env.KAKAO_AUTH_SALT;
  process.env.KAKAO_AUTH_SALT = 'kakao-google-link-unit-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.KAKAO_AUTH_SALT;
    else process.env.KAKAO_AUTH_SALT = previous;
  });
  const auth = {
    async getUser(uid) {
      return { uid, email: 'same@example.com', disabled: false, providerData: [{ providerId: 'google.com' }] };
    }
  };
  await assert.rejects(
    issueFirebaseCustomToken({
      admin: { auth: () => auth },
      db: fakeDb('google-firebase-uid', { kakaoId: '12345' }),
      kakaoId: '12345',
      email: 'same@example.com',
      nickname: '사용자'
    }),
    { code: 'KAKAO_LINK_REVIEW_REQUIRED' }
  );
});

test('신규 Kakao 계정의 이메일이 기존 계정과 충돌해도 자동 병합하지 않는다', async t => {
  const previous = process.env.KAKAO_AUTH_SALT;
  process.env.KAKAO_AUTH_SALT = 'kakao-identity-new-user-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.KAKAO_AUTH_SALT;
    else process.env.KAKAO_AUTH_SALT = previous;
  });
  const created = [];
  const auth = {
    async getUser() { throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' }); },
    async createUser(payload) {
      created.push(payload);
      if (payload.email) throw Object.assign(new Error('collision'), { code: 'auth/email-already-exists' });
      return { uid: payload.uid };
    },
    async createCustomToken(uid) { return `token:${uid}`; }
  };
  const result = await issueFirebaseCustomToken({
    admin: { auth: () => auth },
    db: fakeDb(''),
    kakaoId: '12345',
    email: 'google-owner@example.com',
    nickname: '신규 사용자'
  });

  assert.equal(created.length, 2);
  assert.equal(created[0].email, 'google-owner@example.com');
  assert.equal(Object.hasOwn(created[1], 'email'), false);
  assert.equal(result.firebaseUid.startsWith('kakao:'), true);
  assert.equal(result.isNewUser, true);
});
