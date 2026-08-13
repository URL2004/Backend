'use strict';

const crypto = require('crypto');
const { logger } = require('../lib/logger');
const { estimateUsd } = require('./usageCost');

const OPENAI_API_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_RETRIES = 3;
const PROMPT_CACHE_MIN_TOKENS = 1024;

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim());
}

function sanitizeEffort(value, fallback = 'medium') {
  const v = String(value || '').trim().toLowerCase();
  return ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'minimal', 'default'].includes(v) ? v : fallback;
}

function promptCacheKey(config, { task, mode, profile, schemaName, phase, model } = {}) {
  if (config && config.cache && config.cache.enabled === false) return undefined;
  const prefix = String(config?.cache?.keyPrefix || process.env.OPENAI_PROMPT_CACHE_KEY_PREFIX || 'gp-prod')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 48);
  const includeMode = envFlag('OPENAI_PROMPT_CACHE_KEY_INCLUDE_MODE');
  const includePhase = envFlag('OPENAI_PROMPT_CACHE_KEY_INCLUDE_PHASE');
  // OpenAI also matches the exact prompt prefix. Keep mode out of routing by
  // default so modes sharing the same long static core can reuse warm routes.
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
  reasoningEffort = 'medium',
  verbosity = 'medium',
  maxOutputTokens = 4096,
  config,
  tools,
  toolChoice,
  include,
  signal,
  deadlineMs,
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

  const effort = sanitizeEffort(reasoningEffort, 'medium');
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
  const chunkTotalLimitMs = Math.max(10000, Number(process.env.OPENAI_CHUNK_TOTAL_TIMEOUT_MS) || 180000);
  const suppliedDeadline = Number(deadlineMs);
  const chunkDeadlineMs = Number.isFinite(suppliedDeadline) && suppliedDeadline > 0
    ? suppliedDeadline
    : startedAt + chunkTotalLimitMs;
  const requestForSchemaAttempt = schemaAttempt => ({
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(schemaAttempt > 0
      ? {
          ...body,
          instructions: [
            body.instructions,
            '[구조화 출력 재시도] 직전 응답이 JSON Schema 계약을 위반했습니다. 이번 응답은 지정된 필수 필드·자료형·additionalProperties 제한을 정확히 지키고, JSON 밖의 설명을 쓰지 마세요.'
          ].filter(Boolean).join('\n\n')
        }
      : body)
  });
  const retryCounts = emptyRetryCounts();
  let raw = null;
  let parsed = null;
  let outputText = '';
  let status = '';
  let incompleteReason = '';
  let schemaAttempt = 0;
  let truncationRetryUsed = false;
  while (schemaAttempt < 2) {
    const request = requestForSchemaAttempt(schemaAttempt);
    const fetched = await fetchOpenAIWithRetry(`${OPENAI_API_BASE}/responses`, request, signal, chunkDeadlineMs);
    mergeRetryCounts(retryCounts, fetched.retryCounts);
    raw = await fetched.response.json();
    status = raw.status || 'completed';
    incompleteReason = raw.incomplete_details?.reason || '';
    if (status !== 'completed') {
      if (incompleteReason === 'max_output_tokens' && !truncationRetryUsed) {
        // reasoning과 구조화 JSON도 같은 출력 예산을 사용한다. 첫 응답이
        // max_output_tokens로 끝났다고 원문 fallback/전체 차단으로 보내지 않고,
        // 같은 모델·같은 절대 마감시간 안에서 출력 여유만 한 번 확장한다.
        truncationRetryUsed = true;
        retryCounts.truncation += 1;
        body.max_output_tokens = expandedMaxOutputTokens(body.max_output_tokens);
        continue;
      }
      const error = new Error(`OpenAI response was not completed: ${status}${incompleteReason ? ` (${incompleteReason})` : ''}`);
      error.code = incompleteReason === 'max_output_tokens' ? 'OPENAI_TRUNCATED_OUTPUT' : 'OPENAI_INCOMPLETE_OUTPUT';
      error.incompleteReason = incompleteReason;
      error.retryCounts = { ...retryCounts };
      throw error;
    }
    outputText = extractOutputText(raw);
    try {
      parsed = JSON.parse(outputText);
      validateStructuredOutput(parsed, schema);
      break;
    } catch (error) {
      if (error instanceof SyntaxError && !error.code) error.code = 'OPENAI_SCHEMA_PARSE';
      if (!String(error?.code || '').startsWith('OPENAI_SCHEMA')) {
        error.retryCounts = { ...retryCounts };
        throw error;
      }
      if (schemaAttempt >= 1) {
        error.retryCounts = { ...retryCounts };
        throw error;
      }
      retryCounts.schema += 1;
      schemaAttempt += 1;
    }
  }
  const elapsedMs = Date.now() - startedAt;

  const usage = normalizeUsage(raw.usage, model, raw);
  const cacheDiagnostics = promptCacheDiagnostics(usage, cacheKey);
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
      retryCounts,
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
    retryCounts,
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
  if (/^gpt-5\.6(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return true;
  if (/^gpt-5\.6-(?:luna|terra|sol)(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return true;
  if (/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return true;
  if (/^gpt-5\.2(?:-|$)/.test(m)) return true;
  if (/^gpt-5\.1(?:-|$)/.test(m)) return true;
  if (/^gpt-5(?:-|$)/.test(m) && !/^gpt-5\.4-(mini|nano)(?:-|$)/.test(m)) return true;
  if (/^gpt-4\.1(?:-|$)/.test(m)) return true;
  return false;
}

async function fetchOpenAIWithRetry(url, init, parentSignal, deadlineMs = 0) {
  const configuredRetries = Number(process.env.OPENAI_API_MAX_RETRIES ?? process.env.OPENAI_API_RETRY_ATTEMPTS);
  const retryCap = Math.max(0, Math.min(3, Number.isFinite(configuredRetries) ? configuredRetries : DEFAULT_MAX_RETRIES));
  const retryLimits = {
    rateLimit: Math.min(3, retryCap),
    server: Math.min(2, retryCap),
    network: Math.min(2, retryCap),
    timeout: Math.min(1, retryCap)
  };
  const retryCounts = emptyRetryCounts();
  const startedAt = Date.now();
  if (deadlineMs && deadlineMs <= startedAt) {
    const error = new Error('OpenAI Responses API request exceeded the chunk time limit');
    error.code = 'OPENAI_CHUNK_TIMEOUT';
    error.retryCounts = emptyRetryCounts();
    throw error;
  }
  const totalLimitMs = deadlineMs > startedAt
    ? deadlineMs - startedAt
    : Math.max(10000, Number(process.env.OPENAI_CHUNK_TOTAL_TIMEOUT_MS) || 180000);
  let lastError = null;
  while (Date.now() - startedAt < totalLimitMs) {
    if (parentSignal?.aborted) throw abortError();
    try {
      const remainingMs = Math.max(1000, totalLimitMs - (Date.now() - startedAt));
      const response = await fetchWithTimeout(url, init, parentSignal, remainingMs);
      if (response.ok) return { response, retryCounts };
      const message = await readErrorMessage(response);
      const err = new Error(`OpenAI Responses API ${response.status}: ${message}`);
      err.status = response.status;
      err.retryAfterMs = retryAfterMs(response.headers?.get?.('retry-after'));
      if (response.status === 429 && isQuotaExhaustionMessage(message)) {
        err.code = 'OPENAI_QUOTA_EXHAUSTED';
        err.retryable = false;
      }
      throw err;
    } catch (err) {
      if (parentSignal?.aborted) throw err;
      const type = retryType(err);
      if (!type || retryCounts[type] >= retryLimits[type]) {
        err.retryCounts = { ...retryCounts };
        throw err;
      }
      retryCounts[type] += 1;
      lastError = err;
      const delay = err?.retryAfterMs ?? backoffMs(retryCounts[type]);
      const remainingMs = totalLimitMs - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      await sleepWithSignal(Math.min(delay, remainingMs), parentSignal);
    }
  }
  const error = lastError || new Error('OpenAI Responses API request exceeded the chunk time limit');
  if (!error.code) error.code = 'OPENAI_CHUNK_TIMEOUT';
  error.retryCounts = { ...retryCounts };
  throw error;
}

async function fetchWithTimeout(url, init, parentSignal, remainingMs = Infinity) {
  const configured = Math.max(5000, Number(process.env.OPENAI_API_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const timeoutMs = Math.max(1000, Math.min(configured, Number.isFinite(remainingMs) ? remainingMs : configured));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  try {
    if (parentSignal) parentSignal.addEventListener('abort', onAbort, { once: true });
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted && !parentSignal?.aborted) {
      const timeoutError = new Error(`OpenAI Responses API request timed out after ${timeoutMs}ms`);
      timeoutError.code = 'ETIMEDOUT';
      timeoutError.retryable = true;
      timeoutError.cause = err;
      throw timeoutError;
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

function retryType(error) {
  if (String(error?.code || '').toUpperCase() === 'OPENAI_QUOTA_EXHAUSTED'
      || isQuotaExhaustionMessage(error?.message)) return '';
  if (Number(error?.status) === 429) return 'rateLimit';
  if (Number(error?.status) >= 500) return 'server';
  if (error?.code === 'ETIMEDOUT' || error?.code === 'OPENAI_CHUNK_TIMEOUT' || /timed?\s*out|timeout/iu.test(String(error?.message || ''))) return 'timeout';
  if (/network|fetch failed|econnreset|enotfound|socket hang up/iu.test(String(error?.message || ''))) return 'network';
  return '';
}

function isQuotaExhaustionMessage(value) {
  return /(?:exceeded\s+your\s+current\s+quota|check\s+your\s+plan\s+and\s+billing|insufficient[_\s-]*quota|billing\s+hard\s+limit)/iu
    .test(String(value || ''));
}

function emptyRetryCounts() {
  return { rateLimit: 0, server: 0, network: 0, timeout: 0, schema: 0, truncation: 0 };
}

function expandedMaxOutputTokens(value) {
  const current = Math.max(1, Number(value) || 4096);
  const configuredCap = Number(process.env.OPENAI_TRUNCATION_RETRY_MAX_OUTPUT_TOKENS);
  const cap = Math.max(8000, Math.min(32000, Number.isFinite(configuredCap) ? configuredCap : 20000));
  return Math.min(cap, Math.max(4096, current + 2048, Math.ceil(current * 1.75)));
}

function mergeRetryCounts(target, source) {
  for (const key of Object.keys(target || {})) target[key] += Number(source?.[key] || 0);
  return target;
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

function sleepWithSignal(ms, signal) {
  if (!ms) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
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
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const u = {
    inputTokens: usage.input_tokens || usage.prompt_tokens || 0,
    cachedInputTokens: inputDetails.cached_tokens || 0,
    cacheWriteTokens: inputDetails.cache_write_tokens || 0,
    outputTokens: usage.output_tokens || usage.completion_tokens || 0,
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
  const declaredTypes = Array.isArray(schema.type)
    ? schema.type.filter(type => typeof type === 'string')
    : (typeof schema.type === 'string' ? [schema.type] : []);
  if (declaredTypes.length > 1) {
    const alternatives = declaredTypes.map(type => {
      const branchErrors = [];
      validateSchemaNode(value, { ...schema, type }, path, branchErrors);
      return branchErrors;
    });
    if (alternatives.some(branchErrors => branchErrors.length === 0)) return;
    errors.push(`${path} must match one of ${declaredTypes.join(',')}`);
    return;
  }
  const type = declaredTypes[0] || schema.type;
  if (type === 'null') {
    if (value !== null) errors.push(`${path} must be null`);
  } else if (type === 'object') {
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
  } else if (type === 'array') {
    if (!Array.isArray(value)) errors.push(`${path} must be array`);
    else value.forEach((item, index) => validateSchemaNode(item, schema.items, `${path}[${index}]`, errors));
  } else if (type === 'string' && typeof value !== 'string') errors.push(`${path} must be string`);
  else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(`${path} must be number`);
  else if (type === 'integer' && (!Number.isInteger(value))) errors.push(`${path} must be integer`);
  else if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${path} must be boolean`);
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
  promptCacheDiagnostics,
  webSearchTool,
  safetyIdentifierForUid,
  extractOutputText,
  retryAfterMs,
  validateStructuredOutput
};
