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

// 장애 알림 연동(선택): error/fatal 로그를 Discord alert 채널로도 보냄.
// discord 모듈은 logger를 require하지 않으므로 순환 없음. 미설정 시 no-op이라 항상 안전.
let _discord;
function discordAlert(record) {
  try {
    if (_discord === undefined) { try { _discord = require('./discord'); } catch (_) { _discord = null; } }
    if (_discord && _discord.alertFromLog) _discord.alertFromLog(record);
  } catch (_) { /* 알림 실패는 로깅 흐름에 영향 없음 */ }
}

function log(level, event, fields) {
  if (!LEVELS[level] || LEVELS[level] < minLevel) return;
  const normalizedEvent = typeof event === 'string' && event.trim() ? event.trim() : 'log';
  const record = baseRecord(level, normalizedEvent, fields);
  write(record);
  if (level === 'error' || level === 'fatal') discordAlert(record);
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
