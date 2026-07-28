const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('Firebase ID tokens use the shared revoked-token and password-provider boundary', () => {
  const config = read('config.js');
  assert.match(config, /verifyIdToken\(idToken,\s*true\)/);
  assert.match(config, /ALLOW_LEGACY_FIREBASE_PASSWORD_AUTH\s*!==\s*['"]1['"]/);
  assert.match(config, /sign_in_provider\s*===\s*['"]password['"]/);

  const kakaoRoute = read(path.join('routes', 'kakaoLogin.js'));
  assert.match(kakaoRoute, /KAKAO_LEGACY_LOGIN_ENABLED\s*!==\s*['"]1['"]/);
});

test('routes do not bypass the shared Firebase ID token verifier', () => {
  const routeFiles = fs.readdirSync(path.join(root, 'routes'))
    .filter(name => name.endsWith('.js'));
  const bypasses = routeFiles.filter(name =>
    /admin\.auth\(\)\.verifyIdToken\(/.test(read(path.join('routes', name)))
  );
  assert.deepEqual(bypasses, []);
});
