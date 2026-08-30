'use strict';

const SERVICE_HOSTS = Object.freeze({
  openai: new Set(['api.openai.com']),
  toss: new Set(['api.tosspayments.com']),
  kakao: new Set(['kapi.kakao.com']),
  meta: new Set(['graph.facebook.com']),
  discord: new Set(['discord.com', 'discordapp.com']),
  nikl: new Set(['stdict.korean.go.kr', 'opendict.korean.go.kr', 'kli.korean.go.kr'])
});

function forbidden(message) {
  return Object.assign(new Error(message), { code: 'OUTBOUND_DESTINATION_FORBIDDEN' });
}

function assertOutboundUrl(value, purpose) {
  const url = value instanceof URL ? value : new URL(String(value || ''));
  const name = String(purpose || '').trim().toLowerCase();
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
  if (url.username || url.password) throw forbidden('outbound_credentials_forbidden');
  if (name === 'internal_loopback') {
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(hostname)) {
      throw forbidden('outbound_destination_forbidden');
    }
    return url;
  }
  const hosts = SERVICE_HOSTS[name];
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || !hosts?.has(hostname)) {
    throw forbidden('outbound_destination_forbidden');
  }
  if (name === 'discord' && !url.pathname.startsWith('/api/webhooks/')) {
    throw forbidden('discord_webhook_path_forbidden');
  }
  return url;
}

async function outboundFetch(purpose, value, init, fetchImpl = globalThis.fetch) {
  const url = assertOutboundUrl(value, purpose);
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  // Provider API는 redirect가 필요하지 않다. 자동 follow를 허용하면 최초 host만
  // 검사한 뒤 307/308에서 인증 헤더·본문이 임의 host로 재전송될 수 있다.
  return await fetchImpl(url, { ...(init || {}), redirect: 'error' });
}

module.exports = { SERVICE_HOSTS, assertOutboundUrl, outboundFetch };
