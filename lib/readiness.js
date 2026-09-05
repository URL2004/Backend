'use strict';
function createReadiness({ probe, configured, timeoutMs = 2500, cacheMs = 10000, clock = Date.now }) {
  let cached, expires = 0, inflight;
  return async function readiness() {
    if (cached && clock() < expires) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
      let timer;
      try {
        if (!configured()) throw new Error('configuration');
        await Promise.race([Promise.resolve().then(probe), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        })]);
        cached = { ok: true, status: 'ready' };
      } catch { cached = { ok: false, status: 'unavailable' }; }
      finally { clearTimeout(timer); expires = clock() + cacheMs; }
      return cached;
    })().finally(() => { inflight = null; });
    return inflight;
  };
}
module.exports = { createReadiness };
