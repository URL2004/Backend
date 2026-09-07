'use strict';

const crypto = require('node:crypto');
const features = require('./detectEvidenceFeatures');
const VERSION = 'detect-evidence-shadow-v1';
const on = value => /^(1|true|on|yes)$/iu.test(String(value || '').trim());
let bundledModel;
let bundledStyleModel;
let bundledRiskPolicy;
let bundledStyleDigest;
let bundledRiskPredictor;
function calibratedShadow(text, model) {
  const started = performance.now();
  try {
    if (bundledRiskPolicy === undefined) bundledRiskPolicy = require('../engine-gpt-prod/models/detect-risk-calibration-v1.json');
    if (bundledRiskPredictor === undefined) bundledRiskPredictor = require('./detectRiskCalibration').createPredictor(model, bundledRiskPolicy);
    const { raw, calibrated: prediction } = bundledRiskPredictor.predict(text);
    return { raw, calibrated: { status: prediction ? 'scored' : 'out_of_scope', applied: false,
      score: prediction?.score ?? null, version: prediction?.version ?? null,
      // Keep the policy identity even for inputs outside the scoring scope.
      policyDigest: bundledRiskPredictor.policyDigest,
      computeMs: Math.round((performance.now() - started) * 1000) / 1000 } };
  } catch { return { calibrated: { status: 'unavailable', applied: false } }; }
}
function styleShadow(text) {
  if (!on(process.env.DETECT_STYLE_SHADOW_ENABLED)) return null;
  const started = performance.now();
  try {
    if (bundledStyleModel === undefined) bundledStyleModel = require('../engine-gpt-prod/models/detect-style-classifier-v1.json');
    const paired = on(process.env.DETECT_RISK_SHADOW_ENABLED) ? calibratedShadow(text, bundledStyleModel) : null;
    const prediction = paired && Object.hasOwn(paired, 'raw') ? paired.raw
      : require('./detectStyleClassifier').predict(text, bundledStyleModel);
    const calibrated = paired?.calibrated;
    if (bundledStyleDigest === undefined) bundledStyleDigest = crypto.createHash('sha256').update(JSON.stringify(bundledStyleModel)).digest('hex');
    return { status: prediction ? 'scored' : 'out_of_scope', applied: false,
      ...(calibrated ? { calibrated } : {}),
      score: prediction ? Math.round(prediction.score * 1000) / 1000 : null,
      modelVersion: prediction?.version || null,
      modelDigest: bundledStyleDigest,
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
    const currentScore = typeof metric?.probability === 'number' && Number.isFinite(metric.probability)
      && metric.probability >= 0 && metric.probability <= 100 ? metric.probability : null;
    const common = { version: VERSION, applied: false,
      ...(classifier ? { classifier } : {}),
      profile: require('../engine-gpt-prod/documentProfile').DOCUMENT_PROFILES.includes(metric?.documentProfile) ? metric.documentProfile : 'unknown',
      chars: typeof text === 'string' ? text.length : 0, currentScore,
      ...(diagnostics ? { selectedModelScore: diagnostics.selectedModelScore, evidenceAlignedScore: diagnostics.evidenceAlignedScore,
        primaryScore: diagnostics.attempts.find(a => a.phase === 'primary')?.modelScore ?? null,
        modelAttempts: diagnostics.attempts.length } : {}),
      ...(diagnostics?.stageVersion ? { stageScores: { version: diagnostics.stageVersion,
        selectedPhase: diagnostics.selectedPhase, statistical: diagnostics.statisticalScore,
        engineFinal: diagnostics.engineFinalScore, displayed: diagnostics.displayedScore ?? null,
        providerPrimary: diagnostics.attempts.find(a => a.phase === 'primary')?.providerScore ?? null,
        providerRecheck: diagnostics.attempts.find(a => a.phase === 'recheck')?.providerScore ?? null } } : {}) };
    const finish = fields => ({ ...common, ...fields, computeMs: Math.round((performance.now() - started) * 1000) / 1000 });
    if (!diagnostics) return finish({ status: 'missing_diagnostics' });
    const f = features.extractFeatures(text, diagnostics.selectedModelScore, metric.documentProfile);
    if (!f) return finish({ status: 'out_of_scope' });
    const candidate = model === undefined ? getModel() : model;
    const prediction = features.predict(f, candidate);
    return finish({ status: prediction ? 'scored' : 'features_only',
      featureVersion: features.VERSION, profile: f.profile, chars: f.chars, sentences: f.sentences,
      matchedFeatures: f.matchedFeatures, values: f.values.map(v => Math.round(v * 1e6) / 1e6),
      candidateScore: prediction?.score ?? null, candidateModel: prediction?.modelKey ?? null,
      candidateVersion: prediction ? 'detect-evidence-fusion-v1' : null,
      candidateDigest: prediction ? crypto.createHash('sha256').update(JSON.stringify(candidate)).digest('hex') : null,
      shortRecheckWouldSkip: f.sentences < 4 && diagnostics.recheckReason === 'low_confidence' });
  } catch {
    // Research must never fail a paid result, change billing or initiate a model call.
    return { version: VERSION, status: 'unavailable', applied: false };
  }
}

module.exports = { VERSION, evaluateShadow };
