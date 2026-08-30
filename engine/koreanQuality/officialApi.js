'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { outboundFetch } = require('../../lib/outboundPolicy');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_PATH = path.join(ROOT, 'data', 'nikl-api-cache.json');
const VERSION = 'nikl-official-api-v2';
const CACHE_MAX_ENTRIES = 5000;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

let cache = null;
let saveTimer = null;
let saveInFlight = Promise.resolve();

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
  const fetched = await cachedFetchJson('stdict', query, url, {
    ...opts,
    validateJson: throwIfDictionaryError
  });
  const json = fetched.json;
  throwIfDictionaryError(json);
  const channel = json?.channel || {};
  const items = normalizeArray(channel.item).map(item => ({
    word: cleanHeadword(item.word),
    pos: clean(item.pos || firstSense(item)?.pos),
    type: clean(firstSense(item)?.type || item.type),
    cat: clean(firstSense(item)?.cat || item.cat)
  })).filter(item => item.word);
  return {
    source: 'stdict',
    total: Number(channel.total || 0) || items.length,
    items: items.slice(0, 5),
    cacheHit: fetched.cacheHit === true
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
  // 표기 보존용 조회는 규범정보(target=15)가 아니라 표제어(target=1)를
  // 기준으로 해야 한다. 규범정보 상세 조회는 검색 결과의 target_code가
  // 확보된 뒤 별도 단계에서만 수행한다.
  url.searchParams.set('target', '1');
  url.searchParams.set('method', 'exact');
  url.searchParams.set('num', '10');
  const fetched = await cachedFetchJson('opendict', query, url, {
    ...opts,
    validateJson: throwIfDictionaryError
  });
  const json = fetched.json;
  throwIfDictionaryError(json);
  const channel = json?.channel || {};
  const items = normalizeArray(channel.item).map(item => ({
    word: cleanHeadword(item.word),
    pos: clean(firstSense(item)?.pos || item.pos),
    type: clean(firstSense(item)?.type || item.type),
    targetCode: clean(firstSense(item)?.target_code || item.target_code),
    normInfo: compactNormInfo(firstSense(item)?.norm_info || item.norm_info)
  })).filter(item => item.word || item.normInfo.length);
  return {
    source: 'opendict',
    total: Number(channel.total || 0) || items.length,
    items: items.slice(0, 5),
    cacheHit: fetched.cacheHit === true
  };
}

async function lookupTerm(query, opts = {}) {
  const key = getApiKey('term');
  if (!key) return null;
  const url = new URL('https://kli.korean.go.kr/term/api/search.do');
  url.searchParams.set('key', key);
  url.searchParams.set('apiSearchWord', query);
  url.searchParams.set('start', '1');
  // 온용어 공식 허용 범위는 10~100이다.
  url.searchParams.set('num', '10');
  url.searchParams.set('sort', 'wt');
  const fetched = await cachedFetchJson('term', query, url, {
    ...opts,
    validateJson: throwIfTermError
  });
  const json = fetched.json;
  throwIfTermError(json);
  const channel = json?.channel || {};
  // 온용어 검색 응답은 channel.return_object[].resultlist[] 구조다.
  // 구형/예시 응답의 channel.item도 하위 호환으로 읽는다.
  const resultItems = normalizeArray(channel.return_object)
    .flatMap(group => normalizeArray(group?.resultlist));
  const rawItems = resultItems.length ? resultItems : normalizeArray(channel.item);
  const items = rawItems.map(item => ({
    word: cleanHeadword(item.word || item.wordinfo?.word),
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
    filteredNonCommercial: items.filter(item => item.licenseType && item.licenseType !== '1').length,
    cacheHit: fetched.cacheHit === true
  };
}

async function cachedFetchJson(provider, query, url, opts = {}) {
  if (opts.disableCache === true) {
    const json = await fetchJson(url, opts);
    validateFetchedJson(json, opts);
    return {
      json,
      cacheHit: false
    };
  }
  const requestedTtl = Number(opts.ttlMs || process.env.NIKL_API_CACHE_TTL_MS || CACHE_TTL_MS);
  const ttlMs = Number.isFinite(requestedTtl) && requestedTtl > 0
    ? Math.min(CACHE_TTL_MS, requestedTtl)
    : CACHE_TTL_MS;
  const now = Date.now();
  const store = opts.cacheStore || loadCache();
  if (!store.entries || typeof store.entries !== 'object') store.entries = {};
  const cacheKey = hashedCacheKey(provider, query);
  const hit = store.entries[cacheKey];
  if (hit && now - Number(hit.fetchedAtMs || 0) <= ttlMs) {
    try {
      validateFetchedJson(hit.json, opts);
      hit.accessedAtMs = now;
      return { json: hit.json, cacheHit: true };
    } catch {
      // 인증 오류 같은 HTTP 200 오류 응답을 이전 버전이 캐시했더라도
      // 재사용하지 않고 즉시 정상 응답을 다시 조회한다.
      delete store.entries[cacheKey];
    }
  }
  const json = await fetchJson(url, opts);
  validateFetchedJson(json, opts);
  store.entries[cacheKey] = {
    fetchedAtMs: now,
    accessedAtMs: now,
    provider,
    json
  };
  pruneCache(store, now, ttlMs);
  if (!opts.cacheStore) scheduleCacheSave(store);
  return { json, cacheHit: false };
}

function validateFetchedJson(json, opts = {}) {
  if (typeof opts.validateJson === 'function') opts.validateJson(json);
}

async function fetchJson(url, opts = {}) {
  const requestedTimeout = Number(opts.timeoutMs || process.env.NIKL_API_TIMEOUT_MS || 1200);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(100, Math.min(1200, requestedTimeout))
    : 1200;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('nikl_api_timeout')), timeoutMs);
  const signal = combineAbortSignals(controller.signal, opts.signal);
  try {
    const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
    const response = await outboundFetch('nikl', url, { signal }, fetchImpl);
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
  if (cache.version !== VERSION) cache = { version: VERSION, entries: {} };
  if (!cache.entries || typeof cache.entries !== 'object') cache.entries = {};
  // v1의 평문 질의 키는 재사용하지 않고 즉시 제거한다.
  cache.entries = Object.fromEntries(Object.entries(cache.entries).filter(([key]) => /^[a-f0-9]{64}$/u.test(key)));
  pruneCache(cache, Date.now(), CACHE_TTL_MS);
  return cache;
}

function scheduleCacheSave(store) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snapshot = JSON.parse(JSON.stringify(pruneCache(store, Date.now(), CACHE_TTL_MS)));
    saveInFlight = saveInFlight.then(() => persistCacheSnapshot(snapshot)).catch(() => {});
  }, 250);
  if (saveTimer.unref) saveTimer.unref();
}

async function persistCacheSnapshot(snapshot) {
  const tempPath = `${CACHE_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.promises.writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tempPath, CACHE_PATH);
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

function firstSense(item) {
  return normalizeArray(item?.sense)[0] || null;
}

function cleanHeadword(value) {
  return clean(value)
    .replace(/\^/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function throwIfDictionaryError(json) {
  const error = json?.error;
  if (!error) return;
  const code = clean(error.error_code || error.code || 'unknown');
  const err = new Error(`api_error_${code}`);
  err.code = `NIKL_API_${code}`;
  throw err;
}

function throwIfTermError(json) {
  throwIfDictionaryError(json);
  const groups = normalizeArray(json?.channel?.return_object);
  const failed = groups.find(group => {
    const code = String(group?.returnCode ?? '').trim();
    return code && code !== '1';
  });
  if (!failed) return;
  const code = clean(failed.returnCode || 'unknown');
  const err = new Error(`api_error_${code}`);
  err.code = `NIKL_API_${code}`;
  throw err;
}

function combineAbortSignals(internalSignal, externalSignal) {
  if (!externalSignal) return internalSignal;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([internalSignal, externalSignal]);
  }
  const combined = new AbortController();
  const forward = signal => {
    if (!combined.signal.aborted) combined.abort(signal.reason);
  };
  for (const source of [internalSignal, externalSignal]) {
    if (source.aborted) {
      forward(source);
      break;
    }
    source.addEventListener('abort', () => forward(source), { once: true });
  }
  return combined.signal;
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
  pruneCache,
  _test: {
    cleanHeadword,
    throwIfDictionaryError,
    throwIfTermError,
    firstSense
  }
};
