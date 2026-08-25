'use strict';

const crypto = require('crypto');
const { logger } = require('../lib/logger');
const { estimateUsd } = require('./usageCost');

const OPENAI_API_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const PROMPT_CACHE_MIN_TOKENS = 1024;

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim());
}

function sanitizeEffort(value, fallback = 'low') {
  const v = String(value || '').trim().toLowerCase();
  return ['none', 'low', 'medium', 'high', 'xhigh', 'minimal', 'default'].includes(v) ? v : fallback;
}

function promptCacheKey(config, { task, mode, profile, schemaName, phase, model } = {}) {
  if (config && config.cache && config.cache.enabled === false) return undefined;
  const prefix = String(config?.cache?.keyPrefix || process.env.OPENAI_PROMPT_CACHE_KEY_PREFIX || 'gp-prod')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 48);
  const includeMode = envFlag('OPENAI_PROMPT_CACHE_KEY_INCLUDE_MODE');
  const includePhase = envFlag('OPENAI_PROMPT_CACHE_KEY_INCLUDE_PHASE');
  // The API already combines this key with an exact prefix hash. Keep mode out
  // by default so prompts sharing the same long static core reuse cache routing.
  const parts = [prefix, model || 'model', task || 'task'];
  if (includeMode) parts.push(mode || 'default');
  parts.push(profile || 'prod', schemaName || 'json');
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
  const outputText = extractOutputText(raw);
  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (e) {
    throw new Error(`OpenAI structured JSON parse failed: ${e.message}`);
  }

  const usage = normalizeUsage(raw.usage, model);
  const cacheDiagnostics = promptCacheDiagnostics(usage, cacheKey);
  const status = raw.status || 'completed';
  const incompleteReason = raw.incomplete_details?.reason || '';
  if (status && status !== 'completed' && incompleteReason) {
    parsed.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
    parsed.warnings.push(`openai_status:${status}:${incompleteReason}`);
  }

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
      cacheWriteTokens: usage.cacheWriteTokens,
      uncachedInputTokens: cacheDiagnostics.uncachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      estimatedUsd: usage.estimatedUsd,
      promptCacheKey: cacheKey,
      promptCacheHitRatio: cacheDiagnostics.hitRatio,
      promptCacheSizeEligible: cacheDiagnostics.sizeEligible,
      promptCacheRead: cacheDiagnostics.read,
      promptCacheSizedMiss: cacheDiagnostics.sizedMiss,
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
  if (/^gpt-5\.6(?:-|$)/.test(m)) return true;
  if (/^gpt-5\.5(?:-|$)/.test(m)) return true;
  if (/^gpt-5\.2(?:-|$)/.test(m)) return true;
  if (/^gpt-5\.1(?:-|$)/.test(m)) return true;
  if (/^gpt-5(?:-|$)/.test(m)) return true;
  if (/^gpt-4\.1(?:-|$)/.test(m)) return true;
  return false;
}

async function fetchOpenAIWithRetry(url, init, parentSignal) {
  const attempts = Math.max(1, Math.min(5, Number(process.env.OPENAI_API_RETRY_ATTEMPTS) || DEFAULT_RETRY_ATTEMPTS));
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
      if (!err.retryable || attempt >= attempts) throw err;
      lastError = err;
    } catch (err) {
      if (parentSignal?.aborted) throw err;
      const retryable = err?.retryable === true || err?.name === 'AbortError' || err?.code === 'ETIMEDOUT' || /timeout|network|fetch failed/i.test(err?.message || '');
      if (!retryable || attempt >= attempts) throw err;
      lastError = err;
    }
    await sleep(backoffMs(attempt));
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
  const base = Math.min(2000, 250 * Math.pow(2, attempt - 1));
  return base + Math.floor(Math.random() * 120);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const item of data?.output || []) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (typeof c?.text === 'string') parts.push(c.text);
        else if (typeof c?.content === 'string') parts.push(c.content);
      }
    } else if (typeof item?.text === 'string') {
      parts.push(item.text);
    }
  }
  const joined = parts.join('').trim();
  if (!joined) throw new Error('OpenAI response did not include output text');
  return joined;
}

function normalizeUsage(usage = {}, model) {
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const u = {
    inputTokens: usage.input_tokens || usage.prompt_tokens || 0,
    cachedInputTokens: inputDetails.cached_tokens || 0,
    cacheWriteTokens: inputDetails.cache_write_tokens || 0,
    outputTokens: usage.output_tokens || usage.completion_tokens || 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    raw: usage
  };
  u.estimatedUsd = estimateUsd(model, u);
  return u;
}

function promptCacheDiagnostics(usage = {}, cacheKey) {
  const inputTokens = Math.max(0, Number(usage.inputTokens) || 0);
  const cachedInputTokens = Math.max(0, Math.min(inputTokens, Number(usage.cachedInputTokens) || 0));
  const cacheWriteTokens = Math.max(0, Math.min(inputTokens, Number(usage.cacheWriteTokens) || 0));
  const sizeEligible = inputTokens >= PROMPT_CACHE_MIN_TOKENS;
  return {
    enabled: Boolean(cacheKey),
    sizeEligible,
    read: cachedInputTokens > 0,
    sizedMiss: Boolean(cacheKey) && sizeEligible && cachedInputTokens === 0,
    hitRatio: inputTokens ? Number((cachedInputTokens / inputTokens).toFixed(4)) : 0,
    cachedInputTokens,
    cacheWriteTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens)
  };
}

function webSearchTool() {
  const type = process.env.OPENAI_WEB_SEARCH_TOOL_TYPE || 'web_search';
  return { type };
}

module.exports = {
  completeJson,
  normalizeUsage,
  promptCacheKey,
  promptCacheDiagnostics,
  webSearchTool
};
