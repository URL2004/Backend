// Meta Conversions API relay.
// Product input/output text is never accepted here; callers provide a strict analytics allow-list only.
const crypto = require('crypto');
const { logger } = require('./logger');

const DEFAULT_DATASET_ID = '1575815300659999';
const DEFAULT_GRAPH_VERSION = 'v23.0';
const ALLOWED_ORIGINS = new Set(['https://gpkorea.ai.kr', 'https://www.gpkorea.ai.kr']);

function clean(value, max = 250) {
  return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function sha256(value) {
  const normalized = clean(value, 500).toLowerCase();
  return normalized ? crypto.createHash('sha256').update(normalized).digest('hex') : '';
}

// Kept byte-for-byte compatible with the browser helper for signup Pixel/CAPI deduplication.
function stableEventId(eventName, stableKey) {
  const name = clean(eventName, 40).replace(/[^a-z0-9_]+/gi, '_') || 'event';
  const key = String(stableKey == null ? '' : stableKey);
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `gp_${name}_${(hash >>> 0).toString(16)}`;
}

function safeEventId(value) {
  const eventId = clean(value, 180);
  return /^[a-z0-9_.:-]{6,180}$/i.test(eventId) ? eventId : '';
}

function safeSourceUrl(value) {
  try {
    const parsed = new URL(clean(value, 1000));
    if (!ALLOWED_ORIGINS.has(parsed.origin)) return '';
    const kept = new URLSearchParams();
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid']) {
      const item = clean(parsed.searchParams.get(key), key === 'fbclid' || key === 'gclid' ? 220 : 150);
      if (item) kept.set(key, item);
    }
    parsed.search = kept.toString();
    parsed.hash = '';
    return parsed.toString().slice(0, 1000);
  } catch (_) {
    return '';
  }
}

function safeMetaCookie(value) {
  const cookie = clean(value, 300);
  return /^fb\.\d+\.\d+\.[A-Za-z0-9._-]+$/.test(cookie) ? cookie : '';
}

function normalizeContext(input) {
  const value = input && typeof input === 'object' ? input : {};
  return {
    fbp: safeMetaCookie(value.fbp),
    fbc: safeMetaCookie(value.fbc),
    sourceUrl: safeSourceUrl(value.sourceUrl || value.eventSourceUrl),
    trafficSource: clean(value.trafficSource || value.traffic_source, 100),
    trafficMedium: clean(value.trafficMedium || value.traffic_medium, 100),
    trafficCampaign: clean(value.trafficCampaign || value.traffic_campaign, 150),
    trafficContent: clean(value.trafficContent || value.traffic_content, 150),
    trafficTerm: clean(value.trafficTerm || value.traffic_term, 150)
  };
}

function buildUserData({ email, externalId, clientIp, userAgent, context }) {
  const meta = normalizeContext(context);
  const userData = {};
  const emailHash = sha256(email);
  const externalHash = sha256(externalId);
  if (emailHash) userData.em = [emailHash];
  if (externalHash) userData.external_id = [externalHash];
  if (clean(clientIp, 100)) userData.client_ip_address = clean(clientIp, 100);
  if (clean(userAgent, 500)) userData.client_user_agent = clean(userAgent, 500);
  if (meta.fbp) userData.fbp = meta.fbp;
  if (meta.fbc) userData.fbc = meta.fbc;
  return userData;
}

function buildEvent({ eventName, eventId, eventTime, email, externalId, clientIp, userAgent, context, customData }) {
  const normalizedContext = normalizeContext(context);
  const normalizedEventId = safeEventId(eventId);
  if (!normalizedEventId) throw new Error('META_EVENT_ID_INVALID');
  const event = {
    event_name: clean(eventName, 80),
    event_time: Number.isFinite(Number(eventTime)) ? Math.floor(Number(eventTime)) : Math.floor(Date.now() / 1000),
    event_id: normalizedEventId,
    action_source: 'website',
    user_data: buildUserData({ email, externalId, clientIp, userAgent, context: normalizedContext })
  };
  if (normalizedContext.sourceUrl) event.event_source_url = normalizedContext.sourceUrl;
  if (customData && typeof customData === 'object') event.custom_data = customData;
  return event;
}

function enabled() {
  return !!clean(process.env.META_CAPI_ACCESS_TOKEN, 4096);
}

async function send(event) {
  if (!enabled()) return { ok: false, skipped: 'META_CAPI_ACCESS_TOKEN_MISSING' };
  const datasetId = clean(process.env.META_DATASET_ID || DEFAULT_DATASET_ID, 40);
  const graphVersion = clean(process.env.META_GRAPH_API_VERSION || DEFAULT_GRAPH_VERSION, 20);
  const accessToken = clean(process.env.META_CAPI_ACCESS_TOKEN, 4096);
  const timeoutMs = Math.min(5000, Math.max(500, Number(process.env.META_CAPI_TIMEOUT_MS) || 2500));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const body = { data: [event] };
  const testEventCode = clean(process.env.META_CAPI_TEST_EVENT_CODE, 100);
  if (testEventCode) body.test_event_code = testEventCode;

  try {
    const response = await fetch(
      `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(datasetId)}/events?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );
    let result = {};
    try { result = await response.json(); } catch (_) {}
    if (!response.ok) {
      logger.warn('meta.capi_rejected', {
        eventName: event.event_name,
        eventId: event.event_id,
        status: response.status,
        code: result?.error?.code,
        subcode: result?.error?.error_subcode
      });
      return { ok: false, status: response.status };
    }
    logger.info('meta.capi_sent', {
      eventName: event.event_name,
      eventId: event.event_id,
      eventsReceived: result.events_received
    });
    return { ok: true, eventsReceived: result.events_received };
  } catch (err) {
    logger.warn('meta.capi_failed', {
      eventName: event.event_name,
      eventId: event.event_id,
      reason: err?.name === 'AbortError' ? 'timeout' : err
    });
    return { ok: false, timeout: err?.name === 'AbortError' };
  } finally {
    clearTimeout(timeout);
  }
}

function sendCompleteRegistration(input) {
  return send(buildEvent({
    ...input,
    eventName: 'CompleteRegistration',
    customData: {
      content_name: 'account_registration',
      status: true,
      traffic_source: clean(input?.context?.trafficSource || input?.context?.traffic_source, 100),
      traffic_campaign: clean(input?.context?.trafficCampaign || input?.context?.traffic_campaign, 150)
    }
  }));
}

function sendPurchase(input) {
  const value = Math.max(0, Number(input?.value) || 0);
  const itemId = clean(input?.itemId, 100) || 'purchase';
  return send(buildEvent({
    ...input,
    eventName: 'Purchase',
    customData: {
      currency: 'KRW',
      value,
      order_id: clean(input?.orderId, 150),
      content_type: 'product',
      content_ids: [itemId],
      contents: [{ id: itemId, quantity: 1, item_price: value }]
    }
  }));
}

module.exports = {
  enabled,
  normalizeContext,
  safeSourceUrl,
  sendCompleteRegistration,
  sendPurchase,
  sha256,
  stableEventId,
  _private: { buildEvent, buildUserData, safeEventId, safeMetaCookie }
};
