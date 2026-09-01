'use strict';

const crypto = require('node:crypto');

const SIGNUP_CREDIT_EVENT_COLLECTION = 'signupCreditEvents';
const SIGNUP_CREDIT_EVENT_SCHEMA_VERSION = 1;
const SIGNUP_CREDIT_GRANT_SCHEMA_VERSION = 1;
const DEFAULT_MAX_EVENTS = 20_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_WINDOW_MS = 7 * DAY_MS;
const EVENT_RETENTION_DAYS = 30;
const EVENT_RETENTION_MS = EVENT_RETENTION_DAYS * DAY_MS;

const PRINCIPAL_THRESHOLDS = Object.freeze({
  soft: Object.freeze({ hourly: 5, daily: 25 }),
  hard: Object.freeze({ hourly: 10, daily: 50 })
});

const EVENT_TYPES = new Set(['grant', 'spend', 'restore']);
const KEY_PATTERN = /^(?:account|principal)_v1_[a-f0-9]{32}$/u;
const DIMENSION_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/u;

function boundedInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function measurementKey(kind, value) {
  const input = String(value || '').trim();
  if (!input) throw new Error(`signup credit ${kind} key requires a value`);
  const digest = crypto.createHash('sha256')
    .update(`signup-credit-${kind}:v1`, 'utf8')
    .update('\0', 'utf8')
    .update(input, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `${kind}_v1_${digest}`;
}

function signupCreditAccountKey(uid) {
  return measurementKey('account', uid);
}

function signupCreditPrincipalKey(clientPrincipal) {
  return measurementKey('principal', clientPrincipal);
}

function signupCreditEventId(eventType, accountKey, sourceKey) {
  const type = EVENT_TYPES.has(eventType) ? eventType : 'unknown';
  const digest = crypto.createHash('sha256')
    .update('signup-credit-event:v1', 'utf8')
    .update('\0', 'utf8')
    .update(String(accountKey || ''), 'utf8')
    .update('\0', 'utf8')
    .update(type, 'utf8')
    .update('\0', 'utf8')
    .update(String(sourceKey || ''), 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `${type}_${digest}`;
}

function normalizeDimension(value, fallback = 'unknown') {
  const normalized = String(value || '').trim().toLowerCase();
  return DIMENSION_PATTERN.test(normalized) ? normalized : fallback;
}

function createSignupCreditGrantMetadata({ grantCredits, nowMs }) {
  const credits = boundedInteger(grantCredits);
  const occurredAtMs = boundedInteger(nowMs);
  return {
    schemaVersion: SIGNUP_CREDIT_GRANT_SCHEMA_VERSION,
    grantCredits: credits,
    remainingCredits: credits,
    netUsedCredits: 0,
    spendEventCount: 0,
    restoreEventCount: 0,
    grantedAtMs: occurredAtMs,
    lastEventAtMs: occurredAtMs,
    source: 'account_initialize_v1'
  };
}

function signupCreditGrantState(userData) {
  const raw = userData && typeof userData.signupCreditGrant === 'object'
    ? userData.signupCreditGrant
    : null;
  if (!raw || Number(raw.schemaVersion) !== SIGNUP_CREDIT_GRANT_SCHEMA_VERSION) return null;
  const grantCredits = boundedInteger(raw.grantCredits);
  if (grantCredits <= 0) return null;
  const remainingCredits = boundedInteger(raw.remainingCredits, { max: grantCredits });
  return { raw, grantCredits, remainingCredits };
}

function nextGrantMetadata(state, remainingCredits, nowMs, eventType) {
  const remaining = boundedInteger(remainingCredits, { max: state.grantCredits });
  return {
    ...state.raw,
    schemaVersion: SIGNUP_CREDIT_GRANT_SCHEMA_VERSION,
    grantCredits: state.grantCredits,
    remainingCredits: remaining,
    netUsedCredits: state.grantCredits - remaining,
    spendEventCount: boundedInteger(state.raw.spendEventCount) + (eventType === 'spend' ? 1 : 0),
    restoreEventCount: boundedInteger(state.raw.restoreEventCount) + (eventType === 'restore' ? 1 : 0),
    lastEventAtMs: boundedInteger(nowMs),
    ...(eventType === 'spend' ? { lastSpentAtMs: boundedInteger(nowMs) } : {}),
    ...(eventType === 'restore' ? { lastRestoredAtMs: boundedInteger(nowMs) } : {})
  };
}

function allocateSignupCreditSpend({ userData, untrackedCredits, untrackedAvailable, nowMs }) {
  const state = signupCreditGrantState(userData);
  if (!state) return { credits: 0, metadata: null };
  // Signup credit is the oldest untracked allocation on a newly initialized
  // account. It is consumed first, but never beyond the amount the lot policy
  // already classified as untracked.
  const eligible = Math.min(state.remainingCredits, boundedInteger(untrackedAvailable));
  const credits = Math.min(eligible, boundedInteger(untrackedCredits));
  if (credits <= 0) return { credits: 0, metadata: null };
  return {
    credits,
    metadata: nextGrantMetadata(state, state.remainingCredits - credits, nowMs, 'spend')
  };
}

function allocateSignupCreditRestore({ userData, untrackedCredits, deductHistory, nowMs }) {
  const state = signupCreditGrantState(userData);
  if (!state || !deductHistory) return { credits: 0, metadata: null };
  const originallyUsed = boundedInteger(deductHistory.signupGrantCreditsUsed);
  const previouslyRestored = boundedInteger(deductHistory.signupGrantCreditsRestored, { max: originallyUsed });
  const unrestored = Math.max(0, originallyUsed - previouslyRestored);
  const capacity = Math.max(0, state.grantCredits - state.remainingCredits);
  const credits = Math.min(unrestored, capacity, boundedInteger(untrackedCredits));
  if (credits <= 0) return { credits: 0, metadata: null };
  return {
    credits,
    totalRestoredForDeduct: previouslyRestored + credits,
    metadata: nextGrantMetadata(state, state.remainingCredits + credits, nowMs, 'restore')
  };
}

function buildSignupCreditEvent({
  eventType,
  accountKey,
  principalKey,
  creditAmount,
  signupCreditsRemaining,
  accountCreditsRemaining,
  op,
  mode,
  occurredAtMs,
  occurredAt
}) {
  if (!EVENT_TYPES.has(eventType)) throw new Error('invalid signup credit event type');
  if (!KEY_PATTERN.test(String(accountKey || ''))) throw new Error('invalid signup credit account key');
  const safeOccurredAtMs = boundedInteger(occurredAtMs);
  if (safeOccurredAtMs <= 0) throw new Error('invalid signup credit event time');
  const event = {
    schemaVersion: SIGNUP_CREDIT_EVENT_SCHEMA_VERSION,
    eventType,
    accountKey,
    creditAmount: boundedInteger(creditAmount),
    signupCreditsRemaining: boundedInteger(signupCreditsRemaining),
    accountCreditsRemaining: boundedInteger(accountCreditsRemaining),
    op: normalizeDimension(op),
    mode: normalizeDimension(mode, 'none'),
    occurredAtMs: safeOccurredAtMs,
    occurredAt,
    // Firestore TTL requires a Timestamp-compatible field. Admin SDK converts a
    // JavaScript Date to Timestamp while keeping the event query on occurredAtMs.
    expireAt: new Date(safeOccurredAtMs + EVENT_RETENTION_MS)
  };
  if (principalKey != null) {
    if (!KEY_PATTERN.test(String(principalKey || '')) || !String(principalKey).startsWith('principal_v1_')) {
      throw new Error('invalid signup credit principal key');
    }
    event.principalKey = principalKey;
  }
  return event;
}

function eventTimestampMs(value) {
  if (Number.isFinite(Number(value))) return boundedInteger(value);
  if (typeof value?.toMillis === 'function') return boundedInteger(value.toMillis());
  if (typeof value?.toDate === 'function') return boundedInteger(value.toDate()?.getTime());
  if (Number.isFinite(Number(value?._seconds))) return boundedInteger(Number(value._seconds) * 1000);
  return 0;
}

function normalizeEvent(row, nowMs) {
  if (!row || Number(row.schemaVersion) !== SIGNUP_CREDIT_EVENT_SCHEMA_VERSION) return null;
  const eventType = String(row.eventType || '');
  const accountKey = String(row.accountKey || '');
  const occurredAtMs = eventTimestampMs(row.occurredAtMs || row.occurredAt);
  if (!EVENT_TYPES.has(eventType) || !KEY_PATTERN.test(accountKey) || occurredAtMs <= 0 || occurredAtMs > nowMs) {
    return null;
  }
  const principalKey = String(row.principalKey || '');
  return {
    eventType,
    accountKey,
    ...(KEY_PATTERN.test(principalKey) && principalKey.startsWith('principal_v1_') ? { principalKey } : {}),
    creditAmount: boundedInteger(row.creditAmount),
    signupCreditsRemaining: boundedInteger(row.signupCreditsRemaining),
    accountCreditsRemaining: boundedInteger(row.accountCreditsRemaining),
    op: normalizeDimension(row.op),
    mode: normalizeDimension(row.mode, 'none'),
    occurredAtMs
  };
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(ratio * sorted.length) - 1);
  return sorted[index];
}

function roundedRate(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function roundedMinutes(milliseconds) {
  return milliseconds == null ? null : Number((milliseconds / 60_000).toFixed(2));
}

function countDimensions(events, field) {
  const counts = new Map();
  for (const event of events) {
    const key = normalizeDimension(event[field], field === 'mode' ? 'none' : 'unknown');
    const previous = counts.get(key) || { key, events: 0, credits: 0 };
    previous.events += 1;
    previous.credits += event.creditAmount;
    counts.set(key, previous);
  }
  return [...counts.values()].sort((a, b) => b.credits - a.credits || b.events - a.events || a.key.localeCompare(b.key));
}

function balanceBucket(remaining, grantCredits) {
  if (remaining <= 0) return 'zero';
  if (remaining === 1) return 'one';
  if (remaining <= 5) return 'two_to_five';
  if (remaining <= 10) return 'six_to_ten';
  if (remaining < grantCredits) return 'eleven_to_nineteen';
  return 'full';
}

function principalThresholdSummary(grants) {
  const hourly = new Map();
  const daily = new Map();
  const principals = new Set();
  let missingPrincipalKeys = 0;
  for (const grant of grants) {
    if (!grant.principalKey) {
      missingPrincipalKeys += 1;
      continue;
    }
    principals.add(grant.principalKey);
    const iso = new Date(grant.occurredAtMs).toISOString();
    const hourKey = `${grant.principalKey}\0${iso.slice(0, 13)}`;
    const dayKey = `${grant.principalKey}\0${iso.slice(0, 10)}`;
    hourly.set(hourKey, (hourly.get(hourKey) || 0) + 1);
    daily.set(dayKey, (daily.get(dayKey) || 0) + 1);
  }
  const threshold = (buckets, value) => {
    const matching = [...buckets.entries()].filter(([, count]) => count >= value);
    return {
      threshold: value,
      bucketsAtOrAbove: matching.length,
      principalsAtOrAbove: new Set(matching.map(([key]) => key.split('\0', 1)[0])).size
    };
  };
  const maximum = buckets => Math.max(0, ...buckets.values());
  return {
    uniquePrincipals: principals.size,
    missingPrincipalKeys,
    maxAccountsPerPrincipal: {
      hourly: maximum(hourly),
      daily: maximum(daily)
    },
    soft: {
      hourly: threshold(hourly, PRINCIPAL_THRESHOLDS.soft.hourly),
      daily: threshold(daily, PRINCIPAL_THRESHOLDS.soft.daily)
    },
    hard: {
      hourly: threshold(hourly, PRINCIPAL_THRESHOLDS.hard.hourly),
      daily: threshold(daily, PRINCIPAL_THRESHOLDS.hard.daily)
    }
  };
}

function completedDetectHumanize18(events, grantCredits, remainingCredits) {
  const netByStep = new Map();
  const detectStep = 'detect\0detect';
  const basicHumanizeStep = 'humanize\0blog';
  let detectObserved = false;
  let orderedPair = false;
  for (const event of events) {
    const direction = event.eventType === 'spend' ? 1 : (event.eventType === 'restore' ? -1 : 0);
    const step = `${event.op}\0${event.mode}`;
    netByStep.set(step, (netByStep.get(step) || 0) + direction * event.creditAmount);
    if (event.eventType === 'spend' && step === detectStep && event.creditAmount === 6) detectObserved = true;
    if (detectObserved && event.eventType === 'spend'
      && step === basicHumanizeStep && event.creditAmount === 12) {
      orderedPair = true;
    }
  }
  return orderedPair
    && (netByStep.get(detectStep) || 0) >= 6
    && (netByStep.get(basicHumanizeStep) || 0) >= 12
    && remainingCredits <= Math.max(0, grantCredits - 18);
}

function emptyCohort({ windowHours, sinceMs, nowMs }) {
  return {
    windowHours,
    since: new Date(sinceMs).toISOString(),
    through: new Date(nowMs).toISOString(),
    accounts: 0,
    anyUse: { accounts: 0, rate: 0 },
    firstUse: { observedAccounts: 0, medianMinutes: null, p90Minutes: null },
    remainingAtOrBelowOne: { accounts: 0, rate: 0 },
    exhausted: { accounts: 0, rate: 0 },
    detectHumanize18: { accounts: 0, rate: 0 },
    balanceBuckets: { zero: 0, one: 0, two_to_five: 0, six_to_ten: 0, eleven_to_nineteen: 0, full: 0 },
    spend: { events: 0, credits: 0, restores: 0, restoredCredits: 0, byOperation: [], byMode: [] },
    principalQuota: principalThresholdSummary([])
  };
}

function aggregateCohort(events, { windowHours, nowMs }) {
  const sinceMs = nowMs - windowHours * HOUR_MS;
  const grants = events.filter(event => event.eventType === 'grant'
    && event.occurredAtMs >= sinceMs && event.occurredAtMs <= nowMs);
  if (!grants.length) return emptyCohort({ windowHours, sinceMs, nowMs });

  const byAccount = new Map();
  for (const grant of grants) {
    const previous = byAccount.get(grant.accountKey);
    if (!previous || grant.occurredAtMs < previous.grant.occurredAtMs) {
      byAccount.set(grant.accountKey, { grant, events: [] });
    }
  }
  for (const event of events) {
    const account = byAccount.get(event.accountKey);
    if (!account || event.eventType === 'grant' || event.occurredAtMs < account.grant.occurredAtMs) continue;
    account.events.push(event);
  }

  const firstUseMs = [];
  const spendEvents = [];
  let anyUseAccounts = 0;
  let atOrBelowOne = 0;
  let exhausted = 0;
  let completed18 = 0;
  let restoreEvents = 0;
  let restoredCredits = 0;
  const balanceBuckets = emptyCohort({ windowHours, sinceMs, nowMs }).balanceBuckets;
  for (const account of byAccount.values()) {
    account.events.sort((a, b) => a.occurredAtMs - b.occurredAtMs);
    const spends = account.events.filter(event => event.eventType === 'spend' && event.creditAmount > 0);
    const restores = account.events.filter(event => event.eventType === 'restore' && event.creditAmount > 0);
    spendEvents.push(...spends);
    restoreEvents += restores.length;
    restoredCredits += restores.reduce((sum, event) => sum + event.creditAmount, 0);
    if (spends.length) {
      anyUseAccounts += 1;
      firstUseMs.push(Math.max(0, spends[0].occurredAtMs - account.grant.occurredAtMs));
    }
    const grantCredits = Math.max(1, account.grant.creditAmount);
    // occurredAtMs is captured before a transaction. Two distinct request IDs
    // can therefore commit in the opposite order from their timestamps, making
    // the per-event remaining snapshot non-monotonic. Deterministic event IDs
    // remove retries; the balance itself must be reconstructed from every
    // distinct delta so ordering cannot change the result.
    const spentCredits = spends.reduce((sum, event) => sum + event.creditAmount, 0);
    const accountRestoredCredits = restores.reduce((sum, event) => sum + event.creditAmount, 0);
    const remaining = Math.max(0, Math.min(
      grantCredits,
      grantCredits - spentCredits + accountRestoredCredits
    ));
    if (remaining <= 1) atOrBelowOne += 1;
    if (remaining === 0) exhausted += 1;
    balanceBuckets[balanceBucket(remaining, grantCredits)] += 1;
    if (completedDetectHumanize18(account.events, grantCredits, remaining)) completed18 += 1;
  }
  const accounts = byAccount.size;
  return {
    windowHours,
    since: new Date(sinceMs).toISOString(),
    through: new Date(nowMs).toISOString(),
    accounts,
    anyUse: { accounts: anyUseAccounts, rate: roundedRate(anyUseAccounts, accounts) },
    firstUse: {
      observedAccounts: firstUseMs.length,
      medianMinutes: roundedMinutes(percentile(firstUseMs, 0.5)),
      p90Minutes: roundedMinutes(percentile(firstUseMs, 0.9))
    },
    remainingAtOrBelowOne: { accounts: atOrBelowOne, rate: roundedRate(atOrBelowOne, accounts) },
    exhausted: { accounts: exhausted, rate: roundedRate(exhausted, accounts) },
    detectHumanize18: { accounts: completed18, rate: roundedRate(completed18, accounts) },
    balanceBuckets,
    spend: {
      events: spendEvents.length,
      credits: spendEvents.reduce((sum, event) => sum + event.creditAmount, 0),
      restores: restoreEvents,
      restoredCredits,
      byOperation: countDimensions(spendEvents, 'op'),
      byMode: countDimensions(spendEvents, 'mode')
    },
    principalQuota: principalThresholdSummary([...byAccount.values()].map(account => account.grant))
  };
}

function aggregateSignupCreditEvents(events, {
  nowMs = Date.now(),
  source = 'firestore',
  truncated = false,
  scanStatus = 'ok',
  scanned = Array.isArray(events) ? events.length : 0
} = {}) {
  const safeNowMs = boundedInteger(nowMs);
  const input = Array.isArray(events) ? events : [];
  const normalized = input.map(event => normalizeEvent(event, safeNowMs)).filter(Boolean)
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs);
  const sevenDay = aggregateCohort(normalized, { windowHours: 24 * 7, nowMs: safeNowMs });
  const status = scanStatus === 'error'
    ? 'error'
    : (truncated ? 'truncated' : (sevenDay.accounts === 0 ? 'empty' : 'ok'));
  return {
    schemaVersion: SIGNUP_CREDIT_EVENT_SCHEMA_VERSION,
    status,
    source,
    generatedAt: new Date(safeNowMs).toISOString(),
    scannedEvents: boundedInteger(scanned),
    validEvents: normalized.length,
    invalidEvents: Math.max(0, input.length - normalized.length),
    truncated: !!truncated,
    thresholds: PRINCIPAL_THRESHOLDS,
    cohorts: {
      hours24: aggregateCohort(normalized, { windowHours: 24, nowMs: safeNowMs }),
      days7: sevenDay
    }
  };
}

async function scanSignupCreditEvents({ db, sinceMs, limit = DEFAULT_MAX_EVENTS }) {
  if (!db) throw Object.assign(new Error('signup credit event store unavailable'), { code: 'STORE_UNAVAILABLE' });
  const safeLimit = boundedInteger(limit, { min: 1, max: 100_000 });
  const query = db.collection(SIGNUP_CREDIT_EVENT_COLLECTION)
    .where('occurredAtMs', '>=', boundedInteger(sinceMs))
    // When the seven-day window is larger than the read cap, retain the newest
    // partial window so a backlog cannot hide the current 24-hour cohort.
    .orderBy('occurredAtMs', 'desc')
    .limit(safeLimit + 1);
  const snapshot = await query.get();
  const docs = Array.isArray(snapshot?.docs) ? snapshot.docs : [];
  const selected = docs.slice(0, safeLimit);
  return {
    // The pure aggregator sorts again, but returning chronological input keeps
    // scanner callers deterministic and avoids exposing query-order coupling.
    events: selected.map(doc => doc.data() || {})
      .sort((a, b) => boundedInteger(a.occurredAtMs) - boundedInteger(b.occurredAtMs)),
    scanned: selected.length,
    truncated: docs.length > safeLimit,
    source: 'firestore'
  };
}

module.exports = {
  DAY_MS,
  DEFAULT_MAX_EVENTS,
  EVENT_RETENTION_DAYS,
  EVENT_RETENTION_MS,
  MAX_WINDOW_MS,
  PRINCIPAL_THRESHOLDS,
  SIGNUP_CREDIT_EVENT_COLLECTION,
  SIGNUP_CREDIT_EVENT_SCHEMA_VERSION,
  SIGNUP_CREDIT_GRANT_SCHEMA_VERSION,
  aggregateSignupCreditEvents,
  allocateSignupCreditRestore,
  allocateSignupCreditSpend,
  buildSignupCreditEvent,
  createSignupCreditGrantMetadata,
  normalizeDimension,
  scanSignupCreditEvents,
  signupCreditAccountKey,
  signupCreditEventId,
  signupCreditGrantState,
  signupCreditPrincipalKey
};
