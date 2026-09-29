'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const MAX_ENTRIES = 256;
const MAX_CHARACTERS = 1000000;
// Edit-distance pairs. One pair above the limit is computed and never stored.
const MAX_DISTANCE_ENTRIES = 8192;
const MAX_DISTANCE_CHARACTERS = 1000000;
const MAX_DISTANCE_PAIR_CHARACTERS = 50000;

function createStore() {
  return { entries: new Map(), characters: 0, distances: new Map(), distanceCharacters: 0, released: false,
    distanceStats: { calls: 0, hits: 0, misses: 0, bypassedOversize: 0, evictions: 0, peakEntries: 0, peakCharacters: 0 } };
}

// Drop every retained string as soon as the owning request ends. Late detached
// callbacks that still run inside this async context compute without storing.
function release(store) {
  store.released = true;
  store.entries.clear(); store.characters = 0;
  store.distances.clear(); store.distanceCharacters = 0;
}

// Request-local only: no user text survives in a process-global cache. Layout
// and semantic checks repeatedly analyze the exact same paragraphs. Reuse the
// deterministic boundaries without sharing mutable arrays between callers.
// Nested callers share the outermost owner's store and do not release it.
function withTextAnalysisCache(fn) {
  if (context.getStore()) return fn();
  const store = createStore();
  let result;
  try { result = context.run(store, fn); }
  catch (error) { release(store); throw error; }
  // A native promise is returned through finally(): the returned promise is a
  // new object that settles the same way after the store has been released.
  // Every other value, including a foreign thenable, is returned untouched and
  // its `then` is never read: a getter may throw or have side effects. The
  // store is released at once, so deferred work computes without storing.
  if (result instanceof Promise) {
    try { return result.finally(() => release(store)); }
    catch { /* not a real promise: fall through and return it untouched */ }
  }
  release(store);
  return result;
}

function memoizeSpans(kind, text, compute) {
  const store = context.getStore();
  if (!store || store.released || text.length > MAX_CHARACTERS) return compute();
  const key = kind + '\0' + text;
  if (store.entries.has(key)) return store.entries.get(key).map(span => ({ ...span }));
  const result = compute();
  while (store.entries.size && (store.entries.size >= MAX_ENTRIES || store.characters + key.length > MAX_CHARACTERS)) {
    const oldest = store.entries.keys().next().value;
    store.characters -= oldest.length;
    store.entries.delete(oldest);
  }
  if (key.length <= MAX_CHARACTERS) {
    store.entries.set(key, result.map(span => ({ ...span })));
    store.characters += key.length;
  }
  return result;
}

// Exact directional pair only. The caller passes already coerced strings and
// the unchanged computation. (a, b) and (b, a) are separate entries because the
// computation is not symmetric for every UTF-16 input. The decimal length of
// `a` ends at the first ':' and `a` has exactly that many code units, so the
// key is injective for any content, including NUL and ':'.
//
// Contract: memoizeDistance(a: string, b: string, compute: (a, b) => number).
// `compute` receives the same two strings in the same order and is called at
// most once per call. Callers look this function up on the module exports at
// call time, so a benchmark may replace the export with
// `(a, b, compute) => compute(a, b)` to measure the uncached baseline while the
// span store stays active.
function memoizeDistance(a, b, compute) {
  const store = context.getStore();
  if (!store || store.released) return compute(a, b);
  const stats = store.distanceStats;
  stats.calls += 1;
  if (a.length + b.length > MAX_DISTANCE_PAIR_CHARACTERS) {
    stats.bypassedOversize += 1;
    return compute(a, b);
  }
  const key = a.length + ':' + a + b;
  const known = store.distances.get(key);
  if (known !== undefined) {
    stats.hits += 1;
    store.distances.delete(key); store.distances.set(key, known);
    return known;
  }
  stats.misses += 1;
  const value = compute(a, b);
  if (typeof value !== 'number' || store.released || store.distances.has(key)) return value;
  while (store.distances.size && (store.distances.size >= MAX_DISTANCE_ENTRIES
      || store.distanceCharacters + key.length > MAX_DISTANCE_CHARACTERS)) {
    const oldest = store.distances.keys().next().value;
    store.distanceCharacters -= oldest.length;
    store.distances.delete(oldest);
    stats.evictions += 1;
  }
  store.distances.set(key, value);
  store.distanceCharacters += key.length;
  stats.peakEntries = Math.max(stats.peakEntries, store.distances.size);
  stats.peakCharacters = Math.max(stats.peakCharacters, store.distanceCharacters);
  return value;
}

// Numbers only: no key, no text and no length of an individual text.
function textAnalysisCacheStats() {
  const store = context.getStore();
  if (!store) return null;
  return { released: store.released,
    spans: { entries: store.entries.size, characters: store.characters },
    distance: { ...store.distanceStats, entries: store.distances.size, characters: store.distanceCharacters,
      maxEntries: MAX_DISTANCE_ENTRIES, maxCharacters: MAX_DISTANCE_CHARACTERS,
      maxPairCharacters: MAX_DISTANCE_PAIR_CHARACTERS } };
}

module.exports = { withTextAnalysisCache, memoizeSpans, memoizeDistance, textAnalysisCacheStats };
