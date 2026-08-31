const crypto = require('crypto');
const historyLinkIntegrity = require('./historyLinkIntegrity');

const VERSION = 'history-calibration-v2';
const SETTINGS_COLLECTION = 'adminSettings';
const SETTINGS_DOC = 'detectCalibration';
const CACHE_TTL_MS = 15000;
const SHINGLE_SIZE = 5;
const HISTORY_SCAN_MULTIPLIER = 4;
const MAX_HISTORY_SCAN = 200;
const DEFAULT_CONFIG = {
  enabled: false,
  limit: 50,
  factor: 0.15,
  maxReduction: 12,
  floor: 35,
  approximateMatchEnabled: true,
  similarityThreshold: 0.88,
  maxLengthDeltaRatio: 0.03,
  minApproximateChars: 500
};
let cachedRuntimeConfig = null;

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function numberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || truthy(value);
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function normalizeText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function config() {
  return sanitizeConfig({
    enabled: truthy(process.env.DETECT_HISTORY_CALIBRATION),
    limit: numberEnv('DETECT_HISTORY_CALIBRATION_LIMIT', DEFAULT_CONFIG.limit),
    factor: numberEnv('DETECT_HISTORY_CALIBRATION_FACTOR', DEFAULT_CONFIG.factor),
    maxReduction: numberEnv('DETECT_HISTORY_CALIBRATION_MAX_REDUCTION', DEFAULT_CONFIG.maxReduction),
    floor: numberEnv('DETECT_HISTORY_CALIBRATION_FLOOR', DEFAULT_CONFIG.floor),
    approximateMatchEnabled: booleanValue(
      process.env.DETECT_HISTORY_CALIBRATION_APPROXIMATE_MATCH,
      DEFAULT_CONFIG.approximateMatchEnabled
    ),
    similarityThreshold: numberEnv(
      'DETECT_HISTORY_CALIBRATION_SIMILARITY_THRESHOLD',
      DEFAULT_CONFIG.similarityThreshold
    ),
    maxLengthDeltaRatio: numberEnv(
      'DETECT_HISTORY_CALIBRATION_MAX_LENGTH_DELTA_RATIO',
      DEFAULT_CONFIG.maxLengthDeltaRatio
    ),
    minApproximateChars: numberEnv(
      'DETECT_HISTORY_CALIBRATION_MIN_APPROXIMATE_CHARS',
      DEFAULT_CONFIG.minApproximateChars
    )
  });
}

function sanitizeConfig(raw = {}) {
  return {
    enabled: booleanValue(raw.enabled, DEFAULT_CONFIG.enabled),
    limit: Math.round(clamp(raw.limit ?? DEFAULT_CONFIG.limit, 1, 100)),
    factor: clamp(raw.factor ?? DEFAULT_CONFIG.factor, 0, 0.4),
    maxReduction: Math.round(clamp(raw.maxReduction ?? DEFAULT_CONFIG.maxReduction, 0, 30)),
    floor: Math.round(clamp(raw.floor ?? DEFAULT_CONFIG.floor, 0, 100)),
    approximateMatchEnabled: booleanValue(
      raw.approximateMatchEnabled,
      DEFAULT_CONFIG.approximateMatchEnabled
    ),
    similarityThreshold: clamp(
      raw.similarityThreshold ?? DEFAULT_CONFIG.similarityThreshold,
      0.8,
      0.99
    ),
    maxLengthDeltaRatio: clamp(
      raw.maxLengthDeltaRatio ?? DEFAULT_CONFIG.maxLengthDeltaRatio,
      0,
      0.1
    ),
    minApproximateChars: Math.round(clamp(
      raw.minApproximateChars ?? DEFAULT_CONFIG.minApproximateChars,
      200,
      5000
    ))
  };
}

function publicConfig(cfg, source = 'env') {
  const clean = sanitizeConfig(cfg);
  return { ...clean, source, version: VERSION };
}

function clearRuntimeConfigCache() {
  cachedRuntimeConfig = null;
}

async function getRuntimeConfig({ db, logger, force = false } = {}) {
  const now = Date.now();
  if (!force && cachedRuntimeConfig && now - cachedRuntimeConfig.loadedAt < CACHE_TTL_MS) {
    return cachedRuntimeConfig.value;
  }

  const envCfg = config();
  if (!db) {
    const value = publicConfig(envCfg, 'env');
    cachedRuntimeConfig = { loadedAt: now, value };
    return value;
  }

  try {
    const snap = await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC).get();
    const stored = snap.exists ? (snap.data() || {}) : {};
    const value = publicConfig({ ...envCfg, ...stored }, snap.exists ? 'firestore' : 'env');
    cachedRuntimeConfig = { loadedAt: now, value };
    return value;
  } catch (e) {
    if (logger && logger.warn) {
      logger.warn('detect.calibration_config_failed_env_fallback', { err: e && e.message });
    }
    const value = publicConfig(envCfg, 'env_fallback');
    cachedRuntimeConfig = { loadedAt: now, value };
    return value;
  }
}

function calibratedProbability(probability, cfg = config()) {
  const raw = clamp(Math.round(Number(probability)), 0, 100);
  const reduction = Math.min(cfg.maxReduction, Math.round(raw * cfg.factor));
  const adjusted = Math.max(cfg.floor, raw - reduction);
  return Math.min(raw, clamp(adjusted, 0, 100));
}

function shingleHash(text, offset, size = SHINGLE_SIZE) {
  let hash = 2166136261;
  for (let i = 0; i < size; i += 1) {
    hash ^= text.charCodeAt(offset + i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildShingleSet(normalized, size = SHINGLE_SIZE) {
  const value = String(normalized || '');
  const out = new Set();
  if (!value) return out;
  if (value.length < size) {
    out.add(shingleHash(value.padEnd(size, '\0'), 0, size));
    return out;
  }
  for (let i = 0; i <= value.length - size; i += 1) {
    out.add(shingleHash(value, i, size));
  }
  return out;
}

function shingleJaccard(left, right) {
  if (!(left instanceof Set) || !(right instanceof Set)) return 0;
  if (!left.size || !right.size) return left.size === right.size ? 1 : 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  let intersection = 0;
  for (const value of smaller) {
    if (larger.has(value)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function normalizedShingleSimilarity(leftText, rightText) {
  const left = normalizeText(leftText);
  const right = normalizeText(rightText);
  if (!left || !right) return 0;
  if (left === right) return 1;
  return shingleJaccard(buildShingleSet(left), buildShingleSet(right));
}

function approximateMatchMetrics(target, candidate, cfg, targetShingles) {
  const targetLength = target.length;
  const candidateLength = candidate.length;
  const maxLength = Math.max(targetLength, candidateLength);
  const minLength = Math.min(targetLength, candidateLength);
  const lengthRatio = maxLength > 0 ? minLength / maxLength : 0;
  const lengthDeltaRatio = maxLength > 0 ? (maxLength - minLength) / maxLength : 1;
  if (!cfg.approximateMatchEnabled
    || minLength < cfg.minApproximateChars
    || lengthDeltaRatio > cfg.maxLengthDeltaRatio) {
    return {
      eligible: false,
      matched: false,
      similarity: 0,
      lengthRatio,
      lengthDeltaRatio
    };
  }

  const similarity = shingleJaccard(
    targetShingles || buildShingleSet(target),
    buildShingleSet(candidate)
  );
  return {
    eligible: true,
    matched: similarity >= cfg.similarityThreshold,
    similarity,
    lengthRatio,
    lengthDeltaRatio
  };
}

function transformJobIdFromHistoryId(historyId) {
  const match = /^job_([A-Za-z0-9_-]{1,128})$/u.exec(String(historyId || ''));
  return match ? match[1] : '';
}

function provenanceRecordFromTransformJob(job = {}) {
  const result = job.result && typeof job.result === 'object' ? job.result : {};
  return {
    type: 'humanize',
    savedBy: 'server',
    mode: job.mode,
    qualityStatus: result.qualityStatus,
    billingDisposition: result.billingDisposition || job.billingDisposition,
    engineMeta: result.engineMeta || job.engineMeta,
    outputText: result.outputText
  };
}

async function verifyExactTransformJobMatch({ db, uid, historyId, target }) {
  const jobId = transformJobIdFromHistoryId(historyId);
  if (!db || !uid || !jobId || !target) return null;
  const snap = await db.collection('transformJobs').doc(jobId).get();
  if (!snap.exists) return null;
  const job = snap.data() || {};
  const provenance = provenanceRecordFromTransformJob(job);
  if (job.uid !== uid
    || job.status !== 'done'
    || normalizeText(provenance.outputText) !== target
    || !historyLinkIntegrity.isExactCalibrationEligible(provenance)) return null;
  return { mode: provenance.mode || null };
}

async function findOwnHumanizedHistoryMatch({ db, uid, text, limit, config: rawConfig }) {
  if (!db || !uid || !text) return null;
  const target = normalizeText(text);
  if (target.length < 100) return null;
  const cfg = sanitizeConfig({ ...(rawConfig || {}), limit });
  const scanLimit = Math.min(
    MAX_HISTORY_SCAN,
    Math.max(cfg.limit, cfg.limit * HISTORY_SCAN_MULTIPLIER)
  );

  let query = db.collection('users').doc(uid).collection('history')
    .orderBy('createdAt', 'desc')
    .limit(scanLimit);
  if (query && typeof query.select === 'function') {
    query = query.select(
      'type', 'outputText', 'mode', 'createdAt', 'qualityStatus',
      'billingDisposition', 'engineMeta', 'historyLinkIntegrity', 'savedBy'
    );
  }
  const snap = await query.get();
  const targetShingles = cfg.approximateMatchEnabled && target.length >= cfg.minApproximateChars
    ? buildShingleSet(target)
    : null;
  let humanizedCount = 0;
  let bestApproximate = null;

  for (const doc of snap.docs) {
    const h = doc.data() || {};
    if (h.type !== 'humanize') continue;
    humanizedCount += 1;
    if (humanizedCount > cfg.limit) break;
    const output = normalizeText(h.outputText);
    if (!output) continue;
    const signed = historyLinkIntegrity.verify(uid, h.outputText, h, h.historyLinkIntegrity);
    if (output === target) {
      let trustedMode = h.mode || null;
      let trust = signed ? 'history_hmac' : '';
      // 2026-08-30 보안 강화 직후 needs_review 결과는 HMAC이 발급되지
      // 않았다. 정확히 같은 결과에 한해 서버 전용 transformJobs 원본으로
      // 소유자·완료 상태·최종 출력·전달 적격성을 다시 확인해 안전하게 복구한다.
      if (!signed) {
        const recovered = await verifyExactTransformJobMatch({
          db,
          uid,
          historyId: doc.id,
          target
        });
        if (!recovered) continue;
        trustedMode = recovered.mode;
        trust = 'transform_job_exact';
      }
      return {
        id: doc.id,
        mode: trustedMode,
        match: 'exact_normalized',
        similarity: 1,
        lengthRatio: 1,
        trust,
        outputHash: hashText(output)
      };
    }

    // 유사 일치는 정상·무경고 전달 결과만 허용한다. review 결과의 HMAC은
    // 정확 일치의 서버 출처 확인 용도이며, 수정된 본문까지 보정하지 않는다.
    if (!signed || !historyLinkIntegrity.isEligible(h)) continue;

    const metrics = approximateMatchMetrics(target, output, cfg, targetShingles);
    if (!metrics.matched) continue;
    if (!bestApproximate || metrics.similarity > bestApproximate.similarity) {
      bestApproximate = {
        id: doc.id,
        mode: h.mode || null,
        match: 'near_normalized',
        similarity: Number(metrics.similarity.toFixed(4)),
        lengthRatio: Number(metrics.lengthRatio.toFixed(4)),
        trust: 'history_hmac',
        outputHash: hashText(output)
      };
    }
  }
  return bestApproximate;
}

async function applyHistoryCalibration({ db, uid, text, probability, logger, route }) {
  const cfg = await getRuntimeConfig({ db, logger });
  const raw = clamp(Math.round(Number(probability)), 0, 100);
  const base = { probability: raw, rawProbability: raw, applied: false, meta: null };
  if (!cfg.enabled) return base;

  let match = null;
  try {
    match = await findOwnHumanizedHistoryMatch({
      db,
      uid,
      text,
      limit: cfg.limit,
      config: cfg
    });
  } catch (e) {
    if (logger && logger.warn) {
      logger.warn('detect.calibration_lookup_failed', { uid, route, err: e && e.message });
    }
    return base;
  }
  if (!match) return base;

  const adjusted = calibratedProbability(raw, cfg);
  const applied = adjusted < raw;
  const meta = {
    version: VERSION,
    applied,
    reason: 'own_humanized_history_match',
    match: match.match,
    historyId: match.id,
    historyMode: match.mode,
    matchSimilarity: match.similarity,
    matchLengthRatio: match.lengthRatio,
    inputHash: hashText(normalizeText(text)),
    outputHash: match.outputHash,
    rawProbability: raw,
    calibratedProbability: adjusted,
    maxReduction: cfg.maxReduction,
    floor: cfg.floor,
    factor: cfg.factor
  };

  if (logger && logger.info) {
    logger.info('detect.calibration_applied', {
      uid,
      route,
      historyId: match.id,
      match: match.match,
      matchSimilarity: match.similarity,
      trust: match.trust,
      rawProbability: raw,
      calibratedProbability: adjusted,
      applied
    });
  }

  return { probability: adjusted, rawProbability: raw, applied, meta };
}

module.exports = {
  VERSION,
  SETTINGS_COLLECTION,
  SETTINGS_DOC,
  DEFAULT_CONFIG,
  normalizeText,
  config,
  sanitizeConfig,
  publicConfig,
  getRuntimeConfig,
  clearRuntimeConfigCache,
  calibratedProbability,
  buildShingleSet,
  shingleJaccard,
  normalizedShingleSimilarity,
  approximateMatchMetrics,
  provenanceRecordFromTransformJob,
  transformJobIdFromHistoryId,
  verifyExactTransformJobMatch,
  findOwnHumanizedHistoryMatch,
  applyHistoryCalibration
};
