'use strict';

const crypto = require('crypto');

const VERSION = 'nikl-lexical-advisor-v2';
const DEFAULT_LOOKUP_MAX = 2;
const DEFAULT_TIMEOUT_MS = 1200;

const LOCAL_PUBLIC_LANGUAGE_PROFILES = new Set([
  'general_essay',
  'long_explainer',
  'blog_review',
  'marketing_ad',
  'social_caption',
  'mail_notice'
]);

const EXTERNAL_EXCLUDED_PROFILES = new Set(['creative']);
const PROPER_NOUN_SUFFIX = /(?:대학교|대학원|학교|연구소|학회|협회|재단|공사|공단|주식회사|유한회사|병원|의원|유치원|어린이집|교육부|보건복지부|시청|군청|구청)$/u;
const PERSON_ROLE_SUFFIX = /(?:연구원|교수|교사|선생님|학생|대표|사장|이사|팀장|부장|과장|대리|담당자|지원자|작성자)$/u;
const SENSITIVE_SURFACE = /(?:https?:\/\/|www\.|@|\b\d{2,4}[.-]\d{1,2}[.-]\d{1,2}\b|\b\d{2,4}-\d{3,4}-\d{4}\b|\b\d{6}-?[1-4]\d{6}\b)/iu;
const ADDRESS_SURFACE = /(?:(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|특별자치도|도|시)?\s*[가-힣]{1,8}(?:시|군|구|읍|면|동|로|길)|[가-힣]{2,8}(?:시|군|구)\s+[가-힣]{1,8}(?:구|읍|면|동|로|길))/u;
const TECHNICAL_SUFFIX = /(?:시스템|설비|장비|기법|이론|모형|모델|분석|검사|시험|측정|측량|공정|프로토콜|프로파일|알고리즘|데이터|자료|회로|전원|센서|펌프|성적서|보고서|소프트웨어|하드웨어|펌웨어|인터페이스|플랫폼|인프라|정책|제도|교육|연구|관리|운영|구조|기능|설계|요구사항|사양|유량|유속|음압|착유)$/u;
const TECHNICAL_PHRASE = /[가-힣]{2,}[ \t]*(?:시스템|설비|장비|기법|이론|모형|모델|분석|검사|시험|측정|측량|공정|프로토콜|프로파일|알고리즘|데이터|자료|회로|전원|센서|펌프|성적서|보고서|소프트웨어|하드웨어|펌웨어|인터페이스|플랫폼|인프라|정책|제도|교육|연구|관리|운영|구조|기능|설계|요구사항|사양|유량|유속|음압|착유)/gu;

async function prepareDocumentAdvisor({
  text,
  protectedTerms = [],
  documentProfile = null,
  requestStrength = '',
  includeLocal = true,
  env = process.env,
  api = null,
  resources = null,
  signal = null
} = {}) {
  const source = String(text || '');
  const profile = profileName(documentProfile);
  const localEnabled = includeLocal !== false
    && String(requestStrength || '').trim().toLowerCase() !== 'polish'
    && String(env.GPT_NIKL_LOCAL_RESOURCE_ENABLED || '1').trim() !== '0'
    && LOCAL_PUBLIC_LANGUAGE_PROFILES.has(profile);
  const externalRequested = String(env.GPT_NIKL_EXTERNAL_API_ENABLED || '1').trim() === '1'
    && !EXTERNAL_EXCLUDED_PROFILES.has(profile);
  const context = {
    version: VERSION,
    profile,
    localEntries: [],
    externalEntries: [],
    appliedLocalIds: new Set(),
    appliedExternalIds: new Set(),
    meta: {
      version: VERSION,
      localResourceEnabled: localEnabled,
      localResourceApplied: false,
      localCandidateCount: 0,
      localErrorCount: 0,
      externalApiEnabled: false,
      externalProviderCount: 0,
      externalCandidateCount: 0,
      externalLookupCount: 0,
      externalHitCount: 0,
      externalCacheHitCount: 0,
      externalErrorCount: 0,
      externalTimeoutCount: 0
    }
  };

  if (localEnabled && source) {
    try {
      const officialResources = resources || loadOfficialResources();
      const analysis = officialResources?.analyzeOfficialQuality(source, {
        maxPublicMatches: 8,
        maxPatterns: 0
      });
      context.localEntries = compactLocalEntries(analysis?.publicLanguageMatches || []);
      context.meta.localCandidateCount = context.localEntries.length;
    } catch {
      context.meta.localErrorCount += 1;
    }
  }

  if (!externalRequested || !source || signal?.aborted) return context;

  try {
    const client = api || loadOfficialApi();
    if (!client) return context;
    const providers = selectedProviders(client.getApiStatus(), env);
    context.meta.externalProviderCount = providers.length;
    if (!providers.length) return context;
    context.meta.externalApiEnabled = true;

    const max = clampInteger(env.GPT_NIKL_API_LOOKUP_MAX, 0, 2, DEFAULT_LOOKUP_MAX);
    const candidates = selectCandidates(source, protectedTerms, { max });
    context.meta.externalCandidateCount = candidates.length;
    if (!candidates.length) return context;

    const timeoutMs = clampInteger(env.NIKL_API_TIMEOUT_MS, 500, 1200, DEFAULT_TIMEOUT_MS);
    const settled = await Promise.allSettled(candidates.map(candidate =>
      client.lookupCandidate(candidate.value, { providers, timeoutMs, signal })
    ));
    context.meta.externalLookupCount = settled.length;
    settled.forEach((item, index) => {
      if (item.status !== 'fulfilled') {
        context.meta.externalErrorCount += 1;
        if (isTimeoutError(item.reason)) context.meta.externalTimeoutCount += 1;
        return;
      }
      const lookup = item.value;
      context.meta.externalErrorCount += Array.isArray(lookup?.warnings) ? lookup.warnings.length : 0;
      context.meta.externalTimeoutCount += (lookup?.warnings || []).filter(isTimeoutError).length;
      if (!hasLookupHit(lookup)) return;
      const entry = compactExternalEntry(candidates[index], lookup);
      if (!entry) return;
      context.externalEntries.push(entry);
      context.meta.externalHitCount += 1;
      context.meta.externalCacheHitCount += Object.values(lookup.providers || {})
        .filter(provider => provider?.cacheHit === true).length;
    });
  } catch (error) {
    context.meta.externalErrorCount += 1;
    if (isTimeoutError(error)) context.meta.externalTimeoutCount += 1;
  }
  return context;
}

function buildPromptHints(context, chunkText) {
  if (!context) return '';
  const chunk = String(chunkText || '');
  const local = (context.localEntries || []).filter(entry =>
    (entry.surfaces || [entry.term]).some(surface => occursInChunk(chunk, surface))
  );
  const external = (context.externalEntries || []).filter(entry => occursInChunk(chunk, entry.query));
  const blocks = [];

  if (local.length) {
    const lines = [
      '[국립국어원 공개 자료 보조]',
      '공공언어의 쉬운 말 후보다. 일반 독자용 문맥에서만 참고하고, 전문 용어·고유명·제품명·인용문은 원문 표기를 유지한다.',
      '후보를 기계적으로 치환하거나 문장의 의미·격식을 낮추지 않는다.'
    ];
    for (const entry of local.slice(0, 3)) {
      context.appliedLocalIds.add(entry.id);
      const alternatives = entry.alternatives.slice(0, 3).join(', ');
      lines.push(`- "${entry.term}"${alternatives ? `: 쉬운 말 후보 ${alternatives}` : ''}`);
    }
    blocks.push(lines.join('\n'));
  }

  if (external.length) {
    const lines = [
      '[국립국어원 사전 표기 보조]',
      '표준국어대사전·우리말샘·온용어의 표제어 조회 결과다. 정의문을 복사하지 말고 용어 표기 보존과 어색한 치환 방지에만 사용한다.',
      '사전 조회 결과는 문맥의 의미·사용자 역할·전문 분야 표기보다 우선하지 않는다.'
    ];
    for (const entry of external.slice(0, 2)) {
      context.appliedExternalIds.add(entry.id);
      const words = entry.words.slice(0, 4).join(', ');
      lines.push(`- "${entry.query}": ${entry.sources.join('/')} 조회됨${words ? `, 표기 후보 ${words}` : ''}`);
    }
    blocks.push(lines.join('\n'));
  }

  context.meta.localResourceApplied = context.appliedLocalIds.size > 0;
  return blocks.join('\n\n');
}

function compactMeta(context) {
  const meta = context?.meta || {};
  return {
    version: meta.version || VERSION,
    localResourceEnabled: meta.localResourceEnabled === true,
    localResourceApplied: context?.appliedLocalIds?.size > 0,
    localCandidateCount: Number(meta.localCandidateCount || 0),
    localAppliedCount: Number(context?.appliedLocalIds?.size || 0),
    localErrorCount: Number(meta.localErrorCount || 0),
    externalApiEnabled: meta.externalApiEnabled === true,
    externalProviderCount: Number(meta.externalProviderCount || 0),
    externalCandidateCount: Number(meta.externalCandidateCount || 0),
    externalLookupCount: Number(meta.externalLookupCount || 0),
    externalHitCount: Number(meta.externalHitCount || 0),
    externalAppliedCount: Number(context?.appliedExternalIds?.size || 0),
    externalCacheHitCount: Number(meta.externalCacheHitCount || 0),
    externalErrorCount: Number(meta.externalErrorCount || 0),
    externalTimeoutCount: Number(meta.externalTimeoutCount || 0)
  };
}

function selectCandidates(text, protectedTerms = [], opts = {}) {
  const source = String(text || '');
  const max = clampInteger(opts.max, 0, 2, DEFAULT_LOOKUP_MAX);
  if (!source || max <= 0) return [];
  const ranked = new Map();
  const add = (raw, origin, score) => {
    const value = normalizeCandidate(raw);
    if (!isSafeCandidate(value, source)) return;
    const key = normalizeForMatch(value);
    const current = ranked.get(key);
    if (!current || score > current.score) ranked.set(key, { value, origin, score });
  };

  for (const term of protectedTerms || []) add(term, 'protected_term', 3);
  for (const match of source.matchAll(TECHNICAL_PHRASE)) add(match[0], 'technical_phrase', 2);

  return [...ranked.values()]
    .sort((a, b) => b.score - a.score || a.value.length - b.value.length || a.value.localeCompare(b.value))
    .slice(0, max);
}

function isSafeCandidate(value, source = '') {
  if (!value || value.length < 4 || value.length > 28) return false;
  if (SENSITIVE_SURFACE.test(value) || ADDRESS_SURFACE.test(value)) return false;
  if (!/^[가-힣]+(?:[ ·-][가-힣]+){0,3}$/u.test(value)) return false;
  if (value.split(/\s+/u).filter(Boolean).length > 2) return false;
  if (PROPER_NOUN_SUFFIX.test(value)) return false;
  if (PERSON_ROLE_SUFFIX.test(value)) return false;
  if (isInsideQuote(source, value)) return false;
  if (!/[ ·-]/u.test(value) && !TECHNICAL_SUFFIX.test(value)) return false;
  return true;
}

function compactLocalEntries(matches) {
  const out = [];
  const seen = new Set();
  for (const match of matches || []) {
    const term = normalizeCandidate(match?.term);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push({
      id: digest(`local\0${term}`),
      term,
      surfaces: [...new Set([
        term,
        ...(match.samples || []).map(normalizeCandidate)
      ].filter(Boolean))].slice(0, 4),
      alternatives: (match.alternatives || [])
        .map(normalizeCandidate)
        .filter(Boolean)
        .slice(0, 3)
    });
    if (out.length >= 6) break;
  }
  return out;
}

function compactExternalEntry(candidate, lookup) {
  if (!candidate || !lookup) return null;
  const sources = [];
  const words = new Set();
  for (const [providerName, provider] of Object.entries(lookup.providers || {})) {
    if (!Array.isArray(provider?.items) || !provider.items.length) continue;
    sources.push(providerLabel(providerName));
    for (const item of provider.items) {
      const word = normalizeCandidate(item?.word);
      if (word) words.add(word);
    }
  }
  if (!sources.length) return null;
  return {
    id: digest(`external\0${candidate.value}`),
    query: candidate.value,
    sources: [...new Set(sources)].slice(0, 3),
    words: [...words].slice(0, 5)
  };
}

function selectedProviders(status, env = process.env) {
  const keys = status?.keys || {};
  const requested = String(env.GPT_NIKL_API_PROVIDERS || 'opendict,stdict,term')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(requested)]
    .filter(provider => ['opendict', 'stdict', 'term'].includes(provider) && keys[provider]);
}

function hasLookupHit(lookup) {
  return Object.values(lookup?.providers || {}).some(provider =>
    (Array.isArray(provider?.items) && provider.items.length > 0)
      || Number(provider?.total || 0) > 0
  );
}

function profileName(documentProfile) {
  return String(
    typeof documentProfile === 'string'
      ? documentProfile
      : documentProfile?.profile || 'unknown'
  ).trim().toLowerCase() || 'unknown';
}

function normalizeCandidate(value) {
  return String(value || '')
    .replace(/\^/gu, ' ')
    .replace(/[^\uAC00-\uD7A3 ·-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeForMatch(value) {
  return normalizeCandidate(value).replace(/[ ·-]/gu, '').toLowerCase();
}

function occursInChunk(chunk, value) {
  const needle = normalizeForMatch(value);
  return Boolean(needle) && normalizeForMatch(chunk).includes(needle);
}

function isInsideQuote(source, value) {
  const escaped = escapeRegExp(String(value || '').trim());
  if (!escaped) return false;
  const patterns = [
    new RegExp(`[“"][^”"\\r\\n]{0,80}${escaped}[^”"\\r\\n]{0,80}[”"]`, 'u'),
    new RegExp(`[‘'][^’'\\r\\n]{0,80}${escaped}[^’'\\r\\n]{0,80}[’']`, 'u'),
    new RegExp(`「[^」\\r\\n]{0,80}${escaped}[^」\\r\\n]{0,80}」`, 'u'),
    new RegExp(`『[^』\\r\\n]{0,80}${escaped}[^』\\r\\n]{0,80}』`, 'u'),
    new RegExp(`《[^》\\r\\n]{0,80}${escaped}[^》\\r\\n]{0,80}》`, 'u'),
    new RegExp(`〈[^〉\\r\\n]{0,80}${escaped}[^〉\\r\\n]{0,80}〉`, 'u')
  ];
  return patterns.some(pattern => pattern.test(String(source || '')));
}

function providerLabel(provider) {
  if (provider === 'opendict') return '우리말샘';
  if (provider === 'stdict') return '표준국어대사전';
  if (provider === 'term') return '온용어';
  return '국립국어원';
}

function isTimeoutError(error) {
  const value = String(error?.message || error || '').toLowerCase();
  return value.includes('timeout') || value.includes('abort');
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function loadOfficialApi() {
  return module.require(['..', 'engine', 'koreanQuality', 'officialApi'].join('/'));
}

function loadOfficialResources() {
  return module.require(['..', 'engine', 'koreanQuality', 'officialResources'].join('/'));
}

module.exports = {
  VERSION,
  prepareDocumentAdvisor,
  buildPromptHints,
  compactMeta,
  selectCandidates,
  selectedProviders,
  isSafeCandidate,
  normalizeCandidate,
  hasLookupHit
};
