'use strict';

async function mapWithConcurrency(items, concurrency, worker, signal) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return [];
  if (typeof worker !== 'function') throw new TypeError('worker must be a function');

  const width = Math.min(
    rows.length,
    Math.max(1, Math.floor(Number(concurrency) || 1))
  );
  const results = new Array(rows.length);
  let cursor = 0;

  const runWorker = async () => {
    while (true) {
      throwIfAborted(signal);
      const index = cursor;
      cursor += 1;
      if (index >= rows.length) return;
      results[index] = await worker(rows[index], index);
    }
  };

  await Promise.all(Array.from({ length: width }, runWorker));
  return results;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  const error = new Error(
    reason instanceof Error && reason.message
      ? reason.message
      : 'Operation aborted',
    reason instanceof Error ? { cause: reason } : undefined
  );
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

module.exports = {
  mapWithConcurrency,
  throwIfAborted
};
