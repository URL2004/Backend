'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { currentContext } = require('./logger');
const waiting = [];
let active = 0;
const cap = Math.max(1, Math.min(3, Number(process.env.HUMANIZE_ENGINE_WORKERS) || 2));
function drain() {
  while (active < cap && waiting.length) {
    const next = waiting.shift();
    next.signal?.removeEventListener('abort', next.cancelWaiting);
    if (next.signal?.aborted) { next.reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })); continue; }
    active++;
    next.run().finally(() => { active--; drain(); });
  }
}
function runHumanize(options = {}) {
  const { signal, ...serializable } = options;
  const context = { ...currentContext() };
  return new Promise((resolve, reject) => {
    if (waiting.length >= 32) return reject(Object.assign(new Error('Engine capacity unavailable'), { code: 'ENGINE_BUSY' }));
    const entry = { signal, reject, run: () => new Promise(done => {
      let worker, settled = false;
      const finish = (error, result) => {
        if (settled) return; settled = true;
        signal?.removeEventListener('abort', abort);
        Promise.resolve(worker?.terminate()).then(done, done);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
      try {
        worker = new Worker(path.join(__dirname, '../engine-gpt-prod/engineWorker.js'), { workerData: { options: serializable, context } });
        worker.once('message', message => finish(message.error ? Object.assign(new Error(message.error.message), message.error) : null, message.result));
        worker.once('error', error => finish(error));
        worker.once('exit', code => { if (!settled) finish(new Error(`Engine worker exited (${code})`)); });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      } catch (error) { finish(error); }
    }) };
    entry.cancelWaiting = () => {
      const index = waiting.indexOf(entry);
      if (index >= 0) {
        waiting.splice(index, 1);
        reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
      }
    };
    waiting.push(entry);
    signal?.addEventListener('abort', entry.cancelWaiting, { once: true });
    drain();
  });
}
module.exports = { runHumanize };
