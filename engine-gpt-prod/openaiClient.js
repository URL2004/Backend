'use strict';

const crypto = require('crypto');
const { logger } = require('../lib/logger');
const { estimateUsd } = require('./usageCost');

const OPENAI_API_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_RETRIES = 3;

function sanitizeEffort(value, fallback = 'low') {
  const v = String(value || '').trim().toLowerCase();
  return ['none', 'low', 'medium', 'high', 'xhigh', 'minimal', 'default'].includes(v) ? v : fallback;
}

function promptCacheKey(config, { task, mode, profile, schemaName, phase, model } = {}) {
  if (config && config.cache && config.cache.enabled === false) return undefined;
  const prefix = String(config?.cache?.keyPrefix || process.env.OPENAI_PROMPT_CACHE_KEY_PREFIX || 'gp-prod')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 48);
  const includePhase = String(process.env.OPENAI_PROMPT_CACHE_KEY_INCLUDE_PHASE || '').trim() === '1';
  const parts = [prefix, model || 'model', task || 'task', mode || 'default', profile || 'prod', schemaName || 'json'];
  if (includePhase) parts.push(phase || 'main');
  const raw = parts
    .map(v => String(v || '').replace(/[^\w.-]+/g, '_'))
    .join(':');
  if (raw.length <= 64) return raw;
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  const modelKey = String(model || 'model').replace(/[^\w.-]+/g, '_').slice(0, 12);
  const taskKey = String(task || 'task').replace(/[^\w.-]+/g, '_').slice(0, 10);
  const reserved = modelKey.length + taskKey.length + hash.length + 3;
  const prefixKey = prefix.slice(0, Math.max(8, 64 - reserved));
  return `${prefixKey}:${modelKey}:${taskKey}:${hash}`.slice(0, 64);
}

async function completeJson({
  system,
  user,
  schema,
  schemaName,
  model,
  reasoningEffort = 'low',
  verbosity = 'medium',
  maxOutputTokens = 4096,
  config,
  tools,
  toolChoice,
  include,
  signal,
  safetyIdentifier,
  meta = {}
} = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured');
  if (!model) throw new Error('OpenAI model is required');
  if (!schema) throw new Error('OpenAI JSON schema is required');

  const text = {
    format: {
      type: 'json_schema',
      name: schemaName || 'gpt_prod_result',
      schema,
      strict: true
    }
  };
  if (verbosity) text.verbosity = verbosity;

  const body = {
    model,
    instructions: String(system || ''),
    input: String(user || ''),
    max_output_tokens: maxOutputTokens,
    text,
    store: false
  };

  const effort = sanitizeEffort(reasoningEffort, 'low');
  if (effort && effort !== 'default') {
    body.reasoning = { effort };
  }

  const cacheKey = promptCacheKey(config, { ...meta, schemaName, model });
  if (cacheKey) body.prompt_cache_key = cacheKey;
  const retention = promptCacheRetention(config, model);
  if (retention) body.prompt_cache_retention = String(retention);
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  if (Array.isArray(include) && include.length) body.include = include.map(v => String(v)).filter(Boolean);
  if (safetyIdentifier) body.safety_identifier = validateSafetyIdentifier(safetyIdentifier);

  const startedAt = Date.now();
  const response = await fetchOpenAIWithRetry(`${OPENAI_API_BASE}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }, signal);

  const raw = await response.json();
  const elapsedMs = Date.now() - startedAt;
  const status = raw.status || 'completed';
  const incompleteReason = raw.incomplete_details?.reason || '';
  if (status !== 'completed') {
    const error = new Error(`OpenAI response was not completed: ${status}${incompleteReason ? ` (${incompleteReason})` : ''}`);
    error.code = incompleteReason === 'max_output_tokens' ? 'OPENAI_TRUNCATED_OUTPUT' : 'OPENAI_INCOMPLETE_OUTPUT';
    error.incompleteReason = incompleteReason;
    throw error;
  }
  const outputText = extractOutputText(raw);
  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (e) {
    const error = new Error(`OpenAI structured JSON parse failed: ${e.message}`);
    error.code = 'OPENAI_SCHEMA_PARSE';
    throw error;
  }
  validateStructuredOutput(parsed, schema);

  const usage = normalizeUsage(raw.usage, model, raw);
  try {
    logger.info('gpt_prod.usage', {
      provider: 'openai',
      model,
      selectedModel: model,
      task: meta.task || 'unknown',
      phase: meta.phase || 'main',
      mode: meta.mode || '',
      chunkIndex: meta.chunkIndex,
      escalated: meta.escalated === true,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      estimatedUsd: usage.estimatedUsd,
      promptCacheKey: cacheKey,
      promptCacheHitRatio: usage.inputTokens ? Number((usage.cachedInputTokens / usage.inputTokens).toFixed(4)) : 0,
      elapsedMs
    });
  } catch {}

  return {
    provider: 'openai',
    model,
    json: parsed,
    rawText: outputText,
    raw,
    usage,
    status,
    incompleteReason,
    elapsedMs
  };
}

function promptCacheRetention(config, model) {
  const raw = String(config?.cache?.retention || process.env.OPENAI_PROMPT_CACHE_RETENTION || '').trim();
  if (raw && raw.toLowerCase() !== 'auto') return raw;
  return supportsExtendedPromptCache(model) ? '24h' : '';
}

function supportsExtendedPromptCache(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return false;
  if (/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return true;
  if (/^gpt-5\.2(?:-|$)/.test(m)) return true;
  if (/^gpt-5\.1(?:-|$)/.test(m)) return true;
  if (/^gpt-5(?:-|$)/.test(m) && !/^gpt-5\.4-(mini|nano)(?:-|$)/.test(m)) return true;
  if (/^gpt-4\.1(?:-|$)/.test(m)) return true;
  return false;
}

async function fetchOpenAIWithRetry(url, init, parentSignal) {
  const configuredRetries = Number(process.env.OPENAI_API_MAX_RETRIES ?? process.env.OPENAI_API_RETRY_ATTEMPTS);
  const maxRetries = Math.max(0, Math.min(3, Number.isFinite(configuredRetries) ? configuredRetries : DEFAULT_MAX_RETRIES));
  const attempts = maxRetries + 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (parentSignal?.aborted) throw new Error('aborted');
    try {
      const response = await fetchWithTimeout(url, init, parentSignal);
      if (response.ok) return response;
      const message = await readErrorMessage(response);
      const err = new Error(`OpenAI Responses API ${response.status}: ${message}`);
      err.status = response.status;
      err.retryable = response.status === 429 || response.status >= 500;
      err.retryAfterMs = retryAfterMs(response.headers?.get?.('retry-after'));
      if (!err.retryable || attempt >= attempts) throw err;
      lastError = err;
    } catch (err) {
      if (parentSignal?.aborted) throw err;
      const retryable = err?.retryable === true || err?.name === 'AbortError' || err?.code === 'ETIMEDOUT' || /timeout|network|fetch failed/i.test(err?.message || '');
      if (!retryable || attempt >= attempts) throw err;
      lastError = err;
    }
    await sleep(lastError?.retryAfterMs ?? backoffMs(attempt));
  }
  throw lastError || new Error('OpenAI Responses API request failed');
}

async function fetchWithTimeout(url, init, parentSignal) {
  const timeoutMs = Math.max(5000, Number(process.env.OPENAI_API_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  try {
    if (parentSignal) parentSignal.addEventListener('abort', onAbort, { once: true });
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted && !parentSignal?.aborted) {
      err.code = err.code || 'ETIMEDOUT';
      err.retryable = true;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
  }
}

async function readErrorMessage(response) {
  let message = response.statusText;
  try {
    const err = await response.json();
    message = err?.error?.message || err?.message || message;
  } catch {}
  return message;
}

function backoffMs(attempt) {
  const base = Math.min(2000, 500 * Math.pow(2, attempt - 1));
  const jitter = Math.floor(base * (Math.random() * 0.3 - 0.15));
  return Math.max(100, base + jitter);
}

function retryAfterMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60000, Math.round(seconds * 1000));
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.min(60000, date - Date.now()));
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  const refusals = [];
  for (const item of data?.output || []) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type === 'refusal' || typeof c?.refusal === 'string') refusals.push(String(c.refusal || c.text || '').trim());
        else if (typeof c?.text === 'string') parts.push(c.text);
        else if (typeof c?.content === 'string') parts.push(c.content);
      }
    } else if (item?.type === 'refusal' || typeof item?.refusal === 'string') {
      refusals.push(String(item.refusal || item.text || '').trim());
    } else if (typeof item?.text === 'string') {
      parts.push(item.text);
    }
  }
  if (refusals.length) {
    const error = new Error(`OpenAI response refused the request: ${refusals.filter(Boolean).join(' ').slice(0, 300) || 'refusal'}`);
    error.code = 'OPENAI_REFUSAL';
    error.refusal = true;
    throw error;
  }
  const joined = parts.join('').trim();
  if (!joined) {
    const error = new Error('OpenAI response did not include output text');
    error.code = 'OPENAI_EMPTY_OUTPUT';
    throw error;
  }
  return joined;
}

function normalizeUsage(usage = {}, model, rawResponse = null) {
  const webSearchRequests = countWebSearchCalls(rawResponse, usage);
  const u = {
    inputTokens: usage.input_tokens || 0,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    webSearchRequests,
    raw: usage
  };
  const webSearchUsd = Number(process.env.OPENAI_WEB_SEARCH_USD_PER_CALL);
  const perCall = Number.isFinite(webSearchUsd) && webSearchUsd >= 0 ? webSearchUsd : 0.01;
  u.webSearchEstimatedUsd = Math.round(webSearchRequests * perCall * 1000000) / 1000000;
  u.estimatedUsd = Math.round((estimateUsd(model, u) + u.webSearchEstimatedUsd) * 1000000) / 1000000;
  return u;
}

function countWebSearchCalls(rawResponse, usage = {}) {
  const metered = Number(usage?.server_tool_use?.web_search_requests || usage?.server_tool_use?.web_search_calls);
  if (Number.isFinite(metered) && metered >= 0) return metered;
  return (rawResponse?.output || []).filter(item => item?.type === 'web_search_call').length;
}

function safetyIdentifierForUid(uid, salt = process.env.OPENAI_SAFETY_SALT) {
  const value = String(uid || '').trim();
  if (!value) return '';
  const secret = String(salt || '');
  if (!secret) {
    const error = new Error('OPENAI_SAFETY_SALT is required to derive safety_identifier');
    error.code = 'OPENAI_SAFETY_SALT_MISSING';
    throw error;
  }
  return crypto.createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

function validateSafetyIdentifier(value) {
  const identifier = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,64}$/u.test(identifier)) {
    const error = new Error('Invalid OpenAI safety_identifier');
    error.code = 'OPENAI_SAFETY_IDENTIFIER_INVALID';
    throw error;
  }
  return identifier;
}

function validateStructuredOutput(value, schema, path = '$') {
  const errors = [];
  validateSchemaNode(value, schema, path, errors);
  if (errors.length) {
    const error = new Error(`OpenAI structured output schema validation failed: ${errors.slice(0, 6).join('; ')}`);
    error.code = 'OPENAI_SCHEMA_VALIDATION';
    error.schemaErrors = errors;
    throw error;
  }
  return true;
}

function validateSchemaNode(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} must be object`);
      return;
    }
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key} is required`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) errors.push(`${path}.${key} is not allowed`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validateSchemaNode(value[key], childSchema, `${path}.${key}`, errors);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) errors.push(`${path} must be array`);
    else value.forEach((item, index) => validateSchemaNode(item, schema.items, `${path}[${index}]`, errors));
  } else if (schema.type === 'string' && typeof value !== 'string') errors.push(`${path} must be string`);
  else if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(`${path} must be number`);
  else if (schema.type === 'integer' && (!Number.isInteger(value))) errors.push(`${path} must be integer`);
  else if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(`${path} must be boolean`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(',')}`);
}

function webSearchTool() {
  const type = process.env.OPENAI_WEB_SEARCH_TOOL_TYPE || 'web_search';
  return { type };
}

module.exports = {
  completeJson,
  normalizeUsage,
  promptCacheKey,
  webSearchTool,
  safetyIdentifierForUid,
  extractOutputText,
  retryAfterMs,
  validateStructuredOutput
};
