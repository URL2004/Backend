'use strict';

const crypto = require('node:crypto');
const features = require('./detectEvidenceFeatures');
const VERSION = 'detect-evidence-shadow-v1';
const on = value => /^(1|true|on|yes)$/iu.test(String(value || '').trim());
let bundledModel;

function getModel() {
  if (bundledModel === undefined) {
    try { bundledModel = require('../engine-gpt-prod/models/detect-evidence-fusion-v1.json'); } catch { bundledModel = null; }
  }
  return bundledModel;
}

function evaluateShadow(text, metric, { enabled = on(process.env.DETECT_EVIDENCE_SHADOW_ENABLED), model, sampleKey = '' } = {}) {
  if (!enabled) return null;
  const rate = Number(process.env.DETECT_EVIDENCE_SHADOW_SAMPLE_RATE || '1');
  const sample = parseInt(crypto.createHash('sha256').update(String(sampleKey)).digest('hex').slice(0, 8), 16) / 0x100000000;
  if (!Number.isFinite(rate) || rate <= 0 || sample >= Math.min(1, rate)) return null;
  const started = performance.now();
  try {
    const diagnostics = require('./detectDiagnostics').sanitizeDiagnostics(metric?.detectDiagnostics);
    if (!diagnostics) return { version: VERSION, status: 'missing_diagnostics' };
    const f = features.extractFeatures(text, diagnostics.selectedModelScore, metric.documentProfile);
    if (!f) return { version: VERSION, status: 'out_of_scope' };
    const candidate = model === undefined ? getModel() : model;
    const prediction = features.predict(f, candidate);
    return { version: VERSION, status: prediction ? 'scored' : 'features_only', applied: false,
      featureVersion: features.VERSION, profile: f.profile, chars: f.chars, sentences: f.sentences,
      matchedFeatures: f.matchedFeatures, values: f.values.map(v => Math.round(v * 1e6) / 1e6),
      selectedModelScore: diagnostics.selectedModelScore, evidenceAlignedScore: diagnostics.evidenceAlignedScore,
      primaryScore: diagnostics.attempts.find(a => a.phase === 'primary')?.modelScore ?? null,
      currentScore: Number.isFinite(metric.probability) ? metric.probability : null,
      candidateScore: prediction?.score ?? null, candidateModel: prediction?.modelKey ?? null,
      candidateVersion: prediction ? 'detect-evidence-fusion-v1' : null,
      candidateDigest: prediction ? crypto.createHash('sha256').update(JSON.stringify(candidate)).digest('hex') : null,
      shortRecheckWouldSkip: f.sentences < 4 && diagnostics.recheckReason === 'low_confidence',
      modelAttempts: diagnostics.attempts.length, computeMs: Math.round((performance.now() - started) * 1000) / 1000 };
  } catch {
    // Research must never fail a paid result, change billing or initiate a model call.
    return { version: VERSION, status: 'unavailable', applied: false };
  }
}

module.exports = { VERSION, evaluateShadow };
