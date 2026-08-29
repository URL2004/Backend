const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50
};

const LEVEL_NAMES = Object.keys(LEVELS);
const DEFAULT_LEVEL = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
const configuredLevel = String(process.env.LOG_LEVEL || DEFAULT_LEVEL).toLowerCase();
const minLevel = LEVELS[configuredLevel] || LEVELS.info;
const LOG_FORMAT = String(process.env.LOG_FORMAT || 'json').toLowerCase();
const MAX_STRING = Number(process.env.LOG_MAX_STRING) || 2000;
const MAX_ARRAY = Number(process.env.LOG_MAX_ARRAY) || 30;
const MAX_DEPTH = Number(process.env.LOG_MAX_DEPTH) || 6;

const SENSITIVE_KEY_RE = /(^|_|\b)(authorization|cookie|password|secret|idtoken|access_token|refresh_token|paymentkey|billingkey|authkey|customerkey|cardnumber|email|phone)(_|$|\b)/i;
const EMAIL_RE = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/;

function nowIso() {
  return new Date().toISOString();
}

function currentContext() {
  return storage.getStore() || {};
}

function runWithLogContext(context, fn) {
  return storage.run({ ...(context || {}) }, fn);
}

function setLogContext(patch) {
  const ctx = storage.getStore();
  if (!ctx || !patch || typeof patch !== 'object') return;
  Object.assign(ctx, patch);
}

function maskString(value) {
  const s = String(value);
  if (!s) return s;
  if (EMAIL_RE.test(s)) {
    return s.replace(EMAIL_RE, (_, head, domain) => {
      const safeHead = head.length <= 2 ? `${head[0] || '*'}*` : `${head.slice(0, 2)}***`;
      return `${safeHead}@${domain}`;
    });
  }
  if (s.length <= 10) return '***';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function serializeError(err) {
  if (!err) return undefined;
  if (typeof err === 'string') return { message: err };
  return {
    name: err.name || 'Error',
    message: err.message || String(err),
    code: err.code,
    status: err.status || err.statusCode,
    stack: process.env.LOG_STACKS === '1' ? err.stack : undefined
  };
}

function sanitize(value, depth = 0, key = '') {
  if (value === null || value === undefined) return value;
  if (SENSITIVE_KEY_RE.test(key)) return maskString(value);
  if (value instanceof Error) return serializeError(value);
  if (depth >= MAX_DEPTH) return '[MaxDepth]';

  if (typeof value === 'string') {
    if (EMAIL_RE.test(value)) return maskString(value);
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated ${value.length - MAX_STRING}]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v, i) => sanitize(v, depth + 1, String(i)));
    if (value.length > MAX_ARRAY) out.push(`[+${value.length - MAX_ARRAY} more]`);
    return out;
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = sanitize(v, depth + 1, k);
    }
    return out;
  }

  return String(value);
}

function baseRecord(level, event, fields) {
  const ctx = currentContext();
  return sanitize({
    ts: nowIso(),
    level,
    service: process.env.SERVICE_NAME || process.env.RENDER_SERVICE_NAME || 'ai-backend',
    env: process.env.APP_ENV || process.env.NODE_ENV || 'local',
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT,
    event,
    ...ctx,
    ...(fields || {})
  });
}

function write(record) {
  if (LOG_FORMAT === 'pretty') {
    const { ts, level, event, message, ...rest } = record;
    const restText = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    process.stdout.write(`[${ts}] ${String(level).toUpperCase()} ${event}${message ? ` - ${message}` : ''}${restText}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

// ── 장애 감지 연동(2026-08-29 개편) ───────────────────────────────────────
// 이전에는 "level이 error/fatal인가"만 보고 Discord로 보냈다. 그래서 결제 실패 대부분(warn)이
// 한 건도 알림되지 않았고, 반대로 미출시 기능의 일상적 실패가 돈 사고와 똑같이 표시됐다.
// 이제 level(기록 여부)과 severity(깨울지 여부)를 분리한다 — 등급은 lib/opsEvents 카탈로그가 정한다.
// 세 모듈 모두 logger를 require하지 않으므로 순환 없음. 미설정 시 전부 no-op이라 항상 안전하다.
let _discord;
let _opsLog;
let _opsEvents;
function lazy(name, cache) {
  if (cache.v === undefined) { try { cache.v = require(name); } catch (_) { cache.v = null; } }
  return cache.v;
}
const _dCache = {}, _lCache = {}, _eCache = {};

function notifyOps(record, level) {
  try {
    const opsEvents = (_opsEvents = lazy('./opsEvents', _eCache));
    if (!opsEvents) return;
    // 고빈도 경로(info 접근 로그) 조기 탈출 — 카탈로그에 없는 info/warn/debug는 볼 일이 없다.
    if (level !== 'error' && level !== 'fatal' && !opsEvents.CATALOG[record.event]) return;

    const classification = opsEvents.classify(record.event, level);
    if (!classification.sev) return;              // 카탈로그에 없고 error/fatal도 아니면 조용히 둔다

    // noAlert의 의미는 "Discord 중복 발송 금지"이지 "기록 금지"가 아니다.
    //  · 접근 로그(http.request 5xx): 라우트가 별도 error를 남기므로 알림은 중복이지만, 기록은 5xx 급증 탐지에 쓰인다.
    //  · 과금 실패(transform.*_manual_action): 바로 앞에서 discord.billingFailure를 직접 호출한다.
    //    예전에는 noAlert가 기록까지 막아 관리자 화면에서 이 돈 사고가 보이지 않았다.
    const opsLog = (_opsLog = lazy('./opsLog', _lCache));
    const outcome = opsLog ? opsLog.record(record, classification) : { merged: false, surge: null };

    const discord = (_discord = lazy('./discord', _dCache));
    if (discord && discord.opsAlert && !record.noAlert) {
      discord.opsAlert(record, classification, {
        merged: outcome.merged,
        count: opsLog ? opsLog.groupCount(record.event, classification.sev, record) : 1
      });
    }

    // 급증(같은 도메인 실패가 창 안에서 임계 초과)은 별도 SEV1 사건으로 승격한다.
    if (outcome.surge) {
      log('error', 'ops.rate_threshold_exceeded', {
        surgeDomain: outcome.surge.domain,
        occurrences: outcome.surge.count,
        threshold: outcome.surge.threshold,
        windowMinutes: outcome.surge.windowMinutes,
        message: `${outcome.surge.domain} 도메인에서 ${outcome.surge.windowMinutes}분간 ${outcome.surge.count}건 실패(임계 ${outcome.surge.threshold})`
      });
    }
  } catch (_) { /* 알림 실패는 로깅 흐름에 영향 없음 */ }
}

function log(level, event, fields) {
  if (!LEVELS[level] || LEVELS[level] < minLevel) return;
  const normalizedEvent = typeof event === 'string' && event.trim() ? event.trim() : 'log';
  const record = baseRecord(level, normalizedEvent, fields);
  write(record);
  notifyOps(record, level);
}

function child(baseFields) {
  const merge = (fields) => ({ ...(baseFields || {}), ...(fields || {}) });
  return {
    debug: (event, fields) => log('debug', event, merge(fields)),
    info: (event, fields) => log('info', event, merge(fields)),
    warn: (event, fields) => log('warn', event, merge(fields)),
    error: (event, fields) => log('error', event, merge(fields)),
    fatal: (event, fields) => log('fatal', event, merge(fields)),
    child: (extra) => child({ ...(baseFields || {}), ...(extra || {}) })
  };
}

const logger = {
  debug: (event, fields) => log('debug', event, fields),
  info: (event, fields) => log('info', event, fields),
  warn: (event, fields) => log('warn', event, fields),
  error: (event, fields) => log('error', event, fields),
  fatal: (event, fields) => log('fatal', event, fields),
  child
};

function captureProcessErrors() {
  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', { err: reason });
  });
  process.on('uncaughtException', (err) => {
    logger.fatal('process.uncaught_exception', { err });
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 100).unref();
  });
}

module.exports = {
  logger,
  runWithLogContext,
  setLogContext,
  currentContext,
  captureProcessErrors,
  LEVEL_NAMES
};
