'use strict';

const DEFAULT_PRICES = {
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
  'gpt-5.6-sol': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 }
};

function priceFor(model) {
  const key = String(model || '').trim();
  const envPrefix = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const canonicalKey = canonicalPriceKey(key);
  const canonicalEnvPrefix = canonicalKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  // 알 수 없는 모델을 가장 싼 Luna로 계산하면 비용 상한이 무력화된다.
  // 정확 단가가 없을 때는 보수적으로 현재 최고 운영 단가를 사용한다.
  const base = DEFAULT_PRICES[canonicalKey] || highestDefaultPrice();
  return {
    input: envNumber(`OPENAI_PRICE_${envPrefix}_INPUT`, envNumber(`OPENAI_PRICE_${canonicalEnvPrefix}_INPUT`, base.input)),
    cachedInput: envNumber(`OPENAI_PRICE_${envPrefix}_CACHED_INPUT`, envNumber(`OPENAI_PRICE_${canonicalEnvPrefix}_CACHED_INPUT`, base.cachedInput)),
    cacheWrite: envNumber(`OPENAI_PRICE_${envPrefix}_CACHE_WRITE`, envNumber(`OPENAI_PRICE_${canonicalEnvPrefix}_CACHE_WRITE`, base.cacheWrite)),
    output: envNumber(`OPENAI_PRICE_${envPrefix}_OUTPUT`, envNumber(`OPENAI_PRICE_${canonicalEnvPrefix}_OUTPUT`, base.output))
  };
}

function canonicalPriceKey(model) {
  const value = String(model || '').trim().toLowerCase();
  const matched = value.match(/^(gpt-5\.6-(?:luna|terra|sol))(?:-\d{4}-\d{2}-\d{2})?$/u);
  return matched ? matched[1] : value;
}

function highestDefaultPrice() {
  return Object.values(DEFAULT_PRICES).reduce((highest, current) => (
    current.output > highest.output ? current : highest
  ), DEFAULT_PRICES['gpt-5.6-terra']);
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
    + cacheWrite * p.cacheWrite
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
    webSearchRequests: 0,
    webSearchEstimatedUsd: 0,
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
  out.webSearchRequests += Number(u.webSearchRequests) || 0;
  out.webSearchEstimatedUsd += Number(u.webSearchEstimatedUsd) || 0;
  out.webSearchEstimatedUsd = Math.round(out.webSearchEstimatedUsd * 1000000) / 1000000;
  out.estimatedUsd += Number(u.estimatedUsd) || 0;
  out.estimatedUsd = Math.round(out.estimatedUsd * 1000000) / 1000000;
  return out;
}

module.exports = {
  estimateUsd,
  addUsage,
  emptyUsage,
  priceFor,
  canonicalPriceKey
};
