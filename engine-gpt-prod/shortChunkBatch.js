'use strict';
const { createHash } = require('node:crypto');
const { emptyUsage } = require('./usageCost');
function createShortChunkBatch(providerCall, { enabled = process.env.HUMANIZE_SHORT_CHUNK_BATCH_ENABLED === '1', concurrency = 2 } = {}) {
  let active = 0;
  const waiting = [];
  const drain = () => {
    while (active < concurrency && waiting.length) {
      const next = waiting.shift();
      next.options.signal?.removeEventListener('abort', next.abort);
      if (next.options.signal?.aborted) { next.reject(next.options.signal.reason); continue; }
      active++;
      Promise.resolve().then(() => providerCall(next.options)).then(next.resolve, next.reject)
        .finally(() => { active--; drain(); });
    }
  };
  const call = options => new Promise((resolve, reject) => {
    const item = { options, resolve, reject };
    item.abort = () => { const index = waiting.indexOf(item); if (index >= 0) waiting.splice(index, 1); reject(options.signal.reason); };
    options.signal?.addEventListener('abort', item.abort, { once: true });
    waiting.push(item); drain();
  });
  const queues = new Map();
  const metrics = { enabled, batchCallCount: 0, batchedChunkCount: 0, individualRecoveryCount: 0 };
  async function flush(key, queue) {
    if (queues.get(key) === queue) queues.delete(key);
    if (queue.started) return;
    queue.started = true;
    const items = queue.items;
    if (items.length === 1) { try { items[0].resolve(await call(items[0].options)); } catch (e) { items[0].reject(e); } return; }
    metrics.batchCallCount++; metrics.batchedChunkCount += items.length;
    const first = items[0].options;
    let response;
    try {
      response = await call({ ...first,
        system: first.system + '\n[Independent chunk batch] Each item is an independent task. Follow its task contract. Return its exact id and result. Never move text, facts, headings or paragraphs between ids.',
        user: JSON.stringify({ items: items.map(item => ({ id: item.id, task: item.options.user })) }),
        schemaName: 'gpt_prod_humanize_chunk_batch',
        schema: { type: 'object', additionalProperties: false, properties: { items: { type: 'array', items: {
          type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, result: first.schema }, required: ['id', 'result']
        } } }, required: ['items'] },
        deadlineMs: Math.min(...items.map(item => Number(item.options.deadlineMs) || Infinity)),
        maxOutputTokens: items.reduce((sum, item) => sum + item.options.maxOutputTokens, 0),
        meta: { ...first.meta, phase: 'primary_short_batch' }
      });
    } catch (error) { if (first.signal?.aborted) { items.forEach(item => item.reject(error)); return; } }
    const rows = Array.isArray(response?.json?.items) ? response.json.items : [];
    await Promise.all(items.map(async (item, index) => {
      try {
        const matches = rows.filter(row => row.id === item.id);
        if (matches.length !== 1) {
          item.options.signal?.throwIfAborted();
          metrics.individualRecoveryCount++;
          item.resolve(await call(item.options)); return;
        }
        const usage = emptyUsage();
        for (const field of Object.keys(usage)) {
          const value = Number(response.usage?.[field] || 0);
          const portion = /Usd$/.test(field) ? Math.floor(value * 1e6 / items.length) / 1e6 : Math.floor(value / items.length);
          usage[field] = index === 0 ? value - portion * (items.length - 1) : portion;
        }
        item.resolve({ ...response, json: matches[0].result, usage, batchId: item.id });
      } catch (error) { item.reject(error); }
    }));
  }
  return { metrics, complete: (options, chars) => {
    if (!enabled || chars >= 400 || options.meta?.phase !== 'primary') return call(options);
    const key = createHash('sha256').update(JSON.stringify([options.system, options.model, options.reasoningEffort, options.meta?.mode, options.schema])).digest('hex');
    return new Promise((resolve, reject) => {
      let queue = queues.get(key);
      if (queue && (queue.items.length >= 4 || queue.chars + chars > 1600)) { void flush(key, queue); queue = null; }
      if (!queue) {
        queue = { items: [], chars: 0 }; queues.set(key, queue);
        const pending = queue; setImmediate(() => { void flush(key, pending); });
      }
      queue.chars += chars;
      queue.items.push({ id: String(options.meta.chunkIndex), options, resolve, reject });
    });
  } };
}
function buildChunkWorkUnits(chunks, enabled) {
  if (!enabled) return chunks.map((_, index) => [index]);
  const units = []; let pending = [], chars = 0;
  const flush = () => { if (pending.length) units.push(pending); pending = []; chars = 0; };
  chunks.forEach((chunk, index) => {
    if (chunk.locked) { units.push([index]); return; }
    const length = String(chunk.text || '').length;
    if (length >= 400) { flush(); units.push([index]); return; }
    if (pending.length >= 4 || chars + length > 1600) flush();
    pending.push(index); chars += length;
  });
  flush(); return units;
}
module.exports = { createShortChunkBatch, buildChunkWorkUnits };
