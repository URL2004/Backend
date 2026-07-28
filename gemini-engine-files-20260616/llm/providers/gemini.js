// llm/providers/gemini.js - Gemini REST provider for local routing experiments.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const MODELS = {
  PRO: 'gemini-3.1-pro-preview',
  FLASH: 'gemini-3.5-flash',
  LITE: 'gemini-3.1-flash-lite'
};

const systemCache = new Map();
let cacheIndexMemo = null;

function apiKey() {
  return (process.env.GEMINI_API_KEY || '').trim();
}

function modelResourceName(model) {
  return String(model || '').startsWith('models/') ? model : `models/${model}`;
}

function cacheKey(model, system) {
  return `${model}:${crypto.createHash('sha256').update(system || '').digest('hex')}`;
}

function cacheDigest(system) {
  return crypto.createHash('sha256').update(system || '').digest('hex');
}

function explicitCacheEnabled() {
  return process.env.GEMINI_EXPLICIT_CACHE === '1';
}

function cacheStrictEnabled() {
  return process.env.GEMINI_CACHE_STRICT === '1';
}

function cacheTtl() {
  const ttl = (process.env.GEMINI_CACHE_TTL || '3600s').trim();
  return /^\d+s$/.test(ttl) ? ttl : '3600s';
}

function cacheMinChars() {
  const n = Number(process.env.GEMINI_EXPLICIT_CACHE_MIN_CHARS);
  return Number.isFinite(n) ? n : 6000;
}

function unsafeSystemCacheReason(system) {
  const s = String(system || '');
  if (!s) return 'empty';
  const unsafeMarkers = [
    /\[사용자 실제 경험 메모/i,
    /\[USER'S REAL EXPERIENCE NOTES/i,
    /\[검증된 참고 사실/i,
    /\[VERIFIED REFERENCE FACTS/i,
    /빠진\s*사실\s*:/i
  ];
  return unsafeMarkers.some(re => re.test(s)) ? 'dynamic_user_material' : '';
}

function cachePersistEnabled() {
  return process.env.GEMINI_CACHE_PERSIST !== '0';
}

function cacheIndexPath() {
  const configured = (process.env.GEMINI_CACHE_INDEX_FILE || '').trim();
  if (configured) return path.resolve(configured);
  return path.resolve(__dirname, '..', '..', 'results', 'gemini-local-runs', 'gemini-cache-index.json');
}

function readCacheIndex() {
  if (!cachePersistEnabled()) return {};
  if (cacheIndexMemo) return cacheIndexMemo;
  try {
    const file = cacheIndexPath();
    if (!fs.existsSync(file)) {
      cacheIndexMemo = {};
      return cacheIndexMemo;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    cacheIndexMemo = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cacheIndexMemo = {};
  }
  return cacheIndexMemo;
}

function writeCacheIndex(index) {
  if (!cachePersistEnabled()) return;
  cacheIndexMemo = index && typeof index === 'object' ? index : {};
  try {
    const file = cacheIndexPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cacheIndexMemo, null, 2), 'utf8');
  } catch {
    // Cache persistence is an optimization. Generation must not fail because the index file failed.
  }
}

function persistedCache(id) {
  const index = readCacheIndex();
  const entry = index[id];
  if (!entry?.name || !entry.expiresAt) return null;
  if (Date.parse(entry.expiresAt) <= Date.now() + 30_000) {
    delete index[id];
    writeCacheIndex(index);
    return null;
  }
  return {
    name: entry.name,
    tokenCount: entry.tokenCount || 0,
    expiresAt: Date.parse(entry.expiresAt),
    keyHash: entry.keyHash || null
  };
}

function persistCache(id, entry) {
  if (!entry?.name) return;
  const index = readCacheIndex();
  index[id] = {
    name: entry.name,
    model: entry.model,
    keyHash: entry.keyHash,
    tokenCount: entry.tokenCount || 0,
    createdAt: entry.createdAt || new Date().toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    ttl: entry.ttl
  };
  writeCacheIndex(index);
}

function usageTokenCount(u) {
  return u?.totalTokenCount || u?.total_token_count || u?.promptTokenCount || 0;
}

function jsonEnv(name) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function safetySettingsFromEnv() {
  const parsed = jsonEnv('GEMINI_SAFETY_SETTINGS');
  return Array.isArray(parsed) ? parsed : null;
}

async function ensureSystemCache({ model, system, signal }) {
  if (!explicitCacheEnabled() || !system) return null;
  if (unsafeSystemCacheReason(system)) return null;
  if (String(system).replace(/\s+/g, '').length < cacheMinChars()) return null;

  const key = apiKey();
  if (!key) throw new Error('GEMINI_API_KEY is not configured');

  const id = cacheKey(model, system);
  const keyHash = cacheDigest(system);
  const cached = systemCache.get(id);
  if (cached && cached.expiresAt > Date.now() + 30_000) return { ...cached, created: false, source: 'memory', keyHash };

  const persisted = persistedCache(id);
  if (persisted) {
    const entry = { ...persisted, keyHash };
    systemCache.set(id, entry);
    return { ...entry, created: false, source: 'disk' };
  }

  const ttl = cacheTtl();
  const seconds = Number(ttl.replace(/s$/, '')) || 3600;
  const url = `${API_BASE}/cachedContents?key=${encodeURIComponent(key)}`;
  const body = {
    model: modelResourceName(model),
    displayName: `danggeun-gemini-system-${String(model).replace(/[^a-zA-Z0-9_-]/g, '-')}-${keyHash.slice(0, 12)}`,
    systemInstruction: { parts: [{ text: system }] },
    ttl
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const e = await res.json(); msg = e?.error?.message || msg; } catch {}
    throw new Error(`Gemini cache ${res.status}: ${msg}`);
  }
  const data = await res.json();
  if (!data?.name) return null;
  const entry = {
    name: data.name,
    model,
    keyHash,
    tokenCount: usageTokenCount(data.usageMetadata || data.usage_metadata || {}),
    expiresAt: Date.now() + seconds * 1000,
    ttl,
    createdAt: new Date().toISOString()
  };
  systemCache.set(id, entry);
  persistCache(id, entry);
  return { ...entry, created: true, source: 'api' };
}

function sanitizeSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (
      key === 'additionalProperties' ||
      key === '$schema' ||
      key === 'default' ||
      key === 'description' ||
      key === 'title' ||
      key === 'examples' ||
      key === 'minimum' ||
      key === 'maximum' ||
      key === 'minLength' ||
      key === 'maxLength'
    ) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(value)) out.properties[pk] = sanitizeSchema(pv, depth + 1);
      continue;
    }
    if (key === 'items') {
      out.items = sanitizeSchema(value, depth + 1);
      continue;
    }
    if (Array.isArray(value)) out[key] = value;
    else if (value && typeof value === 'object') out[key] = sanitizeSchema(value, depth + 1);
    else out[key] = value;
  }
  return out;
}

function attachJsonResponseFormat(generationConfig, responseSchema) {
  const schema = sanitizeSchema(responseSchema);
  generationConfig.responseFormat = {
    text: {
      mimeType: 'application/json',
      ...(schema ? { schema } : {})
    }
  };
}

function attachLegacyJsonResponseFormat(generationConfig, responseSchema) {
  const schema = sanitizeSchema(responseSchema);
  delete generationConfig.responseFormat;
  generationConfig.responseMimeType = 'application/json';
  if (schema) generationConfig.responseSchema = schema;
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
  if (tool.googleSearch !== undefined) return { google_search: tool.googleSearch || {} };
  if (tool.google_search !== undefined) return { google_search: tool.google_search || {} };
  if (tool.urlContext !== undefined) return { url_context: tool.urlContext || {} };
  if (tool.url_context !== undefined) return { url_context: tool.url_context || {} };
  return tool;
}

function normalizeTools(tools) {
  return Array.isArray(tools) ? tools.map(normalizeTool).filter(Boolean) : [];
}

async function postGenerate(url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (res.ok) return { ok: true, data: await res.json() };
  let msg = res.statusText;
  try { const e = await res.json(); msg = e?.error?.message || msg; } catch {}
  return { ok: false, status: res.status, message: msg };
}

function canRetryLegacySchema(result) {
  const msg = String(result?.message || '').toLowerCase();
  return result?.status === 400 && (
    msg.includes('response_format') ||
    msg.includes('responseformat') ||
    msg.includes('mime_type') ||
    msg.includes('mimetype')
  );
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('');
}

function usageFrom(data, model) {
  const u = data?.usageMetadata || {};
  const c = data?.candidates?.[0] || {};
  const grounding = c.groundingMetadata || {};
  const thought = u.thoughtsTokenCount || u.thinkingTokenCount || 0;
  const cached = u.cachedContentTokenCount || u.cachedPromptTokenCount || 0;
  const output = (u.candidatesTokenCount || 0) + thought;
  return {
    input_tokens: u.promptTokenCount || 0,
    output_tokens: output,
    thinking_tokens: thought,
    cache_read_input_tokens: cached,
    cached_tokens: cached,
    total_tokens: u.totalTokenCount || 0,
    finish_reason: c.finishReason || null,
    safety_ratings: c.safetyRatings || [],
    grounding_metadata_present: !!c.groundingMetadata,
    grounding_web_search_queries: Array.isArray(grounding.webSearchQueries) ? grounding.webSearchQueries.length : 0,
    schema_format: null,
    _provider: 'gemini',
    _model: model
  };
}

function inferThinkingLevel({ model, task, riskLevel, jsonMode, maxTokens }) {
  const t = String(task || '').toLowerCase();
  const highRisk = riskLevel === 'high' || t === 'judge' || t === 'ledger' || t === 'evidence' || t === 'formal';
  const shortRepair = t === 'repair' || t === 'voicerepair' || t === 'polish' || t === 'schema' || t === 'classify' || t === 'route';
  const budget = Number(maxTokens) || 0;
  let level;
  if (model === MODELS.PRO) {
    level = (process.env.GEMINI_THINKING_PRO || (jsonMode ? 'low' : (highRisk ? 'high' : 'medium'))).toLowerCase();
    if (level === 'minimal') level = 'low';
  } else if (model === MODELS.LITE) {
    level = (process.env.GEMINI_THINKING_LITE || (highRisk ? 'low' : 'minimal')).toLowerCase();
  } else if (jsonMode && budget > 0 && budget <= 1200) {
    level = (process.env.GEMINI_THINKING_STRUCTURED_SHORT || 'minimal').toLowerCase();
  } else if (jsonMode && t === 'detect') {
    level = (process.env.GEMINI_THINKING_STRUCTURED_DETECT || 'low').toLowerCase();
  } else if (shortRepair) {
    level = (process.env.GEMINI_THINKING_REPAIR || 'minimal').toLowerCase();
  } else {
    level = (process.env.GEMINI_THINKING_FLASH || (highRisk ? 'high' : 'medium')).toLowerCase();
  }
  if (!['minimal', 'low', 'medium', 'high'].includes(level)) level = model === MODELS.PRO ? 'high' : 'medium';
  return level;
}

async function generate({
  system,
  user,
  model,
  maxTokens = 4096,
  temperature,
  responseSchema,
  jsonMode = false,
  signal,
  task,
  riskLevel,
  tools,
  safetySettings
}) {
  const key = apiKey();
  if (!key) throw new Error('GEMINI_API_KEY is not configured');
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const generationConfig = {
    maxOutputTokens: maxTokens,
    thinkingConfig: {
      thinkingLevel: inferThinkingLevel({ model, task, riskLevel, jsonMode, maxTokens })
    }
  };
  if (typeof temperature === 'number') generationConfig.temperature = temperature;
  if (jsonMode) {
    attachJsonResponseFormat(generationConfig, responseSchema);
  }

  let cacheInfo = null;
  try {
    cacheInfo = await ensureSystemCache({ model, system, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (cacheStrictEnabled()) throw e;
    cacheInfo = null;
  }

  const body = {
    contents: [{ role: 'user', parts: [{ text: user || '' }] }],
    generationConfig
  };
  if (cacheInfo?.name) body.cachedContent = cacheInfo.name;
  else if (system) body.systemInstruction = { parts: [{ text: system }] };
  const normalizedTools = normalizeTools(tools);
  if (normalizedTools.length) body.tools = normalizedTools;
  const safety = Array.isArray(safetySettings) ? safetySettings : safetySettingsFromEnv();
  if (Array.isArray(safety) && safety.length) body.safetySettings = safety;

  let schemaFormat = jsonMode ? 'responseFormat' : null;
  let result = await postGenerate(url, body, signal);
  if (!result.ok && jsonMode && body.generationConfig?.responseFormat && canRetryLegacySchema(result)) {
    const legacyConfig = { ...generationConfig };
    attachLegacyJsonResponseFormat(legacyConfig, responseSchema);
    result = await postGenerate(url, { ...body, generationConfig: legacyConfig }, signal);
    schemaFormat = 'legacy';
  }
  if (!result.ok) throw new Error(`Gemini API ${result.status}: ${result.message}`);
  const data = result.data;
  const usage = usageFrom(data, model);
  usage.schema_format = schemaFormat;
  usage.thinking_level = generationConfig.thinkingConfig.thinkingLevel;
  usage.cached_content = cacheInfo?.name || null;
  usage.cache_source = cacheInfo?.source || null;
  usage.cache_key = cacheInfo?.keyHash ? cacheInfo.keyHash.slice(0, 16) : null;
  if (cacheInfo?.created) usage.cache_creation_input_tokens = cacheInfo.tokenCount || 0;
  return {
    text: extractText(data),
    raw: data,
    usage,
    stop_reason: usage.finish_reason,
    safetyRatings: usage.safety_ratings,
    groundingMetadata: data?.candidates?.[0]?.groundingMetadata || null
  };
}

module.exports = { MODELS, generate, sanitizeSchema, inferThinkingLevel };
