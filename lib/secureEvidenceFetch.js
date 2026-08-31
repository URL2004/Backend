'use strict';

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const IPV4_BLOCKS = (() => {
  const list = new net.BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
    ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
  ]) list.addSubnet(network, prefix, 'ipv4');
  return list;
})();

const IPV6_BLOCKS = (() => {
  const list = new net.BlockList();
  for (const [network, prefix] of [
    ['::', 96], ['::ffff:0:0', 96],
    ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
    ['2001::', 23], ['2001:2::', 48], ['2001:db8::', 32],
    ['2002::', 16], ['3fff::', 20],
    ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
  ]) list.addSubnet(network, prefix, 'ipv6');
  return list;
})();

function isPrivateIp(address, family = net.isIP(address)) {
  const value = String(address || '').replace(/^\[|\]$/gu, '').toLowerCase();
  if (family === 4) {
    return !net.isIPv4(value) || IPV4_BLOCKS.check(value, 'ipv4');
  }
  if (family === 6) return IPV6_BLOCKS.check(value, 'ipv6');
  return true;
}

function validateEvidenceUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported_evidence_protocol');
  const expectedPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port && url.port !== expectedPort) throw new Error('unsafe_evidence_port');
  if (url.username || url.password) throw new Error('evidence_url_credentials_forbidden');
  const host = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('unsafe_evidence_host');
  }
  if (host === 'metadata.google.internal') throw new Error('unsafe_evidence_host');
  const family = net.isIP(host);
  if (family && isPrivateIp(host, family)) throw new Error('unsafe_evidence_ip');
  return { url, host, family };
}

async function resolvePublicTarget(value, options = {}) {
  const parsed = validateEvidenceUrl(value);
  if (parsed.family) return { ...parsed, address: parsed.host };
  const lookup = options.lookup || dns.lookup;
  const records = await lookup(parsed.host, { all: true, verbatim: true });
  const rows = Array.isArray(records) ? records : [records];
  if (!rows.length) throw new Error('evidence_dns_empty');
  const normalized = rows.map(row => ({
    address: String(row?.address || ''),
    family: Number(row?.family || net.isIP(row?.address))
  }));
  if (normalized.some(row => !row.family || isPrivateIp(row.address, row.family))) {
    throw new Error('unsafe_evidence_dns_answer');
  }
  return { ...parsed, address: normalized[0].address, family: normalized[0].family };
}

function createPinnedLookup(address, family) {
  return function pinnedLookup(_hostname, options, callback) {
    const opts = typeof options === 'object' && options ? options : {};
    const cb = typeof options === 'function' ? options : callback;
    if (opts.all === true) return cb(null, [{ address, family }]);
    return cb(null, address, family);
  };
}

function sameIpAddress(left, right, family = net.isIP(left)) {
  if (!family || family !== net.isIP(right)) return false;
  try {
    const exact = new net.BlockList();
    exact.addAddress(String(left), family === 6 ? 'ipv6' : 'ipv4');
    return exact.check(String(right), family === 6 ? 'ipv6' : 'ipv4');
  } catch (_) {
    return false;
  }
}

function verifyPinnedPeer(response, target) {
  const peerAddress = String(response?.socket?.remoteAddress || '').replace(/^\[|\]$/gu, '');
  const peerFamily = net.isIP(peerAddress);
  if (!peerFamily) throw new Error('evidence_peer_address_missing');
  if (isPrivateIp(peerAddress, peerFamily)) throw new Error('unsafe_evidence_peer_address');
  if (!sameIpAddress(target.address, peerAddress, target.family)) {
    throw new Error('evidence_peer_address_mismatch');
  }
  return peerAddress;
}

async function requestPinned(value, { method = 'HEAD', signal, lookup, requestImpl } = {}) {
  const target = await resolvePublicTarget(value, { lookup });
  const request = requestImpl || (target.url.protocol === 'https:' ? https.request : http.request);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    const onAbort = () => {
      req?.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    const finish = (fn, payload) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(payload);
    };
    const options = {
      protocol: target.url.protocol,
      hostname: target.host,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method,
      // 전역 Agent의 기존 소켓을 재사용하면 이번 DNS 검증·pin을 우회할 수 있다.
      // evidence 검증은 호출량이 작으므로 요청마다 새 연결을 사용한다.
      agent: false,
      lookup: createPinnedLookup(target.address, target.family),
      headers: {
        Host: target.url.host,
        ...(method === 'GET' ? { Range: 'bytes=0-2048' } : {})
      },
      ...(target.url.protocol === 'https:' ? {
        servername: target.host,
        rejectUnauthorized: true
      } : {})
    };
    req = request(options, response => {
      let peerAddress;
      try {
        // DNS resolution is pinned through `lookup`, then the connected peer is
        // checked once more. This closes proxy/agent mistakes and turns a DNS
        // rebinding regression into a hard failure before any response is used.
        peerAddress = verifyPinnedPeer(response, target);
      } catch (error) {
        response.destroy?.();
        finish(reject, error);
        return;
      }
      const headers = new Map(Object.entries(response.headers || {}).map(([key, item]) => [key.toLowerCase(), Array.isArray(item) ? item.join(', ') : String(item ?? '')]));
      const result = {
        status: Number(response.statusCode || 0),
        headers: { get: name => headers.get(String(name || '').toLowerCase()) || null },
        pinnedAddress: target.address,
        peerAddress,
        host: target.host
      };
      // 검증에는 상태·Location만 필요하다. Range를 무시하는 서버의 거대 본문을
      // 끝까지 소비하지 않고 헤더를 받은 즉시 연결을 닫는다.
      response.destroy?.();
      finish(resolve, result);
    });
    req.once('error', error => finish(reject, error));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

async function requestWithRedirects(value, {
  method = 'HEAD', signal, maxRedirects = 3, lookup, requestImpl
} = {}) {
  let current = String(value || '').trim();
  for (let index = 0; index <= maxRedirects; index += 1) {
    const response = await requestPinned(current, { method, signal, lookup, requestImpl });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (index >= maxRedirects) throw new Error('too_many_evidence_redirects');
    current = new URL(location, current).toString();
    // 다음 반복에서 redirect 목적지를 다시 DNS 검증하고 새 주소에 pin한다.
  }
  throw new Error('too_many_evidence_redirects');
}

module.exports = {
  createPinnedLookup,
  isPrivateIp,
  requestPinned,
  requestWithRedirects,
  resolvePublicTarget,
  sameIpAddress,
  verifyPinnedPeer,
  validateEvidenceUrl
};
