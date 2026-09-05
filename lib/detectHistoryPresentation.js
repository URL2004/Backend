'use strict';

const crypto = require('node:crypto');
const { secret: historySecret } = require('./historyLinkIntegrity');
const { VERSION, SUB_BANDS, normalizeScore, buildDetectInterpretation } = require('./detectInterpretation');
const { sourceSentences } = require('./detectGrounding');

const PROOF_VERSION = 'detect-interpretation-proof-v1';
const MAX_BYTES = 16000;
const KEYS = new Set(['version', 'score', 'status', 'band', 'subBand', 'label', 'headline', 'description', 'evidence', 'pattern', 'nextSteps', 'limitations', 'sample']);
const CATEGORIES = new Set(['sentence_uniformity', 'ending_repetition', 'formulaic_transition', 'generic_abstraction', 'insufficient_grounding', 'overstructured_progression', 'voice_instability', 'unsupported_assertion', 'lexical_template', 'other_observed_style']);
const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const sampleCount = value => value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 60000);

function boundedInterpretation(value, score) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== VERSION || value.score !== normalizeScore(score)
      || Object.keys(value).some(key => !KEYS.has(key))) return null;
  if (!['ready', 'limited', 'partial', 'unavailable'].includes(value.status)
      || !['low', 'moderate', 'high', 'unknown'].includes(value.band)
      || !value.evidence || !['limited', 'some', 'sufficient'].includes(value.evidence.level)
      || !value.sample || !Array.isArray(value.nextSteps) || value.nextSteps.length > 3
      || !Array.isArray(value.limitations) || value.limitations.length > 4) return null;
  if (!closed(value.evidence, ['level', 'label', 'reason'])
      || !closed(value.sample, ['characters', 'sentences'])
      || !sampleCount(value.sample.characters) || !sampleCount(value.sample.sentences)) return null;
  const band = value.score === null ? null : SUB_BANDS.find(item => value.score <= item.max);
  if (value.band !== (band?.band || 'unknown')) return null;
  if (band ? !closed(value.subBand, Object.keys(band))
    || Object.keys(band).some(key => value.subBand[key] !== band[key]) : value.subBand !== null) return null;
  if (value.pattern !== null) {
    const pattern = value.pattern;
    if (!closed(pattern, ['category', 'label', 'description', 'locationCount', 'scope', 'paragraphIndices'])
        || !CATEGORIES.has(pattern.category) || !['isolated', 'recurring'].includes(pattern.scope)
        || !Number.isSafeInteger(pattern.locationCount) || pattern.locationCount < 1 || pattern.locationCount > 8
        || ![pattern.label, pattern.description].every(item => typeof item === 'string' && item.length <= 1000)
        || !Array.isArray(pattern.paragraphIndices) || pattern.paragraphIndices.length > 8
        || !pattern.paragraphIndices.every(item => Number.isSafeInteger(item) && item >= 0 && item <= 60000)) return null;
  }
  if (![value.label, value.headline, value.description, value.evidence.label, value.evidence.reason,
    ...value.nextSteps, ...value.limitations].every(item => typeof item === 'string' && item.length <= 1000)) return null;
  try {
    const json = JSON.stringify(value);
    return Buffer.byteLength(json, 'utf8') <= MAX_BYTES ? JSON.parse(json) : null;
  } catch { return null; }
}

// Server-generated descriptors retain the exact analysis-time evidence level
// and locations. Older server result shapes are rebuilt from trusted metadata.
function storedDetectInterpretation(result = {}, text = '') {
  const report = result.reportView || {};
  const supplied = boundedInterpretation(report.interpretation || result.interpretation, result.probability);
  if (supplied && supplied.sample.characters === String(text).length) return supplied;
  return buildDetectInterpretation({
    probability: result.probability,
    probSource: result.probSource === 'cached_llm' ? 'llm' : result.probSource,
    confidence: result.confidence || result.detectConfidence || null,
    textLength: String(text).length,
    sentenceTotal: report.measuredEvidence?.sentenceTotal ?? report.contentEvidence?.total ?? sourceSentences(text).length,
    signalEvidence: result.signalEvidence || report.causeAnalysis?.items || [],
    causeCoverageStatus: report.causeAnalysis?.status || result.detectCauseAlignment?.status || null
  });
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
}

function signature(uid, text, info, key) {
  const sourceHash = crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
  return crypto.createHmac('sha256', key).update(JSON.stringify([
    PROOF_VERSION, String(uid), sourceHash, info.score, ordered(info)
  ]), 'utf8').digest('base64url');
}

// Only the server's completed interpretation is signed; no secret is required
// to display or save a normal result if optional backup proof is unavailable.
function signDetectInterpretation(uid, text, interpretation, key = historySecret()) {
  const info = boundedInterpretation(interpretation, interpretation?.score);
  if (!uid || !info || info.sample.characters !== String(text).length || String(key).length < 32) return null;
  return `${PROOF_VERSION}.${signature(uid, text, info, key)}`;
}

function verifiedBackupInterpretation(uid, entry = {}, key = historySecret()) {
  const info = boundedInterpretation(entry.interpretation, entry.probability);
  const proof = entry.interpretationProof;
  const signed = typeof proof === 'string' && proof.startsWith(`${PROOF_VERSION}.`)
    ? proof.slice(PROOF_VERSION.length + 1) : '';
  if (!uid || !info || info.sample.characters !== String(entry.inputText || '').length
      || String(key).length < 32 || !/^[A-Za-z0-9_-]{43}$/u.test(signed)) return null;
  const expected = Buffer.from(signature(uid, entry.inputText || '', info, key));
  const actual = Buffer.from(signed);
  return crypto.timingSafeEqual(expected, actual) ? info : null;
}

module.exports = { storedDetectInterpretation, signDetectInterpretation, verifiedBackupInterpretation };
