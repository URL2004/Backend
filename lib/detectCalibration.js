const crypto = require('crypto');
const historyLinkIntegrity = require('./historyLinkIntegrity');
const sourceScores = require('./detectSourceScore');

const VERSION = 'history-calibration-v4-linked-comparison';
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
  // 2026-09-02: 500자였을 때 자소서 한 문항(공백 제외 470~800자)의 절반이 경계 아래라
  //   휴머나이징 결과에서 오타 하나만 고쳐도 보정이 빠졌다. 글자 수 또는 문장 수 둘 중
  //   하나만 넘으면 근사 일치를 시도한다(정확 일치는 바깥 공백을 뺀 원문 100자부터, 내부 공백 포함).
  minApproximateChars: 300,
  minApproximateSentences: 5,
  // 우리 휴머나이징 결과의 재검사가 원글 점수를 넘지 않게 — 이력에 남은 원점수(sourceProbability)를 상한으로 쓴다.
  sourceCapEnabled: true
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

function lookupHash(text) {
  return crypto.createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
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
      100,
      5000
    )),
    minApproximateSentences: Math.round(clamp(
      raw.minApproximateSentences ?? DEFAULT_CONFIG.minApproximateSentences,
      2,
      50
    )),
    sourceCapEnabled: booleanValue(raw.sourceCapEnabled, DEFAULT_CONFIG.sourceCapEnabled)
  };
}

// 정규화 본문(공백 제거)에 남은 문장 종결 부호로 문장 수를 센다 — 근사 일치 문턱의 두 번째 기준.
const APPROX_ABS_MIN_CHARS = 200;
function countSentenceMarks(normalized) {
  const m = String(normalized || '').match(/[.!?。！？]/g);
  return m ? m.length : 0;
}

function approximateEligible(normalized, cfg) {
  if (!cfg.approximateMatchEnabled) return false;
  // 문장 수 기준에도 절대 하한(200자)을 둔다 — 짧은 글은 shingle이 적어 유사도가 요동친다.
  return normalized.length >= cfg.minApproximateChars
    || (countSentenceMarks(normalized) >= cfg.minApproximateSentences && normalized.length >= APPROX_ABS_MIN_CHARS);
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
  if (!force && cachedRuntimeConfig && cachedRuntimeConfig.db === db && now - cachedRuntimeConfig.loadedAt < CACHE_TTL_MS) {
    return cachedRuntimeConfig.value;
  }

  const envCfg = config();
  if (!db) {
    const value = publicConfig(envCfg, 'env');
    cachedRuntimeConfig = { db, loadedAt: now, value };
    return value;
  }

  try {
    const snap = await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC).get();
    const stored = snap.exists ? (snap.data() || {}) : {};
    const value = publicConfig({ ...envCfg, ...stored }, snap.exists ? 'firestore' : 'env');
    cachedRuntimeConfig = { db, loadedAt: now, value };
    return value;
  } catch (e) {
    if (logger && logger.warn) {
      logger.warn('detect.calibration_config_unavailable', { err: e && e.message });
    }
    // Do not silently switch off a stored policy during a database outage.
    const error = new Error('Detection calibration settings are temporarily unavailable', { cause: e });
    error.code = 'DETECT_CALIBRATION_UNAVAILABLE';
    throw error;
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

// A set of shingles alone ignores order and can accept changed numbers or
// polarity. Near matches must retain those anchors and have a small ordered edit.
function nearIntegrityCompatible(left, right) {
  const anchors = value => JSON.stringify({
    numbers: value.match(/\d+(?:[.,]\d+)*/gu) || [],
    polarity: value.match(/않|없|못|안|아니|불가능|금지|never|without|cannot|not/giu) || [],
    quotes: value.match(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/gu) || []
  });
  if (anchors(left) !== anchors(right)) return false;
  const budget = Math.min(64, Math.max(4, Math.floor(Math.min(left.length, right.length) * 0.03)));
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  left = left.slice(start); right = right.slice(start);
  let end = 0;
  while (end < left.length && end < right.length && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  if (end) { left = left.slice(0, -end); right = right.slice(0, -end); }
  if (Math.abs(left.length - right.length) > budget) return false;
  let previousStart = 0;
  let previous = Int32Array.from({ length: Math.min(right.length, budget) + 1 }, (_, j) => j);
  for (let i = 1; i <= left.length; i++) {
    const start = Math.max(0, i - budget), end = Math.min(right.length, i + budget);
    const current = new Int32Array(end - start + 1).fill(budget + 1);
    const prior = j => j >= previousStart && j < previousStart + previous.length ? previous[j - previousStart] : budget + 1;
    let minimum = budget + 1;
    for (let j = start; j <= end; j++) {
      const offset = j - start;
      current[offset] = j === 0 ? i : Math.min(
        offset > 0 ? current[offset - 1] + 1 : budget + 1,
        prior(j) + 1, prior(j - 1) + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      minimum = Math.min(minimum, current[offset]);
    }
    if (minimum > budget) return false;
    previous = current;
    previousStart = start;
  }
  return previous[right.length - previousStart] <= budget;
}

function approximateMatchMetrics(target, candidate, cfg, targetShingles) {
  const targetLength = target.length;
  const candidateLength = candidate.length;
  const maxLength = Math.max(targetLength, candidateLength);
  const minLength = Math.min(targetLength, candidateLength);
  const lengthRatio = maxLength > 0 ? minLength / maxLength : 0;
  const lengthDeltaRatio = maxLength > 0 ? (maxLength - minLength) / maxLength : 1;
  const shorter = targetLength <= candidateLength ? target : candidate;
  if (!cfg.approximateMatchEnabled
    || !approximateEligible(shorter, cfg)
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
    matched: similarity >= cfg.similarityThreshold && nearIntegrityCompatible(target, candidate),
    similarity,
    lengthRatio,
    lengthDeltaRatio
  };
}

// 휴머나이징 이력에 남긴 원글 감지 점수(보고서 → 휴머나이징 핸드오프 때 저장). 없으면 null.
function sourceProbabilityOf(record = {}) {
  return sourceScores.optionalScore(record.sourceProbability);
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
  if (!db || !uid || typeof text !== 'string') return null;
  const rawText = text.trim();
  // Match the user-facing character convention for exact history lookup.
  // Normalization is for equality, not for subtracting internal spaces from
  // the minimum sample length. Approximate matching keeps its own thresholds.
  if (rawText.length < 100) return null;
  const target = normalizeText(rawText);
  if (!target) return null;
  const cfg = sanitizeConfig({ ...(rawConfig || {}), limit });
  const scanLimit = Math.min(
    MAX_HISTORY_SCAN,
    Math.max(cfg.limit, cfg.limit * HISTORY_SCAN_MULTIPLIER)
  );

  const history = db.collection('users').doc(uid).collection('history');
  const fields = [
    'type', 'outputText', 'mode', 'createdAt', 'qualityStatus',
    'billingDisposition', 'engineMeta', 'historyLinkIntegrity', 'savedBy',
    'sourceProbability', 'historySourceScoreIntegrity'
  ];
  let indexedDocs = [];
  if (typeof history.where === 'function') {
    const indexed = await history.where('calibrationTextHash', '==', lookupHash(text))
      .orderBy('createdAt', 'desc').limit(10).select(...fields).get();
    indexedDocs = indexed.docs;
  }
  let query = history
    .orderBy('createdAt', 'desc')
    .limit(scanLimit);
  if (query && typeof query.select === 'function') {
    query = query.select(...fields);
  }
  // An index is only a locator; the HMAC / completed-job checks below remain
  // authoritative. Invalid indexed rows must not suppress legacy lookup.
  const indexedTrusted = indexedDocs.find(doc => {
    const h = doc.data() || {};
    return normalizeText(h.outputText) === target && historyLinkIntegrity.verify(uid, h.outputText, h, h.historyLinkIntegrity);
  });
  const docs = indexedTrusted ? [indexedTrusted] : (await query.get()).docs;
  const targetShingles = approximateEligible(target, cfg)
    ? buildShingleSet(target)
    : null;
  let humanizedCount = 0;
  let bestApproximate = null;

  for (const doc of docs) {
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
        outputHash: hashText(output),
        sourceProbability: sourceScores.verifiedSourceScore(uid, h)
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
        outputHash: hashText(output),
        sourceProbability: sourceScores.verifiedSourceScore(uid, h)
      };
    }
  }
  return bestApproximate;
}

let disabledWarned = false;
// 운영에서 보정이 꺼져 있으면 재검사 신뢰 장치가 통째로 없는 상태다. 프로세스당 한 번만 경고를 남긴다.
function warnIfDisabledInProduction(cfg, logger, route) {
  if (cfg.enabled || disabledWarned || process.env.NODE_ENV !== 'production') return;
  disabledWarned = true;
  if (logger && logger.warn) {
    logger.warn('detect.calibration_disabled_in_production', {
      route,
      hint: 'DETECT_HISTORY_CALIBRATION=1 또는 adminSettings/detectCalibration.enabled=true 로 켜야 휴머나이징 결과 재검사가 보정된다.'
    });
  }
}

async function applyHistoryCalibration({ db, uid, text, probability, logger, route }) {
  const cfg = await getRuntimeConfig({ db, logger });
  const raw = clamp(Math.round(Number(probability)), 0, 100);
  const base = { probability: raw, rawProbability: raw, applied: false, meta: null };
  warnIfDisabledInProduction(cfg, logger, route);
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
    const error = new Error('Detection history calibration is temporarily unavailable', { cause: e });
    error.code = 'DETECT_CALIBRATION_UNAVAILABLE';
    throw error;
  }
  if (!match) return base;

  let adjusted = calibratedProbability(raw, cfg);
  // 원점수 상한: 원글이 72였는데 우리 결과 재검사가 78이면 사용자는 "더 나빠졌다"고 읽는다.
  //   이력에 원점수가 남아 있으면 그 값을 넘지 않게 자른다(비율 보정보다 우선하지 않고, 둘 중 낮은 쪽).
  const sourceCap = cfg.sourceCapEnabled && match.match === 'exact_normalized' && match.sourceProbability != null ? match.sourceProbability : null;
  const capApplied = sourceCap != null && sourceCap < adjusted;
  if (capApplied) adjusted = sourceCap;
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
    sourceProbability: match.sourceProbability,
    sourceCapApplied: capApplied,
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

  const comparison = buildHistoryComparison(meta);
  return { probability: adjusted, rawProbability: raw, applied, meta, comparison };
}

function buildHistoryComparison(meta) {
  if (!meta || meta.reason !== 'own_humanized_history_match') return null;
  const before = sourceScores.optionalScore(meta.sourceProbability);
  const raw = sourceScores.optionalScore(meta.rawProbability);
  const after = sourceScores.optionalScore(meta.calibratedProbability);
  if (raw === null || after === null) return null;
  return {
    version: 'humanize-comparison-v1', basis: 'history_adjusted_style',
    sourceProbability: before, rawProbability: raw, probability: after,
    rawDelta: before === null ? null : raw - before,
    adjustedDelta: before === null ? null : after - before,
    adjustment: after - raw, calibrationApplied: meta.applied === true,
    match: meta.match,
    status: before === null ? 'unavailable' : after < before ? 'improved' : after === before ? 'unchanged' : 'increased'
  };
}

module.exports = {
  countSentenceMarks,
  approximateEligible,
  sourceProbabilityOf,
  VERSION,
  SETTINGS_COLLECTION,
  SETTINGS_DOC,
  DEFAULT_CONFIG,
  normalizeText,
  lookupHash,
  nearIntegrityCompatible,
  buildHistoryComparison,
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
