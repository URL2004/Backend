// llm/providers/gemini.js - Gemini REST provider for local routing experiments.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const MODELS = {
  PRO: 'gemini-3.1-pro-preview',
  FLASH: 'gemini-3.5-flash',
  LITE: 'gemini-3.1-flash-lite'
};

function apiKey() {
  return (process.env.GEMINI_API_KEY || '').trim();
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
  const output = (u.candidatesTokenCount || 0) + thought;
  return {
    input_tokens: u.promptTokenCount || 0,
    output_tokens: output,
    thinking_tokens: thought,
    total_tokens: u.totalTokenCount || 0,
    _provider: 'gemini',
    _model: model
  };
}

async function generate({ system, user, model, maxTokens = 4096, temperature, responseSchema, jsonMode = false, signal }) {
  const key = apiKey();
  if (!key) throw new Error('GEMINI_API_KEY is not configured');
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const generationConfig = {
    maxOutputTokens: maxTokens
  };
  if (typeof temperature === 'number') generationConfig.temperature = temperature;
  if (jsonMode) {
    generationConfig.responseMimeType = 'application/json';
    const schema = sanitizeSchema(responseSchema);
    if (schema) generationConfig.responseSchema = schema;
  }

  const body = {
    contents: [{ role: 'user', parts: [{ text: user || '' }] }],
    generationConfig
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

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
  return {
    text: extractText(data),
    raw: data,
    usage: usageFrom(data, model),
    stop_reason: data?.candidates?.[0]?.finishReason || null
  };
}

module.exports = { MODELS, generate, sanitizeSchema };
