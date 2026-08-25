'use strict';

const DEFAULT_PRICES = {
  'gpt-5.6-terra': { input: 2.5, cachedInput: 0.25, cacheWriteInput: 3.125, output: 15 },
  'gpt-5.6-luna': { input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 6 }
};

function priceFor(model) {
  const key = String(model || '').trim();
  const envPrefix = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const base = DEFAULT_PRICES[key] || DEFAULT_PRICES['gpt-5.6-luna'];
  return {
    input: envNumber(`OPENAI_PRICE_${envPrefix}_INPUT`, base.input),
    cachedInput: envNumber(`OPENAI_PRICE_${envPrefix}_CACHED_INPUT`, base.cachedInput),
    cacheWriteInput: envNumber(`OPENAI_PRICE_${envPrefix}_CACHE_WRITE_INPUT`, base.cacheWriteInput),
    output: envNumber(`OPENAI_PRICE_${envPrefix}_OUTPUT`, base.output)
  };
}

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function estimateUsd(model, usage = {}) {
  const p = priceFor(model);
  const input = Math.max(0, Number(usage.inputTokens) || 0);
  const cached = Math.max(0, Math.min(input, Number(usage.cachedInputTokens) || 0));
  const cacheWrite = Math.max(0, Math.min(input - cached, Number(usage.cacheWriteTokens) || 0));
  const uncached = input - cached - cacheWrite;
  const output = Math.max(0, Number(usage.outputTokens) || 0);
  const usd = (
    uncached * p.input
    + cached * p.cachedInput
    + cacheWrite * p.cacheWriteInput
    + output * p.output
  ) / 1000000;
  return Math.round(usd * 1000000) / 1000000;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedUsd: 0
  };
}

function addUsage(acc, usage) {
  const out = acc || emptyUsage();
  const u = usage || {};
  out.inputTokens += Number(u.inputTokens) || 0;
  out.cachedInputTokens += Number(u.cachedInputTokens) || 0;
  out.cacheWriteTokens += Number(u.cacheWriteTokens) || 0;
  out.outputTokens += Number(u.outputTokens) || 0;
  out.reasoningTokens += Number(u.reasoningTokens) || 0;
  out.totalTokens += Number(u.totalTokens) || 0;
  out.estimatedUsd += Number(u.estimatedUsd) || 0;
  out.estimatedUsd = Math.round(out.estimatedUsd * 1000000) / 1000000;
  return out;
}

module.exports = {
  estimateUsd,
  addUsage,
  emptyUsage,
  priceFor
};
