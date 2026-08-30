const { logger } = require('../lib/logger');

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

function isMaintenanceEnabled() {
  return truthy(process.env.MAINTENANCE_MODE);
}

function getBypassSecret() {
  return process.env.MAINTENANCE_BYPASS_SECRET || '';
}

function getRequestSecret(req) {
  const auth = req.get('authorization') || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return (req.get('x-maintenance-bypass') || req.query?.maintenance_bypass || '').trim();
}

function hasBypass(req) {
  const secret = getBypassSecret();
  if (!secret) return false;
  return getRequestSecret(req) === secret;
}

function isAllowedWithoutBypass(req) {
  if (req.method === 'OPTIONS') return true;
  const path = req.path || req.originalUrl || '';
  if (path === '/healthz' || path === '/api/health' || path === '/internal/health') return true;
  if (path === '/kakao-login') return true;
  if (req.method === 'GET' && path === '/subscription/status') return true;
  return false;
}

function isProtectedDuringMaintenance(req) {
  const path = req.path || req.originalUrl || '';
  const protectedExact = new Set([
    '/confirm-payment',
    '/request-refund',
    '/approve-refund',
    '/reject-refund',
    '/redeem-coupon',
    '/apply-referral',
    '/delete-account',
    '/diagnose',
    '/detect-report',
    '/analyze',
    '/analyze-pdf',
    '/toss/webhook'
  ]);
  if (protectedExact.has(path)) return true;
  return [
    '/transform',
    '/subscription',
    '/admin/'
  ].some(prefix => path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix));
}

function maintenanceMode(req, res, next) {
  if (!isMaintenanceEnabled()) return next();
  if (isAllowedWithoutBypass(req)) return next();
  if (!isProtectedDuringMaintenance(req)) return next();
  if (hasBypass(req)) {
    logger.info('maintenance.bypassed', { path: req.path, method: req.method });
    return next();
  }
  logger.warn('maintenance.blocked', { path: req.path, method: req.method });
  return res.status(503).json({
    ok: false,
    error: 'maintenance_mode',
    message: '서비스 점검 중입니다. 잠시 후 다시 시도해주세요.'
  });
}

maintenanceMode.isMaintenanceEnabled = isMaintenanceEnabled;
maintenanceMode.hasBypass = hasBypass;

module.exports = maintenanceMode;
