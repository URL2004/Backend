'use strict';

const { logger: defaultLogger } = require('../lib/logger');
const { verifyCronRequest } = require('../lib/cronAuth');

const MODES = new Set(['off', 'shadow', 'enforce']);

function appCheckMode(env = process.env) {
  const explicit = String(env.APPCHECK_MODE || '').trim().toLowerCase();
  if (MODES.has(explicit)) return explicit;
  if (String(env.APPCHECK_ENFORCE || '').trim() === '1') return 'enforce';
  return 'shadow';
}

function bearerToken(req) {
  const raw = String(req?.get?.('authorization') || '').trim();
  const match = raw.match(/^Bearer\s+(.+)$/iu);
  return match ? match[1].trim() : '';
}

function firebaseIdToken(req) {
  const headerToken = bearerToken(req);
  if (headerToken) return headerToken;
  const compatibilityToken = typeof req?.body?.idToken === 'string' ? req.body.idToken.trim() : '';
  return compatibilityToken.length <= 8192 ? compatibilityToken : '';
}

function createAppCheckProtection({
  verifyAppCheck,
  verifyFirebaseIdToken,
  adminUids = [],
  logger = defaultLogger,
  allowAdmin = true,
  allowCron = false,
  cronSecret = undefined,
  mode = null
} = {}) {
  return async function appCheckProtection(req, res, next) {
    if (req.method === 'OPTIONS' || req.method === 'GET' || req.method === 'HEAD') return next();
    const activeMode = mode || appCheckMode();
    if (activeMode === 'off') {
      req.appCheck = { status: 'off' };
      return next();
    }

    const token = String(req.get('x-firebase-appcheck') || '').trim();
    if (token && typeof verifyAppCheck === 'function' && await verifyAppCheck(token)) {
      req.appCheck = { status: 'valid' };
      return next();
    }

    if (allowAdmin && typeof verifyFirebaseIdToken === 'function') {
      const idToken = firebaseIdToken(req);
      if (idToken) {
        try {
          const decoded = await verifyFirebaseIdToken(idToken);
          if (decoded?.uid && adminUids.includes(decoded.uid)) {
            req.appCheck = { status: 'exempt_admin' };
            return next();
          }
        } catch (_) {
          // App Check enforcement still decides the response. Do not log the token or auth error.
        }
      }
    }

    if (allowCron) {
      const cron = verifyCronRequest(req, {
        secret: cronSecret,
        allowBearer: true,
        allowBody: false,
        allowQuery: false
      });
      if (cron.ok) {
        req.appCheck = { status: 'exempt_cron' };
        return next();
      }
    }

    const reason = token ? 'invalid' : 'missing';
    req.appCheck = { status: activeMode === 'shadow' ? `shadow_${reason}` : reason };
    logger.warn(activeMode === 'shadow' ? 'security.app_check_shadow_rejected' : 'security.app_check_rejected', {
      path: req.originalUrl || req.path,
      method: req.method,
      reason,
      noAlert: activeMode === 'shadow'
    });
    if (activeMode === 'shadow') return next();
    return res.status(401).json({
      ok: false,
      code: 'APP_CHECK_REQUIRED',
      error: '안전한 앱 연결을 확인하지 못했어요. 화면을 새로고침한 뒤 다시 시도해 주세요.'
    });
  };
}

module.exports = {
  appCheckMode,
  bearerToken,
  firebaseIdToken,
  createAppCheckProtection
};
