// [tools/_test-reqtoken.js] A2 — bearerToken(req) 헤더 우선·폴백·deprecation 로그 검증
const assert = require('assert');
const { logger } = require('../lib/logger');
const { bearerToken } = require('../lib/reqtoken');

let warns = [];
const origWarn = logger.warn;
logger.warn = (event, fields) => { warns.push({ event, fields }); };

function req({ header, body, query, path = '/x' } = {}) {
  return {
    get: (h) => (String(h).toLowerCase() === 'authorization' ? header : undefined),
    headers: header ? { authorization: header } : {},
    body, query, path
  };
}
let pass = 0, fail = 0;
function t(name, fn) { try { warns = []; fn(); pass++; console.log('  ✅', name); } catch (e) { fail++; console.log('  ❌', name, '\n      ', e.message); } }

t('헤더 Bearer 우선 — body 있어도 헤더 사용, 경고 없음', () => {
  const r = req({ header: 'Bearer HEADERTOK', body: { idToken: 'BODYTOK' } });
  assert.strictEqual(bearerToken(r), 'HEADERTOK');
  assert.strictEqual(warns.length, 0, '헤더 사용 시 경고가 나면 안 됨');
});
t('헤더 없으면 body 폴백 + warn(via:body)', () => {
  const r = req({ body: { idToken: 'BODYTOK' } });
  assert.strictEqual(bearerToken(r), 'BODYTOK');
  assert.strictEqual(warns.length, 1);
  assert.strictEqual(warns[0].event, 'auth.idtoken_in_body_deprecated');
  assert.strictEqual(warns[0].fields.via, 'body');
});
t('header·body 없으면 query 폴백 + warn(via:query)', () => {
  const r = req({ query: { idToken: 'QTOK' } });
  assert.strictEqual(bearerToken(r), 'QTOK');
  assert.strictEqual(warns[0].fields.via, 'query');
});
t('아무것도 없으면 빈 문자열·무경고', () => {
  assert.strictEqual(bearerToken(req()), '');
  assert.strictEqual(warns.length, 0);
});
t('Bearer 대소문자·다중공백 허용', () => {
  assert.strictEqual(bearerToken(req({ header: 'bearer   TOK2' })), 'TOK2');
});
t('req.get 없는 목(headers만)도 동작', () => {
  assert.strictEqual(bearerToken({ headers: { authorization: 'Bearer H' }, path: '/x' }), 'H');
});
t('null/undefined req도 안전', () => {
  assert.strictEqual(bearerToken(null), '');
  assert.strictEqual(bearerToken(undefined), '');
});

logger.warn = origWarn;
console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'} (pass ${pass} / fail ${fail})`);
process.exit(fail === 0 ? 0 : 1);
