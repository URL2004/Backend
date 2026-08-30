'use strict';

const crypto = require('crypto');

// 운영에서는 기존 HMAC 용도의 서버 비밀을 재사용하되 메시지에 고정 도메인을
// 붙여 다른 지문과 상호 대입할 수 없게 한다. 로컬 누락 시에는 프로세스 수명
// 동안만 유지되는 무작위 키를 사용해 원 IP가 로그로 빠지는 상황을 피한다.
const PROCESS_LOCAL_SECRET = crypto.randomBytes(32);
const CLIENT_HASH_DOMAIN = 'gp-request-log-client:v1';

function serverLogSecret() {
  const configured = String(
    process.env.OPENAI_SAFETY_SALT
      || process.env.WRITING_LAB_CONTEXT_SECRET
      || ''
  ).trim();
  return configured || PROCESS_LOCAL_SECRET;
}

function clientHashForLog(value, secret = serverLogSecret()) {
  const client = String(value || '').trim();
  if (!client || client === 'unknown') return undefined;
  return `client_v1_${crypto.createHmac('sha256', secret)
    .update(CLIENT_HASH_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(client, 'utf8')
    .digest('hex')
    .slice(0, 24)}`;
}

function originHostnameForLog(value) {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    return hostname ? hostname.slice(0, 253) : undefined;
  } catch (_) {
    return undefined;
  }
}

module.exports = {
  clientHashForLog,
  originHostnameForLog
};
