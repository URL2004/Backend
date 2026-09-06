'use strict';

// A fast score must not cancel the conversion preview. The preview has its own
// bounded lifetime, including providers that do not immediately honor abort.
function startDetectPreview(task, { timeoutMs = 12000, onError = () => {} } = {}) {
  const controller = new AbortController();
  let settled = false, finish;
  const result = new Promise(resolve => { finish = resolve; });
  const settle = value => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish(value || null);
  };
  const cancel = () => { controller.abort(); settle(null); };
  const timer = setTimeout(cancel, timeoutMs);
  Promise.resolve().then(() => controller.signal.aborted ? null : task(controller.signal)).then(settle, error => {
    try { onError(error); } finally { settle(null); }
  }).catch(() => settle(null));
  return { result, cancel };
}

module.exports = { startDetectPreview };
