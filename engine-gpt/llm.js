'use strict';

const crypto = require('crypto');
const { logger } = require('../lib/logger');

const OPENAI_API_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
const DEFAULT_MODEL = process.env.OPENAI_MODEL_MAIN || process.env.GPT_MODEL_MAIN || 'gpt-5.6-terra';
const DEFAULT_FAST_MODEL = process.env.OPENAI_MODEL_FAST || process.env.GPT_MODEL_FAST || 'gpt-5.6-luna';

function modelFor(kind = 'main') {
  if (kind === 'fast') return DEFAULT_FAST_MODEL;
  return DEFAULT_MODEL;
}

function promptCacheKey({ task, mode, profile, schemaName } = {}) {
  const prefix = (process.env.OPENAI_PROMPT_CACHE_KEY_PREFIX || 'gp-humanize-gpt').replace(/[^\w.-]+/g, '_').slice(0, 24);
  const raw = [prefix, task || 'humanize', mode || 'default', profile || 'gpt', schemaName || 'json']
    .map(v => String(v || '').replace(/[^\w.-]+/g, '_'))
    .join(':');
  if (raw.length <= 64) return raw;
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  return `${prefix}:${String(task || 'humanize').replace(/[^\w.-]+/g, '_').slice(0, 12)}:${String(mode || 'default').replace(/[^\w.-]+/g, '_').slice(0, 10)}:${hash}`.slice(0, 64);
}

async function completeJson({
  system,
  user,
  schema,
  schemaName = 'gpt_humanize_result',
  model,
  modelKind = 'main',
  maxOutputTokens = 8192,
  reasoningEffort,
  verbosity,
  signal,
  meta = {}
} = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured');

  const selectedModel = model || modelFor(modelKind);
  const text = {
    format: {
      type: 'json_schema',
      name: schemaName,
      schema,
      strict: true
    }
  };
  const textVerbosity = verbosity || process.env.OPENAI_TEXT_VERBOSITY || 'medium';
  if (textVerbosity) text.verbosity = textVerbosity;

  const body = {
    model: selectedModel,
    instructions: String(system || ''),
    input: String(user || ''),
    max_output_tokens: maxOutputTokens,
    text,
    prompt_cache_key: promptCacheKey({ ...meta, schemaName })
  };

  const retention = process.env.OPENAI_PROMPT_CACHE_RETENTION;
  if (retention) body.prompt_cache_retention = retention;

  const effort = reasoningEffort || process.env.OPENAI_REASONING_MAIN || 'low';
  if (effort && effort !== 'default') body.reasoning = { effort };

  const startedAt = Date.now();
  const response = await fetch(`${OPENAI_API_BASE}/responses`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const err = await response.json();
      message = err?.error?.message || message;
    } catch {}
    throw new Error(`OpenAI Responses API ${response.status}: ${message}`);
  }

  const data = await response.json();
  const elapsedMs = Date.now() - startedAt;
  const outputText = extractOutputText(data);
  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (e) {
    throw new Error(`OpenAI structured JSON parse failed: ${e.message}`);
  }

  const usage = normalizeUsage(data.usage);
  try {
    logger.info('llm.usage', {
      provider: 'openai',
      model: selectedModel,
      task: meta.task || 'gpt_humanize',
      phase: meta.phase,
      mode: meta.mode,
      profile: meta.profile,
      chunkIndex: meta.chunkIndex,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      elapsedMs
    });
  } catch {}

  return {
    provider: 'openai',
    model: selectedModel,
    json: parsed,
    rawText: outputText,
    raw: data,
    usage,
    elapsedMs,
    status: data.status || 'completed',
    stopReason: data.incomplete_details?.reason || data.status || 'completed'
  };
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text.trim();
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

function normalizeUsage(usage = {}) {
  return {
    inputTokens: usage.input_tokens || 0,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    raw: usage
  };
}

module.exports = { completeJson, modelFor, normalizeUsage };
