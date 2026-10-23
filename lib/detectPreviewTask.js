'use strict';

// A fast score must not cancel the conversion preview. The preview has its own
// bounded lifetime, including providers that do not immediately honor abort.
function startDetectPreview(task, { timeoutMs = 12000, onError = () => {}, onOutcome = () => {} } = {}) {
  const controller = new AbortController();
  const startedAt = Date.now();
  let settled = false, finish, outcome = null;
  const result = new Promise(resolve => { finish = resolve; });
  const settle = (value, status) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    outcome = { status, elapsedMs: Math.max(0, Date.now() - startedAt) };
    try { onOutcome(outcome); } catch (_) { /* Observability cannot fail detection. */ }
    finish(value || null);
  };
  const stop = status => { if (settled) return; settle(null, status); controller.abort(); };
  const cancel = () => stop('cancelled');
  const timer = setTimeout(() => stop('deadline'), timeoutMs);
  Promise.resolve().then(() => controller.signal.aborted ? null : task(controller.signal)).then(
    value => settle(value, value ? 'ready' : 'no_example'), error => {
      // An expected abort (or a late provider rejection) is not a model failure.
      if (settled) return;
      try { onError(error); } finally { settle(null, 'provider_error'); }
    }).catch(() => settle(null, 'provider_error'));
  return { result, cancel, get outcome() { return outcome; } };
}

module.exports = { startDetectPreview };
