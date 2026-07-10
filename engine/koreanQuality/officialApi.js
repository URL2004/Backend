'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_PATH = path.join(ROOT, 'data', 'nikl-api-cache.json');
const VERSION = 'nikl-official-api-v1';
const CACHE_MAX_ENTRIES = 5000;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

let cache = null;

function getApiKey(provider) {
  const aliases = {
    stdict: ['NIKL_STDICT_API_KEY', 'STDICT_API_KEY', 'STANDARD_KOREAN_DICT_API_KEY', '표준국어대사전'],
    opendict: ['NIKL_OPENDICT_API_KEY', 'OPENDICT_API_KEY', 'WOORIMALSAEM_API_KEY', '우리말샘'],
    term: ['NIKL_TERM_API_KEY', 'TERM_API_KEY', 'KOREAN_TERM_API_KEY', '온용어 API', '온용어']
  }[provider] || [];
  for (const key of aliases) {
    const value = process.env[key] || readLooseEnv(key);
    if (value) return value;
  }
  return '';
}

function getApiStatus() {
  return {
    version: VERSION,
    keys: {
      stdict: Boolean(getApiKey('stdict')),
      opendict: Boolean(getApiKey('opendict')),
      term: Boolean(getApiKey('term'))
    },
    cachePath: CACHE_PATH
  };
}

async function lookupCandidate(candidate, opts = {}) {
  const query = normalizeQuery(candidate);
  if (!query) return null;
  const providers = uniqueProviders(opts.providers || ['opendict', 'stdict', 'term']);
  const out = { query, providers: {}, warnings: [] };
  const settled = await Promise.allSettled(providers.map(async provider => {
    try {
      return {
        provider,
        result: await lookupProvider(provider, query, opts)
      };
    } catch (err) {
      throw new Error(`${provider}:${err.message || String(err)}`);
    }
  }));
  for (const item of settled) {
    if (item.status === 'fulfilled') {
      if (item.value.result) out.providers[item.value.provider] = item.value.result;
    } else {
      out.warnings.push(item.reason?.message || String(item.reason));
    }
  }
  return out;
}

function uniqueProviders(providers) {
  const out = [];
  const seen = new Set();
  for (const provider of providers || []) {
    const p = String(provider || '').trim().toLowerCase();
    if (!['opendict', 'stdict', 'term'].includes(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

async function lookupProvider(provider, query, opts = {}) {
  if (provider === 'stdict') return lookupStdDict(query, opts);
  if (provider === 'opendict') return lookupOpenDict(query, opts);
  if (provider === 'term') return lookupTerm(query, opts);
  return null;
}

async function lookupStdDict(query, opts = {}) {
  const key = getApiKey('stdict');
  if (!key) return null;
  const url = new URL('https://stdict.korean.go.kr/api/search.do');
  url.searchParams.set('key', key);
  url.searchParams.set('q', query);
  url.searchParams.set('req_type', 'json');
  url.searchParams.set('advanced', 'y');
  url.searchParams.set('target', '1');
  url.searchParams.set('method', 'exact');
  url.searchParams.set('num', '10');
  const json = await cachedFetchJson('stdict', query, url, opts);
  const channel = json?.channel || {};
  const items = normalizeArray(channel.item).map(item => ({
    word: clean(item.word),
    pos: clean(item.pos),
    type: clean(item.sense?.type || item.type),
    cat: clean(item.sense?.cat || item.cat)
  })).filter(item => item.word);
  return {
    source: 'stdict',
    total: Number(channel.total || 0) || items.length,
    items: items.slice(0, 5)
  };
}

async function lookupOpenDict(query, opts = {}) {
  const key = getApiKey('opendict');
  if (!key) return null;
  const url = new URL('https://opendict.korean.go.kr/api/search');
  url.searchParams.set('key', key);
  url.searchParams.set('q', query);
  url.searchParams.set('req_type', 'json');
  url.searchParams.set('advanced', 'y');
  url.searchParams.set('target', '15');
  url.searchParams.set('method', 'include');
  url.searchParams.set('norm', '0');
  url.searchParams.set('num', '10');
  const json = await cachedFetchJson('opendict', query, url, opts);
  const channel = json?.channel || {};
  const items = normalizeArray(channel.item).map(item => ({
    word: clean(item.word),
    pos: clean(item.sense?.pos || item.pos),
    type: clean(item.sense?.type || item.type),
    normInfo: compactNormInfo(item.sense?.norm_info || item.norm_info)
  })).filter(item => item.word || item.normInfo.length);
  return {
    source: 'opendict',
    total: Number(channel.total || 0) || items.length,
    items: items.slice(0, 5)
  };
}

async function lookupTerm(query, opts = {}) {
  const key = getApiKey('term');
  if (!key) return null;
  const url = new URL('https://kli.korean.go.kr/term/api/search.do');
  url.searchParams.set('key', key);
  url.searchParams.set('apiSearchWord', query);
  url.searchParams.set('start', '1');
  url.searchParams.set('num', '5');
  url.searchParams.set('sort', 'wt');
  const json = await cachedFetchJson('term', query, url, opts);
  const channel = json?.channel || {};
  const items = normalizeArray(channel.item).map(item => ({
    word: clean(item.word || item.wordinfo?.word),
    categoryMain: clean(item.category_main),
    categorySub: clean(item.category_sub),
    glossary: clean(item.glossary),
    source: clean(item.source),
    licenseType: clean(item.kr_gvrn_lcns_ty),
    usableCommercially: String(item.kr_gvrn_lcns_ty || '').trim() === '1'
  })).filter(item => item.word);
  return {
    source: 'term',
    total: Number(channel.total || 0) || items.length,
    items: items.filter(item => item.usableCommercially).slice(0, 5),
    filteredNonCommercial: items.filter(item => item.licenseType && item.licenseType !== '1').length
  };
}

async function cachedFetchJson(provider, query, url, opts = {}) {
  const requestedTtl = Number(opts.ttlMs || process.env.NIKL_API_CACHE_TTL_MS || CACHE_TTL_MS);
  const ttlMs = Number.isFinite(requestedTtl) && requestedTtl > 0
    ? Math.min(CACHE_TTL_MS, requestedTtl)
    : CACHE_TTL_MS;
  const now = Date.now();
  const store = loadCache();
  const cacheKey = hashedCacheKey(provider, query);
  const hit = store.entries[cacheKey];
  if (hit && now - Number(hit.fetchedAtMs || 0) <= ttlMs) {
    hit.accessedAtMs = now;
    return hit.json;
  }
  const json = await fetchJson(url, opts);
  store.entries[cacheKey] = {
    fetchedAtMs: now,
    accessedAtMs: now,
    provider,
    json
  };
  pruneCache(store, now, ttlMs);
  saveCache(store);
  return json;
}

async function fetchJson(url, opts = {}) {
  const requestedTimeout = Number(opts.timeoutMs || process.env.NIKL_API_TIMEOUT_MS || 1200);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(100, Math.min(1200, requestedTimeout))
    : 1200;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`http_${response.status}`);
    try {
      if (!text.trim()) throw new Error('empty_response');
      return JSON.parse(text);
    } catch {
      throw new Error('invalid_json');
    }
  } finally {
    clearTimeout(timer);
  }
}

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    cache = { version: VERSION, entries: {} };
  }
  if (!cache.entries || typeof cache.entries !== 'object') cache.entries = {};
  // v1의 평문 질의 키는 재사용하지 않고 즉시 제거한다.
  cache.entries = Object.fromEntries(Object.entries(cache.entries).filter(([key]) => /^[a-f0-9]{64}$/u.test(key)));
  pruneCache(cache, Date.now(), CACHE_TTL_MS);
  return cache;
}

function saveCache(store) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    pruneCache(store, Date.now(), CACHE_TTL_MS);
    const tempPath = `${CACHE_PATH}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, CACHE_PATH);
  } catch {}
}

function hashedCacheKey(provider, query) {
  return crypto.createHash('sha256').update(`${provider}\0${normalizeQuery(query)}`, 'utf8').digest('hex');
}

function pruneCache(store, now = Date.now(), ttlMs = CACHE_TTL_MS) {
  const entries = Object.entries(store.entries || {})
    .filter(([, item]) => now - Number(item?.fetchedAtMs || 0) <= ttlMs)
    .sort((a, b) => Number(b[1]?.accessedAtMs || b[1]?.fetchedAtMs || 0) - Number(a[1]?.accessedAtMs || a[1]?.fetchedAtMs || 0))
    .slice(0, CACHE_MAX_ENTRIES);
  store.entries = Object.fromEntries(entries);
  store.version = VERSION;
  return store;
}

function readLooseEnv(name) {
  try {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return '';
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const key = trimmed.slice(0, trimmed.indexOf('=')).trim();
      if (key !== name) continue;
      return trimmed.slice(trimmed.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  return '';
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function compactNormInfo(value) {
  return normalizeArray(value).map(item => ({
    type: clean(item.type),
    role: clean(item.role),
    desc: clean(item.desc).slice(0, 140)
  })).filter(item => item.type || item.role || item.desc).slice(0, 5);
}

function normalizeQuery(value) {
  return String(value || '')
    .replace(/[^\u3131-\uD7A3A-Za-z0-9·\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

module.exports = {
  VERSION,
  getApiKey,
  getApiStatus,
  lookupCandidate,
  lookupProvider,
  lookupStdDict,
  lookupOpenDict,
  lookupTerm,
  hashedCacheKey,
  pruneCache
};
