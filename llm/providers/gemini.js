// llm/providers/gemini.js - Gemini REST provider for local routing experiments.

const crypto = require('crypto');
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const MODELS = {
  PRO: 'gemini-3.1-pro-preview',
  FLASH: 'gemini-3.5-flash',
  LITE: 'gemini-3.1-flash-lite'
};

const systemCache = new Map();

function apiKey() {
  return (process.env.GEMINI_API_KEY || '').trim();
}

function modelResourceName(model) {
  return String(model || '').startsWith('models/') ? model : `models/${model}`;
}

function cacheKey(model, system) {
  return `${model}:${crypto.createHash('sha256').update(system || '').digest('hex')}`;
}

function explicitCacheEnabled() {
  return process.env.GEMINI_EXPLICIT_CACHE === '1';
}

function cacheTtl() {
  const ttl = (process.env.GEMINI_CACHE_TTL || '3600s').trim();
  return /^\d+s$/.test(ttl) ? ttl : '3600s';
}

function cacheMinChars() {
  const n = Number(process.env.GEMINI_EXPLICIT_CACHE_MIN_CHARS);
  return Number.isFinite(n) ? n : 6000;
}

function usageTokenCount(u) {
  return u?.totalTokenCount || u?.total_token_count || u?.promptTokenCount || 0;
}

async function ensureSystemCache({ model, system, signal }) {
  if (!explicitCacheEnabled() || !system) return null;
  if (String(system).replace(/\s+/g, '').length < cacheMinChars()) return null;

  const key = apiKey();
  if (!key) throw new Error('GEMINI_API_KEY is not configured');

  const id = cacheKey(model, system);
  const cached = systemCache.get(id);
  if (cached && cached.expiresAt > Date.now() + 30_000) return { ...cached, created: false };

  const ttl = cacheTtl();
  const seconds = Number(ttl.replace(/s$/, '')) || 3600;
  const url = `${API_BASE}/cachedContents?key=${encodeURIComponent(key)}`;
  const body = {
    model: modelResourceName(model),
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
    tokenCount: usageTokenCount(data.usageMetadata || data.usage_metadata || {}),
    expiresAt: Date.now() + seconds * 1000
  };
  systemCache.set(id, entry);
  return { ...entry, created: true };
}

function sanitizeSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === '$schema' || key === 'default') continue;
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

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('');
}

function usageFrom(data, model) {
  const u = data?.usageMetadata || {};
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
    _provider: 'gemini',
    _model: model
  };
}

function inferThinkingLevel({ model, task, riskLevel }) {
  const t = String(task || '').toLowerCase();
  const highRisk = riskLevel === 'high' || t === 'judge' || t === 'ledger' || t === 'evidence' || t === 'formal';
  let level;
  if (model === MODELS.PRO) {
    level = (process.env.GEMINI_THINKING_PRO || (highRisk ? 'high' : 'medium')).toLowerCase();
    if (level === 'minimal') level = 'low';
  } else if (model === MODELS.LITE) {
    level = (process.env.GEMINI_THINKING_LITE || (highRisk ? 'low' : 'minimal')).toLowerCase();
  } else {
    level = (process.env.GEMINI_THINKING_FLASH || (highRisk ? 'high' : (t === 'repair' ? 'low' : 'medium'))).toLowerCase();
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
  tools
}) {
  const key = apiKey();
  if (!key) throw new Error('GEMINI_API_KEY is not configured');
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const generationConfig = {
    maxOutputTokens: maxTokens,
    thinkingConfig: {
      thinkingLevel: inferThinkingLevel({ model, task, riskLevel })
    }
  };
  if (typeof temperature === 'number') generationConfig.temperature = temperature;
  if (jsonMode) {
    generationConfig.responseMimeType = 'application/json';
    const schema = sanitizeSchema(responseSchema);
    if (schema) generationConfig.responseSchema = schema;
  }

  let cacheInfo = null;
  try {
    cacheInfo = await ensureSystemCache({ model, system, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    cacheInfo = null;
  }

  const body = {
    contents: [{ role: 'user', parts: [{ text: user || '' }] }],
    generationConfig
  };
  if (cacheInfo?.name) body.cachedContent = cacheInfo.name;
  else if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const e = await res.json(); msg = e?.error?.message || msg; } catch {}
    throw new Error(`Gemini API ${res.status}: ${msg}`);
  }
  const data = await res.json();
  const usage = usageFrom(data, model);
  usage.thinking_level = generationConfig.thinkingConfig.thinkingLevel;
  usage.cached_content = cacheInfo?.name || null;
  if (cacheInfo?.created) usage.cache_creation_input_tokens = cacheInfo.tokenCount || 0;
  return {
    text: extractText(data),
    raw: data,
    usage,
    stop_reason: data?.candidates?.[0]?.finishReason || null
  };
}

module.exports = { MODELS, generate, sanitizeSchema, inferThinkingLevel };
