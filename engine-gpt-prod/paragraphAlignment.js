'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { ngramSet, splitSentences } = require('../engine/koreanText');
const context = new AsyncLocalStorage();
// Only one bounded CPU slice per event-loop turn, including synchronous layout
// preparation. Three requests must not concatenate their preparation into one
// long task. Bind both request and layout async contexts before queueing.
const cpuQueue = [];
let cpuScheduled = false;
function scheduleSlice(fn, signal) {
  return new Promise((resolve, reject) => {
    cpuQueue.push({ fn: AsyncLocalStorage.bind(fn), signal, resolve, reject });
    if (!cpuScheduled) { cpuScheduled = true; setImmediate(drainSlice); }
  });
}
function drainSlice() {
  const item = cpuQueue.shift();
  try { item.signal?.throwIfAborted(); item.resolve(item.fn()); } catch (error) { item.reject(error); }
  if (cpuQueue.length) setImmediate(drainSlice); else cpuScheduled = false;
}
const compact = s => String(s).replace(/\s+/gu, '');
function feature(text) {
  const store = context.getStore();
  if (store?.features.has(text)) return store.features.get(text);
  const value = { key: compact(text), ids: (String(text).match(/\d+(?:\.\d+)?/gu) || []).join('|'), grams: ngramSet(text, 2) };
  if (store) {
    store.features.set(text, value);
    if (store.features.size > 5000) store.features.delete(store.features.keys().next().value);
  }
  return value;
}
function hasStableSentenceOwnership(sourceGroups, outputGroups) {
  if (sourceGroups.length !== outputGroups.length) return false;
  // The fallback is bounded too. Do not spend quadratic feature comparison
  // before it discovers that a very large document is outside that bound.
  if (sourceGroups.length > 30 || sourceGroups.reduce((sum, group) => sum + group.length, 0) > 180
      || outputGroups.reduce((sum, group) => sum + group.length, 0) > 180) return false;
  const from = sourceGroups.map(group => group.map(feature));
  const to = outputGroups.map(group => group.map(feature));
  const ids = new Map(), exact = new Map();
  for (const group of from) for (const sentence of group) {
    if (sentence.ids) ids.set(sentence.ids, (ids.get(sentence.ids) || 0) + 1);
    exact.set(sentence.key, (exact.get(sentence.key) || 0) + 1);
  }
  return from.every((group, pi) => group.length > 0 && group.length === to[pi].length
    && group.every((sentence, si) => {
      const other = to[pi][si];
      if (sentence.key === other.key && exact.get(sentence.key) === 1) return true;
      const score = similarity(sentence.grams, other.grams);
      if (score < .72) return false;
      if (sentence.ids && ids.get(sentence.ids) === 1 && sentence.ids === other.ids) return true;
      // Every sentence, including interior ones, must belong to this paragraph.
      // Matching only first/last sentences hid moved middle sentences.
      return from.every((elsewhere, otherPi) => otherPi === pi
        || elsewhere.every(candidate => score > similarity(candidate.grams, other.grams) + .1));
    }));
}
function similarity(a, b) {
  let count = 0;
  for (const gram of a) if (b.has(gram)) count++;
  return a.size + b.size ? count / (a.size + b.size - count) : 1;
}
function* compute(source, output, metrics) {
  const started = performance.now();
  const p = source.length, n = output.length;
  if (p > 30 || n > 180 || p > n) { metrics.limitReached = true; return null; }
  const src = source.map(text => { const sentences = splitSentences(text); return {
    grams: ngramSet(text, 3), first: ngramSet(sentences[0] || text, 2),
    last: ngramSet(sentences.at(-1) || text, 2), length: Math.max(1, compact(text).length) }; });
  const out = output.map(text => ({ grams: ngramSet(text, 3), edge: ngramSet(text, 2), length: compact(text).length }));
  const prefix = [0];
  out.forEach(item => prefix.push(prefix.at(-1) + item.length));
  const segmentCache = new Map();
  const edgeFirst = src.map(item => out.map(sentence => similarity(item.first, sentence.edge)));
  const edgeLast = src.map(item => out.map(sentence => similarity(item.last, sentence.edge)));
  const expected = [];
  let length = 0;
  const totalLength = src.reduce((sum, item) => sum + item.length, 0);
  src.forEach(item => { length += item.length; expected.push(Math.round(n * length / totalLength)); });
  const scores = Array.from({ length: p + 1 }, () => new Float64Array(n + 1).fill(-Infinity));
  const prev = Array.from({ length: p + 1 }, () => new Int16Array(n + 1).fill(-1));
  scores[0][0] = 0;
  let sliceStart = performance.now();
  for (let pi = 1; pi <= p; pi++) {
    // A trustworthy first-sentence anchor narrows the next boundary; otherwise
    // use the complete bounded search, never a proportional cut as ownership.
    for (let end = pi; end <= n - (p - pi); end++) {
      if (pi === p && end !== n) continue;
      for (let start = pi - 1; start < end; start++) {
        if (!Number.isFinite(scores[pi - 1][start])) continue;
        if (metrics.states >= 50000 || performance.now() - started > 2000) { metrics.limitReached = true; return null; }
        metrics.states++;
        if (performance.now() - sliceStart >= 8) { yield; sliceStart = performance.now(); }
        const key = start * (n + 1) + end;
        let grams = segmentCache.get(key);
        if (!grams) {
          grams = new Set();
          for (let i = start; i < end; i++) for (const gram of out[i].grams) grams.add(gram);
          segmentCache.set(key, grams);
        }
        const sl = src[pi - 1].length, ol = Math.max(1, prefix[end] - prefix[start]);
        const score = scores[pi - 1][start] + similarity(src[pi - 1].grams, grams) * 0.58
          + edgeFirst[pi - 1][start] * 0.2 + edgeLast[pi - 1][end - 1] * 0.12
          + Math.min(sl, ol) / Math.max(sl, ol) * 0.1
          - (pi === p ? 0 : Math.abs(end - expected[pi - 1]) / n * 0.35);
        if (score > scores[pi][end]) { scores[pi][end] = score; prev[pi][end] = start; }
      }
    }
  }
  if (!Number.isFinite(scores[p][n])) return null;
  const boundaries = [];
  let end = n;
  for (let pi = p; pi > 0; pi--) { const start = prev[pi][end]; if (start < 0) return null; if (pi > 1) boundaries.unshift(start); end = start; }
  const score = scores[p][n] / p;
  return { boundaries, score, confidence: Math.max(0, Math.min(1, score)) };
}
function requestAlignment(source, output) {
  const store = context.getStore();
  const key = createHash('sha256').update(JSON.stringify([source, output])).digest('hex');
  if (store) {
    if (store.cache.has(key)) return store.cache.get(key);
    store.pending.set(key, { source, output });
    return null;
  }
  // Compatibility for synchronous helpers/evaluation. Production uses runLayout.
  const metrics = { states: 0, limitReached: false };
  const iterator = compute(source, output, metrics);
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}
async function runLayout(fn, options = {}) {
  return require('../engine/textAnalysisCache').withTextAnalysisCache(() => runCachedLayout(fn, options));
}
async function runCachedLayout(fn, options = {}) {
  const started = performance.now();
  const job = require('./callLedger').current();
  const store = { cache: job?.layoutCache || new Map(), features: job?.layoutFeatures || new Map(), pending: new Map(), metrics: { states: 0, limitReached: false, fastPath: false } };
  return context.run(store, async () => {
    let result = await scheduleSlice(() => fn(options), options.signal);
    for (let round = 0; store.pending.size && round < 4; round++) {
      const pending = [...store.pending]; store.pending.clear();
      for (const [key, pair] of pending) {
        options.signal?.throwIfAborted();
        const iterator = compute(pair.source, pair.output, store.metrics);
        let step = await scheduleSlice(() => iterator.next(), options.signal);
        while (!step.done) step = await scheduleSlice(() => iterator.next(), options.signal);
        store.cache.set(key, step.value);
        if (store.cache.size > 100) store.cache.delete(store.cache.keys().next().value);
      }
      result = await scheduleSlice(() => fn(options), options.signal);
    }
    const alignmentMetrics = { ...store.metrics, elapsedMs: Math.round(performance.now() - started) };
    job?.layoutMetrics.push(alignmentMetrics);
    return { ...result, alignmentMetrics };
  });
}
function recordFastPath() { const store = context.getStore(); if (store) store.metrics.fastPath = true; }
module.exports = { requestAlignment, runLayout, recordFastPath, hasStableSentenceOwnership };
