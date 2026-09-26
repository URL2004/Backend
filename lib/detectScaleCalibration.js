'use strict';

// Display-scale calibration (development-only candidate).
//   Applied AFTER the model, recheck, cause ceiling, statistical assist and
//   history calibration, right before the score is shown. It never changes the
//   engine score that is cached, logged as rawProbability or used as a source
//   cap; it only maps the displayed number through a monotone piecewise-linear
//   table for inputs inside a validated scope. Default OFF. Only rule ids listed
//   in DETECT_SCALE_CALIBRATION_RULES are active.
const VERSION = 'detect-scale-calibration-v1';
const MODEL_PATH = '../engine-gpt-prod/models/detect-scale-calibration-v1.json';
const SOURCES = new Set(['llm']);
let cachedModel = null;

function enabled(value = process.env.DETECT_SCALE_CALIBRATION_ENABLED) {
  return /^(1|true|on|yes)$/iu.test(String(value ?? '').trim());
}

function enabledRules(value = process.env.DETECT_SCALE_CALIBRATION_RULES) {
  return String(value ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

function validPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Array.isArray(p) || p.length !== 2 || !p.every(v => Number.isFinite(v) && v >= 0 && v <= 100)) return false;
    if (i > 0 && (p[0] <= points[i - 1][0] || p[1] < points[i - 1][1])) return false;
  }
  return points[0][0] === 0 && points[0][1] === 0 && points[points.length - 1][0] === 100 && points[points.length - 1][1] === 100;
}

function validRule(rule) {
  if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' || !/^[a-z0-9_]{3,60}$/u.test(rule.id)) return false;
  const scope = rule.scope;
  if (!scope || typeof scope !== 'object') return false;
  if (scope.minChars !== undefined && !(Number.isSafeInteger(scope.minChars) && scope.minChars >= 0)) return false;
  if (scope.maxChars !== undefined && !(Number.isSafeInteger(scope.maxChars) && scope.maxChars >= 0)) return false;
  if (scope.minChars !== undefined && scope.maxChars !== undefined && scope.minChars > scope.maxChars) return false;
  if (scope.profiles !== undefined && !(Array.isArray(scope.profiles) && scope.profiles.length && scope.profiles.every(p => typeof p === 'string' && /^[a-z_]{3,40}$/u.test(p)))) return false;
  if (scope.sources !== undefined && !(Array.isArray(scope.sources) && scope.sources.length && scope.sources.every(s => SOURCES.has(s)))) return false;
  return validPoints(rule.points);
}

function validateModel(model) {
  return !!model && model.version === VERSION && Array.isArray(model.rules) && model.rules.length > 0
    && model.rules.every(validRule) && new Set(model.rules.map(r => r.id)).size === model.rules.length;
}

function loadModel() {
  if (!cachedModel) {
    const candidate = require(MODEL_PATH);
    if (!validateModel(candidate)) throw new Error('invalid_scale_calibration_model');
    cachedModel = candidate;
  }
  return cachedModel;
}

function mapScore(score, points) {
  const s = Math.max(0, Math.min(100, Number(score)));
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    if (s <= x1) return Math.round(y0 + (y1 - y0) * ((s - x0) / (x1 - x0)));
  }
  return Math.round(points[points.length - 1][1]);
}

function inScope(rule, { chars, profile, probSource }) {
  const scope = rule.scope;
  if (!Number.isSafeInteger(chars) || chars < 0) return false;
  if (scope.minChars !== undefined && chars < scope.minChars) return false;
  if (scope.maxChars !== undefined && chars > scope.maxChars) return false;
  if (scope.profiles && !scope.profiles.includes(String(profile || 'unknown'))) return false;
  if (scope.sources && !scope.sources.includes(String(probSource || ''))) return false;
  return true;
}

// Returns { probability, applied, meta }. meta is null when the feature is off
// or no active rule matches; the caller keeps rawProbability/engine scores as is.
function applyScaleCalibration({ probability, chars, profile, probSource = 'llm' } = {},
  { active = enabled(), rules = enabledRules(), model } = {}) {
  const before = typeof probability === 'number' ? probability : NaN;
  const base = { probability: before, applied: false, meta: null };
  if (!Number.isFinite(before) || before < 0 || before > 100 || !active || !rules.length) return base;
  let table;
  try { table = model ? (validateModel(model) ? model : null) : loadModel(); } catch { table = null; }
  if (!table) return base;
  const rule = table.rules.find(r => rules.includes(r.id) && r.status !== 'rejected_development' && inScope(r, { chars, profile, probSource }));
  if (!rule) return base;
  const after = mapScore(Math.round(before), rule.points);
  const applied = after !== Math.round(before);
  return { probability: after, applied, meta: sanitizeScaleMeta({
    version: VERSION, applied, rule: rule.id, before: Math.round(before), after, chars, profile: String(profile || 'unknown')
  }) };
}

function sanitizeScaleMeta(value) {
  if (!value || value.version !== VERSION || typeof value.rule !== 'string' || !/^[a-z0-9_]{3,60}$/u.test(value.rule)
    || typeof value.applied !== 'boolean' || ![value.before, value.after].every(v => Number.isSafeInteger(v) && v >= 0 && v <= 100)
    || value.applied !== (value.before !== value.after) || !Number.isSafeInteger(value.chars) || value.chars < 0) return null;
  return { version: VERSION, applied: value.applied, rule: value.rule, before: value.before, after: value.after,
    chars: value.chars, profile: String(value.profile || 'unknown').slice(0, 40) };
}

module.exports = { VERSION, enabled, enabledRules, validateModel, validPoints, loadModel, mapScore, inScope, applyScaleCalibration, sanitizeScaleMeta };
