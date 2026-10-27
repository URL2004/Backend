'use strict';

const crypto = require('node:crypto');
const DELAY_MESSAGE = '현재 요청 처리가 지연되고 있습니다. 잠시만 기다려 주세요.';
const PAUSE_MS = 60000;
// Longer than the HTTP attempt ceiling. A dead probe owner cannot hold the
// circuit forever; another instance can take over after this lease expires.
const PROBE_MS = 320000;
const isUnavailable = error => ['OPENAI_QUOTA_EXHAUSTED', 'PROVIDER_RECOVERY_PENDING'].includes(error?.code);
const publicFailure = error => ({ ok: false, code: 'SERVICE_TEMPORARILY_UNAVAILABLE',
  error: DELAY_MESSAGE + ' 크레딧·이용권은 차감되지 않았어요. 잠시 후 다시 시도해 주세요.',
  charged: 0, retryable: true, retryAfterSeconds: Math.max(1, Math.ceil((Number(error?.retryAtMs) - Date.now()) / 1000) || 60) });
const unavailable = retryAtMs => Object.assign(new Error(DELAY_MESSAGE), {
  code: 'OPENAI_QUOTA_EXHAUSTED', status: 503, retryable: false, retryAtMs
});
async function bounded(operation) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Availability storage timeout'), { code: 'AVAILABILITY_TIMEOUT' })), 1500);
  })]); } finally { clearTimeout(timer); }
}

// The store exposes read() and an atomic update(fn). No user text, credentials
// or customer billing state is stored in this operational circuit.
function createProviderAvailability({ store, clock = Date.now, pauseMs = PAUSE_MS,
  probeMs = PROBE_MS, cacheMs = 5000, onError = () => {} } = {}) {
  let cached = null, expires = 0, reading = null;
  const remember = state => { cached = state || null; expires = clock() + cacheMs; return cached; };
  async function snapshot() {
    if (!store || clock() < expires) return cached;
    if (reading) return reading;
    const prior = cached;
    reading = bounded(() => store.read()).then(state => {
      // A read started before a quota response must not erase the new pause.
      if (cached === prior && !(cached?.open && cached.retryAtMs > clock()
          && Number(state?.updatedAtMs || 0) < Number(cached.updatedAtMs || 0))) remember(state);
      return cached;
    }).catch(error => { onError(error); expires = clock() + cacheMs; return cached; })
      .finally(() => { reading = null; });
    return reading;
  }
  async function beforeRequest() {
    const state = await snapshot();
    if (!state?.open) return null;
    if (Number(state.retryAtMs) > clock()) throw unavailable(state.retryAtMs);
    let ticket;
    try {
      const now = clock(), token = crypto.randomUUID();
      const result = await bounded(() => store.update(current => {
        if (!current?.open) return { state: current, value: null };
        if (current.retryAtMs > now) return { state: current, value: false };
        return { state: { ...current, probeId: token, retryAtMs: now + probeMs },
          value: { version: current.version, probeId: token } };
      }));
      remember(result.state); ticket = result.value;
    } catch (error) {
      onError(error);
      throw unavailable(clock() + pauseMs);
    }
    if (ticket === false) throw unavailable(cached?.retryAtMs || clock() + pauseMs);
    return ticket;
  }
  async function quota() {
    const now = clock(), version = crypto.randomUUID();
    if (!store) return now + pauseMs; // Standalone engine tests have no shared service circuit.
    const next = { open: true, version, sinceMs: cached?.sinceMs || now,
      retryAtMs: now + pauseMs, probeId: null, updatedAtMs: now };
    remember(next); // Immediate local stop even if operational storage fails.
    try {
      if (store) await bounded(() => store.update(current => ({ state: { ...next, sinceMs: current?.open ? current.sinceMs : now }, value: null })));
    } catch (error) { onError(error); }
    return next.retryAtMs;
  }
  async function settle(ticket, ok) {
    // An ordinary request that began before an outage cannot close its circuit.
    if (!ticket || !store) return;
    try {
      const result = await bounded(() => store.update(current => {
        if (!current?.open || current.version !== ticket.version || current.probeId !== ticket.probeId)
          return { state: current, value: null };
        return { state: ok ? { open: false, updatedAtMs: clock() } : {
          ...current, probeId: null, retryAtMs: clock() + pauseMs, updatedAtMs: clock()
        }, value: null };
      }));
      remember(result.state);
    } catch (error) { onError(error); }
  }
  async function checkAdmission() {
    const state = await snapshot();
    if (state?.open && state.retryAtMs > clock()) throw unavailable(state.retryAtMs);
    return state;
  }
  return { snapshot, beforeRequest, quota, settle, checkAdmission,
    peek: () => cached };
}

let circuit = createProviderAvailability();
function configure({ db, logger, key = process.env.OPENAI_API_KEY,
  base = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1' } = {}) {
  if (!db || !key) return;
  const id = crypto.createHash('sha256').update(base + '\0' + key).digest('hex');
  const ref = db.collection('providerAvailability').doc(id);
  const store = {
    read: async () => { const snap = await ref.get(); return snap.exists ? snap.data() : null; },
    update: fn => db.runTransaction(async tx => {
      const snap = await tx.get(ref), current = snap.exists ? snap.data() : null;
      const result = fn(current);
      if (result.state !== current) tx.set(ref, result.state);
      return result;
    })
  };
  circuit = createProviderAvailability({ store, onError: error =>
    logger?.warn('provider.availability_store_unavailable', { code: error?.code || 'storage_error' }) });
}

module.exports = { createProviderAvailability, configure, isUnavailable, publicFailure, DELAY_MESSAGE,
  beforeRequest: () => circuit.beforeRequest(), quota: () => circuit.quota(),
  settle: (ticket, ok) => circuit.settle(ticket, ok), snapshot: () => circuit.snapshot(),
  checkAdmission: () => circuit.checkAdmission(), peek: () => circuit.peek() };
