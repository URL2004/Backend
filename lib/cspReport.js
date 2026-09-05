'use strict';
function summarizeReport(body) {
  const report = body?.['csp-report'] || {};
  const origin = value => { try { return new URL(value).origin.slice(0, 180); } catch { return ['inline', 'eval'].includes(value) ? value : 'unknown'; } };
  return {
    directive: String(report['effective-directive'] || '').replace(/[^a-z-]/g, '').slice(0, 60),
    blockedOrigin: origin(report['blocked-uri']), documentOrigin: origin(report['document-uri']),
    disposition: report.disposition === 'enforce' ? 'enforce' : 'report', noAlert: true
  };
}
module.exports = { summarizeReport };
