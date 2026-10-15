'use strict';

// Remote token fencing protects writes. This watchdog separately stops local
// provider work if a renewal RPC hangs or returns after ownership has expired.
function guardExecutionLease({ coordinator, lease, controller, onLost = () => {},
  clock = Date.now, timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  renewalIntervalMs = 20000, renewalTimeoutMs = 10000, expiryMarginMs = 1000 }) {
  let stopped = false, pending = false, expiryTimer, renewalTimer, interval;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    timers.clearTimeout(expiryTimer); timers.clearTimeout(renewalTimer); timers.clearInterval(interval);
    controller.signal.removeEventListener('abort', stop);
  };
  const lost = () => {
    if (stopped) return;
    stop();
    try { onLost(lease); } catch (_) { /* Observers must not prevent cancellation or escape a timer. */ } finally {
      controller.abort(Object.assign(new Error('Execution lease lost'), { code: 'EXECUTION_LEASE_LOST' }));
    }
  };
  const armExpiry = () => {
    timers.clearTimeout(expiryTimer);
    const remaining = Number(lease.expiresAtMs) - clock() - expiryMarginMs;
    if (!(remaining > 0)) { lost(); return; }
    expiryTimer = timers.setTimeout(lost, remaining);
  };
  const renew = () => {
    if (stopped || pending) return;
    pending = true;
    renewalTimer = timers.setTimeout(lost, renewalTimeoutMs);
    Promise.resolve().then(() => coordinator.renew(lease)).then(ok => {
      if (stopped) return;
      if (!ok) lost(); else armExpiry();
    }, lost).finally(() => { pending = false; timers.clearTimeout(renewalTimer); });
  };
  controller.signal.addEventListener('abort', stop, { once: true });
  if (controller.signal.aborted) stop();
  else {
    armExpiry();
    if (!stopped) interval = timers.setInterval(renew, renewalIntervalMs);
  }
  return stop;
}

module.exports = { guardExecutionLease };
