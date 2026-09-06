'use strict';

const crypto = require('node:crypto');
const features = require('./detectEvidenceFeatures');
const VERSION = 'detect-evidence-shadow-v1';
const on = value => /^(1|true|on|yes)$/iu.test(String(value || '').trim());
let bundledModel;
let bundledStyleModel;
let bundledRiskPolicy;
function calibratedShadow(text, model) {
  if (!on(process.env.DETECT_RISK_SHADOW_ENABLED)) return null;
  const started = performance.now();
  try {
    if (bundledRiskPolicy === undefined) bundledRiskPolicy = require('../engine-gpt-prod/models/detect-risk-calibration-v1.json');
    const prediction = require('./detectRiskCalibration').predict(text, model, bundledRiskPolicy);
    return { status: prediction ? 'scored' : 'out_of_scope', applied: false,
      score: prediction?.score ?? null, version: prediction?.version ?? null,
      policyDigest: prediction?.policyDigest ?? null,
      computeMs: Math.round((performance.now() - started) * 1000) / 1000 };
  } catch { return { status: 'unavailable', applied: false }; }
}
function styleShadow(text) {
  if (!on(process.env.DETECT_STYLE_SHADOW_ENABLED)) return null;
  const started = performance.now();
  try {
    if (bundledStyleModel === undefined) bundledStyleModel = require('../engine-gpt-prod/models/detect-style-classifier-v1.json');
    const prediction = require('./detectStyleClassifier').predict(text, bundledStyleModel);
    const calibrated = calibratedShadow(text, bundledStyleModel);
    return { status: prediction ? 'scored' : 'out_of_scope', applied: false,
      ...(calibrated ? { calibrated } : {}),
      score: prediction ? Math.round(prediction.score * 1000) / 1000 : null,
      modelVersion: prediction?.version || null,
      modelDigest: crypto.createHash('sha256').update(JSON.stringify(bundledStyleModel)).digest('hex'),
      computeMs: Math.round((performance.now() - started) * 1000) / 1000 };
  } catch { return { status: 'unavailable', applied: false }; }
}

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
    const classifier = styleShadow(text);
    const diagnostics = require('./detectDiagnostics').sanitizeDiagnostics(metric?.detectDiagnostics);
    if (!diagnostics) return { version: VERSION, status: 'missing_diagnostics', ...(classifier ? { classifier } : {}) };
    const f = features.extractFeatures(text, diagnostics.selectedModelScore, metric.documentProfile);
    if (!f) return { version: VERSION, status: 'out_of_scope', ...(classifier ? { classifier } : {}) };
    const candidate = model === undefined ? getModel() : model;
    const prediction = features.predict(f, candidate);
    return { version: VERSION, status: prediction ? 'scored' : 'features_only', applied: false,
      ...(classifier ? { classifier } : {}),
      ...(diagnostics.stageVersion ? { stageScores: { version: diagnostics.stageVersion,
        selectedPhase: diagnostics.selectedPhase, statistical: diagnostics.statisticalScore,
        engineFinal: diagnostics.engineFinalScore, displayed: diagnostics.displayedScore ?? null,
        providerPrimary: diagnostics.attempts.find(a => a.phase === 'primary')?.providerScore ?? null,
        providerRecheck: diagnostics.attempts.find(a => a.phase === 'recheck')?.providerScore ?? null } } : {}),
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
