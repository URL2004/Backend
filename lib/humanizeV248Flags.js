'use strict';

const V248_FEATURE_FLAGS = Object.freeze({
  sectionRecovery: 'HUMANIZE_SECTION_RECOVERY_ENABLED',
  fingerprintAudit: 'HUMANIZE_FINGERPRINT_AUDIT_ENABLED',
  effectConfirmation: 'HUMANIZE_EFFECT_CONFIRMATION_ENABLED',
  billingProtection: 'HUMANIZE_BILLING_PROTECTION_ENABLED'
});

function isV248FeatureEnabled(name) {
  const envName = V248_FEATURE_FLAGS[name] || name;
  const raw = process.env[envName];
  if (raw == null || String(raw).trim() === '') return true;
  return String(raw).trim() === '1';
}

module.exports = {
  V248_FEATURE_FLAGS,
  isV248FeatureEnabled
};
