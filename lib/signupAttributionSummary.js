'use strict';

const DAY_MS = 86400000;
const MAX_ACCOUNTS = 20000;
const PAGE_SIZE = 500;

function summaryOptions(body = {}, nowMs = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('조회 조건이 올바르지 않습니다.');
    error.status = 400;
    throw error;
  }
  const days = Number(body.days ?? 30);
  const touch = body.touch ?? 'last_touch';
  if (![7, 30, 90].includes(days) || !['first_touch', 'last_touch'].includes(touch)) {
    const error = new Error('조회 기간 또는 유입 기준이 올바르지 않습니다.');
    error.status = 400;
    throw error;
  }
  const offset = 9 * 3600000;
  const todayStart = Math.floor((nowMs + offset) / DAY_MS) * DAY_MS - offset;
  return { days, touch, since: new Date(todayStart - (days - 1) * DAY_MS).toISOString(), until: new Date(nowMs).toISOString() };
}

function label(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 250) : '';
}

function aggregateSignupAttribution(accounts, { days, touch, since, until, excludedUids = [], truncated = false } = {}) {
  const excluded = new Set(excludedUids);
  const seen = new Set();
  const groups = new Map();
  let total = 0;
  let unrecorded = 0;
  for (const account of accounts) {
    if (!account.id || excluded.has(account.id) || seen.has(account.id)) continue;
    seen.add(account.id);
    const row = account.data;
    // Account initialization stores createdAt as ISO UTC. Ignore malformed legacy records.
    const createdMs = Date.parse(row?.createdAt);
    if (!Number.isFinite(createdMs) || createdMs < Date.parse(since) || createdMs > Date.parse(until)) continue;
    total += 1;
    const attribution = row.signupAttribution?.[touch];
    const source = label(attribution?.source);
    if (!source) { unrecorded += 1; continue; }
    const dimension = { source, medium: label(attribution.medium), campaign: label(attribution.campaign), content: label(attribution.content) };
    const key = JSON.stringify(Object.values(dimension));
    const group = groups.get(key) || { ...dimension, signups: 0 };
    group.signups += 1;
    groups.set(key, group);
  }
  return {
    days, touch, since, until, generatedAt: until, truncated,
    status: truncated ? 'partial' : 'ok',
    total, recorded: total - unrecorded, unrecorded,
    groups: [...groups.values()].sort((a, b) => b.signups - a.signups || JSON.stringify(a).localeCompare(JSON.stringify(b)))
  };
}

async function scanSignupAccounts({ database, since, until, limit = MAX_ACCOUNTS }) {
  if (!database) throw new Error('Signup database is unavailable');
  const boundedLimit = Math.max(1, Math.min(MAX_ACCOUNTS, Math.floor(Number(limit)) || MAX_ACCOUNTS));
  const query = database.collection('users')
    .where('createdAt', '>=', since).where('createdAt', '<=', until)
    .orderBy('createdAt', 'desc').select('createdAt', 'signupAttribution');
  const accounts = [];
  let cursor;
  while (accounts.length <= boundedLimit) {
    const pageLimit = Math.min(PAGE_SIZE, boundedLimit + 1 - accounts.length);
    const page = await (cursor ? query.startAfter(cursor) : query).limit(pageLimit).get();
    for (const doc of page.docs) accounts.push({ id: doc.id, data: doc.data() });
    if (page.docs.length < pageLimit || accounts.length > boundedLimit) break;
    cursor = page.docs.at(-1);
  }
  return { accounts: accounts.slice(0, boundedLimit), truncated: accounts.length > boundedLimit };
}

module.exports = { summaryOptions, aggregateSignupAttribution, scanSignupAccounts, MAX_ACCOUNTS };
