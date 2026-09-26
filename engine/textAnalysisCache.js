'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const MAX_ENTRIES = 256;
const MAX_CHARACTERS = 1000000;

// Request-local only: no user text survives in a process-global cache. Layout
// and semantic checks repeatedly analyze the exact same paragraphs. Reuse the
// deterministic boundaries without sharing mutable arrays between callers.
function withTextAnalysisCache(fn) {
  if (context.getStore()) return fn();
  return context.run({ entries: new Map(), characters: 0 }, fn);
}

function memoizeSpans(kind, text, compute) {
  const store = context.getStore();
  if (!store || text.length > MAX_CHARACTERS) return compute();
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

module.exports = { withTextAnalysisCache, memoizeSpans };
