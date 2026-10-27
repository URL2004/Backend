// [routes/transform.js] 단일 GPT 운영 엔진의 비동기 작업·과금 라우트
// ────────────────────────────────────────────────────────────────
// 긴 문서도 처리하므로 POST는 jobId를 반환하고 백그라운드 작업을 수행한다.
// GET /transform/:id는 running|done|blocked|error 상태를 반환한다.
// 과금은 시작 전 잔액만 확인하고 결과 전달이 확정된 완료 시점에 멱등 차감한다.
// 작업 아카이브에는 원문·결과를 복제하지 않고 운영 관측용 축약값만 저장한다.
// 의미·사실·구조 경고는 결과와 함께 전달하고, 기술적 전달 오류만 차단한다.

const express = require('express');
const crypto = require('crypto');
const { jobNotification } = require('../lib/jobNotification');
const router = express.Router();
const usageBilling = require('../lib/usageBilling');
const historyService = require('../lib/historyService');
const { db, verifyToken, verifyAdminToken, ADMIN_UIDS } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const { bearerToken } = require('../lib/reqtoken');   // idToken 추출 단일 출처(헤더 우선·폴백 deprecated)
const inputrouting = require('../engine/inputrouting');   // 재구성 부적합 사전감지(생성 호출 '전' 차단 → API 낭비 0)
const { reviewCandidates, hostOf } = require('../engine/evidencereview');
const discord = require('../lib/discord');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const gptAnalyze = require('./analyze-gpt');
const layoutNormalizer = require('../engine/layout');
const { CONTENT_GENRES, detectDocumentProfile, applyDocumentProfileOverride } = require('../engine-gpt-prod/documentProfile');
const humanizeRecommendation = require('../engine-gpt-prod/humanizeRecommendation');
const { estimateAdvancedTime } = require('../engine-gpt-prod/timeEstimate');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const documentStructure = require('../engine-gpt-prod/documentStructure');
const { restructureStructureCredit } = require('../lib/humanizePricing');
const { shouldCallModel } = require('../engine-gpt-prod/chunkPolicy');
const humanizationDepth = require('../engine-gpt-prod/humanizationDepth');
const surfaceguard = require('../engine/surfaceguard');
const { isV248FeatureEnabled } = require('../lib/humanizeV248Flags');
const deliveryPolicy = require('../lib/humanizeDeliveryPolicy');
const restartRecovery = require('../lib/transformRestartRecovery');
const completionState = require('../lib/transformCompletionState');
const providerAvailability = require('../lib/providerAvailability');
const providerRecovery = require('../lib/transformProviderRecovery');
const attemptTrace = require('../lib/transformAttemptTrace');
const publicMetrics = require('../lib/publicMetrics');
const {
  COLLECTION: ACCOUNT_ACTIVITY_COLLECTION,
  TRANSFORM_CLAIM_TTL_MS,
  TRANSFORM_LANE,
  accountDeletionBlocksWrites,
  laneWithClaim,
  laneWithoutClaim,
  activeLane,
} = require('../lib/accountActivityClaims');
const {
  restructureCredit,
  shortHumanizeCredit
} = require('../lib/humanizePricing');

const jobs = new Map();
const launchingJobs = new Set();
const pendingAdmissions = new Set();
const admissionRequests = new Set();
const auxiliaryUsers = new Set();
const executionPolicy = require('../lib/transformExecution');
const jobPersistChains = new Map();
const JOB_TTL_MS = 6 * 60 * 60 * 1000;   // 완료 후 6시간 보관
const JOB_ARCHIVE_COLLECTION = 'transformJobArchive'; // 관리자 모니터 장기 보관용(원문·결과 제외)
const TERMINAL_JOB_STATUSES = new Set(['done', 'blocked', 'error', 'cancelled']);
let draining = false;
let restorationReady = !db;
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (TERMINAL_JOB_STATUSES.has(j.status) && j.refine?.status !== 'running'
        && !j.pendingCompletion && !j.pendingRefinement
        && now - (j.terminalAtMs || j.createdAt) > JOB_TTL_MS) {
      archiveJob(j, { expiredAtMs: now });
      jobs.delete(id); deletePersisted(id); orphan401.delete(id);
    }
  }
  const today = kstDay();
  for (const [uid, d] of dailyStarts) if (d.day !== today) dailyStarts.delete(uid);
  for (const [uid, d] of dailyStructurePreviews) if (d.day !== today) dailyStructurePreviews.delete(uid);
}, 30 * 60 * 1000).unref();

// ── 비용 방어(2026-06-12): 차감이 완료 시점이라 차단·에러·취소 job의 원가(최대 $7)는 회사 부담 →
//   동시·일일 한도로 최악 비용을 캡. 한도는 "운영자가 감당 가능한 하루 최대 손실" 기준으로 env 조정.
// Python layout 프로세스 제거와 청크 worker 상한(최대 3) 적용 뒤 검증된 안전
// 기본값. 운영 env가 유실돼도 두 풀이 1건씩으로 되돌아가 처리량이 잠기지 않는다.
const executionLimits = require('../lib/humanizeCapacity').executionLimits();
const MAX_ACTIVE_GLOBAL = executionLimits.caps.formal;
const BLOG_MAX_ACTIVE = executionLimits.caps.short;
const ENGINE_ACTIVE_CAP = executionLimits.totalCap;
const executionCoordinator = executionPolicy.createExecutionCoordinator({ db, ...executionLimits });

async function executeOwned(job, feature, run) {
  // A queue timer inherits the previous request's async context. Give each job
  // its own stable identity before acquiring ownership or starting any model.
  return require('../lib/logger').runWithLogContext({ requestId: 'job_' + job.id, jobId: job.id, uid: job.uid, feature },
    () => executeOwnedInContext(job, feature, run));
}

async function executeOwnedInContext(job, feature, run) {
  const lease = await executionCoordinator.acquire(job, feature);
  if (!lease) return false;
  // Shutdown can begin while the ownership transaction is pending. Leave the
  // persisted job queued for the next instance; never start a fresh model then.
  if (draining) {
    await executionCoordinator.release(lease);
    return false;
  }
  if (lease.persisted) Object.assign(job, lease.persisted);
  job.executionToken = lease.token;
  if (feature === 'main' && job.ac?.signal.aborted) job.ac = new AbortController();
  if (feature === 'refine' && job.refine?.status === 'running') {
    // A fresh lease proves the previous execution no longer owns this job.
    job.refine = { ...job.refine, status: 'error', error: '이전 보강의 저장 상태를 확인한 뒤 다시 처리해요.' };
  }
  const controller = feature === 'main' ? job.ac : new AbortController();
  if (feature !== 'main') job.auxAc = controller;
  const limit = Math.max(120000, Math.min(7200000, Number(process.env.TRANSFORM_JOB_TIMEOUT_MS) || 5400000));
  job.executionDeadlineMs = Date.now() + limit;
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Job deadline exceeded'), { code: 'JOB_DEADLINE' })), limit);
  const stopLeaseGuard = require('../lib/executionLeaseGuard').guardExecutionLease({
    coordinator: executionCoordinator, lease, controller,
    onLost: current => {
      if (current.cancelled) completionState.normalizeCancelledJob(Object.assign(job, { status: 'cancelled', stage: '중단됨' }));
    }
  });
  const attemptId = attemptTrace.begin(job, feature);
  try {
    controller.signal.throwIfAborted();
    const ledger = require('../engine-gpt-prod/callLedger');
    await ledger.observe(() => feature === 'main' ? run(controller.signal)
      : ledger.run(() => run(controller.signal)), snapshot => attemptTrace.capture(job, attemptId, snapshot));
    return true;
  }
  finally {
    clearTimeout(timer); stopLeaseGuard();
    attemptTrace.finish(job, attemptId, { aborted: controller.signal.aborted, reason: controller.signal.reason?.code || controller.signal.reason?.name });
    await persistJob(job);
    if (jobPersistChains.has(job.id)) await jobPersistChains.get(job.id);
    await executionCoordinator.release(lease).catch(error => logger.warn('transform.lease_release_failed', { jobId: job.id, error }));
    delete job.executionToken;
    delete job.auxAc;
    delete job.executionDeadlineMs;
    // A slot becomes available only after persistence and lease release.
    scheduleQueueDrain();
  }
}

function auxiliaryRoute(feature, handler) {
  return async (req, res, next) => {
    const job = await loadControlJob(req, res);
    if (!job) return;
    if (draining || !restorationReady) return res.status(503).json({ error: '서버 점검 중이에요. 잠시 후 다시 시도해 주세요.' });
    if (auxiliaryUsers.has(job.uid) || activeJobFor(job.uid)) return res.status(409).json({ error: '이미 진행 중인 작업이 있어요.' });
    auxiliaryUsers.add(job.uid);
    try {
      const ran = await executeOwned(job, feature, async () => {
        // Only a newly acquired lease may turn a remote snapshot into locally
        // executing state. Never copy another instance's execution token.
        jobs.set(job.id, job);
        if (feature === 'refine' && job.pendingRefinement) {
          await finishRefinement(job);
          return res.json({ ok: true, refine: publicRefine(job) });
        }
        return handler(req, res);
      });
      if (!ran && !res.headersSent) res.status(409).json({ error: '다른 작업이 처리 중이에요. 잠시 후 다시 시도해 주세요.' });
    } catch (error) { next(error); }
    finally { auxiliaryUsers.delete(job.uid); scheduleQueueDrain(); }
  };
}
const MAX_QUEUE_GLOBAL = Number(process.env.RESTRUCTURE_MAX_QUEUE) || 30;    // formal 대기열 상한 — 무한 접수 방지
const BLOG_MAX_QUEUE = Number(process.env.BLOG_MAX_QUEUE) || 50;             // short 대기열 상한
const QUEUE_DRAIN_INTERVAL_MS = Number(process.env.TRANSFORM_QUEUE_TICK_MS) || 3000;
const RESTORE_QUEUE_DRAIN_DELAY_MS = Number(process.env.TRANSFORM_RESTORE_DRAIN_DELAY_MS) || 30000;
const RESTORE_RUNNING_RECOVERY_DELAY_MS = Math.max(
  5000,
  Math.min(120000, Number(process.env.TRANSFORM_RUNNING_RECOVERY_DELAY_MS) || 30000)
);
const RESTART_RECOVERY_MAX = restartRecovery.restartRecoveryLimit();
const configuredTechnicalBlockAutoRetryMax = Number(process.env.TRANSFORM_TECHNICAL_BLOCK_AUTO_RETRY_MAX);
const TECHNICAL_BLOCK_AUTO_RETRY_MAX = Math.max(
  0,
  Math.min(3, Math.floor(Number.isFinite(configuredTechnicalBlockAutoRetryMax) ? configuredTechnicalBlockAutoRetryMax : 2))
);
const TECHNICAL_BLOCK_AUTO_RETRY_DELAY_MS = Math.max(
  1000,
  Math.min(30000, Number(process.env.TRANSFORM_TECHNICAL_BLOCK_AUTO_RETRY_DELAY_MS) || 3000)
);
const DAILY_CAP_PER_UID = Number(process.env.RESTRUCTURE_DAILY_CAP) || 8;    // 사용자당 일일 시작 횟수(취소·차단 포함) — formal만
const CANCEL_WINDOW_SEC = Number(process.env.CANCEL_WINDOW_SEC) || 45;       // 시작 후 이 시간 안에서만 사용자 취소 허용(원가 거의 안 쓴 구간). UI 버튼은 30초, 서버는 시계·네트워크 지연 여유로 45초.
const dailyStarts = new Map();   // uid → { day, count } — 메모리 보관(재시작 시 리셋은 사용자에게 유리한 방향이라 허용)
const dailyStructurePreviews = new Map();
const orphan401 = new Map();   // jobId → 폴링 GET 401 연속 횟수(결과 유실 의심 감지용)
const restartRecoveryTimers = new Map();

// idToken 추출은 lib/reqtoken.bearerToken으로 단일화(헤더 우선, body/query 폴백 + deprecation 로그).
function tokenFromReq(req) { return bearerToken(req); }

function isAdminUid(uid) {
  return ADMIN_UIDS.includes(uid);
}

async function activeGptConfig() {
  const cfg = await gptRuntimeConfig.getRuntimeConfig({ db, logger });
  return gptRuntimeConfig.isGptActive(cfg) ? cfg : null;
}

function technicalProviderError() {
  const error = new Error('OpenAI 운영 설정을 찾을 수 없습니다.');
  error.code = 'GPT_PROVIDER_UNAVAILABLE';
  error.technical = true;
  return error;
}

function loadAdminHumanizeEngines() {
  // Keep the labs boundary out of the server startup and ordinary transform
  // import graph. This function is reached only for a verified admin lab job.
  const modulePath = ['..', 'labs', 'adminHumanizeEngines'].join('/');
  return require(modulePath);
}

function effectConfirmationEnabled() {
  return isV248FeatureEnabled('effectConfirmation');
}

function recoveryBudgetUsdForCredits(credits) {
  if (process.env.HUMANIZE_RECOVERY_BUDGET_ENABLED === '0') return 0;
  const fixed = Number(process.env.HUMANIZE_RECOVERY_BUDGET_USD);
  if (Number.isFinite(fixed) && fixed > 0) return Number(fixed.toFixed(6));
  // 최저 판매 패키지의 크레딧당 매출을 보수적으로 잡아 추가 회복 원가가
  // 정가 매출의 일정 비율을 넘지 않게 한다. 환율·비율은 운영 env로 즉시
  // 조정할 수 있고, 핵심 생성·안전/의미 감사에는 이 상한을 적용하지 않는다.
  const revenueRatio = clampNumber(
    process.env.HUMANIZE_RECOVERY_BUDGET_REVENUE_RATIO,
    0.1,
    1,
    0.6
  );
  const creditFloorKrw = clampNumber(
    process.env.HUMANIZE_CREDIT_LIST_PRICE_KRW
      ?? process.env.HUMANIZE_CREDIT_FLOOR_KRW,
    1,
    100,
    21
  );
  const usdKrw = clampNumber(
    process.env.HUMANIZE_RECOVERY_BUDGET_FX_KRW_PER_USD
      ?? process.env.HUMANIZE_USD_KRW,
    500,
    3000,
    1400
  );
  const minimumUsd = clampNumber(
    process.env.HUMANIZE_RECOVERY_BUDGET_MIN_USD,
    0.01,
    1,
    0.08
  );
  const maximumUsd = clampNumber(
    process.env.HUMANIZE_RECOVERY_BUDGET_MAX_USD,
    minimumUsd,
    20,
    3
  );
  const listPriceCredits = Math.max(1, Number(credits) || 1);
  const calculated = listPriceCredits * creditFloorKrw * revenueRatio / usdKrw;
  return Number(Math.min(maximumUsd, Math.max(minimumUsd, calculated)).toFixed(6));
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? number : fallback));
}

function assessEffectExpectation(text, mode, basicStyle = '') {
  const source = String(text || '');
  const requestStrength = mode === 'formal' ? 'advanced' : (mode === 'polish' ? 'polish' : 'basic');
  const documentProfile = detectDocumentProfile(source, { basicStyle });
  let inputRisk = null;
  try { inputRisk = surfaceguard.classifyInputRisk(source); } catch {}
  const plan = humanizationDepth.buildHumanizationPlan(source, {
    requestStrength,
    documentProfile,
    inputRisk
  });
  const assessment = humanizationDepth.classifyEffectExpectation(plan);
  return {
    ...assessment,
    requiresEffectConfirmation: mode === 'polish' ? false : assessment.requiresEffectConfirmation,
    documentProfile: documentProfile.profile,
    profileConfidence: Number(documentProfile.confidence || 0)
  };
}

function safeAdvancedTimeEstimate(text, options) {
  try {
    return estimateAdvancedTime(text, options);
  } catch (error) {
    logger.warn('transform.time_estimate_failed', { err: error });
    return null;
  }
}

function applyRouteDeliveryPolicy(out, { mode = '', logName = '', meta = {} } = {}) {
  const previousStatus = out?.floorReport?.status || '';
  const previousGates = (out?.floorReport?.criticals || [])
    .map(deliveryPolicy.gateOf)
    .filter(Boolean);
  const applied = deliveryPolicy.applyDeliveryPolicy(out?.floorReport, { mode });
  if (out && typeof out === 'object') out.floorReport = applied.report;
  if (logName && previousStatus === 'blocked' && applied.decision !== 'block_technical') {
    logger.info(logName, {
      ...meta,
      gates: previousGates,
      decision: applied.decision,
      policy: 'humanizeDeliveryPolicy'
    });
  }
  return applied;
}

function assessEditableContent(text, { mode = 'formal', basicStyle = '', documentProfileOverride = '' } = {}) {
  const source = String(text || '');
  const detected = detectDocumentProfile(source, { basicStyle });
  const profile = applyDocumentProfileOverride(detected, documentProfileOverride);
  const engineMode = mode === 'polish' ? 'polish' : (mode === 'blog' ? 'blog' : 'assignment');
  const plan = structureChunk.splitChunksForGpt(source, {
    coalesceEditable: true,
    formatProfile: profile.formatProfile
  });
  const editableChunkCount = plan.chunks.filter(chunk => shouldCallModel(chunk, engineMode)).length;
  // 편집 불가로 분류된 청크를 잠금 종류별로 센다. "본문이 없다"는 422가 났을 때 표·제목·참고문헌 중
  // 무엇으로 묶였는지 로그만 보고 오분류 여부를 판단하기 위한 것(2026-09-29).
  const lockTypes = {};
  // 청크 수만으로는 "한 가지 잠금이 문서 대부분을 덮었다"를 알 수 없다(10/9 점검 F-02: 참고문헌 잠금이
  // 12,669자 중 98%를 덮어 12번 차단됐는데 로그에는 "reference_item 89"만 남았다). 잠금 종류별로
  // 원문에서 차지한 글자 비율(0~1)을 함께 센다. 로그 전용이며 응답·과금에는 쓰지 않는다.
  const lockChars = {};
  for (const chunk of plan.chunks) {
    if (shouldCallModel(chunk, engineMode)) continue;
    const key = chunk.lockType || (chunk.skipReason ? String(chunk.skipReason).split(':')[0] : 'not_editable');
    lockTypes[key] = (lockTypes[key] || 0) + 1;
    lockChars[key] = (lockChars[key] || 0) + String(chunk.text || '').length;
  }
  const share = chars => (source.length ? Math.round((chars / source.length) * 1000) / 1000 : 0);
  const lockCharShare = Object.fromEntries(Object.entries(lockChars).map(([key, chars]) => [key, share(chars)]));
  const dominant = Object.entries(lockChars).sort((a, b) => b[1] - a[1])[0] || null;
  return {
    documentProfile: profile.profile || 'unknown',
    editableChunkCount,
    totalChunkCount: plan.chunks.length,
    lockTypes,
    lockCharShare,
    dominantLockType: dominant ? dominant[0] : '',
    dominantLockShare: dominant ? share(dominant[1]) : 0
  };
}

// 입력 본문은 로그에 싣지 않는다. 같은 글로 반복 시도했는지만 알면 되므로 짧은 다이제스트를 남긴다.
function inputDigest(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 12);
}

function normalizeBasicStyle(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'report' || v === 'assignment' || v === 'school') return 'report';
  return 'blog';
}

const DOCUMENT_PROFILE_ALIASES = Object.freeze({
  student_record: 'student_record_teacher',
  general_essay: 'personal_essay',
  long_explainer: 'report_assignment',
  blog_review: 'review_blog',
  marketing_ad: 'marketing',
  social_caption: 'social',
  short_phrase: 'general'
});

function normalizeDocumentProfileOverride(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const normalized = DOCUMENT_PROFILE_ALIASES[raw] || raw;
  return CONTENT_GENRES.includes(normalized) && normalized !== 'unknown' ? normalized : null;
}

function normalizeAdminLabProfile(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'gpt_engine' || v === 'gpt-engine' || v === 'openai_engine' || v === 'openai-engine' || v === 'engine_gpt' || v === 'engine-gpt') {
    return 'gpt_engine';
  }
  if (v === 'ko_quality_pattern_lab' || v === 'ko-quality-pattern-lab' || v === 'quality_pattern_lab' || v === 'korean_quality_pattern_lab') {
    return 'ko_quality_pattern_lab';
  }
  if (v === 'v6_engine' || v === 'v6-engine' || v === 'humanizing_v6' || v === 'humanizing-engine-v6' || v === 'engine_v6' || v === 'engine-v6') {
    return 'v6_engine';
  }
  if (v === 'fundamental_engine' || v === 'fundamental-engine' || v === 'root_improvement_engine' || v === 'root-improvement-engine') {
    return 'fundamental_engine';
  }
  if (v === 'final_report_engine' || v === 'report_engine' || v === 'final_report' || v === 'final-report-engine') {
    return 'final_report_engine';
  }
  return 'preserve_lab';
}

function adminLabProfileOf(job) {
  return normalizeAdminLabProfile(job && (job.adminLabProfile || job.basicExperiment?.profile));
}

function isPreserveLabJob(job) {
  return !!(job && job.basicExperiment && adminLabProfileOf(job) === 'preserve_lab');
}

function isFinalReportEngineJob(job) {
  return !!(job && job.basicExperiment && adminLabProfileOf(job) === 'final_report_engine');
}

function isFundamentalEngineJob(job) {
  return !!(job && job.basicExperiment && adminLabProfileOf(job) === 'fundamental_engine');
}

function isV6EngineJob(job) {
  return !!(job && job.basicExperiment && adminLabProfileOf(job) === 'v6_engine');
}

function isGptEngineJob(job) {
  return !!(job && job.basicExperiment && adminLabProfileOf(job) === 'gpt_engine');
}

function isKoQualityPatternLabJob(job) {
  return !!(job && job.basicExperiment && adminLabProfileOf(job) === 'ko_quality_pattern_lab');
}

function isAdminHumanizeLabJob(job) {
  return !!(job && job.adminHumanizeLab && job.basicExperiment);
}

function markAdminLabPipeline(job, path) {
  if (!isAdminHumanizeLabJob(job)) return null;
  const profile = adminLabProfileOf(job);
  job.adminLabProfile = profile;
  job.basicExperiment = {
    ...(job.basicExperiment || {}),
    profile,
    applied: true,
    appliedAtMs: Date.now(),
    path
  };
  return profile;
}

async function requireJobOwner(req, res, job) {
  if (job.devNoAuth && !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1') {
    return job.uid || 'dev-local';
  }
  const uid = await verifyToken(tokenFromReq(req));
  if (!uid) {
    res.status(401).json({ error: '로그인이 필요해요.' });
    return null;
  }
  setLogContext({ uid });
  if (uid !== job.uid) {
    res.status(403).json({ error: '본인의 작업만 확인할 수 있어요.' });
    return null;
  }
  return uid;
}

async function loadControlJob(req, res) {
  try {
    const id = req.params.id;
    let job = jobs.get(id);
    if (db && !job?.executionToken && !launchingJobs.has(id) && /^[a-f0-9]{16}$/u.test(id)) {
      const snapshot = await db.collection('transformJobs').doc(id).get();
      if (!snapshot.exists) job = null;
      else {
        job = { ...snapshot.data(), id, ac: new AbortController() };
        delete job.executionToken;
        completionState.normalizeCancelledJob(job);
      }
    }
    const owned = jobs.get(id);
    if (owned?.executionToken || launchingJobs.has(id)) job = owned || job;
    if (!job) { res.status(404).json({ error: '작업을 찾을 수 없어요.' }); return null; }
    if (!(await requireJobOwner(req, res, job))) return null;
    if (jobs.has(id) && !job.executionToken && !launchingJobs.has(id)
        && !['queued', 'running'].includes(job.status)) jobs.set(id, job);
    // Return a detached snapshot. Controls must commit a guarded transition or
    // acquire ownership before installing it in the local execution map.
    return job;
  } catch (error) {
    logger.warn('transform.control_load_failed', { jobId: req.params.id, err: error });
    res.status(503).json({ error: '작업 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' });
    return null;
  }
}

function kstDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

// 완료된 transform job의 결제 단일 진입점. 크레딧과 구독 쿠폰이 같은 큐·엔진·게이트를
// 공유하되 결제 수단만 달라지도록 한다. requestId는 job_<id>로 고정해 재시작·재시도에도
// 한 번만 차감된다. 결과 생성 실패·차단은 이 함수에 도달하지 않으므로 무차감이다.
async function commitJobBilling(job, {
  creditAmount = job?.needed,
  operation = 'humanize',
  mode = job?.mode || 'formal',
  textLength = (job?.text || '').length,
  meta = {}
} = {}) {
  if (!job || job.devNoAuth) return false;
  const requestId = 'job_' + job.id;
  if (job.billingMode === 'coupon') {
    if (!job.billingTier) {
      throw new Error('coupon_billing_unavailable');
    }
    await usageBilling.retryAsync(() => usageBilling.commitCouponUsage(
      job.uid,
      job.billingTier,
      mode,
      textLength,
      requestId
    ));
    job.deducted = true;
    return true;
  }
  if (job.plan === 'unlimited') return false;
  await usageBilling.retryAsync(() => usageBilling.commitCreditDeduct(
    job.uid,
    creditAmount,
    operation,
    requestId,
    { ...meta, mode, textLength }
  ));
  job.deducted = true;
  return true;
}
router.commitJobBilling = commitJobBilling;   // 회귀 테스트용

async function resolveBillingDisposition(job, out) {
  const disposition = classifyBillingDisposition({
    adminNoCharge: !job || job.devNoAuth === true || job.adminHumanizeLab === true,
    plan: job?.plan, alreadyDeducted: job?.deducted === true, sourceText: job?.text,
    result: out?.result ? { ...out.result, engineMeta: out.engineMeta || out.result.engineMeta } : out
  });
  if (disposition !== 'charged') return disposition;

  await commitJobBilling(job, {
    creditAmount: job.needed,
    operation: job.mode === 'formal' ? 'restructure' : 'humanize',
    mode: job.mode || 'formal',
    structurePreview: job.structurePreview === true,
    textLength: (job.text || '').length
  });
  return job.deducted ? 'charged' : (job.plan === 'unlimited' ? 'plan_unlimited' : 'admin_no_charge');
}

function classifyBillingDisposition({
  adminNoCharge = false, plan = '', alreadyDeducted = false, sourceText, result
} = {}) {
  // Restart after a ledger commit must preserve the settled disposition.
  // Existing debits are restored through a separate audited transaction.
  if (alreadyDeducted) return 'charged';
  if (adminNoCharge) return 'admin_no_charge';
  if (plan === 'unlimited') return 'plan_unlimited';
  const meta = result?.engineMeta || {};
  const unchanged = typeof sourceText === 'string' && typeof result?.outputText === 'string'
    && sourceText.replace(/\s/gu, '') === result.outputText.replace(/\s/gu, '');
  const depthShortfall = meta.humanizationNoBenefitDelivered === true
    || (meta.humanizationDepthApplicable === true
      && (meta.humanizationDepthPass === false || meta.humanizationMinimumEffectPass === false));
  const validationFailed = ['verified_fail', 'incomplete', 'uncertain', 'stale', 'unconfirmed', 'confirmation_pending'].includes(meta.finalSemanticState)
    || (['no_safe_transformed_candidate', 'semantic_verification_not_required'].includes(meta.candidateLedgerSelectionReason)
      && meta.candidateLedgerEligibleCount === 0);
  if (unchanged || depthShortfall || validationFailed) return 'waived_quality_shortfall';
  return 'charged';
}

router.resolveBillingDisposition = resolveBillingDisposition;
router.classifyBillingDisposition = classifyBillingDisposition;
router.assessEffectExpectation = assessEffectExpectation;

// 차단 후 사용자가 보존형 재처리를 선택할 때도 최초 작업의 결제 수단을 유지한다.
// 쿠폰 작업을 크레딧으로 재검사하면 유효한 Pro 사용자가 잔액 부족으로 막히므로,
// 인증·구독·잔량을 쿠폰 계약으로 다시 확인하고 최신 티어를 job에 반영한다.
async function precheckExistingJobBilling(job, idToken, creditAmount, textLength = (job?.text || '').length) {
  if (!job || job.devNoAuth) return null;
  if (job.billingMode === 'coupon') {
    const checked = await usageBilling.precheckCoupon(idToken, textLength);
    if (checked.uid !== job.uid) throw Object.assign(new Error('AUTH_INVALID'), { status: 401 });
    job.billingTier = checked.tier;
    return checked;
  }
  if (job.plan === 'unlimited') return { uid: job.uid, plan: 'unlimited' };
  return usageBilling.precheckCredits(idToken, creditAmount);
}
router.precheckExistingJobBilling = precheckExistingJobBilling;   // 회귀 테스트용

// 모드별 상한과 공유 엔진 상한을 함께 적용한다. 시작 순서는 두 모드의 접수 시각을 따른다.
function poolOf(mode) { return (mode || 'formal') === 'formal' ? 'formal' : 'short'; }

function countActive(uid, mode) {
  let running = 0, queued = 0, mine = 0;
  const pool = poolOf(mode);
  for (const j of jobs.values()) {
    if ((j.status === 'running' || launchingJobs.has(j.id)) && poolOf(j.mode) === pool) running++;
    if (j.status === 'queued' && poolOf(j.mode) === pool) queued++;
    // 승인·대기는 LLM을 안 쓰지만 사용자 기준으로는 "진행 중 작업" — 같은 사용자가 쌓아두는 건 모드 무관 차단.
    if (j.uid === uid && completionState.ACTIVE_STATUSES.includes(j.status)) mine++;
  }
  return { running, queued, mine };
}

function activeJobFor(uid) {
  let found = null;
  for (const j of jobs.values()) {
    if (j.uid !== uid) continue;
    if (!completionState.ACTIVE_STATUSES.includes(j.status)) continue;
    if (!found || (j.createdAt || 0) > (found.createdAt || 0)) found = j;
  }
  return found;
}

function poolCap(mode) {
  return poolOf(mode) === 'short' ? BLOG_MAX_ACTIVE : MAX_ACTIVE_GLOBAL;
}

function queueCap(mode) {
  return poolOf(mode) === 'short' ? BLOG_MAX_QUEUE : MAX_QUEUE_GLOBAL;
}

function queuedJobsForPool(pool) {
  return [...jobs.values()]
    .filter(j => j.status === 'queued' && poolOf(j.mode) === pool)
    .sort((a, b) => (a.queuedAt || a.createdAt || 0) - (b.queuedAt || b.createdAt || 0));
}

function queueDetails(job) {
  return require('../lib/transformQueueEstimate').estimateQueue(job, jobs.values(), {
    sharedCap: ENGINE_ACTIVE_CAP, formalCap: MAX_ACTIVE_GLOBAL, shortCap: BLOG_MAX_ACTIVE,
    launching: launchingJobs
  });
}

function activeJobPayload(job) {
  if (!job) return null;
  const elapsedBase = job.status === 'queued'
    ? (job.queuedAt || job.createdAt || Date.now())
    : (job.startedAt || job.createdAt || Date.now());
  const base = {
    id: job.id,
    ...require('../lib/transformCancellation').cancellationAvailability(job, { windowSec: CANCEL_WINDOW_SEC }),
    status: job.status,
    inputChars: typeof job.text === 'string' ? job.text.length : 0,
    durationMs: Math.max(0, (job.terminalAtMs || Date.now()) - job.createdAt),
    stage: job.stage,
    mode: job.mode || 'formal',
    modeSource: job.modeSource === 'defaulted' ? 'defaulted' : 'provided',
    billingMode: job.billingMode === 'coupon' ? 'coupon' : 'credit',
    elapsedSec: Math.max(0, Math.round((Date.now() - elapsedBase) / 1000)),
    estSec: job.estSec,
    estLowSec: job.estLowSec,
    estHighSec: job.estHighSec,
    estimateVersion: job.estimateVersion,
    estimateBasis: job.estimateBasis,
    estimatedEditableChunks: job.estimatedEditableChunks,
    estimatedTotalChunks: job.estimatedTotalChunks,
    createdAt: job.createdAt,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    needed: job.needed,
    effectExpectation: job.effectExpectation || 'normal',
    effectNoticeCode: job.effectNoticeCode || null,
    billingDisposition: job.billingDisposition || null,
    deducted: job.deducted === true,
    restartRecoveryCount: Math.max(0, Number(job.restartRecoveryCount) || 0),
    technicalRecoveryCount: Math.max(0, Number(job.technicalRecoveryCount) || 0)
  };
  if (job.documentProfileOverride) base.documentProfile = job.documentProfileOverride;
  Object.assign(base, queueDetails(job));
  Object.assign(base, providerRecovery.payload(job));
  if (job.note) base.note = job.note;
  if (job.status === 'awaiting_approval') base.candidates = job.candidates || [];
  base.structurePreview = job.structurePreview === true;
  if (job.status === 'awaiting_payment') Object.assign(base, completionState.paymentRequiredPayload(job));
  return base;
}

function checkLimits(uid, mode, preview = false) {
  if (pendingAdmissions.has(uid) || auxiliaryUsers.has(uid)) return { status: 409, error: '이미 진행 중인 작업이 있어요.' };
  const { running, queued, mine } = countActive(uid, mode);
  if (mine >= 1) {
    const active = activeJobFor(uid);
    return {
      status: 409,
      error: '이미 진행 중인 작업이 있어요. 완료(또는 취소) 후 다시 시작해 주세요.',
      activeJobId: active?.id || null,
      activeStatus: active?.status || null
    };
  }
  // 일일 시작 한도는 formal(고원가)만 — short 모드는 저원가라 레이트리밋·동시 1개로 충분.
  if (mode === 'formal') {
    const day = kstDay();
    const d = (preview ? dailyStructurePreviews : dailyStarts).get(uid);
    if (d && d.day === day && d.count >= DAILY_CAP_PER_UID) {
      return { status: 429, error: `재구성은 하루 ${DAILY_CAP_PER_UID}회까지 시작할 수 있어요. 내일 다시 시도해 주세요.` };
    }
  }
  const cap = poolCap(mode);
  if (running >= cap && queued >= queueCap(mode)) {
    return { status: 503, error: '현재 대기열이 가득 찼어요. 잠시 후 다시 시도해 주세요.' };
  }
  return null;
}

function recordStart(uid) {
  const day = kstDay();
  const d = dailyStarts.get(uid);
  if (d && d.day === day) d.count++;
  else dailyStarts.set(uid, { day, count: 1 });
}

function blockedReason(gates, mode) {
  const set = new Set(Array.isArray(gates) ? gates : []);
  if (set.has('confirmed_semantic_omission')) return '재검증 후에도 원문의 일부 내용이 빠져 결과를 전달하지 않았어요.';
  if (set.has('confirmed_semantic_relation')) return '재검증 후에도 원문의 행위·조건·부정 의미가 달라진 부분이 있어 결과를 전달하지 않았어요.';
  if (set.has('citation_integrity_unresolved')) return '인용 표기와 문장의 연결을 보존하지 못해 결과를 전달하지 않았어요.';
  if (set.has('polish_evaluative_padding_added')) return '다듬는 과정에서 원문에 없던 평가나 단정이 추가되어 결과를 전달하지 않았어요.';
  if (set.has('internal_marker_leak')) return '결과에 내부 처리 표식이 남아 전달을 중단했어요. 원문을 수정할 필요는 없어요.';
  if (set.has('confirmed_fragment_corruption') || set.has('sentence_truncated')) return '변환 결과의 문장 일부가 끊기거나 중복되어 전달하지 않았어요.';
  if (set.has('semanticJudge')) return '변환 결과에 원문에 없던 사실이나 주장이 남아 안전하게 작업을 멈췄어요.';
  if (set.has('lostFacts')) return '변환 결과에서 원문의 핵심 사실이나 수치 누락이 확인돼 작업을 멈췄어요.';
  if (set.has('novelty')) return '변환 결과에 새 정보가 추가된 흔적이 남아 작업을 멈췄어요.';
  if (set.has('evidence_pairing')) return '수치와 출처의 연결을 안전하게 확인할 수 없어 작업을 멈췄어요.';
  if (set.has('length_collapse')) return '재구성 과정에서 분량이 원문보다 크게 줄어(상당 부분이 빠져) 결과를 그대로 내보내지 않았어요. 아래에서 원문 보존 다듬기로 받으면 분량·사실이 유지돼요.';
  if (set.has('restructure_unfit')) return '이 글은 고급(재구성)에 맞지 않아요. 재구성은 글을 새로 써내는 방식이라, 자소서·생기부·탐구문이나 짧고 추상적인 글은 원문에 없는 내용이 지어내져 차단돼요. 아래에서 「원문 보존 다듬기」로 받으면 그대로 안전하게 처리돼요.';
  if (mode === 'polish') return '문장을 다듬는 중 원문의 뜻을 안전하게 지킬 결과를 만들지 못해 작업을 멈췄어요.';
  return '안전하게 전달할 수 있는 결과를 만들지 못해 작업을 멈췄어요.';
}

// 관리자/사용자 표시용 짧은 차단 단계 라벨 — blocked인데 "재처리 중"으로 멈춰 보이던 표시 버그 해결.
function blockedStage(gates) {
  const set = new Set(Array.isArray(gates) ? gates : []);
  if (set.has('confirmed_semantic_omission')) return '안전 중단 · 원문 내용 누락';
  if (set.has('confirmed_semantic_relation')) return '안전 중단 · 원문 의미 변화';
  if (set.has('citation_integrity_unresolved')) return '안전 중단 · 인용 연결 확인 필요';
  if (set.has('polish_evaluative_padding_added')) return '안전 중단 · 다듬기 평가 표현 추가';
  if (set.has('internal_marker_leak')) return '안전 중단 · 내부 표식 복원 실패';
  if (set.has('confirmed_fragment_corruption') || set.has('sentence_truncated')) return '안전 중단 · 문장 연결 복원 실패';
  if (set.has('lostFacts')) return '안전 중단 · 원문 사실 누락';
  if (set.has('semanticJudge') || set.has('novelty')) return '안전 중단 · 원문에 없는 주장 추가';
  if (set.has('restructure_unfit')) return '보류됨 · 고급에 맞지 않는 글(자소서·짧은 글)';
  if (set.has('length_short')) return '안전 중단 · 결과가 너무 짧음';
  if (set.has('length_collapse')) return '보류됨 · 분량이 너무 줄어듦';
  if (set.has('length_overrun')) return '안전 중단 · 과도하게 늘어남';
  if (set.has('evidence_pairing')) return '안전 중단 · 수치-출처 불일치';
  return '안전 중단 · 전달 가능한 결과 없음';
}

function blockedNextActions(gates, mode) {
  const set = new Set(Array.isArray(gates) ? gates : []);
  if (set.has('confirmed_semantic_omission') || set.has('confirmed_semantic_relation') || set.has('citation_integrity_unresolved')) return [
    '원문을 유지하려면 다듬기 모드를 선택하거나 해당 문단을 따로 처리해 주세요.',
    '같은 문제가 반복되면 작업 기록과 함께 고객센터에 알려 주세요.'
  ];
  if (set.has('restructure_unfit')) {
    return [
      '이 글은 「그대로 다듬기」가 가장 잘 맞아요 — 사실·분량을 지키며 AI 티만 줄여요.',
      '시사·논증 주제의 글이라면 「기본 피하기」도 좋아요.',
      '고급을 꼭 쓰려면, 구체적 경험·수치·사례를 더 넣어 다시 시도해 주세요.'
    ];
  }
  if (mode === 'formal') {
    if (set.has('semanticJudge') || set.has('novelty')) {
      return [
        '같은 설정으로 반복하기보다 그대로 다듬기를 사용해 주세요.',
        '고급 피하기를 다시 쓸 경우 근거 보강을 끄거나 글을 2~3개로 나눠 주세요.',
        '연도, 기관명, 정책 판단처럼 원문에 없는 내용이 들어가기 쉬운 문장을 줄여 주세요.'
      ];
    }
    if (set.has('length_collapse')) {
      return [
        '이 글은 장문 논문이라 한 번에 재구성하면 요약처럼 접혀요 — 「그대로 다듬기」로 받으면 문단을 나눠 분량·사실을 지켜요.',
        '고급을 꼭 쓰려면 장(章) 단위로 글을 나눠 따로 시도해 주세요.',
        '크레딧은 차감되지 않았어요.'
      ];
    }
    if (set.has('lostFacts') || set.has('evidence_pairing') || set.has('length_collapse')) {
      return [
        '사실과 수치가 많은 문단은 짧게 나눠 다시 시도해 주세요.',
        '근거 보강을 켠 경우 승인 근거 수를 줄이거나 핵심 근거만 남겨 주세요.',
        '바로 결과가 필요하면 그대로 다듬기를 사용해 주세요.'
      ];
    }
  }
  if (mode === 'blog') {
    return [
      '글을 2~3개로 나눠 짧게 시도해 주세요.',
      '경험 메모를 줄이거나 원문에 없는 사례가 들어가지 않게 해 주세요.',
      '바로 결과가 필요하면 그대로 다듬기를 사용해 주세요.'
    ];
  }
  return [
    '원문을 더 짧게 나눠 다시 시도해 주세요.',
    '사실, 수치, 고유명사가 많은 부분은 원문 표현을 더 유지해 주세요.'
  ];
}

function blockedResponse(job) {
  const gates = job.gates || [];
  const actions = blockedNextActions(gates, job.mode || 'formal');
  // 재구성 부적합(자소서·짧고추상·영어)은 종류별 '구체 사유'를 job.note에 담아 두므로 그걸 우선 노출.
  const reason = (gates.includes('restructure_unfit') && job.note) ? job.note : blockedReason(gates, job.mode || 'formal');
  return {
    error: `${reason} 크레딧은 차감되지 않았어요. ${actions[0]}`,
    reason,
    nextActions: actions
  };
}

// A retry keeps the selected mode, price and billing instrument. Legacy
// downgrade offers are never advertised, even for a basic request.
function buildBlockOffer(job, text) {
  let abstractParas = [];
  try {
    const sg = require('../engine/surfaceguard');
    const pa = sg.analyzeParagraphs(text || '');
    const paras = (text || '').split(/\n[ \t]*\n+/).map(p => p.trim()).filter(Boolean);
    abstractParas = (pa.detail || [])
      .map((d, i) => ({ kind: d.kind, snippet: (paras[i] || '').replace(/\s+/g, ' ').slice(0, 70) }))
      .filter(d => d.kind === 'abstract_risk' && d.snippet)
      .slice(0, 5);
  } catch { /* surfaceguard 실패해도 차단 안내는 나가야 함 */ }
  return {
    fallbackOffer: false,
    retryOffer: ['blog', 'formal', 'polish'].includes(job.mode),
    retryCredit: job.needed,
    canEvidence: job.mode === 'formal' && !job.wantEvidence,
    mode: job.mode || 'formal',
    abstractParas
  };
}

// Optional follow-up on an existing experience; definitions and purposes need no personal anecdote.
// One contextual question at a time. Unchanged/failed refinements do not consume credits or free uses.
function refineEnabled() { return process.env.PARAGRAPH_REFINE === '1'; }
const refineFreeCountRaw = Number(process.env.REFINE_FREE_COUNT);
const REFINE_FREE_COUNT = Number.isFinite(refineFreeCountRaw)
  ? Math.max(0, Math.floor(refineFreeCountRaw))
  : 2;
const REFINE_TIMEOUT_MS = Math.max(30000, Number(process.env.REFINE_TIMEOUT_MS) || 180000);
const REFINE_MEMO_MIN = 5, REFINE_MEMO_MAX = 500;

function attachRefineTargets(job) {
  if (!refineEnabled()) return;
  if (job.mode !== 'blog' && job.mode !== 'polish') return;   // 이번 단계는 short 경로만
  if (!job.result || typeof job.result.outputText !== 'string') return;
  try {
    job.result.refineTargets = require('../lib/refineCoaching').selectRefineTargets(job.result.outputText, {
      refinedIndices: (job.refineHistory || []).map(h => h.paragraphIndex),
      creditForLength: shortHumanizeCredit
    });
    job.result.refine = {
      enabled: true,
      freeLeft: Math.max(0, REFINE_FREE_COUNT - (job.refineCount || 0)),
      freeTotal: REFINE_FREE_COUNT
    };
  } catch (e) {
    logger.warn('transform.refine_targets_failed', { jobId: job.id, uid: job.uid, err: e && e.message });
  }
}

// 클라이언트에 내려보내는 refine 상태(메모 원문은 제외 — 응답 슬림화).
function publicRefine(job) {
  const r = job.refine;
  if (!r) return null;
  return {
    status: r.status, paragraphIndex: r.paragraphIndex, n: r.n, needed: r.needed || 0,
    ...(typeof r.changed === 'boolean' ? { changed: r.changed } : {}),
    ...(typeof r.deducted === 'boolean' ? { deducted: r.deducted } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.error ? { error: r.error } : {})
  };
}

async function finishRefinement(job) {
  const pending = job.pendingRefinement;
  if (!pending) return;
  const { n, needed, paraLen, paragraphIndex, memoLength, outputText } = pending;
  const deducted = needed ? await commitRefineBilling(job, n, needed, paraLen) : false;
  const outputVersion = pending.outputVersion || (Number(job.outputVersion) || 1) + 1;
  const draft = { ...job, outputVersion, terminalAtMs: Date.now(), engineMeta: null, semanticAuditTrace: null };
  const review = { code: 'refined_document_review', message: '추가한 경험이 글 전체의 주장과 맞는지 확인해 주세요.' };
  draft.result = { ...job.result, outputText, outputVersion,
    qualityStatus: 'needs_review', qualityWarnings: [...(job.result.qualityWarnings || []), review],
    metrics: null, floorReport: { status: 'needs_review', criticals: [], warnings: ['refined_document_review'], metrics: null }, koreanRefinement: null, naturalnessShadow: null,
    engineMeta: null, humanizeMeta: null, registerLeak: null, preserveLab: null, finalReportEngine: null,
    effectStatus: 'normal', effectNotices: [],
    noOpScore: null, weakTransform: false, preservationCheck: measurePreservation(outputText),
    auditScope: 'refined_paragraph', auditVersion: outputVersion,
    refinementAudit: require('../lib/refinementAudit').sanitizeRefinementAudit(pending.refinementAudit) };
  draft.refineCount = n;
  draft.refineHistory = [...(job.refineHistory || []).filter(item => item.n !== n),
    { n, paragraphIndex, memoLength, atMs: Date.now(), outLen: outputText.length }];
  draft.refine = { status: 'done', changed: true, paragraphIndex, n, needed, deducted };
  draft.pendingRefinement = null;
  attachRefineTargets(draft);
  const committed = await persistJob(draft);
  if (!committed.ok) throw new Error('REFINE_COMPLETION_PERSIST_UNAVAILABLE');
  Object.assign(job, draft);
  if (!job.adminHumanizeLab) await saveJobHistory(job, job.text, outputText);
}

async function stageCompletion(job, result, mode = job.mode) {
  if (job.status === 'cancelled' || job.ac?.signal.aborted) throw new Error('TRANSFORM_CANCELLED');
  completionState.assertSelectedMode(job, result, mode);
  job.pendingCompletion = { result, mode, creditAmount: job.needed, createdAtMs: Date.now() };
  job.status = 'running';
  const staged = await persistJob(job, { requireClaim: true });
  if (!staged.ok) throw new Error('COMPLETION_PERSIST_UNAVAILABLE');
  return recoverCompletion(job);
}

async function recoverCompletion(job) {
  if (job.status === 'cancelled') { completionState.normalizeCancelledJob(job); return; }
  const pending = job.pendingCompletion;
  if (!pending) return;
  const disposition = classifyBillingDisposition({ adminNoCharge: job.devNoAuth === true || job.adminHumanizeLab === true,
    plan: job.plan, alreadyDeducted: job.deducted === true, sourceText: job.text, result: pending.result });
  try {
    if (disposition === 'charged') await commitJobBilling(job, { creditAmount: pending.creditAmount,
      mode: pending.mode, operation: pending.mode === 'formal' ? 'restructure' : 'humanize' });
  } catch (error) {
    if (!completionState.isPaymentRequired(error)) throw error;
    job.status = 'awaiting_payment';
    job.stage = '결과 보관 중 · 결제 확인 필요';
    job.error = completionState.paymentRequiredPayload(job).error;
    job.retryNotBeforeMs = null;
    job.terminalAtMs = null;
    const held = await persistJob(job, { requireClaim: true });
    if (!held.ok) throw new Error('PAYMENT_HOLD_PERSIST_UNAVAILABLE');
    logger.info('transform.payment_required', { jobId: job.id, uid: job.uid, needed: pending.creditAmount });
    return;
  }
  const draft = { ...job, billingDisposition: disposition, status: 'done', pendingCompletion: null,
    result: { ...pending.result, billingDisposition: disposition, outputVersion: (job.outputVersion || 1) } };
  if (draft.result.creditBreakdown) draft.result.creditBreakdown = { ...draft.result.creditBreakdown,
    charged: disposition === 'charged' ? pending.creditAmount : 0 };
  if (draft.result.engineMeta) draft.result.engineMeta = { ...draft.result.engineMeta, billingDisposition: disposition };
  const committed = await persistJob(draft);
  if (!committed.ok) throw new Error('COMPLETION_COMMIT_UNAVAILABLE');
  Object.assign(job, draft);
  if (!job.adminHumanizeLab) await saveJobHistory(job, job.text, job.result.outputText);
}

// refine 전용 과금 커밋 — 멱등키를 job_<id>_refine<n>으로 분리해 본 작업 차감(job_<id>)과 절대 충돌하지
// 않고, 같은 n의 재시도는 원장에서 자동 dedupe된다. 결제 수단(쿠폰/크레딧)은 원 작업 계약을 따른다.
async function commitRefineBilling(job, n, creditAmount, textLength) {
  if (!job || job.devNoAuth || job.plan === 'unlimited' || !creditAmount) return false;
  const requestId = 'job_' + job.id + '_refine' + n;
  if (job.billingMode === 'coupon') {
    if (!job.billingTier) throw new Error('coupon_billing_unavailable');
    await usageBilling.retryAsync(() => usageBilling.commitCouponUsage(job.uid, job.billingTier, job.mode, textLength, requestId));
    return true;
  }
  await usageBilling.retryAsync(() => usageBilling.commitCreditDeduct(
    job.uid, creditAmount, 'humanize_refine', requestId,
    { mode: job.mode, paragraphLength: textLength, refineN: n }
  ));
  return true;
}

// ── job 영속화(2026-06-12): Firestore transformJobs — 재시작에도 결과·승인대기 생존.
//   90분짜리 job이 도는 서비스에서 영속화 없는 배포 = 누군가의 90분이 증발. 로컬(db 없음)은 무동작.
//   AbortController 등 비직렬화 필드는 제외하고 상태 전이 시점마다 스냅샷 저장(fire-and-forget — 저장 실패가 job을 죽이면 안 됨).
const PERSIST_FIELDS = ['id', 'status', 'stage', 'createdAt', 'uid', 'plan', 'needed', 'listPriceCredits', 'recoveryBudgetUsd', 'devNoAuth', 'deducted', 'attemptTrace',
  'providerRecoveryStartedAtMs', 'providerRecoveryCount', 'recoverableErrorCode', 'queueWaitReason',
  'text', 'estSec', 'estLowSec', 'estHighSec', 'estimateVersion', 'estimateBasis', 'estimatedEditableChunks', 'estimatedTotalChunks', 'note', 'gates', 'gateDetail', 'blockOffer', 'candidates', 'approvedCount', 'result', 'error',
  'mode', 'modeSource', 'billingMode', 'billingTier', 'billingDisposition', 'effectExpectation', 'effectNoticeCode', 'effectNoticeAccepted', 'memo', 'autoCoach', 'autoCoachApplied', 'lang', 'queuedAt', 'startedAt', 'terminalAtMs', 'restartRecoveryCount', 'restartRecoveryAtMs', 'restartRecoveryReason', 'technicalRecoveryCount', 'technicalRecoveryAtMs', 'technicalRecoveryReason', 'retryNotBeforeMs', 'wantEvidence', 'approvedEvidence', 'basicStyle', 'documentProfileOverride', 'basicExperiment', 'adminHumanizeLab', 'adminLabProfile', 'niklQualityTest', 'layoutNlpTest', 'gptModel', 'engineMeta', 'refine', 'refineCount', 'refineHistory',
  'sourceProbability', 'sourceEvidence', 'sourceBand', 'sourceDetectorVersion', 'executionToken', 'pendingCompletion', 'pendingRefinement', 'outputVersion', 'refineAttempts', 'cancelRequestedAtMs', 'executionFeature', 'retryAcceptedAtMs', 'retryRequestId',
  'structurePreview', 'approvedStructure', 'structurePlanId', 'structureMode', 'basePriceCredits', 'structureCredits'];
// transformJobs is owner-readable. Private judge evidence belongs only in its
// server-only store, written by the same transaction before completion/billing.
const ARCHIVE_FIELDS = ['id', 'status', 'stage', 'createdAt', 'uid', 'plan', 'needed', 'listPriceCredits', 'recoveryBudgetUsd', 'devNoAuth', 'deducted',
  'providerRecoveryStartedAtMs', 'providerRecoveryCount', 'recoverableErrorCode', 'queueWaitReason',
  'estSec', 'estLowSec', 'estHighSec', 'estimateVersion', 'estimateBasis', 'estimatedEditableChunks', 'estimatedTotalChunks', 'note', 'error', 'mode', 'modeSource', 'billingMode', 'billingTier', 'billingDisposition', 'effectExpectation', 'effectNoticeCode', 'effectNoticeAccepted', 'lang', 'queuedAt', 'startedAt', 'terminalAtMs', 'restartRecoveryCount', 'restartRecoveryAtMs', 'restartRecoveryReason', 'technicalRecoveryCount', 'technicalRecoveryAtMs', 'technicalRecoveryReason', 'wantEvidence', 'approvedCount', 'basicStyle', 'documentProfileOverride', 'basicExperiment', 'adminHumanizeLab', 'adminLabProfile', 'niklQualityTest', 'layoutNlpTest',
  'sourceProbability', 'sourceEvidence', 'sourceBand', 'sourceDetectorVersion'];

// ── 유지할 근거 보존 검사 ─────────────────────────────────────────────────────
//   감지 보고서가 "실제 경험 문장 N · 구체 사실 문장 N"이라고 센 것을 결과에서 같은 자로 다시 센다.
//   보고서(detectReportView.resolveContentEvidence)와 같은 계측(surfaceguard.analyzeParagraphs)이라
//   같은 글이면 같은 수가 나온다. 무날조 약속의 증거를 사용자가 눈으로 세게 하려는 장치.
function measurePreservation(text) {
  try {
    const detail = surfaceguard.analyzeParagraphs(String(text || '')).detail || [];
    const sum = key => detail.reduce((acc, item) => acc + Math.max(0, Number(item?.[key]) || 0), 0);
    return { lived: sum('lived'), specific: sum('specific'), total: sum('sents') };
  } catch {
    return null;
  }
}

// 보고서 → 휴머나이징 핸드오프 값. 없거나 이상하면 조용히 버린다(선택 필드).
function parseSourceProbability(value) {
  return require('../lib/detectSourceScore').optionalScore(value);
}
// 퍼널 계측용 최초 감지 밴드·감지기 버전(사장님 2026-09-07: 노출→실행→완료→결제·환불을 최초 밴드로 이어 본다).
//   점수·요금·보정에는 쓰지 않는다. 화면이 보내는 값이라 열거형·길이만 검증한다.
const SOURCE_BANDS = new Set(['low', 'moderate', 'high']);
function parseSourceBand(value) {
  return SOURCE_BANDS.has(value) ? value : null;
}
function parseSourceDetectorVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9._-]{1,40}$/u.test(trimmed) ? trimmed : null;
}
function parseSourceEvidence(value) {
  if (!value || typeof value !== 'object') return null;
  const count = v => Math.max(0, Math.min(100000, Math.round(Number(v) || 0)));
  const out = { lived: count(value.lived), specific: count(value.specific), total: count(value.total) };
  return out.total > 0 ? out : null;
}

function pruneUndefinedForFirestore(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map(pruneUndefinedForFirestore).filter(v => v !== undefined);
  }
  if (typeof value === 'object') {
    if (value instanceof Date) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = pruneUndefinedForFirestore(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

function persistJob(job, { requireClaim = false, expectedStatus = null, cancelRequest = false } = {}) {
  completionState.normalizeCancelledJob(job);
  normalizeCompletedJobState(job);
  ensureTerminalTimestamp(job);
  attemptTrace.observeStatus(job);
  if (!db) return Promise.resolve({ ok: true, localOnly: true });
  const doc = {};
  for (const k of PERSIST_FIELDS) {
    const cleaned = pruneUndefinedForFirestore(job[k]);
    if (cleaned !== undefined) doc[k] = cleaned;
  }
  const archiveDoc = buildArchiveDocument(job);
  const evidenceStorage = job.semanticAuditTrace === undefined ? null : require('../lib/semanticAuditStorage');
  let evidenceDoc;
  try { evidenceDoc = evidenceStorage?.document(job); }
  catch (error) { return Promise.resolve({ ok: false, code: 'SEMANTIC_EVIDENCE_PERSIST_UNAVAILABLE', error }); }
  const previous = jobPersistChains.get(job.id) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    try {
      const primaryRef = db.collection('transformJobs').doc(job.id);
      const archiveRef = db.collection(JOB_ARCHIVE_COLLECTION).doc(job.id);
      const deletionRef = db.collection('accountDeletionJobs').doc(job.uid);
      const activityRef = db.collection(ACCOUNT_ACTIVITY_COLLECTION).doc(job.uid);
      if (typeof db.runTransaction !== 'function') {
        return {
          ok: false,
          code: 'TRANSFORM_JOB_PERSIST_UNAVAILABLE',
          error: new Error('Firestore transaction support is required for transform persistence'),
        };
      }
      return await db.runTransaction(async transaction => {
        const leaseRef = db.collection(executionPolicy.COLLECTION).doc(executionPolicy.DOCUMENT);
        // Keep the shared lock order consistent with execution acquisition.
        // Parallel reads can take the lease before the deletion lock and form
        // a cycle with another transaction updating this same job.
        const deletionSnapshot = await transaction.get(deletionRef);
        const activitySnapshot = await transaction.get(activityRef);
        const executionSnapshot = await transaction.get(leaseRef);
        const currentSnapshot = await transaction.get(primaryRef);
        const nowMs = Date.now();
        const cancellation = cancelRequest ? require('../lib/transformCancellation').cancellationDecision(
          currentSnapshot.exists ? currentSnapshot.data() : null, { uid: job.uid, nowMs, windowSec: CANCEL_WINDOW_SEC }) : null;
        if (cancellation && !cancellation.ok) return cancellation;
        const writeDoc = cancellation ? cancellation.job : doc;
        if (currentSnapshot.exists && currentSnapshot.data().status === 'cancelled' && doc.status !== 'cancelled') {
          return { ok: false, code: 'TRANSFORM_CANCELLED' };
        }
        if (doc.status === 'cancelled' && currentSnapshot.exists) {
          const current = currentSnapshot.data();
          if (current.deducted || (current.pendingCompletion && !['awaiting_payment', 'cancelled'].includes(current.status))) {
            return { ok: false, code: 'TRANSFORM_COMPLETION_IN_PROGRESS' };
          }
        }
        if (expectedStatus && (!currentSnapshot.exists || currentSnapshot.data().status !== expectedStatus)) {
          return { ok: false, code: 'TRANSFORM_STATE_CHANGED' };
        }
        const activity = activitySnapshot.exists ? activitySnapshot.data() || {} : {};
        const lease = executionSnapshot.exists ? executionSnapshot.data()?.slots?.[executionPolicy.keyOf(job.id)] : null;
        // Cancellation is a durable owner-authorized intent, not execution.
        // It never releases the live slot; its owner observes it on renewal.
        if (!cancelRequest && lease && lease.expiresAtMs > nowMs && lease.token !== job.executionToken) return { ok: false, code: 'EXECUTION_OWNED_ELSEWHERE' };
        if (!cancelRequest && job.executionToken && (!lease || lease.token !== job.executionToken || lease.expiresAtMs <= nowMs)) return { ok: false, code: 'EXECUTION_LEASE_LOST' };
        const active = completionState.ACTIVE_STATUSES.includes(String(writeDoc.status || ''))
          || writeDoc.refine?.status === 'running';
        if (active && requireClaim && Object.values(executionSnapshot.exists ? executionSnapshot.data()?.slots || {} : {})
          .some(slot => slot.uid === job.uid && slot.jobId !== job.id && slot.expiresAtMs > nowMs)) {
          return { ok: false, code: 'USER_TRANSFORM_ACTIVE' };
        }
        if (active && requireClaim && Object.values(activeLane(activity, TRANSFORM_LANE, nowMs)).some(claim => claim.id !== job.id)) {
          return { ok: false, code: 'USER_TRANSFORM_ACTIVE' };
        }
        const nextLane = active
          ? laneWithClaim(activity, TRANSFORM_LANE, {
            id: job.id,
            status: writeDoc.status,
            ttlMs: TRANSFORM_CLAIM_TTL_MS,
          }, nowMs)
          : laneWithoutClaim(activity, TRANSFORM_LANE, job.id, nowMs);
        if (deletionSnapshot.exists
          && accountDeletionBlocksWrites(deletionSnapshot.data() || {}, nowMs)) {
          if (activitySnapshot.exists) {
            transaction.set(activityRef, {
              uid: job.uid,
              [TRANSFORM_LANE]: laneWithoutClaim(activity, TRANSFORM_LANE, job.id, nowMs),
              updatedAtMs: nowMs,
            }, { merge: true });
          }
          return { ok: false, blocked: true, code: 'ACCOUNT_DELETION_IN_PROGRESS' };
        }
        const notification = jobNotification({ ...writeDoc, id: job.id, uid: job.uid }, currentSnapshot.exists ? currentSnapshot.data() : null, nowMs);
        if (notification) {
          transaction.set(db.collection(`users/${job.uid}/notifications`).doc(notification.id), notification.data);
        }
        transaction.set(primaryRef, notification ? { ...writeDoc, notificationRevision: notification.revision } : writeDoc, { merge: true });
        transaction.set(archiveRef, cancellation ? buildArchiveDocument(writeDoc) : archiveDoc, { merge: true });
        if (!cancellation && evidenceDoc) {
          // Refinement marks old evidence stale without destroying it. A new
          // completed audit replaces that record atomically with the job.
          transaction.set(db.collection(evidenceStorage.COLLECTION).doc(job.id), evidenceDoc,
            { merge: evidenceDoc.invalidated === true });
        }
        if (active || activitySnapshot.exists || requireClaim) {
          transaction.set(activityRef, {
            uid: job.uid,
            [TRANSFORM_LANE]: nextLane,
            updatedAtMs: nowMs,
          }, { merge: true });
        }
        return cancellation ? { ok: true, job: writeDoc } : { ok: true };
      });
    } catch (e) {
      logger.warn('transform.persist_failed', { jobId: job.id, uid: job.uid, status: job.status, err: e });
      return { ok: false, error: e };
    }
  });
  jobPersistChains.set(job.id, operation);
  void operation.finally(() => {
    if (jobPersistChains.get(job.id) === operation) jobPersistChains.delete(job.id);
  }).catch(() => {});
  return operation;
}

function resultLength(result) {
  if (!result) return 0;
  if (typeof result === 'string') return result.length;
  if (typeof result.outputText === 'string') return result.outputText.length;
  if (typeof result.text === 'string') return result.text.length;
  return 0;
}

function archiveJob(job, extra = {}) {
  if (!db || !job || !job.id) return;
  const doc = buildArchiveDocument(job, extra);
  const archiveRef = db.collection(JOB_ARCHIVE_COLLECTION).doc(job.id);
  if (!job.uid || typeof db.runTransaction !== 'function') {
    const error = new Error('Transform archive persistence requires an owner UID and Firestore transactions');
    logger.warn('transform.archive_failed', { jobId: job.id, uid: job.uid, status: job.status, err: error });
    return Promise.resolve({ ok: false, error });
  }
  return db.runTransaction(async transaction => {
    const deletionRef = db.collection('accountDeletionJobs').doc(job.uid);
    const deletionSnapshot = await transaction.get(deletionRef);
    if (deletionSnapshot.exists && accountDeletionBlocksWrites(deletionSnapshot.data() || {})) {
      return { ok: false, blocked: true };
    }
    transaction.set(archiveRef, doc, { merge: true });
    return { ok: true };
  }).catch(e => {
    logger.warn('transform.archive_failed', { jobId: job.id, uid: job.uid, status: job.status, err: e });
    return { ok: false, error: e };
  });
}

function buildArchiveDocument(job, extra = {}, now = Date.now()) {
  if (!job || !job.id) return {};
  normalizeCompletedJobState(job);
  ensureTerminalTimestamp(job, now);
  const doc = {};
  for (const k of ARCHIVE_FIELDS) {
    const cleaned = pruneUndefinedForFirestore(job[k]);
    if (cleaned !== undefined) doc[k] = cleaned;
  }
  doc.jobId = job.id;
  doc.archiveSchemaVersion = 2;
  doc.textLength = typeof job.text === 'string' ? job.text.length : 0;
  doc.resultLength = resultLength(job.result);
  doc.candidatesCount = Array.isArray(job.candidates) ? job.candidates.length : 0;
  if (Number.isFinite(Number(job.terminalAtMs)) && Number(job.terminalAtMs) > 0) {
    const terminalAtMs = Number(job.terminalAtMs);
    const startedAtMs = Number(job.startedAt || job.createdAt || 0);
    const createdAtMs = Number(job.createdAt || 0);
    if (startedAtMs > 0) doc.processingDurationMs = Math.max(0, terminalAtMs - startedAtMs);
    if (createdAtMs > 0) doc.totalDurationMs = Math.max(0, terminalAtMs - createdAtMs);
  }
  Object.assign(doc, buildArchiveObservability(job));
  doc.attemptLifecycle = attemptTrace.summary(job);
  Object.assign(doc, require('../lib/executionTiming').executionTiming(doc.attemptLifecycle));
  Object.assign(doc, require('../lib/executionTiming').completionTiming(job, doc.attemptLifecycle));
  Object.assign(doc, require('../engine-gpt-prod/auditTrace').compactAuditTrace(
    job.result?.engineMeta || job.result?.humanizeMeta?.engineMeta || job.engineMeta || {}));
  for (const [k, v] of Object.entries(extra || {})) {
    const cleaned = pruneUndefinedForFirestore(v);
    if (cleaned !== undefined) doc[k] = cleaned;
  }
  if (Number.isFinite(Number(job.terminalAtMs)) && Number(job.terminalAtMs) > 0) doc.terminalAtMs = Number(job.terminalAtMs);
  doc.updatedAtMs = Number(now) || Date.now();
  return pruneUndefinedForFirestore(doc);
}

function ensureTerminalTimestamp(job, now = Date.now()) {
  if (!job) return null;
  if (!TERMINAL_JOB_STATUSES.has(String(job.status || ''))) {
    if (job.terminalAtMs != null) job.terminalAtMs = null;
    return null;
  }
  if (!Number.isFinite(Number(job.terminalAtMs)) || Number(job.terminalAtMs) <= 0) {
    job.terminalAtMs = Number(now) || Date.now();
  }
  return job.terminalAtMs;
}

function normalizeCompletedJobState(job) {
  if (!job || job.status !== 'done') return job;
  job.gates = [];
  job.gateDetail = null;
  job.blockOffer = null;
  job.error = null;
  if (!job.stage || /차단|보류|재처리|처리 중/u.test(String(job.stage))) job.stage = '완료';
  return job;
}

function buildArchiveObservability(job) {
  const result = job?.result && typeof job.result === 'object' ? job.result : {};
  const engineMeta = result.engineMeta || result.humanizeMeta?.engineMeta || job?.engineMeta || {};
  const humanizeMeta = result.humanizeMeta || {};
  const usage = humanizeMeta.usage || result.structurePlan?.usage || {};
  const layoutRepair = humanizeMeta.layoutRepair || humanizeMeta.structureLock?.layoutRepair || {};
  const paragraphRepair = layoutRepair.paragraphs || {};
  const paragraphReadability = paragraphRepair.readability || engineMeta.paragraphReadability || {};
  const formattingRepair = layoutRepair.formatting || {};
  const dedupeAudit = humanizeMeta.dedupeAudit || {};
  const naturalnessShadow = result.naturalnessShadow || humanizeMeta.naturalnessShadow || {};
  const warningCodes = finalQualityWarningCodes(result);
  const depthStageMetrics = compactArchiveDepthStages(engineMeta.humanizationDepthStages);
  const postSemanticDepthStage = depthStageMetrics.find(item => item.stage === 'post_semantic');
  const finalDepthStage = depthStageMetrics.slice().reverse().find(item => item.stage === 'final');
  const postSemanticToFinalSubstantiveEditDelta = postSemanticDepthStage && finalDepthStage
    ? Number((finalDepthStage.substantiveEditRatio - postSemanticDepthStage.substantiveEditRatio).toFixed(4))
    : undefined;
  const gateCodes = job?.status === 'done'
    ? []
    : uniqueArchiveCodes([
        ...(Array.isArray(job.gates) ? job.gates : []),
        ...(Array.isArray(result.floorReport?.criticals) ? result.floorReport.criticals : [])
      ]);
  return pruneUndefinedForFirestore({
    gates: gateCodes,
    structurePreview: job?.structurePreview === true,
    structureApplied: result.structureImprovement?.applied === true || result.structurePlan?.applied === true,
    structureCredits: archiveFinite(job?.structureCredits || 0),
    structurePlanningUsd: archiveFinite(result.structurePlan?.usage?.estimatedUsd ?? engineMeta.structurePlanningUsd),
    structureFallback: engineMeta.structureFallback === true,
    structureAttemptModelCalls: archiveFinite(engineMeta.structureAttemptModelCalls),
    qualityStatus: archiveString(result.qualityStatus, 32),
    effectStatus: archiveString(result.effectStatus || engineMeta.effectStatus, 32),
    effectNoticeCodes: uniqueStrictArchiveCodes((result.effectNotices || []).map(item => item?.code)),
    billingDisposition: archiveString(result.billingDisposition || job?.billingDisposition || engineMeta.billingDisposition, 48),
    qualityWarningCodes: warningCodes,
    preservationFallback: result.preservationFallback === true,
    fallbackFromMode: archiveString(result.engineMeta?.fallbackFromMode || engineMeta.fallbackFromMode, 24),
    engineVersion: archiveString(engineMeta.engineVersion || humanizeMeta.engine || result.refinementAudit?.parentEngineVersion, 80),
    requestedMode: archiveString(engineMeta.requestedMode, 24),
    effectiveMode: archiveString(engineMeta.effectiveMode, 24),
    requestStrength: archiveString(engineMeta.requestStrength, 24),
    documentProfile: archiveString(engineMeta.documentProfile, 64),
    profileGroup: archiveString(engineMeta.profileGroup, 64),
    profileConfidence: archiveFinite(engineMeta.profileConfidence),
    profileDecisionSource: archiveString(engineMeta.profileDecisionSource, 48),
    profileMargin: archiveFinite(engineMeta.profileMargin),
    profileGroupMargin: archiveFinite(engineMeta.profileGroupMargin),
    detectedDocumentProfile: archiveString(engineMeta.detectedDocumentProfile, 64),
    detectedProfileConfidence: archiveFinite(engineMeta.detectedProfileConfidence),
    requestedDocumentProfile: archiveString(engineMeta.requestedDocumentProfile, 64),
    profileOverrideApplied: engineMeta.profileOverrideApplied === true,
    profileOverrideIgnoredReason: archiveString(engineMeta.profileOverrideIgnoredReason, 48),
    tonePolicy: archiveString(engineMeta.tonePolicy, 32),
    targetRegister: archiveString(engineMeta.targetRegister || engineMeta.tonePolicy, 40),
    targetRegisterSource: archiveString(engineMeta.targetRegisterSource, 40),
    niklAdvisorVersion: archiveString(engineMeta.niklAdvisorVersion, 40),
    niklLocalResourceEnabled: engineMeta.niklLocalResourceEnabled === true,
    niklLocalResourceApplied: engineMeta.niklLocalResourceApplied === true,
    niklLocalCandidateCount: archiveFinite(engineMeta.niklLocalCandidateCount),
    niklLocalAppliedCount: archiveFinite(engineMeta.niklLocalAppliedCount),
    niklLocalErrorCount: archiveFinite(engineMeta.niklLocalErrorCount),
    niklExternalApiEnabled: engineMeta.niklExternalApiEnabled === true,
    niklExternalProviderCount: archiveFinite(engineMeta.niklExternalProviderCount),
    niklExternalCandidateCount: archiveFinite(engineMeta.niklExternalCandidateCount),
    niklExternalLookupCount: archiveFinite(engineMeta.niklExternalLookupCount),
    niklExternalHitCount: archiveFinite(engineMeta.niklExternalHitCount),
    niklExternalAppliedCount: archiveFinite(engineMeta.niklExternalAppliedCount),
    niklExternalCacheHitCount: archiveFinite(engineMeta.niklExternalCacheHitCount),
    niklExternalErrorCount: archiveFinite(engineMeta.niklExternalErrorCount),
    niklExternalTimeoutCount: archiveFinite(engineMeta.niklExternalTimeoutCount),
    semanticJudgeRan: engineMeta.semanticJudgeRan === true,
    semanticUnchangedRepairCount: archiveFinite(engineMeta.semanticUnchangedRepairCount),
    semanticRepairStyleWarnings: uniqueStrictArchiveCodes(engineMeta.semanticRepairStyleWarnings),
    finalRelationPatchAttempted: engineMeta.finalRelationPatchAttempted === true,
    finalRelationPatchReason: archiveString(engineMeta.finalRelationPatchReason, 80),
    semanticViolationCount: archiveFinite(engineMeta.semanticViolationCount),
    semanticOmissionCount: archiveFinite(engineMeta.semanticOmissionCount),
    semanticAdditionCount: archiveFinite(engineMeta.semanticAdditionCount),
    semanticDistortionCount: archiveFinite(engineMeta.semanticDistortionCount),
    deterministicOmissionRestoreCount: archiveFinite(engineMeta.deterministicOmissionRestoreCount),
    initialCompoundClaimCandidateCount: archiveFinite(engineMeta.initialCompoundClaimCandidateCount),
    confirmedCompoundClauseRestoreCount: archiveFinite(engineMeta.confirmedCompoundClauseRestoreCount),
    deterministicOmissionRestoreRejectedCount: archiveFinite(engineMeta.deterministicOmissionRestoreRejectedCount),
    deterministicOmissionRestoreRejectionCodes: uniqueStrictArchiveCodes(
      engineMeta.deterministicOmissionRestoreRejectionCodes
    ),
    discourseAuditVersion: archiveFinite(engineMeta.discourseAuditVersion),
    discoursePass: typeof engineMeta.discoursePass === 'boolean' ? engineMeta.discoursePass : undefined,
    discourseWarningCodes: uniqueStrictArchiveCodes(engineMeta.discourseWarningCodes),
    discourseSignalCount: archiveFinite(engineMeta.discourseSignalCount),
    discourseRepairRan: engineMeta.discourseRepairRan === true,
    repairCount: archiveFinite(engineMeta.repairCount),
    deliveryDecision: archiveString(engineMeta.deliveryDecision, 32),
    deliveryReasonCodes: uniqueStrictArchiveCodes(engineMeta.deliveryReasonCodes),
    editableChunkCount: archiveFinite(engineMeta.editableChunkCount),
    deferredLabelMicroChunkCount: archiveFinite(engineMeta.deferredLabelMicroChunkCount),
    deferredPolishMicroChunkCount: archiveFinite(engineMeta.deferredPolishMicroChunkCount),
    primaryApprovedModelChunkCount: archiveFinite(engineMeta.primaryApprovedModelChunkCount),
    approvedModelChunkCount: archiveFinite(engineMeta.approvedModelChunkCount),
    modelFailureChunkCount: archiveFinite(engineMeta.modelFailureChunkCount),
    textualRefusalAttemptCount: archiveFinite(engineMeta.textualRefusalAttemptCount),
    textualRefusalChunkCount: archiveFinite(engineMeta.textualRefusalChunkCount),
    textualRefusalRecoveredChunkCount: archiveFinite(engineMeta.textualRefusalRecoveredChunkCount),
    textualRefusalUnrecoveredChunkCount: archiveFinite(engineMeta.textualRefusalUnrecoveredChunkCount),
    retryCounts: compactArchiveCodeCountMap(engineMeta.retryCounts),
    chunkConcurrency: archiveFinite(engineMeta.chunkConcurrency),
    structureSignaturePass: typeof engineMeta.structureSignaturePass === 'boolean' ? engineMeta.structureSignaturePass : undefined,
    fragmentIntegrityPass: typeof engineMeta.fragmentIntegrityPass === 'boolean' ? engineMeta.fragmentIntegrityPass : undefined,
    fragmentIntegrityIssueCount: archiveFinite(engineMeta.fragmentIntegrityIssueCount) == null
      ? undefined
      : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(archiveFinite(engineMeta.fragmentIntegrityIssueCount)))),
    fragmentIntegrityCodes: uniqueStrictArchiveCodes(engineMeta.fragmentIntegrityCodes).filter(code => [
      'introduced_orphan_ending', 'introduced_duplicate_predicate_tail', 'introduced_dependent_tail_owner_shift'
    ].includes(code)),
    sectionPathErrorCount: archiveFinite(engineMeta.sectionPathErrorCount),
    originalStructurePass: typeof engineMeta.originalStructurePass === 'boolean' ? engineMeta.originalStructurePass : undefined,
    originalStructuralMarkerLossCount: archiveFinite(engineMeta.originalStructuralMarkerLossCount),
    inlineLabelBodyLayoutPass: typeof engineMeta.inlineLabelBodyLayoutPass === 'boolean'
      ? engineMeta.inlineLabelBodyLayoutPass
      : undefined,
    inlineLabelBodySplitCount: archiveFinite(engineMeta.inlineLabelBodySplitCount),
    introducedOrphanParticleBoundaryCount: archiveFinite(engineMeta.introducedOrphanParticleBoundaryCount),
    inlineCodeSpanCount: archiveFinite(engineMeta.inlineCodeSpanCount),
    inlineCodeIntegrityPass: typeof engineMeta.inlineCodeIntegrityPass === 'boolean'
      ? engineMeta.inlineCodeIntegrityPass
      : undefined,
    inlineCodeRestoredCount: archiveFinite(engineMeta.inlineCodeRestoredCount),
    inlineMathSpanCount: archiveFinite(engineMeta.inlineMathSpanCount),
    inlineMathIntegrityPass: typeof engineMeta.inlineMathIntegrityPass === 'boolean'
      ? engineMeta.inlineMathIntegrityPass
      : undefined,
    inlineMathOrderPass: typeof engineMeta.inlineMathOrderPass === 'boolean'
      ? engineMeta.inlineMathOrderPass
      : undefined,
    inlineMathRestoredCount: archiveFinite(engineMeta.inlineMathRestoredCount),
    inlineMathFixedPointRestoreCount: archiveFinite(engineMeta.inlineMathFixedPointRestoreCount),
    signatureLineCount: archiveFinite(engineMeta.signatureLineCount),
    clinicalStructureSignalCount: archiveFinite(engineMeta.clinicalStructureSignalCount),
    modelCallCount: archiveFinite(engineMeta.modelCallCount),
    humanizeCallCount: archiveFinite(engineMeta.humanizeCallCount),
    surfaceRetryCallCount: archiveFinite(engineMeta.surfaceRetryCallCount),
    polishRetryReason: archiveString(engineMeta.polishRetryReason, 32),
    polishEditKind: archiveString(engineMeta.polishEditKind, 24),
    polishEvaluativePaddingCodes: uniqueStrictArchiveCodes(engineMeta.polishEvaluativePaddingCodes),
    polishDeterministicPaddingRestoreCount: archiveFinite(engineMeta.polishDeterministicPaddingRestoreCount),
    fallbackCount: archiveFinite(engineMeta.fallbackCount ?? result.fallbackCount),
    finalNoopRecoveryCount: archiveFinite(engineMeta.finalNoopRecoveryCount),
    finalNoopRecoveryAttempted: engineMeta.finalNoopRecoveryAttempted === true,
    finalNoopRecoveryApplied: engineMeta.finalNoopRecoveryApplied === true,
    finalNoopRecoveryMethod: archiveString(engineMeta.finalNoopRecoveryMethod, 32),
    finalNoopRecoveryReason: archiveString(engineMeta.finalNoopRecoveryReason, 96),
    conservativeSentenceRetryAttemptCount: archiveFinite(engineMeta.conservativeSentenceRetryAttemptCount),
    conservativeSentenceRetryModelCallCount: archiveFinite(engineMeta.conservativeSentenceRetryModelCallCount),
    conservativeSentenceRetryAppliedCount: archiveFinite(engineMeta.conservativeSentenceRetryAppliedCount),
    conservativeSentenceRetryStoppedNoProgress:
      engineMeta.conservativeSentenceRetryStoppedNoProgress === true,
    conservativeSentenceRetryMarginalGainCount:
      archiveFinite(engineMeta.conservativeSentenceRetryMarginalGainCount),
    conservativeSentenceRetrySubstantiveEditGain:
      archiveFinite(engineMeta.conservativeSentenceRetrySubstantiveEditGain),
    conservativeSentenceRetryRejectionCodes: uniqueStrictArchiveCodes(
      engineMeta.conservativeSentenceRetryRejectionCodes
    ),
    humanizationDepthEnabled: engineMeta.humanizationDepthEnabled === true,
    humanizationDepthApplicable: engineMeta.humanizationDepthApplicable === true,
    humanizationDepthPass: engineMeta.humanizationDepthPass === true,
    humanizationOverallDepthPass: engineMeta.humanizationOverallDepthPass === true,
    humanizationMinimumEffectPass: engineMeta.humanizationMinimumEffectPass === true,
    humanizationEffectStatus: archiveString(engineMeta.humanizationEffectStatus, 32),
    humanizationDepthUserReviewRequired: engineMeta.humanizationDepthUserReviewRequired === true,
    humanizationDepthUserReviewReasons: uniqueStrictArchiveCodes(engineMeta.humanizationDepthUserReviewReasons),
    humanizationDepthShadowReasons: uniqueStrictArchiveCodes(engineMeta.humanizationDepthShadowReasons),
    humanizationDepthSoftDelivered: engineMeta.humanizationDepthSoftDelivered === true,
    humanizationNoBenefitDelivered: engineMeta.humanizationNoBenefitDelivered === true,
    ...(typeof engineMeta.humanizationDepthTargetMissed === 'boolean' ? { humanizationDepthTargetMissed: engineMeta.humanizationDepthTargetMissed } : {}),
    ...(typeof engineMeta.humanizationUnchanged === 'boolean' ? { humanizationUnchanged: engineMeta.humanizationUnchanged } : {}),
    humanizationPolicyVersion: archiveString(engineMeta.humanizationPolicyVersion, 32),
    humanizationPlanSignalSource: archiveString(engineMeta.humanizationPlanSignalSource, 48),
    humanizationRiskLevel: archiveString(engineMeta.humanizationRiskLevel, 24),
    humanizationMinimumRatio: archiveFinite(engineMeta.humanizationMinimumRatio),
    humanizationHardMinimumRatio: archiveFinite(engineMeta.humanizationHardMinimumRatio),
    humanizationTargetMinRatio: archiveFinite(engineMeta.humanizationTargetMinRatio),
    humanizationTargetMaxRatio: archiveFinite(engineMeta.humanizationTargetMaxRatio),
    humanizationRequiredSentenceRatio: archiveFinite(engineMeta.humanizationRequiredSentenceRatio),
    humanizationHardRequiredSentenceCount: archiveFinite(engineMeta.humanizationHardRequiredSentenceCount),
    humanizationMinimumTargetCoverage: archiveFinite(engineMeta.humanizationMinimumTargetCoverage),
    substantiveEditRatio: archiveFinite(engineMeta.substantiveEditRatio),
    substantiveChangedSentenceRatio: archiveFinite(engineMeta.substantiveChangedSentenceRatio),
    substantiveCarryoverCount: archiveFinite(engineMeta.substantiveCarryoverCount),
    substantiveCarryoverRatio: archiveFinite(engineMeta.substantiveCarryoverRatio),
    substantiveCarryoverEligibleSentenceCount: archiveFinite(engineMeta.substantiveCarryoverEligibleSentenceCount),
    substantiveCarryoverMaximum: archiveFinite(engineMeta.substantiveCarryoverMaximum),
    humanizationTargetCoverage: archiveFinite(engineMeta.humanizationTargetCoverage),
    humanizationTargetChangedCount: archiveFinite(engineMeta.humanizationTargetChangedCount),
    structuralChangedSentenceCount: archiveFinite(engineMeta.structuralChangedSentenceCount),
    structuralChangedSentenceRatio: archiveFinite(engineMeta.structuralChangedSentenceRatio),
    materiallyRecastSentenceCount: archiveFinite(engineMeta.materiallyRecastSentenceCount),
    effectiveStructuralChangedSentenceCount: archiveFinite(engineMeta.effectiveStructuralChangedSentenceCount),
    clauseLevelStructuralAlternative: engineMeta.clauseLevelStructuralAlternative === true,
    humanizationRequiredStructuralSentenceCount: archiveFinite(engineMeta.humanizationRequiredStructuralSentenceCount),
    humanizationParagraphCoverageApplicable: engineMeta.humanizationParagraphCoverageApplicable === true,
    humanizationEligibleParagraphCount: archiveFinite(engineMeta.humanizationEligibleParagraphCount),
    humanizationTargetParagraphCount: archiveFinite(engineMeta.humanizationTargetParagraphCount),
    humanizationRequiredTargetParagraphCount: archiveFinite(engineMeta.humanizationRequiredTargetParagraphCount),
    humanizationTargetChangedParagraphCount: archiveFinite(engineMeta.humanizationTargetChangedParagraphCount),
    humanizationTargetParagraphCoverage: archiveFinite(engineMeta.humanizationTargetParagraphCoverage),
    rhetoricalRemediationTargetCount: archiveFinite(engineMeta.rhetoricalRemediationTargetCount),
    rhetoricalRemediationAchievedCount: archiveFinite(engineMeta.rhetoricalRemediationAchievedCount),
    rhetoricalRemediationCoverage: archiveFinite(engineMeta.rhetoricalRemediationCoverage),
    macroDiscourseApplicable: engineMeta.macroDiscourseApplicable === true,
    macroDiscourseScore: archiveFinite(engineMeta.macroDiscourseScore),
    macroDiscoursePass: typeof engineMeta.macroDiscoursePass === 'boolean'
      ? engineMeta.macroDiscoursePass
      : undefined,
    macroDiscourseOrderPass: typeof engineMeta.macroDiscourseOrderPass === 'boolean'
      ? engineMeta.macroDiscourseOrderPass
      : undefined,
    macroDiscourseSourceParagraphCount: archiveFinite(engineMeta.macroDiscourseSourceParagraphCount),
    macroDiscourseOutputParagraphCount: archiveFinite(engineMeta.macroDiscourseOutputParagraphCount),
    macroDiscourseRecomposedParagraphCount: archiveFinite(engineMeta.macroDiscourseRecomposedParagraphCount),
    macroDiscourseRepeatedEvaluationReduction: archiveFinite(
      engineMeta.macroDiscourseRepeatedEvaluationReduction
    ),
    macroDiscourseRoleOrderRetention: archiveFinite(engineMeta.macroDiscourseRoleOrderRetention),
    macroDiscourseIdeaOrderRetention: archiveFinite(engineMeta.macroDiscourseIdeaOrderRetention),
    resumeRepetitionAuditVersion: archiveFinite(engineMeta.resumeRepetitionAuditVersion),
    resumeRepetitionApplicable: engineMeta.resumeRepetitionApplicable === true,
    resumeRepetitionPass: typeof engineMeta.resumeRepetitionPass === 'boolean' ? engineMeta.resumeRepetitionPass : undefined,
    resumeRepetitionThemeCount: archiveFinite(engineMeta.resumeRepetitionThemeCount),
    resumeRepetitionSourcePairCount: archiveFinite(engineMeta.resumeRepetitionSourcePairCount),
    resumeRepetitionResidualPairCount: archiveFinite(engineMeta.resumeRepetitionResidualPairCount),
    resumeRepetitionRequiredReduction: archiveFinite(engineMeta.resumeRepetitionRequiredReduction),
    resumeRepetitionAchievedReduction: archiveFinite(engineMeta.resumeRepetitionAchievedReduction),
    resumeRepetitionCoverage: archiveFinite(engineMeta.resumeRepetitionCoverage),
    sourceRedundancyAuditVersion: archiveFinite(engineMeta.sourceRedundancyAuditVersion),
    sourceRedundancyApplicable: engineMeta.sourceRedundancyApplicable === true,
    sourceRedundancyPass: typeof engineMeta.sourceRedundancyPass === 'boolean'
      ? engineMeta.sourceRedundancyPass
      : undefined,
    sourceRedundancySourceSentenceCount: archiveFinite(engineMeta.sourceRedundancySourceSentenceCount),
    sourceRedundancyOutputSentenceCount: archiveFinite(engineMeta.sourceRedundancyOutputSentenceCount),
    sourceRedundancyRequiredReduction: archiveFinite(engineMeta.sourceRedundancyRequiredReduction),
    sourceRedundancyAchievedReduction: archiveFinite(engineMeta.sourceRedundancyAchievedReduction),
    lengthRatio: archiveFinite(engineMeta.lengthRatio ?? result.floorReport?.metrics?.lengthRatio),
    humanizationTargetDepthMet: engineMeta.humanizationTargetDepthMet === true,
    humanizationEditTargetMet: engineMeta.humanizationEditTargetMet === true,
    humanizationTargetDepthGap: archiveFinite(engineMeta.humanizationTargetDepthGap),
    humanizationDeliveryDepthBand: archiveString(engineMeta.humanizationDeliveryDepthBand, 24),
    humanizationDepthRetryCount: archiveFinite(engineMeta.humanizationDepthRetryCount),
    humanizationDepthEscalationAttemptCount: archiveFinite(engineMeta.humanizationDepthEscalationAttemptCount),
    humanizationNoEffectRetryAttemptCount: archiveFinite(engineMeta.humanizationNoEffectRetryAttemptCount),
    humanizationRoleRecoveryAttemptCount: archiveFinite(engineMeta.humanizationRoleRecoveryAttemptCount),
    humanizationDepthRetryApplied: engineMeta.humanizationDepthRetryApplied === true,
    humanizationDepthRetryTargetSentenceCount: archiveFinite(engineMeta.humanizationDepthRetryTargetSentenceCount),
    humanizationDepthRetryRejectedCount: archiveFinite(engineMeta.humanizationDepthRetryRejectedCount),
    humanizationDepthRetryRejectionCodes: uniqueStrictArchiveCodes(engineMeta.humanizationDepthRetryRejectionCodes),
    humanizationDepthStages: depthStageMetrics,
    postSemanticSubstantiveEditRatio: archiveFinite(postSemanticDepthStage?.substantiveEditRatio),
    finalStageSubstantiveEditRatio: archiveFinite(finalDepthStage?.substantiveEditRatio),
    postSemanticToFinalSubstantiveEditDelta: archiveFinite(postSemanticToFinalSubstantiveEditDelta),
    sectionRecoveryEnabled: engineMeta.sectionRecoveryEnabled === true,
    sectionRecoverySelectedCount: archiveFinite(engineMeta.sectionRecoverySelectedCount),
    sectionRecoveryAttemptCount: archiveFinite(engineMeta.sectionRecoveryAttemptCount),
    sectionRecoveryPreferredSectionCount: archiveFinite(engineMeta.sectionRecoveryPreferredSectionCount),
    sectionRecoveryFragmentCount: archiveFinite(engineMeta.sectionRecoveryFragmentCount),
    sectionRecoveryTargetOnlyCount: archiveFinite(engineMeta.sectionRecoveryTargetOnlyCount),
    sectionRecoveryAppliedCount: archiveFinite(engineMeta.sectionRecoveryAppliedCount),
    sectionRecoveryUniqueAppliedSectionCount: archiveFinite(engineMeta.sectionRecoveryUniqueAppliedSectionCount),
    sectionRecoveryCandidateAppliedCount: archiveFinite(engineMeta.sectionRecoveryCandidateAppliedCount),
    wholeDocumentDepthRetrySkippedAfterSectionRecovery:
      engineMeta.wholeDocumentDepthRetrySkippedAfterSectionRecovery === true,
    sectionRecoveryEscalationCount: archiveFinite(engineMeta.sectionRecoveryEscalationCount),
    sectionRecoveryEscalationEligibleCount: archiveFinite(engineMeta.sectionRecoveryEscalationEligibleCount),
    sectionRecoveryEscalationSkippedCount: archiveFinite(engineMeta.sectionRecoveryEscalationSkippedCount),
    sectionRecoveryEscalationSkipCodes: uniqueStrictArchiveCodes(engineMeta.sectionRecoveryEscalationSkipCodes),
    sectionRecoveryEscalationSkipCodeCounts: compactArchiveCodeCountMap(
      engineMeta.sectionRecoveryEscalationSkipCodeCounts
    ),
    sectionRecoveryEscalationMaximum: archiveFinite(engineMeta.sectionRecoveryEscalationMaximum),
    sectionRecoveryRejectedAttemptCount: archiveFinite(engineMeta.sectionRecoveryRejectedAttemptCount),
    sectionRecoveryRejectionCodes: uniqueStrictArchiveCodes(engineMeta.sectionRecoveryRejectionCodes),
    sectionRecoveryRejectionCodeCounts: compactArchiveCodeCountMap(engineMeta.sectionRecoveryRejectionCodeCounts),
    sectionRecoveryMiniAppliedCount: archiveFinite(engineMeta.sectionRecoveryMiniAppliedCount),
    sectionRecoveryEscalationAppliedCount: archiveFinite(engineMeta.sectionRecoveryEscalationAppliedCount),
    fingerprintAuditVersion: archiveFinite(engineMeta.fingerprintAuditVersion),
    fingerprintPass: typeof engineMeta.fingerprintPass === 'boolean' ? engineMeta.fingerprintPass : undefined,
    fingerprintIssueCodes: uniqueStrictArchiveCodes(engineMeta.fingerprintIssueCodes),
    fingerprintIntroducedCount: archiveFinite(engineMeta.fingerprintIntroducedCount),
    fingerprintExcessIntroducedCount: archiveFinite(engineMeta.fingerprintExcessIntroducedCount),
    semanticRelationShiftCount: archiveFinite(engineMeta.semanticRelationShiftCount),
    semanticRelationShiftFamilies: uniqueStrictArchiveCodes(engineMeta.semanticRelationShiftFamilies),
    fingerprintRepairCount: archiveFinite(engineMeta.fingerprintRepairCount),
    fingerprintSourceRestoreCount: archiveFinite(engineMeta.fingerprintSourceRestoreCount),
    unsupportedSpecificityAuditVersion: archiveFinite(engineMeta.unsupportedSpecificityAuditVersion),
    unsupportedSpecificityPass: typeof engineMeta.unsupportedSpecificityPass === 'boolean'
      ? engineMeta.unsupportedSpecificityPass
      : undefined,
    unsupportedSpecificityIssueCount: archiveFinite(engineMeta.unsupportedSpecificityIssueCount),
    unsupportedSpecificityRestorableCount: archiveFinite(engineMeta.unsupportedSpecificityRestorableCount),
    unsupportedSpecificityResidualCount: archiveFinite(engineMeta.unsupportedSpecificityResidualCount),
    unsupportedSpecificityRestoreCount: archiveFinite(engineMeta.unsupportedSpecificityRestoreCount),
    unsupportedSpecificityRemovalCount: archiveFinite(engineMeta.unsupportedSpecificityRemovalCount),
    unsupportedSpecificityRestoreRejectedCount: archiveFinite(
      engineMeta.unsupportedSpecificityRestoreRejectedCount
    ),
    unsupportedSpecificityRestoreRejectionCodes: uniqueStrictArchiveCodes(
      engineMeta.unsupportedSpecificityRestoreRejectionCodes
    ),
    finalSourceIntegrityRestoreCount: archiveFinite(engineMeta.finalSourceIntegrityRestoreCount),
    finalSourceIntegrityRestoreCodes: uniqueStrictArchiveCodes(engineMeta.finalSourceIntegrityRestoreCodes),
    fingerprintShadowPositiveCodes: uniqueStrictArchiveCodes(engineMeta.fingerprintShadowPositiveCodes),
    fingerprintShadowPositiveCount: archiveFinite(engineMeta.fingerprintShadowPositiveCount),
    lexicalTransitionCodes: uniqueStrictArchiveCodes(engineMeta.lexicalTransitionCodes),
    lexicalTransitionCount: archiveFinite(engineMeta.lexicalTransitionCount),
    endingStyleAuditVersion: archiveFinite(engineMeta.endingStyleAuditVersion),
    endingStylePass: typeof engineMeta.endingStylePass === 'boolean' ? engineMeta.endingStylePass : undefined,
    endingStyleIssueCount: archiveFinite(engineMeta.endingStyleIssueCount),
    endingStyleIntroducedOtherCount: archiveFinite(engineMeta.endingStyleIntroducedOtherCount),
    endingStyleSourceRestoreCount: archiveFinite(engineMeta.endingStyleSourceRestoreCount),
    resumeCoverageAuditVersion: archiveFinite(engineMeta.resumeCoverageAuditVersion),
    resumeCoverageApplicable: engineMeta.resumeCoverageApplicable === true,
    resumeCoveragePass: typeof engineMeta.resumeCoveragePass === 'boolean' ? engineMeta.resumeCoveragePass : undefined,
    resumeClaimCount: archiveFinite(engineMeta.resumeClaimCount),
    resumeCoveredClaimCount: archiveFinite(engineMeta.resumeCoveredClaimCount),
    resumeCoverageRatio: archiveFinite(engineMeta.resumeCoverageRatio),
    resumeCoverageMinimumRecall: archiveFinite(engineMeta.resumeCoverageMinimumRecall),
    humanizationDepthReasonCodes: uniqueStrictArchiveCodes(engineMeta.humanizationDepthReasonCodes),
    humanizationDepthBlockingReasonCodes: uniqueStrictArchiveCodes(engineMeta.humanizationDepthBlockingReasonCodes),
    koreanRefinementVersion: archiveFinite(engineMeta.koreanRefinementVersion),
    koreanRefinementPass: typeof engineMeta.koreanRefinementPass === 'boolean' ? engineMeta.koreanRefinementPass : undefined,
    koreanRefinementIssueCodes: uniqueStrictArchiveCodes(engineMeta.koreanRefinementIssueCodes),
    koreanRefinementIntroducedIssueCount: archiveFinite(engineMeta.koreanRefinementIntroducedIssueCount),
    formalRegisterResidualCount: archiveFinite(engineMeta.formalRegisterResidualCount),
    studentRecordFragmentCount: archiveFinite(engineMeta.studentRecordFragmentCount),
    functionalGreetingDuplicationCount: archiveFinite(engineMeta.functionalGreetingDuplicationCount),
    adjacentSemanticRepetitionCount: archiveFinite(engineMeta.adjacentSemanticRepetitionCount),
    removedLocalOverlapCount: archiveFinite(engineMeta.removedLocalOverlapCount),
    localOverlapReasons: uniqueStrictArchiveCodes(engineMeta.localOverlapReasons),
    removedAdjacentRestatementCount: archiveFinite(engineMeta.removedAdjacentRestatementCount),
    adjacentRestatementFamilies: uniqueStrictArchiveCodes(engineMeta.adjacentRestatementFamilies),
    directionalGrowthCollocationCount: archiveFinite(engineMeta.directionalGrowthCollocationCount),
    koreanDeterministicRepairCount: archiveFinite(engineMeta.koreanDeterministicRepairCount),
    koreanRefinementRetryAttemptCount: archiveFinite(engineMeta.koreanRefinementRetryAttemptCount),
    koreanRefinementRetryCount: archiveFinite(engineMeta.koreanRefinementRetryCount),
    koreanSourceRestoreCount: archiveFinite(engineMeta.koreanSourceRestoreCount),
    koreanRefinementRetryApplied: engineMeta.koreanRefinementRetryApplied === true,
    quoteIntegrityAuditVersion: archiveFinite(engineMeta.quoteIntegrityAuditVersion),
    quoteIntegrityPass: typeof engineMeta.quoteIntegrityPass === 'boolean' ? engineMeta.quoteIntegrityPass : undefined,
    quoteDuplicateReductionBenign: engineMeta.quoteDuplicateReductionBenign === true,
    quoteDuplicateReductionCount: archiveFinite(engineMeta.quoteDuplicateReductionCount),
    quoteMissingUniqueCount: archiveFinite(engineMeta.quoteMissingUniqueCount),
    quoteCountChanged: engineMeta.quoteCountChanged === true,
    quoteContentChangedCount: archiveFinite(engineMeta.quoteContentChangedCount),
    quoteIntegrityRestoreCount: archiveFinite(engineMeta.quoteIntegrityRestoreCount),
    finalQuoteIntegrityRestoreCount: archiveFinite(engineMeta.finalQuoteIntegrityRestoreCount),
    finalFormattingRepairCount: archiveFinite(engineMeta.finalFormattingRepairCount ?? formattingRepair.changeCount),
    finalFormattingRepairCodes: uniqueStrictArchiveCodes(engineMeta.finalFormattingRepairCodes || formattingRepair.changeCodes),
    brokenLineBreakRepairCount: archiveFinite(engineMeta.brokenLineBreakRepairCount ?? formattingRepair.brokenLineBreakRepairCount),
    brokenParagraphBreakRepairCount: archiveFinite(engineMeta.brokenParagraphBreakRepairCount ?? formattingRepair.brokenParagraphBreakRepairCount),
    excessiveBlankLineRepairCount: archiveFinite(engineMeta.excessiveBlankLineRepairCount ?? formattingRepair.excessiveBlankLineRepairCount),
    missingSentenceSpaceRepairCount: archiveFinite(engineMeta.missingSentenceSpaceRepairCount ?? formattingRepair.missingSentenceSpaceRepairCount),
    contextualSpacingRepairCount: archiveFinite(engineMeta.contextualSpacingRepairCount ?? formattingRepair.contextualSpacingRepairCount),
    sourceReviewWarningCodes: uniqueStrictArchiveCodes(engineMeta.sourceReviewWarningCodes),
    structureAuditScope: engineMeta.structureAuditScope === 'submitted_text' ? 'submitted_text' : undefined,
    sourceLayoutStatus: ['reading_order_unverified', 'text_only'].includes(engineMeta.sourceLayoutStatus) ? engineMeta.sourceLayoutStatus : undefined,
    sourceReviewWarningCount: archiveFinite(engineMeta.sourceReviewWarningCount),
    sourcePreflightVersion: archiveFinite(engineMeta.sourcePreflightVersion),
    sourcePreflightChanged: engineMeta.sourcePreflightChanged === true,
    sourceArtifactRemovedCount: archiveFinite(engineMeta.sourceArtifactRemovedCount),
    sourcePreflightNoticeCount: archiveFinite(engineMeta.sourcePreflightNoticeCount),
    sourcePreflightIssueCodes: uniqueStrictArchiveCodes(engineMeta.sourcePreflightIssueCodes),
    sourceLayoutRepairCount: archiveFinite(engineMeta.sourceLayoutRepairCount),
    assessmentProtectedLineCount: archiveFinite(engineMeta.assessmentProtectedLineCount),
    assessmentExplanationLineCount: archiveFinite(engineMeta.assessmentExplanationLineCount),
    structuralContextIssueCount: archiveFinite(engineMeta.structuralContextIssueCount),
    chunkFailureCodes: uniqueStrictArchiveCodes(engineMeta.chunkFailureCodes),
    chunkPrimaryFailureCodes: uniqueStrictArchiveCodes(engineMeta.chunkPrimaryFailureCodes),
    chunkResidualFailureCodes: uniqueStrictArchiveCodes(engineMeta.chunkResidualFailureCodes),
    chunkFallbackReasonCodes: uniqueStrictArchiveCodes(engineMeta.chunkFallbackReasonCodes),
    chunkResolvedFailureCodes: uniqueStrictArchiveCodes(engineMeta.chunkResolvedFailureCodes),
    humanizationPlanDistributionAligned: typeof engineMeta.humanizationPlanDistributionAligned === 'boolean'
      ? engineMeta.humanizationPlanDistributionAligned
      : undefined,
    humanizationPlanDocumentSentenceCount: archiveFinite(engineMeta.humanizationPlanDocumentSentenceCount),
    humanizationPlanMappedSentenceCount: archiveFinite(engineMeta.humanizationPlanMappedSentenceCount),
    humanizationDepthLockFreezeAttemptCount: archiveFinite(engineMeta.humanizationDepthLockFreezeAttemptCount),
    humanizationDepthLockFreezeMissCount: archiveFinite(engineMeta.humanizationDepthLockFreezeMissCount),
    depthTugOfWar: engineMeta.depthTugOfWar ? {
      trigger: archiveString(engineMeta.depthTugOfWar.trigger, 48),
      rounds: archiveFinite(engineMeta.depthTugOfWar.rounds),
      semanticRepairRounds: archiveFinite(engineMeta.depthTugOfWar.semanticRepairRounds),
      rejudgeCount: archiveFinite(engineMeta.depthTugOfWar.rejudgeCount),
      finalSide: archiveString(engineMeta.depthTugOfWar.finalSide, 12),
      usdSpent: archiveFinite(engineMeta.depthTugOfWar.usdSpent)
    } : undefined,
    depthTugTrigger: archiveString(engineMeta.depthTugOfWar?.trigger, 48),
    depthTugFinalSide: archiveString(engineMeta.depthTugOfWar?.finalSide, 12),
    pipelineFixedPoint: engineMeta.pipelineFixedPoint ? {
      safetyPass: engineMeta.pipelineFixedPoint.safetyPass === true,
      depthHardMinimumPass: engineMeta.pipelineFixedPoint.depthHardMinimumPass === true,
      structurePass: engineMeta.pipelineFixedPoint.structurePass === true,
      quotePass: engineMeta.pipelineFixedPoint.quotePass === true,
      inlineCodePass: engineMeta.pipelineFixedPoint.inlineCodePass === true,
      reasonCodes: uniqueStrictArchiveCodes(engineMeta.pipelineFixedPoint.reasonCodes)
    } : undefined,
    recoveryBudgetEnabled: engineMeta.recoveryBudgetEnabled === true,
    recoveryBudgetEnforced: engineMeta.recoveryBudgetEnforced === true,
    recoveryBudgetLimitUsd: archiveFinite(engineMeta.recoveryBudgetLimitUsd),
    recoveryBudgetSpentUsd: archiveFinite(engineMeta.recoveryBudgetSpentUsd),
    recoveryBudgetExhausted: engineMeta.recoveryBudgetExhausted === true,
    recoveryBudgetAttemptedCallCount: archiveFinite(engineMeta.recoveryBudgetAttemptedCallCount),
    recoveryBudgetSkippedCallCount: archiveFinite(engineMeta.recoveryBudgetSkippedCallCount),
    recoveryBudgetSkippedCodes: uniqueStrictArchiveCodes(engineMeta.recoveryBudgetSkippedCodes),
    recoveryAbsoluteCallLimit: archiveFinite(engineMeta.recoveryAbsoluteCallLimit),
    recoveryAbsoluteElapsedLimitMs: archiveFinite(engineMeta.recoveryAbsoluteElapsedLimitMs),
    recoveryElapsedMs: archiveFinite(engineMeta.recoveryElapsedMs),
    recoveryCallLimitExhausted: engineMeta.recoveryCallLimitExhausted === true,
    recoveryTimeLimitExhausted: engineMeta.recoveryTimeLimitExhausted === true,
    recoveryLastDeniedReason: archiveString(engineMeta.recoveryLastDeniedReason, 80),
    recoveryBudgetStageUsageUsd: compactArchiveCodeCountMap(engineMeta.recoveryBudgetStageUsageUsd),
    modelCost: require('../engine-gpt-prod/modelCostSummary').sanitize(engineMeta.modelCost) || undefined,
    recoveryReservedUsd: archiveFinite(engineMeta.recoveryReservedUsd),
    recoveryUnknownUsageUsd: archiveFinite(engineMeta.recoveryUnknownUsageUsd),
    paragraphAlignmentElapsedMs: archiveFinite(engineMeta.paragraphAlignmentElapsedMs),
    paragraphAlignmentFastPath: engineMeta.paragraphAlignmentFastPath === true,
    paragraphAlignmentLimitReached: engineMeta.paragraphAlignmentLimitReached === true,
    semanticPairAlignment: uniqueStrictArchiveCodes(engineMeta.semanticPairAlignment),
    semanticVerificationCompleted: engineMeta.semanticVerificationCompleted === true,
    finalSemanticRevalidationElapsedMs: archiveFinite(engineMeta.finalSemanticRevalidationElapsedMs),
    httpAttemptCount: archiveFinite(engineMeta.httpAttemptCount),
    failedEstimatedUsd: archiveFinite(engineMeta.failedEstimatedUsd),
    unknownEstimatedUsd: archiveFinite(engineMeta.unknownEstimatedUsd),
    unknownUsageCount: archiveFinite(engineMeta.unknownUsageCount),
    shortChunkBatchEnabled: engineMeta.shortChunkBatchEnabled === true,
    shortChunkBatchCallCount: archiveFinite(engineMeta.shortChunkBatchCallCount),
    shortChunkBatchedChunkCount: archiveFinite(engineMeta.shortChunkBatchedChunkCount),
    shortChunkIndividualRecoveryCount: archiveFinite(engineMeta.shortChunkIndividualRecoveryCount),
    sectionRecoveryBudgetSkippedCount: archiveFinite(engineMeta.sectionRecoveryBudgetSkippedCount),
    sectionRecoveryBudgetSkippedCodes: uniqueStrictArchiveCodes(engineMeta.sectionRecoveryBudgetSkippedCodes),
    polishSpeakerRestoreCount: archiveFinite(engineMeta.polishSpeakerRestoreCount),
    polishSpeakerRestoredSentenceCount: archiveFinite(engineMeta.polishSpeakerRestoredSentenceCount),
    lineBoundaryPolicy: archiveString(engineMeta.lineBoundaryPolicy, 24),
    naturalnessRiskIncreased: naturalnessShadow.riskIncreased === true,
    naturalnessOverallRiskDelta: archiveFinite(naturalnessShadow.delta?.overallRisk),
    rhythmUniformityDelta: archiveFinite(naturalnessShadow.rhythmUniformityDelta),
    estimatedUsd: archiveFinite(humanizeMeta.estimatedUsd ?? usage.estimatedUsd ?? engineMeta.modelCost?.knownUsd),
    unknownReservedUsd: archiveFinite(engineMeta.modelCost?.unknownReservedUsd),
    dedupeRemovedBlockCount: archiveFinite(dedupeAudit.removedBlockCount),
    dedupeRemovedBlockSentenceCount: archiveFinite(dedupeAudit.removedBlockSentenceCount),
    finalGeneratedDedupeApplied:
      dedupeAudit.finalPass?.applied === true || engineMeta.finalGeneratedDedupeApplied === true,
    finalGeneratedDedupeRejected:
      dedupeAudit.finalPass?.rejected === true || engineMeta.finalGeneratedDedupeRejected === true,
    finalGeneratedDedupeReasonCodes: uniqueStrictArchiveCodes(
      dedupeAudit.finalPass?.reasonCodes || engineMeta.finalGeneratedDedupeReasonCodes
    ),
    finalGeneratedDedupeBlockCount: archiveFinite(
      dedupeAudit.finalPass?.removedBlockCount ?? engineMeta.finalGeneratedDedupeBlockCount
    ),
    finalGeneratedDedupeSentenceCount: archiveFinite(
      dedupeAudit.finalPass?.removedBlockSentenceCount
        ?? engineMeta.finalGeneratedDedupeSentenceCount
    ),
    dedupeRemovedLocalOverlapCount: archiveFinite(
      dedupeAudit.removedLocalOverlapCount ?? engineMeta.removedLocalOverlapCount
    ),
    dedupeRemovedAdjacentRestatementCount: archiveFinite(
      dedupeAudit.removedAdjacentRestatementCount ?? engineMeta.removedAdjacentRestatementCount
    ),
    paragraphRepairPolicy: archiveString(paragraphRepair.policy || engineMeta.paragraphRepairPolicy, 48),
    paragraphRepairSourceCount: archiveFinite(paragraphRepair.sourceCount ?? engineMeta.paragraphRepairSourceCount),
    paragraphCountBeforeRepair: archiveFinite(paragraphRepair.beforeCount ?? engineMeta.paragraphRepairBeforeCount),
    paragraphRepairTargetCount: archiveFinite(paragraphRepair.targetCount ?? engineMeta.paragraphRepairTargetCount),
    paragraphCountAfterRepair: archiveFinite(paragraphRepair.afterCount ?? engineMeta.paragraphRepairAfterCount),
    paragraphRoleBoundaryCount: archiveFinite(paragraphRepair.roleBoundaryCount ?? engineMeta.paragraphRoleBoundaryCount),
    paragraphSourceBoundaryRepairCount: archiveFinite(paragraphRepair.sourceBoundaryRepairCount ?? engineMeta.paragraphSourceBoundaryRepairCount),
    paragraphBackwardConclusionRepairCount: archiveFinite(paragraphRepair.backwardConclusionRepairCount ?? engineMeta.paragraphBackwardConclusionRepairCount),
    paragraphAlignmentConfidence: archiveFinite(paragraphRepair.paragraphAlignmentConfidence ?? engineMeta.paragraphAlignmentConfidence),
    paragraphProseSplitCount: archiveFinite(paragraphRepair.proseSplitCount ?? engineMeta.paragraphProseSplitCount),
    paragraphVisualGapRepairCount: archiveFinite(paragraphRepair.visualGapRepairCount ?? engineMeta.paragraphVisualGapRepairCount),
    inlineLabelBodyRepairCount: archiveFinite(engineMeta.inlineLabelBodyRepairCount),
    inlineLabelBodyApplicableCount: archiveFinite(engineMeta.inlineLabelBodyApplicableCount),
    explicitParagraphCountBefore: archiveFinite(paragraphRepair.explicitParagraphCountBefore ?? engineMeta.explicitParagraphCountBefore),
    explicitParagraphCountAfter: archiveFinite(paragraphRepair.explicitParagraphCountAfter ?? engineMeta.explicitParagraphCountAfter),
    paragraphOverlongCount: archiveFinite(paragraphReadability.overlongCount),
    paragraphMaxBare: archiveFinite(paragraphReadability.maxBare),
    paragraphMaxSentences: archiveFinite(paragraphReadability.maxSentences),
    paragraphMaxBareLimit: archiveFinite(paragraphReadability.maxBareLimit),
    paragraphMaxSentenceLimit: archiveFinite(paragraphReadability.maxSentenceLimit)
  });
}

function uniqueArchiveCodes(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const raw = typeof value === 'string' ? value : (value?.code || value?.gate || value?.type || '');
    const code = String(raw || '').trim().replace(/[^A-Za-z0-9_.:-]+/gu, '_').slice(0, 80);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= 24) break;
  }
  return out;
}

function finalQualityWarningCodes(result = {}) {
  return uniqueArchiveCodes([
    ...(Array.isArray(result.qualityWarnings) ? result.qualityWarnings : []),
    ...(Array.isArray(result.floorReport?.warnings) ? result.floorReport.warnings : [])
  ]);
}

function uniqueStrictArchiveCodes(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{1,79}$/u.test(raw)) continue;
    const code = raw.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 80);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= 24) break;
  }
  return out;
}

function archiveString(value, limit) {
  const text = String(value || '').trim();
  return text ? text.slice(0, limit) : undefined;
}

function archiveFinite(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function compactArchiveDepthStages(values) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const stage = archiveString(value?.stage, 48);
    if (!stage || !/^[a-z][a-z0-9_]{1,47}$/u.test(stage)) continue;
    out.push(pruneUndefinedForFirestore({
      stage,
      pass: value?.pass === true,
      minimumEffectPass: value?.minimumEffectPass === true,
      targetDepthMet: value?.targetDepthMet === true,
      score: archiveFinite(value?.score),
      substantiveEditRatio: archiveFinite(value?.substantiveEditRatio),
      changedSentenceRatio: archiveFinite(value?.changedSentenceRatio),
      targetCoverage: archiveFinite(value?.targetCoverage),
      structuralChangedCount: archiveFinite(value?.structuralChangedCount),
      carryoverRatio: archiveFinite(value?.carryoverRatio)
    }));
    if (out.length >= 16) break;
  }
  return out;
}

function deletePersisted(id) {
  if (!db) return;
  db.collection('transformJobs').doc(id).delete()
    .catch(e => logger.warn('transform.persist_delete_failed', { jobId: id, err: e }));
}

let queueDrainPending = false;
let queueDrainTimer = null;
let queueDrainDue = 0;
function scheduleQueueDrain(delayMs = 0) {
  if (draining) return;
  const due = Date.now() + Math.max(0, delayMs);
  if (queueDrainPending && queueDrainDue <= due) return;
  clearTimeout(queueDrainTimer);
  queueDrainPending = true;
  queueDrainDue = due;
  const t = queueDrainTimer = setTimeout(() => {
    queueDrainPending = false;
    queueDrainTimer = null;
    drainQueue();
  }, Math.max(0, delayMs));
  if (t.unref) t.unref();
}

function drainQueue() {
  if (draining) return 0;
  // One chronological admission queue across both modes. Per-mode ceilings still
  // apply, but formal jobs must not always win the last shared worker slot.
  const running = { formal: countActive('', 'formal').running, short: countActive('', 'short').running };
  let free = Math.max(0, ENGINE_ACTIVE_CAP - running.formal - running.short);
  let started = 0;
  const queued = [...queuedJobsForPool('formal'), ...queuedJobsForPool('short')]
    .sort((a, b) => (a.queuedAt || a.createdAt || 0) - (b.queuedAt || b.createdAt || 0));
  for (const job of queued) {
    if (!free) break;
    const pool = poolOf(job.mode);
    if (running[pool] >= poolCap(job.mode)) continue;
    if (launchQueuedJob(job)) { running[pool]++; free--; started++; }
  }
  return started;
}

function launchQueuedJob(job) {
  if (!job || job.status !== 'queued' || launchingJobs.has(job.id)) return false;
  // 시작 시 이전 인스턴스가 아직 종료 중일 수 있다. Firestore 상태를 다시
  // 확인해 소유권을 넘겨받기 전에는 같은 작업을 두 인스턴스가 동시에 실행하지 않는다.
  if (restartRecovery.isRestartRecoveryHeld(job)) return false;
  if (Number(job.retryNotBeforeMs || 0) > Date.now()) return false;
  job.retryNotBeforeMs = null;
  const isShort = job.mode !== 'formal';
  launchingJobs.add(job.id);
  const hasApprovedEvidence = Object.prototype.hasOwnProperty.call(job, 'approvedEvidence');
  void executeOwned(job, 'main', async () => {
    // The persisted state loaded by executeOwned is authoritative. Start only
    // after ownership; queued jobs must not pretend to run while acquiring it.
    if (job.status === 'cancelled' || job.status === 'awaiting_payment') return;
    if (!job.pendingCompletion) {
      try { providerRecovery.observeAvailability(job, await providerAvailability.checkAdmission()); }
      catch (error) {
        if (!providerAvailability.isUnavailable(error)) throw error;
        providerRecovery.defer(job, error.retryAtMs);
        await persistJob(job);
        return;
      }
      // An outage that outlived the automatic window keeps its source and
      // mode, but asks the owner to resume instead of polling forever.
      if (job.providerRecoveryStartedAtMs && Date.now() - job.providerRecoveryStartedAtMs >= providerRecovery.HOLD_MS) {
        providerRecovery.defer(job, Date.now()); await persistJob(job); return;
      }
    }
    job.status = 'running';
    job.startedAt = Date.now();
    job.queueWaitReason = null;
    job.stage = isShort ? '문장 다듬는 중' : (job.wantEvidence ? '근거 검색' : '구조 계획');
    logger.info('transform.started', {
    jobId: job.id,
    uid: job.uid,
    mode: job.mode,
    textLength: (job.text || '').length,
    bareLength: (job.text || '').replace(/\s+/g, '').length,
    evidence: !!job.wantEvidence,
    needed: job.needed,
    plan: job.plan,
    estSec: job.estSec,
    estLowSec: job.estLowSec,
    estHighSec: job.estHighSec,
    estimateBasis: job.estimateBasis,
    estimatedEditableChunks: job.estimatedEditableChunks,
    queuedMs: Math.max(0, job.startedAt - (job.queuedAt || job.createdAt || job.startedAt))
  });
    if (job.pendingCompletion) return recoverCompletion(job);
    if (job.structurePreview) return runStructurePreview(job);
    if (isShort) return runHumanizeJob(job, job.text || '');
    if (hasApprovedEvidence) return runJob(job, job.text || '', job.approvedEvidence || '');
    if (job.wantEvidence) return runSearchPhase(job, job.text || '');
    return runJob(job, job.text || '', '');
  }).then(async ran => {
    if (ran || !['queued', 'running'].includes(job.status)) return;
    job.status = 'queued'; job.retryNotBeforeMs = Date.now() + 2000;
    job.queueWaitReason = 'execution_lease';
    if (db) {
      const snapshot = await db.collection('transformJobs').doc(job.id).get();
      if (snapshot.exists && (TERMINAL_JOB_STATUSES.has(snapshot.data().status) || snapshot.data().status === 'awaiting_payment')) {
        const persisted = snapshot.data(); delete persisted.executionToken;
        Object.assign(job, persisted);
      }
    }
  }).catch(error => {
    if (job.status === 'cancelled' || job.status === 'awaiting_payment') {
      void persistJob(job);
      return;
    }
    job.status = 'queued'; job.retryNotBeforeMs = Date.now() + 10000;
    job.queueWaitReason = 'connection_retry';
    logger.warn('transform.execution_unavailable', { jobId: job.id, error });
  }).finally(() => {
    launchingJobs.delete(job.id);
    if (job.status === 'queued') scheduleQueueDrain(Math.max(0, Number(job.retryNotBeforeMs || 0) - Date.now()));
    else scheduleQueueDrain();
  });
  return true;
}

const queueDrainInterval = setInterval(() => scheduleQueueDrain(), QUEUE_DRAIN_INTERVAL_MS);
if (queueDrainInterval.unref) queueDrainInterval.unref();

// ── 서버측 이용 기록 노출(2026-06-14) ─────────────────────────────────────────
//   기존엔 변환 결과가 transformJobs(서버) + localStorage 보관함에만 남아, 완료 화면을 못 보고 이탈하면
//   (폴링 401·뒤로가기·브라우저 전환 등) 사용자 화면(이용 기록)에서 결과가 사라졌다.
//   해결: 완료 시 analyze와 동일 컬렉션·스키마(users/{uid}/history)로도 저장 → 이용 기록에 노출되어
//   완료 화면을 못 봐도 결과를 복원할 수 있다. 멱등키 job_<id>(재시작·중복 호출에도 1건).
//   fire-and-forget — 결과는 이미 transformJobs에 있으므로 저장 실패가 job을 죽이면 안 된다.
function saveJobHistory(job, text, outputText) {
  if (!db || job.devNoAuth) return;
  return historyService.saveAnalyzeHistory({
    uid: job.uid,
    requestId: 'job_' + job.id,
    opType: 'humanize',
    text: text || job.text || '',
    needed: (job.result?.billingDisposition || job.billingDisposition) === 'waived_quality_shortfall' ? 0 : job.needed,
    result: { outputText: outputText || '' },
    mode: ['blog', 'formal', 'polish'].includes(job.mode) ? job.mode : 'formal',
    modeSource: job.modeSource === 'defaulted' ? 'defaulted' : 'provided',
    qualityStatus: job.result?.qualityStatus,
    billingDisposition: job.result?.billingDisposition || job.billingDisposition || null,
    qualityWarningCodes: finalQualityWarningCodes(job.result),
    sourceReviewWarningCodes: (job.result?.sourceReviewWarnings || []).map(item => item?.code).filter(Boolean),
    engineMeta: job.result?.engineMeta || null,
    engineVersion: job.result?.engineMeta?.engineVersion || job.result?.refinementAudit?.parentEngineVersion || null,
    auditScope: job.result?.auditScope || null,
    auditVersion: job.result?.auditVersion || null,
    refinementAudit: job.result?.refinementAudit || null,
    sourceProbability: job.sourceProbability ?? null,
    sourceEvidence: job.sourceEvidence || null,
    sourceBand: job.sourceBand ?? null,
    sourceDetectorVersion: job.sourceDetectorVersion ?? null
  }).catch(e => logger.warn('transform.history_save_failed', { jobId: job.id, uid: job.uid, err: e }));
}

// ── 결과 유실 의심 감지(2026-06-14) ───────────────────────────────────────────
//   폴링(GET /transform/:id) 중 토큰 만료로 401이 반복되면, 작업은 서버에서 완료되는데 사용자는
//   결과 화면을 못 본다(클라가 떠남). 그 순간 토큰이 죽어 클라가 스스로 보고할 수도 없으므로,
//   서버가 job.uid로 직접 cs 채널에 알린다. 일시 만료는 클라가 토큰을 갱신해 복구되므로(프론트 폴링 fix)
//   여기까지 반복해서 오지 않는다 → 3번째 연속 401에만 1회 발송(지속 실패=진짜 유실 위험).
function maybeNotifyOrphan(job) {
  if (!job) return;
  if (job.status !== 'running' && job.status !== 'queued' && job.status !== 'done' && job.status !== 'awaiting_approval') return;
  const n = (orphan401.get(job.id) || 0) + 1;
  orphan401.set(job.id, n);
  if (n !== 3) return;   // 3번째에만 1회 발송(이후 n>3은 무시)
  discord.resultRisk({
    uid: job.uid,
    jobId: job.id,
    kind: (job.mode || 'formal') + ' · ' + job.status,
    credits: job.needed,
    reason: '폴링 중 로그인 만료(401)가 반복됐어요. 작업은 서버에 있으나 사용자가 결과를 못 볼 수 있어요.'
  });
  logger.warn('transform.orphan_risk_notified', { jobId: job.id, uid: job.uid, status: job.status, needed: job.needed });
}

function handleAbortedJob(job) {
  if (!job) return 'missing';
  if (job.status === 'cancelled') {
    completionState.normalizeCancelledJob(job);
    persistJob(job);
    return 'cancelled';
  }
  if (job.status === 'awaiting_payment') return 'awaiting_payment';
  if (job.pendingCompletion) {
    job.status = 'queued'; job.retryNotBeforeMs = Date.now() + 60000;
    job.stage = '저장된 결과의 완료 상태를 확인하고 있어요.';
    job.ac = new AbortController();
    persistJob(job);
    return 'completion_recovery';
  }
  if (job.ac?.signal.reason?.code === 'JOB_DEADLINE') {
    job.status = 'error'; job.stage = '처리 시간 초과';
    job.error = '서버 처리 시간 제한을 넘었어요. 완료 결과가 없어 크레딧은 차감하지 않았어요.';
    persistJob(job); return 'deadline';
  }
  if (job.ac?.signal.reason?.code === 'EXECUTION_LEASE_LOST') {
    job.status = 'queued'; job.retryNotBeforeMs = Date.now() + 60000;
    job.stage = '작업 실행 상태를 확인하고 있어요.';
    return 'ownership_recovery';
  }
  if (job._restartRecoveryPending === true
      || (draining && job.status === 'queued' && /자동 재개|서버 교체/u.test(String(job.stage || '')))) {
    persistJob(job);
    return 'restart_recovery';
  }
  if (job.status !== 'error' && job.status !== 'cancelled') {
    job.status = 'cancelled';
    job.stage = '중단됨';
    persistJob(job);
  }
  return 'cancelled';
}

function clearRestartRecoveryTimer(jobId) {
  const timer = restartRecoveryTimers.get(jobId);
  if (timer) clearTimeout(timer);
  restartRecoveryTimers.delete(jobId);
}

function scheduleRestartRecovery(jobId, delayMs = RESTORE_RUNNING_RECOVERY_DELAY_MS) {
  if (!db || !jobId || draining) return;
  clearRestartRecoveryTimer(jobId);
  const timer = setTimeout(() => {
    restartRecoveryTimers.delete(jobId);
    reconcileRestartRecovery(jobId).catch(error => {
      logger.warn('transform.restart_recovery_failed', { jobId, err: error });
      const job = jobs.get(jobId);
      if (job && job._restartRecoveryPending === true && Date.now() - Number(job.createdAt || 0) < JOB_TTL_MS) {
        scheduleRestartRecovery(jobId, Math.min(30000, RESTORE_RUNNING_RECOVERY_DELAY_MS));
      }
    });
  }, Math.max(0, Number(delayMs) || 0));
  if (timer.unref) timer.unref();
  restartRecoveryTimers.set(jobId, timer);
}

async function reconcileRestartRecovery(jobId) {
  if (!db || draining) return false;
  const local = jobs.get(jobId);
  if (!local || local._restartRecoveryPending !== true) return false;

  const snap = await db.collection('transformJobs').doc(jobId).get();
  if (draining || local.executionToken || launchingJobs.has(jobId)) return false;
  const leaseSnapshot = await db.collection(executionPolicy.COLLECTION).doc(executionPolicy.DOCUMENT).get();
  const liveLease = leaseSnapshot.exists ? leaseSnapshot.data()?.slots?.[executionPolicy.keyOf(jobId)] : null;
  if (liveLease && liveLease.expiresAtMs > Date.now()) {
    scheduleRestartRecovery(jobId, Math.max(5000, Math.min(30000, liveLease.expiresAtMs - Date.now())));
    return false;
  }
  if (draining || jobs.get(jobId) !== local || local.executionToken || launchingJobs.has(jobId)) return false;
  if (!snap.exists) {
    restartRecovery.markRestartRecoveryExhausted(local);
    local.error = '자동 재개할 작업 정보를 찾지 못했어요. 크레딧은 차감되지 않았습니다.';
    await persistJob(local);
    return false;
  }

  const persisted = { ...(snap.data() || {}), id: (snap.data() || {}).id || jobId };
  completionState.normalizeCancelledJob(persisted);
  delete persisted.executionToken;
  const persistedStatus = String(persisted.status || '');
  if (TERMINAL_JOB_STATUSES.has(persistedStatus) || ['awaiting_approval', 'awaiting_payment'].includes(persistedStatus)) {
    persisted.ac = new AbortController();
    restartRecovery.releaseRestartRecoveryHold(persisted);
    jobs.set(jobId, persisted);
    archiveJob(persisted);
    return false;
  }

  if (persistedStatus === 'running') {
    const prepared = restartRecovery.prepareRunningJobForRestart(persisted, {
      maxRecoveries: RESTART_RECOVERY_MAX,
      reason: 'unclean_process_restart'
    });
    if (!prepared.recovered) {
      restartRecovery.markRestartRecoveryExhausted(persisted);
      persisted.ac = new AbortController();
      jobs.set(jobId, persisted);
      await persistJob(persisted, { expectedStatus: persistedStatus });
      logger.error('transform.restart_recovery_exhausted', {
        jobId,
        reason: prepared.reason,
        restartRecoveryCount: Number(persisted.restartRecoveryCount || 0)
      });
      return false;
    }
  } else if (persistedStatus !== 'queued') {
    persisted.status = 'error';
    persisted.stage = '자동 재개 상태 오류';
    persisted.error = '서버 교체 후 작업 상태를 복구하지 못했어요. 크레딧은 차감되지 않았습니다.';
    persisted.ac = new AbortController();
    jobs.set(jobId, persisted);
    await persistJob(persisted);
    return false;
  }

  persisted.status = 'queued';
  persisted.stage = '서버 교체 후 자동 재개 대기';
  persisted.error = null;
  persisted.terminalAtMs = null;
  persisted.queuedAt = Number(persisted.queuedAt) || Date.now();
  persisted.ac = new AbortController();
  persisted._restartRecoveryPending = true;
  persisted._restartRecoveryHoldUntilMs = Date.now() + 5000;
  jobs.set(jobId, persisted);
  const recovered = await persistJob(persisted, { expectedStatus: persistedStatus });
  if (!recovered?.ok) {
    scheduleRestartRecovery(jobId, 10000);
    return false;
  }
  restartRecovery.releaseRestartRecoveryHold(persisted);
  logger.info('transform.restart_recovery_queued', {
    jobId,
    mode: persisted.mode,
    restartRecoveryCount: Number(persisted.restartRecoveryCount || 0),
    textLength: String(persisted.text || '').length,
    message: `재시작(배포)으로 끊긴 작업을 자동 재개(${persisted.mode}, ${String(persisted.text || '').length}자, ${Number(persisted.restartRecoveryCount || 0)}회째).`
  });
  scheduleQueueDrain();
  return true;
}

// 서버 시작 시 복원: 완료·승인대기는 그대로 살린다. 이전 인스턴스에서
// running이던 작업은 곧바로 오류로 끝내지 않는다. Render의 무중단 교체 중
// 두 인스턴스가 겹치는 짧은 구간을 기다린 뒤 Firestore 상태를 다시 읽고,
// 같은 job ID·과금 멱등키로 자동 재개한다.
async function restoreJobs() {
  if (!db) return;
  try {
    const documents = [];
    let cursor = null;
    do {
      let query = db.collection('transformJobs').orderBy('__name__').limit(500);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      documents.push(...page.docs);
      cursor = page.docs.length === 500 ? page.docs[page.docs.length - 1] : null;
    } while (cursor);
    const snap = { forEach: fn => documents.forEach(fn) };
    const cutoff = Date.now() - JOB_TTL_MS;
    let kept = 0, recovering = 0, expired = 0;
    snap.forEach(d => {
      const j = d.data();
      completionState.normalizeCancelledJob(j);
      delete j.executionToken;
      if (TERMINAL_JOB_STATUSES.has(j.status) && !j.pendingCompletion && !j.pendingRefinement
          && j.refine?.status !== 'running' && (j.terminalAtMs || j.createdAt || 0) < cutoff) {
        expired++; archiveJob({ ...j, id: j.id || d.id }, { expiredAtMs: Date.now() }); deletePersisted(d.id); return;
      }
      if (!j.createdAt) j.createdAt = Date.now();
      if (completionState.canResumeCompletion(j)) { j.status = 'queued'; j.terminalAtMs = null; }
      j.id = j.id || d.id;
      j.ac = new AbortController();
      // 재시작으로 끊긴 문단 보강은 error로 정규화 — 프론트가 무한 폴링하지 않게.
      if (j.refine && j.refine.status === 'running') {
        j.refine = { ...j.refine, status: 'error', error: '서버 재시작으로 보강이 중단됐어요. 다시 시도하면 저장된 완료 상태부터 확인합니다.' };
      }
      if (j.status === 'running') {
        restartRecovery.holdRestoredRunningJob(j, { delayMs: RESTORE_RUNNING_RECOVERY_DELAY_MS });
        recovering++;
        scheduleRestartRecovery(j.id);
      } else if (j.status === 'queued') {
        void persistJob(j, { requireClaim: true }).then(result => {
          if (result?.blocked) jobs.delete(j.id);
        });
      } else if (j.status === 'cancelled') {
        void persistJob(j);
      } else {
        archiveJob(j);
      }
      jobs.set(j.id, j);
      kept++;
    });
    if (kept || expired) {
      logger.info('transform.jobs_restored', { kept, recovering, interrupted: 0, expired });
    }
    restorationReady = true;
    scheduleQueueDrain(RESTORE_QUEUE_DRAIN_DELAY_MS);
  } catch (e) {
    logger.warn('transform.jobs_restore_failed', { err: e });
    const retry = setTimeout(() => { if (!draining) void restoreJobs(); }, 60000);
    retry.unref();
  }
}
restoreJobs();

const jobDiscovery = require('../lib/transformJobDiscovery').createJobDiscovery({ db,
  enabled: () => restorationReady && !draining,
  onJob: async persisted => {
    const local = jobs.get(persisted.id);
    if (draining || local?.executionToken || launchingJobs.has(persisted.id) || local?._restartRecoveryPending) return;
    delete persisted.executionToken;
    persisted.ac = new AbortController();
    if (persisted.status === 'running') {
      restartRecovery.holdRestoredRunningJob(persisted, { delayMs: 0 });
      jobs.set(persisted.id, persisted);
      scheduleRestartRecovery(persisted.id, 0);
    } else if (persisted.status === 'queued') {
      jobs.set(persisted.id, persisted);
      scheduleQueueDrain();
    }
  }
});
const discoveryInterval = setInterval(() => {
  void jobDiscovery.scan().catch(error => logger.warn('transform.discovery_failed', { err: error }));
}, Math.max(5000, Number(process.env.TRANSFORM_DISCOVERY_INTERVAL_MS) || 15000));
discoveryInterval.unref();

// ── graceful shutdown(server.js가 SIGTERM/SIGINT에서 호출): 새 작업 거부 → 진행 중 LLM 중단 →
//   동일 job ID로 queued 상태를 영속화한다. 다음 인스턴스가 자동 재개하며 완료
//   과금의 멱등키도 그대로라 중복 차감하지 않는다.
router.shutdown = async function shutdown() {
  draining = true;
  for (const jobId of restartRecoveryTimers.keys()) clearRestartRecoveryTimer(jobId);
  const writes = [];
  for (const j of jobs.values()) {
    if (j.auxAc) j.auxAc.abort();
    if (j.status === 'running') {
      const prepared = restartRecovery.prepareRunningJobForRestart(j, {
        maxRecoveries: RESTART_RECOVERY_MAX,
        reason: 'graceful_shutdown'
      });
      if (!prepared.recovered) restartRecovery.markRestartRecoveryExhausted(j);
      try { j.ac.abort(); } catch {}
    }
    ensureTerminalTimestamp(j);
    if (db) {
      writes.push(persistJob(j, {
        requireClaim: ['queued', 'running'].includes(String(j.status || '')),
      }));
    }
  }
  // An admission can already be committing when drain starts. Include its
  // durable handoff in the same bounded shutdown wait, without starting work.
  for (const admission of admissionRequests) {
    writes.push(admission.done.then(() => admission.job && db
      ? persistJob(admission.job, { requireClaim: true }) : undefined));
  }
  let shutdownTimer;
  try { await Promise.race([Promise.allSettled(writes), new Promise(resolve => { shutdownTimer = setTimeout(resolve, 4000); })]); }
  finally { clearTimeout(shutdownTimer); }
};
router.stats = () => {
  const formal = countActive('', 'formal');
  const short = countActive('', 'blog');
  return {
    activeJobs: formal.running + short.running,
    auxiliaryJobs: auxiliaryUsers.size,
    pendingAdmissions: admissionRequests.size,
    queuedJobs: formal.queued + short.queued,
    totalJobs: jobs.size,
    draining,
    restorationReady,
    maxActive: MAX_ACTIVE_GLOBAL,
    engineActiveCap: ENGINE_ACTIVE_CAP,
    modeActiveCaps: { formal: MAX_ACTIVE_GLOBAL, short: BLOG_MAX_ACTIVE }
  };
};

// ── P4: 근거 검색 단계(evidence:true일 때 재구성 전에 실행) ──
//   검색(웹·환각게이트) → 결정론 검수(등급·충돌) → awaiting_approval로 멈추고 학생 승인 대기.
//   승인 전이므로 과금 없음. 후보 0건이면 근거 없이 바로 재구성 진행(차단 아님 — 검색 실패가 작업을 죽이면 안 됨).
async function runSearchPhase(job, text) {
  try {
    job.status = 'running';
    job.stage = '근거 검색';
    const gptCfg = await activeGptConfig();
    if (!gptCfg) throw technicalProviderError();
    const ev = await gptAnalyze.suggestEvidence({
      query: text,
      signal: job.ac.signal,
      config: gptCfg,
      uid: job.uid
    });
    const candidates = (ev.candidates || []).map(c => ({
      fact: c.reason || c.title,
      sourceTitle: c.title || c.publisher || hostOf(c.url),
      sourceUrl: c.url,
      publisher: c.publisher
    }));
    const reviewed = reviewCandidates(candidates);
    if (!reviewed.length) {
      logger.warn('transform.evidence_empty', { jobId: job.id, uid: job.uid });
      job.note = '주제와 맞는 검증 가능한 근거를 찾지 못해 근거 없이 진행했어요.';
      return runJob(job, text, '');
    }
    job.candidates = reviewed.map((c, i) => ({
      id: i,
      fact: c.fact,
      sourceTitle: c.sourceTitle || hostOf(c.sourceUrl),
      sourceUrl: c.sourceUrl,
      host: hostOf(c.sourceUrl),
      grade: c.grade,
      conflict: c.conflict,
      conflictDetail: c.conflictDetail
    }));
    job.status = 'awaiting_approval';
    job.stage = '근거 검수 대기';
    persistJob(job);   // 승인 대기는 재시작 후에도 text·후보가 살아 있어 그대로 승인→재개 가능
    logger.info('transform.awaiting_evidence_approval', {
      jobId: job.id,
      uid: job.uid,
      candidates: job.candidates.length,
      gradeA: job.candidates.filter(c => c.grade === 'A').length,
      gradeB: job.candidates.filter(c => c.grade === 'B').length,
      gradeC: job.candidates.filter(c => c.grade === 'C').length,
      conflicts: job.candidates.filter(c => c.conflict).length
    });
    scheduleQueueDrain();
  } catch (e) {
    if (job.ac.signal.aborted) {
      handleAbortedJob(job);
      scheduleQueueDrain();
      return;
    }
    logger.error('transform.evidence_search_failed', { jobId: job.id, uid: job.uid, err: e });
    job.note = '근거 검색이 실패해 근거 없이 진행했어요.';
    return runJob(job, text, '');
  }
}

function compactArchiveCodeCountMap(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(source).slice(0, 20).map(([code, count]) => {
    const safeCode = String(archiveString(code, 80) || '').replace(/[^a-z0-9_.:-]/giu, '_');
    const safeCount = archiveFinite(count);
    return [safeCode, safeCount];
  }).filter(([code, count]) => code && Number.isFinite(count) && count > 0));
}

function preservationFallbackAllowed(mode) {
  return false; // Neither basic nor advanced requests may downgrade to polish.
}

function recoverableTechnicalBlockReason(out) {
  const engineMeta = out?.engineMeta || out?.result?.engineMeta || {};
  const modelFailureCodes = [
    ...(Array.isArray(engineMeta.chunkFailureCodes) ? engineMeta.chunkFailureCodes : []),
    ...(Array.isArray(engineMeta.chunkResidualFailureCodes) ? engineMeta.chunkResidualFailureCodes : [])
  ].map(value => String(value || '').toLowerCase());
  // A concurrent chunk may also report a temporary error. Account-wide
  // exhausted credit still makes a whole-job retry futile.
  if (modelFailureCodes.includes('openai_quota_exhausted')) return '';
  const recoverableModelFailure = modelFailureCodes.find(code => /^(?:openai_(?:truncated_output|incomplete_output|empty_output|timeout|network_error|server_error|rate_limited))$/u.test(code));
  if (recoverableModelFailure) return recoverableModelFailure;
  // refusal·quota·prompt 계약 실패처럼 반복해도 나아지지 않는 원인이 명시된
  // 경우 generic no_approved 게이트만 보고 전체 문서를 다시 호출하지 않는다.
  if (modelFailureCodes.length) return '';
  const gates = (out?.floorReport?.criticals || [])
    .map(deliveryPolicy.gateOf)
    .filter(Boolean)
    .map(value => String(value || '').toLowerCase());
  return gates.includes('no_approved_model_chunks') ? 'no_approved_model_chunks' : '';
}

function queueTechnicalRecovery(job, out) {
  if (!job || TECHNICAL_BLOCK_AUTO_RETRY_MAX <= 0) return false;
  const reason = recoverableTechnicalBlockReason(out);
  const count = Math.max(0, Number(job.technicalRecoveryCount) || 0);
  if (!reason || count >= TECHNICAL_BLOCK_AUTO_RETRY_MAX) return false;

  const now = Date.now();
  job.status = 'queued';
  job.stage = '일시적 모델 오류 자동 재처리 대기';
  job.error = null;
  job.gates = [];
  job.gateDetail = null;
  job.blockOffer = null;
  job.terminalAtMs = null;
  job.queuedAt = now;
  job.startedAt = null;
  job.technicalRecoveryCount = count + 1;
  job.technicalRecoveryAtMs = now;
  job.technicalRecoveryReason = reason;
  job.retryNotBeforeMs = now + (TECHNICAL_BLOCK_AUTO_RETRY_DELAY_MS * job.technicalRecoveryCount);
  job.ac = job.auxAc || new AbortController();
  persistJob(job);
  logger.warn('transform.humanize_technical_recovery_queued', {
    jobId: job.id,
    mode: job.mode,
    reason,
    technicalRecoveryCount: job.technicalRecoveryCount,
    message: `기술 원인(${reason})으로 작업을 자동 재시도 큐에 넣음(${job.technicalRecoveryCount}회째). 이후 humanize_done이 따라오면 정상.`
  });
  scheduleQueueDrain(Math.max(1000, job.retryNotBeforeMs - now));
  return true;
}

async function runAdminHumanizeLabJob(job, text, evidence) {
  try {
    const profile = adminLabProfileOf(job);
    const isFinalReport = profile === 'final_report_engine';
    const isFundamental = profile === 'fundamental_engine';
    const isV6 = profile === 'v6_engine';
    const isGpt = profile === 'gpt_engine';
    const isQualityPatternLab = profile === 'ko_quality_pattern_lab';
    const engineMode = job.mode === 'blog' ? 'blog' : 'assignment';
    const tonePolish = job.mode === 'polish';
    job.status = 'running';
    job.stage = isQualityPatternLab ? '관리자 테스트 · 한국어 품질 패턴 shadow 감사'
      : isGpt ? '관리자 테스트 · GPT 전용 엔진'
      : isV6 ? '관리자 테스트 · V9 카피킬러 안전 엔진'
      : isFundamental ? '관리자 테스트 · 근본개선 엔진'
      : isFinalReport ? '관리자 테스트 · 최종 개선보고서 엔진'
        : '관리자 테스트 · 보존형 엔진';
    if (job.niklQualityTest) job.stage += ' · 국어원식 품질 테스트';
    if (job.basicExperiment) {
      job.basicExperiment = { ...job.basicExperiment, profile, applied: true, appliedAtMs: Date.now() };
    }
    job.adminLabProfile = profile;
    persistJob(job);

    const runtimeCfg = await gptRuntimeConfig.getRuntimeConfig({ db, logger });
    const activeGpt = gptRuntimeConfig.isGptActive(runtimeCfg) ? runtimeCfg : null;
    if (!activeGpt) throw technicalProviderError();
    const gptTestCfg = job.gptModel
      ? { ...runtimeCfg, models: { ...(runtimeCfg.models || {}), humanizePrimary: job.gptModel } }
      : runtimeCfg;
    const labCall = opts => gptAnalyze.callGpt({ ...opts, config: activeGpt });
    const labExtract = gptAnalyze.extractGptResult;
    let baselineOut = null;

    const out = isQualityPatternLab
      ? await runAdminQualityPatternAudit({
        job,
        text,
        mode: tonePolish ? 'polish' : engineMode,
        lang: job.lang || 'ko',
        evidence,
        config: gptTestCfg,
        styleProfile: 'admin_gpt_engine'
      })
      : isGpt
      ? await runAdminGptLabWithOptionalNiklCompare({
        job,
        text,
        mode: tonePolish ? 'polish' : engineMode,
        lang: job.lang || 'ko',
        evidence,
        config: gptTestCfg,
        styleProfile: 'admin_gpt_engine',
        label: 'GPT 전용 엔진',
        setBaseline: out => { baselineOut = out; }
      })
      : (isFundamental || isV6)
      ? await loadAdminHumanizeEngines().run(profile, {
        text,
        mode: isV6 ? (job.mode || engineMode) : engineMode,
        lang: job.lang || 'ko',
        signal: job.ac.signal,
        userNotes: job.memo || '',
        evidence: evidence || '',
        callModel: labCall,
        extractModelResult: labExtract
      })
      : await runAdminGptLabWithOptionalNiklCompare({
        job,
        text,
        mode: engineMode,
        lang: job.lang || 'ko',
        evidence,
        config: activeGpt,
        styleProfile: profile,
        label: profile,
        setBaseline: out => { baselineOut = out; }
      });
    if (out.floorReport) {
      const adminDelivery = applyRouteDeliveryPolicy(out, {
        mode: tonePolish ? 'polish' : engineMode,
        logName: 'transform.admin_humanize_lab_review_delivered',
        meta: { jobId: job.id, uid: job.uid, profile }
      });
      if (adminDelivery.decision === 'block_technical') {
        const gates = (out.floorReport.criticals || [])
          .map(deliveryPolicy.gateOf)
          .filter(Boolean);
        logger.warn('transform.admin_humanize_lab_blocked', { jobId: job.id, uid: job.uid, profile, gates });
        job.status = 'blocked';
        job.gates = gates;
        job.gateDetail = { criticals: (out.floorReport.criticals || []).slice(0, 8) };
        job.stage = blockedStage(gates);
        job.blockOffer = buildBlockOffer(job, text);
        persistJob(job);
        return;
      }
    }
    if (!out.result || !out.result.outputText) throw new Error('admin_preserve_lab_incomplete');
    job.status = 'done';
    job.result = {
      outputText: out.result.outputText,
      adminHumanizeLab: true,
      adminLabProfile: profile,
      floorReport: {
        status: out.floorReport.status,
        criticals: out.floorReport.criticals,
        warnings: (out.floorReport.warnings || []).map(compactFloorWarning).filter(Boolean),
        metrics: out.floorReport.metrics
      },
      metrics: out.floorReport.metrics,
      chunkCount: out.chunkCount,
      fallbackCount: out.fallbackCount,
      basicExperiment: job.basicExperiment || null,
      styleProfile: out.result.styleProfile || profile,
      preserveLab: out.result.preserveLab || null,
      finalReportEngine: out.result.finalReportEngine || null,
      fundamentalEngine: out.result.fundamentalEngine || null,
      v6Engine: out.result.v6Engine || null,
      humanizeMeta: out.result.humanizeMeta || null,
      niklQualityTest: out.result.niklQualityTest || out.result.humanizeMeta?.niklQualityTest || null,
      niklQualityCompare: baselineOut ? buildAdminLabNiklCompare(baselineOut, out) : null,
      qualityPatternLab: out.result.qualityPatternLab || null,
      qualityPatternCompare: buildAdminLabQualityPatternAuditSummary(out),
      qualityProfileBefore: out.result.qualityProfileBefore || null,
      qualityProfileAfter: out.result.qualityProfileAfter || null,
      patternDelta: out.result.patternDelta || null,
      auditTrail: out.result.auditTrail || null,
      protectedTermReport: out.result.protectedTermReport || null,
      claimStrengthDrift: out.result.claimStrengthDrift || null,
      rhetoricalInsertion: out.result.rhetoricalInsertion || null,
      grammarHardError: out.result.grammarHardError || null,
      niklQuality: out.result.niklQuality || null,
      externalApiHintsUsed: out.result.externalApiHintsUsed === true,
      layoutNlpTest: job.layoutNlpTest === true,
      layoutFormat: out.result.layoutFormat || null,
      layoutFormatCompare: baselineOut && out.result.layoutFormat ? buildAdminLabLayoutCompare(baselineOut, out) : null,
      baselineOutputText: baselineOut?.result?.outputText || '',
      baselineHumanizeMeta: baselineOut?.result?.humanizeMeta || null,
      baselineFloorReport: baselineOut?.floorReport || baselineOut?.result?.floorReport || null,
      compressionFallback: !!out.result.compressionFallback
    };
    persistJob(job);
    logger.info('transform.admin_humanize_lab_done', {
      jobId: job.id,
      uid: job.uid,
      mode: job.mode,
      profile,
      chunkCount: out.chunkCount,
      fallbackCount: out.fallbackCount,
      niklQualityTest: job.niklQualityTest === true,
      path: (out.result.v6Engine || out.result.fundamentalEngine || out.result.finalReportEngine || out.result.preserveLab || {}).path,
      engineStatus: (out.result.v6Engine || out.result.fundamentalEngine || out.result.finalReportEngine || out.result.preserveLab || {}).status,
      hardFails: (out.result.v6Engine || out.result.fundamentalEngine || out.result.finalReportEngine || out.result.preserveLab || {}).hardFails
    });
  } catch (e) {
    if (job.ac.signal.aborted) {
      handleAbortedJob(job);
      return;
    }
    logger.error('transform.admin_humanize_lab_failed', { jobId: job.id, uid: job.uid, mode: job.mode, profile: adminLabProfileOf(job), err: e });
    job.status = 'error';
    job.error = '관리자 테스트 처리 중 오류가 발생했어요. 크레딧은 차감되지 않았어요.';
    persistJob(job);
  } finally {
    scheduleQueueDrain();
  }
}

async function runAdminQualityPatternAudit({
  job,
  text,
  mode,
  lang,
  evidence,
  config,
  styleProfile
}) {
  job.stage = '관리자 테스트 · 운영 GPT 결과 생성 중';
  persistJob(job);
  const out = await gptAnalyze.runHumanizeChunked({
    text,
    mode,
    lang,
    signal: job.ac.signal,
    deadlineMs: job.executionDeadlineMs,
    userNotes: job.memo || '',
    evidence: evidence || '',
    config,
    documentProfileOverride: job.documentProfileOverride || '',
    allowPolish: mode === 'polish',
    recoveryBudgetUsd: Number(job.recoveryBudgetUsd)
      || recoveryBudgetUsdForCredits(job.listPriceCredits || job.needed),
    uid: job.uid,
    styleProfile,
    niklQualityTest: job.niklQualityTest === true
  });
  job.stage = '관리자 테스트 · 한국어 품질 패턴 shadow 감사 중';
  persistJob(job);
  return loadAdminHumanizeEngines().attachQualityPatternAudit(out, text, { mode });
}

async function runAdminGptLabWithOptionalNiklCompare({
  job,
  text,
  mode,
  lang,
  evidence,
  config,
  styleProfile,
  label,
  setBaseline
}) {
  const layoutNlpTest = job.layoutNlpTest === true;
  const common = {
    text,
    mode,
    lang,
    signal: job.ac.signal,
    deadlineMs: job.executionDeadlineMs,
    userNotes: job.memo || '',
    evidence: evidence || '',
    layoutNlp: layoutNlpTest ? false : null,
    config,
    documentProfileOverride: job.documentProfileOverride || '',
    allowPolish: mode === 'polish',
    recoveryBudgetUsd: Number(job.recoveryBudgetUsd)
      || recoveryBudgetUsdForCredits(job.listPriceCredits || job.needed),
    uid: job.uid
  };
  const shouldCompare = job.niklQualityTest === true || layoutNlpTest;
  if (!shouldCompare) {
    return await gptAnalyze.runHumanizeChunked({ ...common, styleProfile, niklQualityTest: false });
  }

  job.stage = `관리자 테스트 · ${label || 'GPT'} · 기준 결과 생성 중`;
  persistJob(job);
  const baseline = await gptAnalyze.runHumanizeChunked({ ...common, styleProfile, niklQualityTest: false });
  if (typeof setBaseline === 'function') setBaseline(baseline);

  let testText = text;
  let preLayout = null;
  if (layoutNlpTest) {
    job.stage = `관리자 테스트 · ${label || 'GPT'} · 문서 형태 입력 복원 중`;
    persistJob(job);
    // The lab runs on the production instance. Python NLP loads a full Kiwi
    // model per call, so it follows the same switch as the engine (default off).
    preLayout = await layoutNormalizer.formatDocument(text, {
      mode,
      phase: 'pre',
      enableNlp: layoutNormalizer.isPythonNlpEnabled(),
      timeoutMs: Number(process.env.LAYOUT_NLP_TIMEOUT_MS || 5000) || 5000
    });
    testText = preLayout.text || text;
  }

  job.stage = layoutNlpTest
    ? `관리자 테스트 · ${label || 'GPT'} · 레이아웃 NLP 결과 생성 중`
    : `관리자 테스트 · ${label || 'GPT'} · 국어원식 품질 테스트 결과 생성 중`;
  persistJob(job);
  const testOut = await gptAnalyze.runHumanizeChunked({
    ...common,
    text: testText,
    styleProfile,
    niklQualityTest: job.niklQualityTest === true
  });
  if (layoutNlpTest && testOut?.result?.outputText) {
    job.stage = `관리자 테스트 · ${label || 'GPT'} · 문서 형태 출력 후처리 중`;
    persistJob(job);
    const postLayout = await layoutNormalizer.formatDocument(testOut.result.outputText, {
      mode,
      phase: 'post',
      enableNlp: layoutNormalizer.isPythonNlpEnabled(),
      timeoutMs: Number(process.env.LAYOUT_NLP_TIMEOUT_MS || 5000) || 5000
    });
    testOut.result.outputText = postLayout.text || testOut.result.outputText;
    testOut.result.layoutFormat = {
      enabled: true,
      pythonNlpEnabled: layoutNormalizer.isPythonNlpEnabled(),
      version: layoutNormalizer.VERSION,
      pre: preLayout?.report || null,
      post: postLayout.report || null,
      inputChanged: Boolean(preLayout?.report?.applied),
      outputChanged: Boolean(postLayout.report?.applied)
    };
  }
  return testOut;
}

function buildAdminLabNiklCompare(baselineOut, testOut) {
  const baselineText = String(baselineOut?.result?.outputText || '');
  const testText = String(testOut?.result?.outputText || '');
  const baseSentences = splitCompareSentences(baselineText);
  const testSentences = splitCompareSentences(testText);
  const baseParagraphs = splitCompareParagraphs(baselineText);
  const testParagraphs = splitCompareParagraphs(testText);
  const changedSentenceRatio = compareChangedRatio(baseSentences, testSentences);
  const changedParagraphRatio = compareChangedRatio(baseParagraphs, testParagraphs);
  const baseTokens = compareTokenSet(baselineText);
  const testTokens = compareTokenSet(testText);
  const addedKeywords = [...testTokens].filter(t => !baseTokens.has(t)).slice(0, 20);
  const removedKeywords = [...baseTokens].filter(t => !testTokens.has(t)).slice(0, 20);
  return {
    enabled: true,
    baselineStatus: baselineOut?.floorReport?.status || baselineOut?.result?.floorReport?.status || baselineOut?.status || '',
    testStatus: testOut?.floorReport?.status || testOut?.result?.floorReport?.status || testOut?.status || '',
    length: {
      baseline: baselineText.length,
      test: testText.length,
      delta: testText.length - baselineText.length
    },
    paragraphs: {
      baseline: baseParagraphs.length,
      test: testParagraphs.length,
      delta: testParagraphs.length - baseParagraphs.length,
      changedRatio: changedParagraphRatio
    },
    sentences: {
      baseline: baseSentences.length,
      test: testSentences.length,
      delta: testSentences.length - baseSentences.length,
      changedRatio: changedSentenceRatio
    },
    keywords: {
      added: addedKeywords,
      removed: removedKeywords
    },
    niklQualityTest: testOut?.result?.niklQualityTest || testOut?.result?.humanizeMeta?.niklQualityTest || null
  };
}

function buildAdminLabQualityPatternAuditSummary(out) {
  const result = out?.result || {};
  if (!result.qualityPatternLab) return null;
  const delta = result.patternDelta || {};
  const audit = result.auditTrail || {};
  const protectedReport = result.protectedTermReport || {};
  const grammar = result.grammarHardError || {};
  const rhetoric = result.rhetoricalInsertion || {};
  const claim = result.claimStrengthDrift || {};
  return {
    enabled: true,
    auditOnly: true,
    compareType: 'quality_pattern_shadow_audit',
    labels: {
      source: '원문',
      output: '운영 GPT 결과'
    },
    qualityPattern: {
      enabled: true,
      auditOnly: true,
      action: audit.action || result.qualityPatternLab?.action || '',
      warnings: audit.warnings || [],
      blockers: audit.blockers || [],
      beforeRisk: delta.beforeRisk,
      afterRisk: delta.afterRisk,
      riskDelta: delta.riskDelta,
      byCategory: delta.byCategory || {},
      reducedCount: delta.reducedCount || 0,
      increasedCount: delta.increasedCount || 0,
      reducedPatterns: (delta.reducedPatterns || []).slice(0, 8),
      increasedPatterns: (delta.increasedPatterns || []).slice(0, 8),
      protectedTermLossCount: protectedReport.lossCount || 0,
      protectedTermLost: (protectedReport.lost || []).slice(0, 12),
      grammarHardError: grammar,
      rhetoricalInsertion: rhetoric,
      claimStrengthDrift: claim,
      externalApiHintsUsed: result.externalApiHintsUsed === true
    }
  };
}

function buildAdminLabLayoutCompare(baselineOut, testOut) {
  const base = buildAdminLabNiklCompare(baselineOut, testOut);
  const layout = testOut?.result?.layoutFormat || {};
  const pre = layout.pre || {};
  const post = layout.post || {};
  return {
    ...base,
    compareType: 'layout_nlp_test',
    labels: {
      baseline: '현재 GPT',
      test: '레이아웃 NLP ON'
    },
    layoutFormat: {
      enabled: true,
      inputChanged: layout.inputChanged === true,
      outputChanged: layout.outputChanged === true,
      pre: compactLayoutReportForCompare(pre),
      post: compactLayoutReportForCompare(post),
      engines: mergeLayoutEngines(pre, post)
    }
  };
}

function compactLayoutReportForCompare(report) {
  if (!report) return null;
  return {
    phase: report.phase || '',
    profile: report.profile || '',
    applied: report.applied === true,
    needScore: report.need?.score,
    before: report.before || null,
    after: report.after || null,
    gates: report.gates || null,
    nlp: report.nlp || null
  };
}

function mergeLayoutEngines(pre, post) {
  const names = ['kss', 'kiwipiepy', 'pykospacing'];
  const out = {};
  for (const name of names) {
    const p = pre?.nlp?.engines?.[name] || {};
    const q = post?.nlp?.engines?.[name] || {};
    out[name] = {
      ok: p.ok === true || q.ok === true,
      version: p.version || q.version || '',
      preOk: p.ok === true,
      postOk: q.ok === true,
      error: p.ok === true || q.ok === true ? '' : (q.error || p.error || '')
    };
  }
  return out;
}

function compactFloorWarning(warning) {
  if (!warning) return '';
  if (typeof warning === 'string') return warning;
  return String(warning.gate || warning.type || warning.reason || warning.action || '').trim();
}

function splitCompareParagraphs(text) {
  return String(text || '').split(/\n[ \t]*\n+/).map(p => p.trim()).filter(Boolean);
}

function splitCompareSentences(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function compareChangedRatio(a, b) {
  const max = Math.max(a.length, b.length);
  if (!max) return 0;
  let changed = 0;
  for (let i = 0; i < max; i += 1) {
    if (normalizeCompareUnit(a[i]) !== normalizeCompareUnit(b[i])) changed += 1;
  }
  return Number((changed / max).toFixed(3));
}

function normalizeCompareUnit(text) {
  return String(text || '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

function compareTokenSet(text) {
  const set = new Set();
  const re = /[가-힣A-Za-z0-9][가-힣A-Za-z0-9+.#-]{1,}/g;
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    const token = String(match[0] || '').trim();
    if (token.length >= 2 && token.length <= 28 && !/^\d+$/.test(token)) set.add(token);
    if (set.size >= 300) break;
  }
  return set;
}

async function runJob(job, text, evidence) {
  try {
    job.status = 'running';
    job.stage = '재구성';
    persistJob(job);

    if (isAdminHumanizeLabJob(job)
        && (job.mode !== 'formal'
          || isFundamentalEngineJob(job)
          || isV6EngineJob(job)
          || isGptEngineJob(job)
          || isKoQualityPatternLabJob(job))) {
      return await runAdminHumanizeLabJob(job, text, evidence);
    }
    if (isAdminHumanizeLabJob(job)) {
      const profile = markAdminLabPipeline(job, 'production_formal_pipeline');
      job.stage = '관리자 테스트 · 운영 고급 재구성';
      persistJob(job);
      logger.info('transform.admin_humanize_lab_formal_pipeline_started', {
        jobId: job.id,
        uid: job.uid,
        mode: job.mode,
        profile,
        path: 'production_formal_pipeline'
      });
    }

    // v2.5 has one production engine. Rollback restores the previous live
    // deployment; no legacy or secondary-provider route remains here.
    return await runHumanizeJob(job, text, evidence || '');
  } catch (error) {
    if (job.ac.signal.aborted) {
      handleAbortedJob(job);
      return;
    }
    logger.error('transform.failed', {
      jobId: job.id,
      uid: job.uid,
      mode: job.mode,
      code: error?.code,
      err: error
    });
    job.status = 'error';
    job.error = '재구성 처리 중 기술 오류가 발생했어요. 크레딧은 차감되지 않았어요.';
    job.deliveryDecision = 'block_technical';
    job.deliveryReasonCodes = [String(error?.code || 'transform_pipeline_error').toLowerCase()];
    persistJob(job);
  } finally {
    scheduleQueueDrain();
  }
}
// ── short job 러너: 블로그 변환·다듬기를 영속 job으로 처리해 새로고침·창닫기에도 이어간다.
//   blog·polish·formal 모두 동일한 GPT 운영 엔진과 전달 정책을 사용한다.
async function runHumanizeJob(job, text, evidence = '') {
  try {
    job.status = 'running';
    job.stage = '문장 다듬는 중';
    persistJob(job);
    const isPolish = job.mode === 'polish';
    const engineMode = job.mode;
    let styleProfile = '';
    const preserveLab = isPreserveLabJob(job);
    const finalReportLab = isFinalReportEngineJob(job);
    const adminSafetyLab = preserveLab || finalReportLab;
    if (preserveLab) {
      styleProfile = 'preserve_lab';
      job.basicExperiment = {
        ...(job.basicExperiment || {}),
        profile: styleProfile,
        applied: true,
        appliedAtMs: Date.now()
      };
      logger.info('transform.admin_preserve_lab_profile_applied', { jobId: job.id, uid: job.uid, mode: job.mode, profile: styleProfile });
    } else if (finalReportLab) {
      styleProfile = 'final_report_engine';
      job.adminLabProfile = styleProfile;
      job.basicExperiment = {
        ...(job.basicExperiment || {}),
        profile: styleProfile,
        applied: true,
        appliedAtMs: Date.now()
      };
      logger.info('transform.admin_final_report_engine_profile_applied', { jobId: job.id, uid: job.uid, mode: job.mode, profile: styleProfile });
    }
    const gptCfg = await activeGptConfig();
    if (!gptCfg) throw technicalProviderError();
    const out = await gptAnalyze.runHumanizeChunked({
          text,
          mode: engineMode,
          lang: job.lang || 'ko',
          signal: job.ac.signal,
          deadlineMs: job.executionDeadlineMs,
          userNotes: job.memo || '',
          evidence: evidence || '',
          config: gptCfg,
          styleProfile: styleProfile || 'production_transform_humanize',
          approvedStructure: job.approvedStructure || null,
          basicStyle: job.basicStyle || '',
          documentProfileOverride: job.documentProfileOverride || '',
          allowPolish: isPolish,
          recoveryBudgetUsd: Number(job.recoveryBudgetUsd)
            || recoveryBudgetUsdForCredits(job.listPriceCredits || job.needed),
          // 원본 UID는 OpenAI 요청에 직접 전달되지 않는다. 엔진 내부에서
          // OPENAI_SAFETY_SALT 기반 HMAC으로만 변환한다.
          uid: job.uid
        });
    // FLOOR 게이트 = 기본은 결과 전달+경고. 치명 출력만 차단한다.
    if (out.floorReport && out.floorReport.status === 'blocked') {
      const gates = (out.floorReport.criticals || []).map(c => c.gate);
      const gateDetail = { criticals: (out.floorReport.criticals || []).slice(0, 8) };
      job.engineMeta = out.engineMeta || out.result?.engineMeta || null;
      if ((job.engineMeta?.modelFailureCodes || []).includes('openai_quota_exhausted')) {
        providerRecovery.defer(job, providerAvailability.peek()?.retryAtMs);
        await persistJob(job); return;
      }
      if (queueTechnicalRecovery(job, out)) return;
      logger.warn('transform.humanize_blocked', {
        jobId: job.id,
        uid: job.uid,
        mode: job.mode,
        gates,
        gateDetail,
        reason: Array.isArray(gates) ? gates.join(',') : undefined,
        message: `품질 게이트 차단(${job.mode}): ${(Array.isArray(gates) ? gates : []).join(', ') || '사유 없음'} — 결과 미전달·무차감.`
      });
      // 기본 작업에만 동의 기반 다듬기 선택지를 붙인다. 고급은 같은
      // 강도로 다시 시도하며 보존형으로 다운그레이드하지 않는다.
      job.status = 'blocked';
      job.stage = blockedStage(gates);
      job.gates = gates;
      job.gateDetail = gateDetail;
      job.blockOffer = buildBlockOffer(job, text);
      job.semanticAuditTrace = out.privateSemanticAudit || null;
      job.blockedAuditContext = out.privateBlockedContext || null;
      // Same transaction as the terminal state, no user charge. Private
      // evidence is not part of owner-readable job fields or public status.
      const saved = await persistJob(job);
      if (!saved?.ok) logger.error('transform.blocked_evidence_persist_failed', {
        jobId: job.id, uid: job.uid, code: saved?.code || 'persist_failed'
      });
      return;
    }
    if (!out.result || !out.result.outputText) throw new Error('humanize_incomplete');
    if ((out.effectStatus || out.result.effectStatus) === 'limited') {
      job.note = (job.note ? job.note + ' ' : '') + (isPolish
        ? '원문과 거의 동일하게 나왔어요(다듬기는 원문을 최대한 보존하는 모드예요). 더 바꾸려면 「기본 피하기」나 「고급 피하기」를 써 보세요 — 같은 글로 다듬기를 다시 돌려도 결과는 비슷해요.'
        : (job.mode === 'formal'
            ? '고급 변환을 적용했지만 안전하게 바꿀 수 있는 범위가 제한적이었어요.'
            : '원문과 큰 차이 없이 나왔어요. 더 넓은 재구성이 필요하면 「고급 피하기」를 쓰거나 경험 메모를 더해 다시 시도해 주세요.'));
    }
    // ★ 사실 누락 소프트 안내(2026-06-16): lostFacts가 소프트가 되어 차단 대신 전달되므로, 빠진 사실을 사용자가 대조하게 안내.
    if ((out.floorReport.warnings || []).some(w => w.gate === 'lostFacts')) {
      job.note = (job.note ? job.note + ' ' : '') + '원문의 사실 일부(연도·수치·기관명 등)가 다듬는 과정에서 빠졌을 수 있어요. 결과를 원문과 한 번 대조해 주세요.';
    }
    const finalText = out.result.outputText;
    if (job.structureMode === 'improve') {
      const improvement = out.result.structureImprovement || { requested: true, applied: false, changes: [] };
      job.structureCredits = improvement.applied ? restructureStructureCredit(text.length) : 0;
      job.needed = job.basePriceCredits + job.structureCredits;
      if (out.result.engineMeta) Object.assign(out.result.engineMeta, { structureCredits: job.structureCredits, structureApplied: improvement.applied,
        structurePlanningUsd: Number(job.approvedStructure?.usage?.estimatedUsd) || 0 });
      job.note = (job.note ? job.note + ' ' : '') + (improvement.applied
        ? '확인한 구조 변경안을 적용했습니다.'
        : '구조 변경은 적용하지 않았으며 구조 추가요금은 차감하지 않습니다.');
    }
    const v2QualityStatus = out.qualityStatus || out.result.qualityStatus || 'clean';
    const v2QualityWarnings = out.qualityWarnings || out.result.qualityWarnings || [];
    const v2EffectStatus = out.effectStatus || out.result.effectStatus || 'normal';
    const v2EffectNotices = out.effectNotices || out.result.effectNotices || [];
    if (out.engineMeta && typeof out.engineMeta === 'object') {
      out.engineMeta.billingDisposition = job.billingDisposition;
      out.engineMeta.effectExpectation = job.effectExpectation || 'normal';
      out.engineMeta.effectNoticeCode = job.effectNoticeCode || null;
    }
    if (out.result?.engineMeta && typeof out.result.engineMeta === 'object') {
      out.result.engineMeta.billingDisposition = job.billingDisposition;
      out.result.engineMeta.effectExpectation = job.effectExpectation || 'normal';
      out.result.engineMeta.effectNoticeCode = job.effectNoticeCode || null;
    }
    const completionResult = {
      outputText: finalText,
      floorReport: {
        status: out.floorReport.status,
        criticals: out.floorReport.criticals,
        warnings: (out.floorReport.warnings || []).map(w => w.gate),
        metrics: out.floorReport.metrics
      },
      metrics: out.floorReport.metrics,   // 배지 렌더 호환(formal과 동일 접근 경로)
      weakTransform: !!out.result.weakTransform,   // 약한 변환(보존형 수준) — UI 안내·강도 추천용
      noOpScore: Number.isFinite(out.result.noOpScore) ? out.result.noOpScore : null,
      registerLeak: out.result.registerLeak,
      chunkCount: out.chunkCount,
      fallbackCount: out.fallbackCount,
      basicStyle: job.basicStyle || null,
      basicExperiment: job.basicExperiment || null,
      styleProfile: out.result.styleProfile || null,
      preserveLab: out.result.preserveLab || null,
      finalReportEngine: out.result.finalReportEngine || null,
      humanizeMeta: out.result.humanizeMeta || null,
      qualityStatus: v2QualityStatus,
      qualityWarnings: v2QualityWarnings,
      effectStatus: v2EffectStatus,
      effectNotices: v2EffectNotices,
      billingDisposition: job.billingDisposition,
      sourceReviewWarnings: out.sourceReviewWarnings || out.result.sourceReviewWarnings || [],
      structureImprovement: out.result.structureImprovement || null,
      creditBreakdown: { base: job.basePriceCredits ?? job.listPriceCredits ?? job.needed, structure: job.structureCredits || 0, total: job.needed },
      koreanRefinement: out.result.koreanRefinement ? {
        version: Number(out.result.koreanRefinement.version) || 0,
        pass: out.result.koreanRefinement.pass === true,
        issueCodes: Array.isArray(out.result.koreanRefinement.issueCodes) ? out.result.koreanRefinement.issueCodes : [],
        introducedIssueCount: Number(out.result.koreanRefinement.introducedIssueCount) || 0,
        repairableIssueCount: Number(out.result.koreanRefinement.repairableIssueCount) || 0
      } : null,
      engineMeta: out.engineMeta || out.result.engineMeta || null,
      naturalnessShadow: out.result.naturalnessShadow || null,
      adminLabProfile: job.adminLabProfile || (adminSafetyLab ? styleProfile : null),
      adminHumanizeLab: !!job.adminHumanizeLab,
      compressionFallback: !!out.result.compressionFallback,
      preservationCheck: measurePreservation(finalText)
    };
    job.semanticAuditTrace = out.privateSemanticAudit || null;
    await stageCompletion(job, completionResult);
    if (job.status !== 'done') return;
    attachRefineTargets(job);   // 사후 문단 보강 타겟(PARAGRAPH_REFINE=1일 때만 부착)
    persistJob(job);
    if (!job.adminHumanizeLab) saveJobHistory(job, text, finalText);   // 이용 기록(서버) 노출
    logger.info('transform.humanize_done', {
      jobId: job.id,
      uid: job.uid,
      mode: job.mode,
      needed: job.needed,
      deducted: job.deducted,
      billingDisposition: job.billingDisposition,
      chunkCount: out.chunkCount,
      fallbackCount: out.fallbackCount
    });
  } catch (e) {
    if (job.ac.signal.aborted) {
      handleAbortedJob(job);
      return;
    }
    logger.error('transform.humanize_failed', { jobId: job.id, uid: job.uid, mode: job.mode, err: e });
    if (job.status === 'awaiting_payment') { persistJob(job); return; }
    if (!job.pendingCompletion && providerAvailability.isUnavailable(e)) {
      providerRecovery.defer(job, e.retryAtMs);
      await persistJob(job); return;
    }
    job.status = 'error';
    job.error = '처리 중 오류가 발생했어요. 크레딧은 차감되지 않았어요.';
    if (job.pendingCompletion) {
      job.status = 'queued'; job.retryNotBeforeMs = Date.now() + 60000;
      job.error = '완료 상태를 확인하고 있어요. 저장된 결과로 다시 처리합니다.';
    }
    persistJob(job);
  } finally {
    scheduleQueueDrain();
  }
}

async function runStructurePreview(job) {
  try {
    job.stage = '목차와 문단 변경안 만드는 중';
    await persistJob(job);
    const config = await activeGptConfig();
    if (!config) throw technicalProviderError();
    let plan;
    try {
      plan = await documentStructure.createPlan({ text: job.text, config, uid: job.uid, signal: job.ac.signal });
    } catch (error) {
      if (job.ac.signal.aborted) throw error;
      plan = { version: documentStructure.VERSION, sourceHash: documentStructure.buildDocument(job.text).sourceHash,
        groups: [], applicable: false, applied: false, changes: [], reason: '안전한 변경안을 만들지 못했습니다. 원문 구조로 다듬을 수 있어요.' };
      logger.warn('transform.structure_plan_rejected', { jobId: job.id, code: error.code || 'STRUCTURE_PLAN_UNAVAILABLE' });
    }
    job.result = { structurePlan: { ...plan, id: job.id, expiresAtMs: job.createdAt + 60 * 60 * 1000,
      inputChars: job.text.length, additionalCredits: plan.applied ? restructureStructureCredit(job.text.length) : 0 } };
    job.needed = 0;
    job.status = 'done'; job.stage = '구조 변경안 준비 완료'; job.terminalAtMs = Date.now();
    if (!(await persistJob(job)).ok) throw new Error('STRUCTURE_PLAN_PERSIST_FAILED');
  } catch (error) {
    if (job.ac.signal.aborted) return handleAbortedJob(job);
    job.status = 'error'; job.error = '구조 변경안을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.';
    await persistJob(job);
  }
}

router.get('/transform/structure-config', (_req, res) => res.json({ enabled: process.env.HUMANIZE_STRUCTURE_ENABLED === '1', version: documentStructure.VERSION }));

const startTransform = async (req, res) => {
  const structurePreview = req.path === '/transform/structure-plan';
  const structureMode = req.body?.structureMode || 'preserve';
  if (!['preserve', 'improve'].includes(structureMode)) return res.status(400).json({ error: '지원하지 않는 구조 옵션입니다.' });
  let { text } = req.body || {};
  // idToken은 Authorization 헤더 우선(헤더 미전환 구버전 클라이언트는 body/query 폴백) — 다른 라우트와 동일하게 단일화.
  // ★버그 수정(2026-06-19): A2 보안 마이그레이션 때 이 시작 핸들러만 body 직접 추출이 남아, FE가 body 토큰 전송을
  //   끊자(lav-138) 토큰이 undefined→precheck 401→로그인 리다이렉트로 휴머나이즈 시작이 전면 차단됐었다.
  const idToken = tokenFromReq(req);
  const billingMode = req.body?.billingMode === 'coupon' ? 'coupon' : 'credit';
  const requestedModeValue = req.body?.mode;
  const sourceProbability = parseSourceProbability(req.body?.sourceProbability);
  const sourceEvidence = parseSourceEvidence(req.body?.sourceEvidence);
  const sourceBand = parseSourceBand(req.body?.sourceBand);
  const sourceDetectorVersion = parseSourceDetectorVersion(req.body?.sourceDetectorVersion);
  const mode = ['blog', 'polish', 'formal'].includes(requestedModeValue) ? requestedModeValue : 'formal';
  const modeSource = ['blog', 'polish', 'formal'].includes(requestedModeValue) ? 'provided' : 'defaulted';
  if ((structurePreview || structureMode === 'improve') && (mode !== 'formal' || billingMode !== 'credit' || req.body?.adminHumanizeLab)) {
    return res.status(400).json({ code: 'STRUCTURE_MODE_UNSUPPORTED', error: '구조 개선은 크레딧 결제의 고급 휴머나이징에서 사용할 수 있어요.' });
  }
  const requestedDocumentProfileValue = req.body?.documentProfile ?? req.body?.documentGenre;
  const documentProfileOverride = normalizeDocumentProfileOverride(requestedDocumentProfileValue);
  if (requestedDocumentProfileValue != null && String(requestedDocumentProfileValue).trim() && documentProfileOverride === null) {
    return res.status(400).json({
      error: '지원하지 않는 글 종류예요.',
      allowedDocumentProfiles: CONTENT_GENRES.filter(profile => profile !== 'unknown')
    });
  }
  // 최소 길이: formal은 구조를 다시 짜는 작업이라 200자, short(blog·polish)는 50자(짧은 글 다듬기 허용)
  // 글자수 기준 통일: 표시·과금(needed)과 동일하게 공백 포함 raw length으로 판정.
  const minLen = mode === 'formal' ? 200 : 50;
  if (typeof text !== 'string' || text.length < minLen) {
    return res.status(400).json({ error: `변환하려면 최소 ${minLen}자가 필요해요.` });
  }
  const hardMax = 30000;
  if (text.length > hardMax) {
    return res.status(400).json({ code: 'INPUT_TOO_LONG', limit: hardMax, actual: text.length, charged: 0, error: `텍스트가 너무 깁니다. (최대 ${hardMax.toLocaleString()}자)` });
  }
  const readability = inputrouting.assessInputReadability(text);
  if (!readability.readable) {
    logger.warn('transform.unreadable_input_blocked', { mode, reason: readability.reason, textLength: text.length });
    return res.status(422).json({
      code: 'UNREADABLE_INPUT',
      reason: readability.reason,
      error: inputrouting.UNREADABLE_INPUT_MESSAGE
    });
  }
  const devNoAuth = !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1';
  const adminLabRequested = req.body && req.body.adminHumanizeLab === true;
  const requestedAdminLabProfile = adminLabRequested ? normalizeAdminLabProfile(req.body && req.body.adminLabProfile) : null;
  let adminLabUid = null;
  let authenticatedUser = null;
  if (adminLabRequested) {
    if (devNoAuth) {
      adminLabUid = 'dev-local';
    } else {
      adminLabUid = await verifyAdminToken(idToken);
      if (adminLabUid === false) return res.status(403).json({ error: '관리자만 사용할 수 있는 테스트 페이지입니다.' });
      if (!adminLabUid) return res.status(401).json({ error: '관리자 테스트는 로그인이 필요해요.' });
    }
  } else if (!devNoAuth) {
    try {
      authenticatedUser = await usageBilling.authenticate(idToken);
    } catch (error) {
      return res.status(error.status || 401).json({ error: usageBilling.authErrorMessage(error.message) });
    }
  }
  // ★ 글자분리(PDF 추출 깨짐) 복원(2026-06-19 실측 #57·#58): 모든 글자가 공백 분리된 입력을 billing·엔진 처리 전에
  const structureUid = authenticatedUser?.uid || adminLabUid || (devNoAuth ? 'dev-local' : '');
  if (structureUid) setLogContext({ uid: structureUid });
  const waitingJob = activeJobFor(structureUid);
  if (waitingJob && ['awaiting_approval', 'awaiting_payment'].includes(waitingJob.status)) {
    return res.status(409).json({ code: 'USER_TRANSFORM_ACTIVE',
      error: waitingJob.status === 'awaiting_payment' ? '결제 확인을 기다리는 작업이 있어요. 기존 결과를 받거나 취소한 뒤 다시 시작해 주세요.' : '근거 승인을 기다리는 작업이 있어요. 기존 작업을 확인해 주세요.',
      activeJobId: waitingJob.id, activeStatus: waitingJob.status });
  }
  if ((structurePreview || structureMode === 'improve') && process.env.HUMANIZE_STRUCTURE_ENABLED !== '1' && !isAdminUid(structureUid) && !devNoAuth) {
    return res.status(503).json({ code: 'STRUCTURE_DISABLED', error: '구조 개선 옵션을 준비 중입니다.' });
  }
  //   재결합 — 공정 과금·URL 보존. 정상 글은 무동작. INPUT_REJOIN=0으로 해제.
  if (process.env.INPUT_REJOIN !== '0') {
    try {
      const rj = inputrouting.rejoinSplitChars(text);
      if (rj.changed) { logger.info('transform.input_rejoined', { mode, ratio: rj.ratio, before: text.length, after: rj.text.length }); text = rj.text; }
    } catch (e) { logger.warn('transform.input_rejoin_failed', { err: e && e.message }); }
  }
  // ★ AI URL 지문 제거(2026-06-20 #68): utm_source=chatgpt.com 류를 엔진 처리 전 제거(참고문헌 동결 우회 경로 대비). STRIP_AI_URL=0 해제.
  if (process.env.STRIP_AI_URL !== '0') {
    try {
      const ai = require('../engine/spacing').stripAiUrlParams(text);
      if (ai.removed) { logger.info('transform.input_ai_url_stripped', { mode, removed: ai.removed }); text = ai.text; }
    } catch (e) { logger.warn('transform.input_ai_url_strip_failed', { err: e && e.message }); }
  }
  // ★ 중복 입력 사전 차단(2026-06-16): 같은 문서를 두 번 붙여넣은 입력은 중복 분량만큼 과금되고 긴 입력이라 결과까지
  //   꼬인다(실측 blog 2만자=412크레딧 + 잘린 결과). 차감·작업 시작 전에 막는다(무차감 — 중복 빼고 재시도하면 절약).
  {
    const dup = inputrouting.detectInputDuplication(text);
    if (dup.duplicated) {
      // 9/29 실측: 한 사용자가 같은 글로 6분간 24번 막혔는데 로그엔 비율만 있어 오탐인지 판단할 수 없었다.
      // 어느 판정 경로가 걸렸는지(method)와 반복 규모, 같은 글 여부(textDigest)를 함께 남긴다.
      const dupSummary = dup.method === 'half_window'
        ? `앞 절반 60자 창 ${dup.windows}개 중 ${dup.matchedWindows}개가 뒤 절반에 재등장`
        : `문단 ${dup.blocks}개 중 ${dup.repeatedBlocks}개가 앞 80자 동일`;
      logger.warn('transform.duplicate_input_blocked', {
        mode,
        textLength: text.length,
        dupRatio: dup.ratio,
        dupMethod: dup.method,        // 'method'는 HTTP 메서드 자리라 이름을 다르게 둔다
        blocks: dup.blocks,
        repeatedBlocks: dup.repeatedBlocks,
        windows: dup.windows,
        matchedWindows: dup.matchedWindows,
        textDigest: inputDigest(text),
        reason: dup.method,
        message: `중복 입력 차단(${mode}, ${text.length}자, 반복 ${Math.round(dup.ratio * 100)}%): ${dupSummary}. 무차감.`
      });
      return res.status(400).json({ error: `입력에 같은 내용이 반복돼 있어요(약 ${Math.round(dup.ratio * 100)}%). 중복된 부분을 빼고 다시 시도하면 크레딧도 절약돼요.` });
    }
  }
  // ★ 영어 글 사전 차단(2026-06-16, 임계값·안내 정정 2026-06-17): 피하기(기본 blog·고급 formal)는 한국어 전용
  //   엔진이라 영어를 넣으면 번역·변형으로 원문이 망가지고, '매끈하게' 다듬을수록 오히려 AI 패턴이 강해져
  //   카피킬러 0→100% 참사(실측). '돌리기 전에' 입력 단계에서 막는다. ※ 과거엔 "다듬기로 유도"였으나 다듬기도
  //   영어를 더 검출되게 만들어 잘못된 안내였음 — 메시지는 "영어 회피 불가·원문 유지"로 정정(ENGLISH_UNFIT_REASON).
  if (inputrouting.isUnsupportedHumanizeInput(text)) {
    logger.warn('transform.english_input_blocked', { mode, textLength: text.length });
    return res.status(400).json({
      code: 'HUMANIZE_KOREAN_ONLY',
      error: '현재 휴머나이징 엔진은 한국어 글만 지원해요. 외국어 중심 입력은 원문 보존을 위해 변환하지 않습니다.'
    });
  }
  // ★ 격식문서 → 고급 안내(2026-06-17, #21·#83·#72·#90): 보고서·계약서·논문을 기본 피하기에 넣으면 구어체로
  //   변질된다. 입력 단계에서 고급 피하기로 유도(blog만, 무차감·무API). 다듬기·고급은 그대로 통과.
  // ★ 제출자 메타데이터 제거(2026-06-17, #97): "제출자: OO학부 20260423 변정빈" 머리말이 본문에 인용 저자처럼
  //   엮이던 사고 — 돌리기 전에 떼어낸다(본문 내용 불변, 무차감). 차단 아님.
  {
    const sm = inputrouting.stripSubmitterMeta(text);
    if (sm.changed) { logger.info('transform.submitter_meta_stripped', { mode, removed: sm.changed }); text = sm.text; }
  }
  const effectBasicStyle = mode === 'blog' ? normalizeBasicStyle(req.body?.basicStyle) : 'report';
  const editable = assessEditableContent(text, {
    mode,
    basicStyle: effectBasicStyle,
    documentProfileOverride
  });
  if (editable.editableChunkCount === 0) {
    // 어떤 잠금(표·제목·참고문헌…)이 본문을 전부 차지했는지 남긴다 — 구조 보존 강화 배포 뒤 오분류 회귀를 로그만으로 판별.
    const lockSummary = Object.entries(editable.lockTypes || {}).map(([k, v]) => `${k} ${v}`).join(', ') || '없음';
    // 한 가지 잠금이 글 대부분을 덮어 본문이 0이 됐는지(오분류 의심)와 여러 구조가 고르게 섞인 글인지를
    // 로그만으로 가른다. 참고문헌 목록만 붙여 넣은 글처럼 정말 전부 잠긴 입력도 같은 값이 나오므로,
    // 판단은 textLength·documentProfile과 함께 본다.
    const dominantSummary = editable.dominantLockType
      ? ` 가장 큰 잠금 ${editable.dominantLockType}이 원문의 ${Math.round(editable.dominantLockShare * 100)}%.`
      : '';
    logger.warn('transform.no_editable_content', {
      // 이 차단도 사전 검사보다 앞이라 로그 문맥에 uid가 없다. 같은 사람이 같은 글로 몇 번 막혔는지 셀 수 있게 싣는다.
      ...(structureUid ? { uid: structureUid } : {}),
      mode,
      basicStyle: effectBasicStyle,
      documentProfileOverride: documentProfileOverride || undefined,
      textLength: text.length,
      documentProfile: editable.documentProfile,
      totalChunkCount: editable.totalChunkCount,
      lockTypes: editable.lockTypes,
      lockCharShare: editable.lockCharShare,
      dominantLockType: editable.dominantLockType || undefined,
      dominantLockShare: editable.dominantLockShare,
      textDigest: inputDigest(text),
      reason: 'no_editable_content',
      message: `변환할 본문 없음 422(${mode}, ${text.length}자, 프로필 ${editable.documentProfile}): 청크 ${editable.totalChunkCount}개가 전부 보존 구조 — ${lockSummary}.${dominantSummary} 무차감.`
    });
    return res.status(422).json({
      code: 'NO_EDITABLE_CONTENT',
      error: '표·목차·참고문헌처럼 보존해야 할 구조만 있어 변환할 일반 본문을 찾지 못했어요.',
      documentProfile: editable.documentProfile,
      editableChunkCount: 0
    });
  }
  // 본문이 조금 있어도 최소 길이에 못 미치면 엔진이 바꿀 문장이 없어 결과가 원문과 같아지고
  // gpt_noop_unchanged로 막힌다. 진단과 같은 함수·같은 기준으로 재서 차감·대기열 전에 거절한다.
  // 코드는 위와 같은 NO_EDITABLE_CONTENT라 이미 배포된 화면도 같은 안내 경로로 받는다. 다듬기는 제외.
  if (mode !== 'polish') {
    const editableText = humanizeRecommendation.editableBody(text, detectDocumentProfile(text, { basicStyle: 'report' }));
    if (editableText.length < humanizeRecommendation.MIN_EDITABLE_LENGTH) {
      logger.warn('transform.little_editable_content', {
        ...(structureUid ? { uid: structureUid } : {}),
        mode,
        textLength: text.length,
        editableLength: editableText.length,
        minEditableLength: humanizeRecommendation.MIN_EDITABLE_LENGTH,
        documentProfile: editable.documentProfile,
        lockTypes: editable.lockTypes,
        textDigest: inputDigest(text),
        reason: 'editable_below_minimum',
        message: `본문 부족 422(${mode}, ${text.length}자 중 본문 ${editableText.length}자 < ${humanizeRecommendation.MIN_EDITABLE_LENGTH}자): 변화 없음 차단을 미리 막음. 무차감.`
      });
      return res.status(422).json({
        code: 'NO_EDITABLE_CONTENT',
        reason: 'editable_below_minimum',
        error: humanizeRecommendation.LITTLE_EDITABLE_MESSAGE,
        documentProfile: editable.documentProfile,
        editableLength: editableText.length,
        minEditableLength: humanizeRecommendation.MIN_EDITABLE_LENGTH
      });
    }
  }
  const effectAssessment = assessEffectExpectation(text, mode, effectBasicStyle);
  const effectNoticeAccepted = req.body?.effectNoticeAccepted === true;
  if (!structurePreview && !adminLabUid
      && effectConfirmationEnabled()
      && effectAssessment.requiresEffectConfirmation
      && !effectNoticeAccepted) {
    logger.info('transform.limited_effect_confirmation_required', {
      mode,
      textLength: text.length,
      effectNoticeCode: effectAssessment.effectNoticeCode,
      documentProfile: effectAssessment.documentProfile,
      profileConfidence: effectAssessment.profileConfidence
    });
    return res.status(409).json({
      error: '이미 자연스러운 글이라 휴머나이징 변화가 제한적일 수 있어요. 예상 효과를 확인한 뒤 진행해 주세요.',
      code: 'LIMITED_EFFECT_CONFIRMATION_REQUIRED',
      effectExpectation: 'limited',
      effectNoticeCode: effectAssessment.effectNoticeCode,
      requiresEffectConfirmation: true
    });
  }
  if (draining || !restorationReady) {
    return res.status(503).json({ error: '서버가 점검을 위해 재시작 중이에요. 1~2분 후 다시 시도해 주세요.' });
  }
  try { await providerAvailability.checkAdmission(); }
  catch (error) {
    if (!providerAvailability.isUnavailable(error)) throw error;
    const failure = providerAvailability.publicFailure(error);
    return res.set('Retry-After', String(failure.retryAfterSeconds)).status(503).json(failure);
  }

  let finishAdmission;
  const admission = { done: new Promise(resolve => { finishAdmission = resolve; }) };
  admissionRequests.add(admission);
  try {

  const wantEvidence = !structurePreview && mode === 'formal' && req.body.evidence === true;
  const sourceProblem = require('../engine-gpt-prod/sourceTablePrecheck').check(text);
  if (sourceProblem) return res.status(422).json(sourceProblem);
  let approvedStructure = null;
  if (!structurePreview && structureMode === 'improve') {
    const planId = String(req.body?.structurePlanId || '');
    if (!/^[a-f0-9]{16}$/u.test(planId)) return res.status(409).json({ code: 'STRUCTURE_PLAN_REQUIRED', error: '구조 변경안을 먼저 확인해 주세요.' });
    let sourceJob = jobs.get(planId);
    try { if (db) { const snap = await db.collection('transformJobs').doc(planId).get(); sourceJob = snap.exists ? snap.data() : null; } }
    catch (_) { return res.status(503).json({ code: 'STRUCTURE_PLAN_UNAVAILABLE', error: '변경안을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' }); }
    try { approvedStructure = documentStructure.validateStoredPlan(sourceJob, { uid: structureUid, text }); }
    catch (_) { return res.status(409).json({ code: 'STRUCTURE_PLAN_STALE', error: '변경안이 만료되었거나 원문이 바뀌었습니다. 구조 변경안을 다시 확인해 주세요.' }); }
  }
  // 과금: 탐지 제외 짧은 기능(blog·polish)은 최소 10크레딧 + 100자당 2크레딧.
  // formal은 lib/humanizePricing의 5크레딧 단위 단계형 요금을 사용한다.
  const creditNeeded = (mode === 'blog' || mode === 'polish')
    ? shortHumanizeCredit(text.length)
    : restructureCredit(text.length, wantEvidence, structurePreview || !!approvedStructure);
  const needed = billingMode === 'coupon' ? 1 : creditNeeded;
  let pre;
  try {
    pre = adminLabUid
      ? { uid: adminLabUid, plan: 'unlimited' }
      : (devNoAuth
          ? { uid: 'dev-local', plan: 'unlimited' }
          : billingMode === 'coupon'
            ? await usageBilling.precheckCoupon(idToken, text.length, authenticatedUser)
            : await usageBilling.precheckCredits(idToken, needed, authenticatedUser));
  } catch (e) {
    // 사전 검사 실패(잔액 부족 등)도 인증은 끝난 요청이다. 10/9 점검 C-09: 잔액 부족 82건이 모두 사용자 식별 없이
    // 남아 누가 몇 번 막혔는지, 그 뒤 충전했는지를 셀 수 없었다(uid를 로그 문맥에 넣는 호출이 이 뒤에 있다).
    // 성공 경로와 같은 식별(uid)만 싣는다. 이 요청의 접근 로그에도 실리도록 문맥에 넣고, 문맥 없이 도는
    // 실행에서도 남도록 필드로도 적는다. 인증이 실패한 요청은 위에서 이미 응답했으므로 여기 오지 않는다.
    const precheckUid = authenticatedUser?.uid || '';
    if (precheckUid) setLogContext({ uid: precheckUid });
    logger.warn('transform.precheck_failed', {
      ...(precheckUid ? { uid: precheckUid } : {}),
      mode,
      needed,
      creditNeeded,
      billingMode,
      err: e
    });
    return res.status(e.status || 500).json({
      error: usageBilling.authErrorMessage(e.message),
      ...(e.charLimit !== undefined ? { charLimit: e.charLimit } : {})
    });
  }
  setLogContext({ uid: pre.uid });
  if (draining) return res.status(503).json({ error: '서버가 점검을 위해 재시작 중이에요. 잠시 후 다시 시도해 주세요.' });
  const previewId = structurePreview ? crypto.createHash('sha256').update([documentStructure.VERSION, pre.uid, text, Math.floor(Date.now() / 1800000)].join('\0')).digest('hex').slice(0, 16) : null;
  const structureExecutionId = approvedStructure ? crypto.createHash('sha256').update(JSON.stringify([
    'structure-execution-v1', pre.uid, approvedStructure.id, wantEvidence, documentProfileOverride,
    String(req.body.memo || '').slice(0, 2000), req.body.autoCoach === true
  ])).digest('hex').slice(0, 16) : null;
  const reusableId = previewId || structureExecutionId;
  if (reusableId) {
    let cached = jobs.get(reusableId);
    try { if (db) { const snap = await db.collection('transformJobs').doc(reusableId).get(); if (snap.exists) cached = snap.data(); } }
    catch (_) { return res.status(503).json({ code: 'STRUCTURE_PLAN_UNAVAILABLE', error: '변경안을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' }); }
    if (cached && cached.uid === pre.uid && ['queued', 'running', 'awaiting_approval', 'done'].includes(cached.status)) {
      return res.json({ ok: true, jobId: cached.id, job: activeJobPayload(cached), structurePreview: cached.structurePreview === true });
    }
  }
  // 한도는 인증 후(uid 확정) 검사 — 비용 방어의 본체. 시작 성공 시에만 일일 카운트(formal만).
  const limited = adminLabUid ? null : checkLimits(pre.uid, mode, structurePreview);
  if (limited) {
    logger.warn('transform.limit_blocked', {
      uid: pre.uid,
      mode,
      status: limited.status,
      activeJobId: limited.activeJobId || null,
      activeStatus: limited.activeStatus || null
    });
    return res.status(limited.status).json({
      error: limited.error,
      activeJobId: limited.activeJobId || null,
      activeStatus: limited.activeStatus || null
    });
  }
  if (!adminLabUid && mode === 'formal') {
    if (structurePreview) {
      const day = kstDay(), prior = dailyStructurePreviews.get(pre.uid);
      dailyStructurePreviews.set(pre.uid, { day, count: prior?.day === day ? prior.count + 1 : 1 });
    } else recordStart(pre.uid);
  }
  const adminOrDev = adminLabUid || isAdminUid(pre.uid) || (devNoAuth && pre.uid === 'dev-local');
  const preserveExperimentRequested = adminLabRequested || (req.body && req.body.humanizeExperiment === true);
  const preserveExperimentEnabled = preserveExperimentRequested && !!adminOrDev;
  const retiredBasicExperimentRequested = req.body && req.body.basicExperiment === true && !preserveExperimentRequested;
  if ((preserveExperimentRequested || retiredBasicExperimentRequested) && !adminOrDev) {
    logger.warn('transform.humanize_experiment_ignored_non_admin', {
      uid: pre.uid,
      mode,
      adminLabRequested,
      preserveExperimentRequested,
      retiredBasicExperimentRequested
    });
  } else if (retiredBasicExperimentRequested) {
    logger.info('transform.retired_basic_experiment_ignored', { uid: pre.uid, mode });
  }
  const basicStyle = mode === 'blog'
    ? normalizeBasicStyle(req.body && req.body.basicStyle)
    : null;
  const adminLabVersion = requestedAdminLabProfile === 'v6_engine'
    ? 'humanizing-engine-v9-registerlock'
    : requestedAdminLabProfile === 'gpt_engine'
      ? 'gpt-openai-humanize-engine-v1'
      : requestedAdminLabProfile === 'ko_quality_pattern_lab'
        ? 'ko-quality-pattern-lab-v1'
        : requestedAdminLabProfile === 'fundamental_engine'
          ? 'fundamental-engine-v1'
          : requestedAdminLabProfile === 'final_report_engine' ? 'final-report-engine-v1' : 'preserve-lab-v1';
  const experimentMeta = preserveExperimentEnabled ? {
    enabled: true,
    requested: true,
    applied: false,
    version: adminLabVersion,
    profile: requestedAdminLabProfile || 'preserve_lab',
    source: adminLabRequested ? 'admin_humanize_lab_page' : 'admin_job_toggle',
    niklQualityTest: !!(adminLabRequested && req.body && req.body.niklQualityTest === true)
  } : null;

  const id = reusableId || crypto.randomBytes(8).toString('hex');
  const bare = text.replace(/\s+/g, '').length;
  const isShort = mode !== 'formal';
  // 고급은 실제 v2 실행 계획의 편집 청크 수로 범위를 산출한다. estSec는 기존
  // 클라이언트·대기열 호환을 위해 보수적인 상한을 계속 제공한다.
  const advancedTimeEstimate = !isShort
    ? safeAdvancedTimeEstimate(text, {
        evidence: wantEvidence,
        basicStyle: 'report',
        documentProfileOverride
      })
    : null;
  const estSec = isShort
    ? Math.max(90, Math.min(1200, Math.round(bare / 12)))
    : (advancedTimeEstimate?.highSec
      || Math.max(240, Math.min(5400, Math.round(bare / 4) + (wantEvidence ? 480 : 0))));
  const job = {
    id, mode, modeSource, status: 'queued', stage: '대기 중', createdAt: Date.now(), queuedAt: Date.now(),
    sourceProbability, sourceEvidence,   // 보고서 → 휴머나이징 핸드오프(선택) — 재검사 상한·유지할 근거 보존 표기용
    sourceBand, sourceDetectorVersion,   // 퍼널 계측용 최초 밴드·감지기 버전(점수·요금과 무관)
    uid: pre.uid,
    structurePreview,
    structureMode,
    structurePlanId: approvedStructure?.id || null,
    approvedStructure,
    structureCredits: approvedStructure ? restructureStructureCredit(text.length) : 0,
    basePriceCredits: mode === 'formal' ? restructureCredit(text.length, wantEvidence) : creditNeeded,
    plan: pre.plan || (billingMode === 'coupon' ? `subscription:${pre.tier || 'unknown'}` : 'free'),
    needed,
    listPriceCredits: creditNeeded,
    recoveryBudgetUsd: recoveryBudgetUsdForCredits(creditNeeded),
    devNoAuth,
    deducted: false,
    billingDisposition: null,
    billingMode: adminLabUid || devNoAuth ? 'credit' : billingMode,
    billingTier: billingMode === 'coupon' && !adminLabUid && !devNoAuth ? pre.tier : null,
    text,   // 승인 후 재개용(v1 메모리 보관 — TTL로 정리)
    effectExpectation: effectAssessment.effectExpectation,
    effectNoticeCode: effectAssessment.effectNoticeCode,
    effectNoticeAccepted,
    memo: typeof req.body.memo === 'string' ? req.body.memo.slice(0, 2000) : '',   // 경험·사례 메모 — blog·formal(재구성) 공통 적용(2026-06-15)
    autoCoach: req.body.autoCoach === true && mode === 'formal',   // 자동 코칭(재구성 전용) — 시작 시 입장 자동 도출·적용(2026-06-18)
    // v2는 한국어 전용이다. 한국어 본문에 lang=en만 붙여 영어 프롬프트로 우회하지 못하게 한다.
    lang: 'ko',
    basicStyle,
    documentProfileOverride: documentProfileOverride || '',
    basicExperiment: experimentMeta,
    adminHumanizeLab: !!(adminLabRequested && preserveExperimentEnabled),
    adminLabProfile: adminLabRequested && preserveExperimentEnabled ? (requestedAdminLabProfile || 'preserve_lab') : null,
    niklQualityTest: !!(adminLabRequested && preserveExperimentEnabled && req.body && req.body.niklQualityTest === true),
    layoutNlpTest: !!(adminLabRequested && preserveExperimentEnabled && req.body && req.body.layoutNlpTest === true),
    gptModel: typeof req.body.gptModel === 'string' ? req.body.gptModel.slice(0, 80) : '',

    wantEvidence,
    estSec,
    estLowSec: advancedTimeEstimate?.lowSec || estSec,
    estHighSec: advancedTimeEstimate?.highSec || estSec,
    estimateVersion: advancedTimeEstimate?.version || 0,
    estimateBasis: advancedTimeEstimate?.basis || 'legacy_point_estimate',
    estimatedEditableChunks: advancedTimeEstimate?.editableChunkCount,
    estimatedTotalChunks: advancedTimeEstimate?.totalChunkCount,
    ac: new AbortController()   // 명시적 취소용(/cancel)
  };
  if (pendingAdmissions.has(job.uid) || activeJobFor(job.uid) || auxiliaryUsers.has(job.uid)) return res.status(409).json({ error: '이미 진행 중인 작업이 있어요.' });
  if (draining) return res.status(503).json({ error: '서버가 점검을 위해 재시작 중이에요. 잠시 후 다시 시도해 주세요.' });
  pendingAdmissions.add(job.uid);
  let initialPersistence;
  try { initialPersistence = await persistJob(job, { requireClaim: true }); }
  finally { pendingAdmissions.delete(job.uid); }
  if (!initialPersistence?.ok) {
    if (initialPersistence?.code === 'USER_TRANSFORM_ACTIVE') return res.status(409).json({ error: '이미 진행 중인 작업이 있어요.' });
    if (initialPersistence?.blocked) {
      return res.status(409).json({
        code: 'ACCOUNT_DELETION_IN_PROGRESS',
        error: '회원 탈퇴 처리가 진행 중이라 새 작업을 시작할 수 없어요.',
      });
    }
    return res.status(503).json({
      code: 'TRANSFORM_JOB_PERSIST_UNAVAILABLE',
      error: '작업을 안전하게 저장하지 못했어요. 잠시 후 다시 시도해 주세요.',
    });
  }
  // Even if drain began during the write, this is an accepted durable job.
  // Keep it in the handoff; periodic discovery on the next instance finds it.
  admission.job = job;
  jobs.set(id, job);
  drainQueue();   // 슬롯이 비어 있으면 같은 tick에서 queued→running 승격, 아니면 대기열에 남김.
  const payload = activeJobPayload(job);
  if (job.status === 'queued') {
    logger.info('transform.queued', {
      jobId: id,
      uid: pre.uid,
      mode,
      textLength: text.length,
      bareLength: bare,
      evidence: wantEvidence,
      needed,
      billingMode: job.billingMode,
      plan: pre.plan,
      estSec,
      estLowSec: job.estLowSec,
      estHighSec: job.estHighSec,
      estimateBasis: job.estimateBasis,
      estimatedEditableChunks: job.estimatedEditableChunks,
      queuePosition: payload.queuePosition,
      queueSize: payload.queueSize,
      queueEtaSec: payload.queueEtaSec
    });
  }
  res.json({
    ok: true,
    jobId: id,
    estSec,
    estLowSec: job.estLowSec,
    estHighSec: job.estHighSec,
    estimateVersion: job.estimateVersion,
    estimateBasis: job.estimateBasis,
    estimatedEditableChunks: job.estimatedEditableChunks,
    estimatedTotalChunks: job.estimatedTotalChunks,
    mode,
    effectExpectation: job.effectExpectation,
    effectNoticeCode: job.effectNoticeCode,
    requiresEffectConfirmation: effectAssessment.requiresEffectConfirmation,
    status: job.status,
    queued: job.status === 'queued',
    job: payload
  });
  } finally { admissionRequests.delete(admission); finishAdmission(); }
};
router.post('/transform', startTransform);
router.post('/transform/structure-plan', startTransform);

// 로컬 jobRef를 잃어도 서버에 남은 진행/승인대기 작업으로 복귀시키는 복구 엔드포인트.
router.get('/transform/active', async (req, res, next) => {
  try {
  const uid = await verifyToken(tokenFromReq(req));
  if (!uid) return res.status(401).json({ error: '로그인이 필요해요.' });
  setLogContext({ uid });
  let job = activeJobFor(uid);
  if (!job && db) {
    const snapshot = await db.collection(ACCOUNT_ACTIVITY_COLLECTION).doc(uid).get();
    const claims = Object.values(activeLane(snapshot.exists ? snapshot.data() : {}, TRANSFORM_LANE));
    for (const claim of claims) {
      const persisted = await db.collection('transformJobs').doc(claim.id).get();
      if (persisted.exists && persisted.data().uid === uid
          && completionState.ACTIVE_STATUSES.includes(persisted.data().status)) {
        job = persisted.data(); break;
      }
    }
  }
  res.json({ ok: true, job: activeJobPayload(job) });
  } catch (error) { next(error); }
});

// ── 명시적 취소: 진행 중 LLM 호출을 abort — 차감은 완료 시에만 일어나므로 취소=항상 무과금.
router.post('/transform/:id/cancel', async (req, res) => {
  const job = await loadControlJob(req, res);
  if (!job) return;
  if (job.status === 'done' || job.status === 'blocked' || job.status === 'error') {
    return res.status(409).json({ error: '이미 끝난 작업이에요.' });
  }
  if (job.deducted || (job.pendingCompletion && !['awaiting_payment', 'cancelled'].includes(job.status))) {
    return res.status(409).json({ error: '결제 완료 상태를 확인하고 있어요. 잠시 후 작업 상태를 다시 확인해 주세요.' });
  }
  // ★ 30초 취소 창(2026-06-15): running 작업이 시작 후 일정 시간을 넘기면 취소 거부 — LLM 원가를 거의
  //   다 쓴 뒤 무과금으로 빠져나가는 손실을 차단(UI 버튼도 30초 후 사라짐). 대기열·근거승인 대기는
  //   비싼 생성 전이라 그대로 허용(원가 미발생).
  if (job.status === 'running') {
    const elapsedSec = (Date.now() - (job.startedAt || job.createdAt || Date.now())) / 1000;
    if (elapsedSec > CANCEL_WINDOW_SEC) {
      return res.status(409).json({ error: '취소 가능 시간이 지났어요. 변환이 이미 진행돼, 완료되면 결과를 받게 돼요.' });
    }
  }
  const cancelled = completionState.normalizeCancelledJob({ ...job, status: 'cancelled', stage: '중단됨' });
  const saved = await persistJob(cancelled, { cancelRequest: true });
  if (!saved.ok) return res.status(['TRANSFORM_COMPLETION_IN_PROGRESS', 'TRANSFORM_STATE_CHANGED', 'TRANSFORM_CANCEL_WINDOW_CLOSED'].includes(saved.code) ? 409 : 503).json({ error: '중단 상태를 저장하지 못했어요. 작업 상태를 다시 확인해 주세요.' });
  const local = jobs.get(job.id);
  if (local) {
    const state = { ...(saved.job || cancelled) }; delete state.executionToken;
    Object.assign(local, state);
    local.ac?.abort(); local.auxAc?.abort();
  }
  clearRestartRecoveryTimer(job.id);
  scheduleQueueDrain();
  logger.info('transform.cancelled_by_user', { jobId: job.id, uid: job.uid, mode: job.mode });
  res.json({ ok: true });
});

// Only an explicit owner action may retry payment for an already generated result.
router.post('/transform/:id/resume-payment', async (req, res, next) => {
  try {
    const job = await loadControlJob(req, res);
    if (!job) return;
    if (job.status !== 'awaiting_payment' || !job.pendingCompletion) return res.status(409).json({ error: '결제 확인 대기 중인 작업이 아니에요.' });
    if (draining || !restorationReady) return res.status(503).json({ error: '서버 점검 중이에요. 잠시 후 다시 시도해 주세요.' });
    try { await precheckExistingJobBilling(job, tokenFromReq(req), job.pendingCompletion.creditAmount); }
    catch (error) {
      return res.status(error.status || 402).json({ ...completionState.paymentRequiredPayload(job), error: usageBilling.authErrorMessage(error.message) });
    }
    // Precheck awaited network I/O; cancellation or another resume may have won.
    if (job.status !== 'awaiting_payment') return res.status(409).json({ error: '작업 상태가 바뀌었어요. 다시 확인해 주세요.' });
    if (draining) return res.status(503).json({ error: '서버 점검 중이에요. 잠시 후 다시 시도해 주세요.' });
    const resumed = { ...job, status: 'queued', stage: '저장된 결과 전달 준비 중', queuedAt: Date.now(), retryNotBeforeMs: null, error: null };
    const saved = await persistJob(resumed, { requireClaim: true, expectedStatus: 'awaiting_payment' });
    if (!saved.ok) return res.status(['TRANSFORM_CANCELLED', 'TRANSFORM_STATE_CHANGED'].includes(saved.code) ? 409 : 503).json({ error: '작업 상태를 저장하지 못했어요. 다시 확인해 주세요.' });
    Object.assign(job, resumed);
    jobs.set(job.id, job);
    scheduleQueueDrain();
    res.json({ ok: true, job: activeJobPayload(job) });
  } catch (error) { next(error); }
});

// Legacy clients must reload instead of silently downgrading their request.
router.post('/transform/:id/accept-fallback', (_req, res) => res.status(410).json({
  code: 'MODE_DOWNGRADE_REMOVED', error: '다듬기 전환은 더 이상 제공하지 않아요. 화면을 새로고침한 뒤 같은 모드로 재시도해 주세요.'
}));
router.post('/transform/:id/retry', async (req, res, next) => {
  const job = await loadControlJob(req, res);
  if (!job) return;
  const retryRequestId = String(req.body?.requestId || '');
  if (!/^[a-z0-9_-]{12,80}$/iu.test(retryRequestId)) return res.status(400).json({ error: '재시도 요청 정보를 확인해 주세요.' });
  // A lost HTTP response must not start another paid attempt. The durable
  // intent survives discovery, deploy handoff and completion recovery.
  if (job.executionFeature === 'retry' && (job.retryRequestId === retryRequestId || ['queued', 'running', 'awaiting_payment', 'done'].includes(job.status))) {
    return res.json({ ok: true, ...activeJobPayload(job) });
  }
  if (draining || !restorationReady) return res.status(503).json({ error: '서버 점검 중이에요. 잠시 후 다시 시도해 주세요.' });
  if (job.status !== 'blocked' && !providerRecovery.canRetry(job)) return res.status(409).json({ error: '중단된 작업만 재시도할 수 있어요.' });
  try { await providerAvailability.checkAdmission(); }
  catch (error) {
    if (!providerAvailability.isUnavailable(error)) throw error;
    const failure = providerAvailability.publicFailure(error);
    return res.set('Retry-After', String(failure.retryAfterSeconds)).status(503).json(failure);
  }
  if (!['blog', 'formal', 'polish'].includes(job.mode)) return res.status(409).json({ error: '작업 모드를 확인할 수 없어요.' });
  if (pendingAdmissions.has(job.uid) || auxiliaryUsers.has(job.uid) || activeJobFor(job.uid)) return res.status(409).json({ error: '이미 진행 중인 작업이 있어요.' });
  if (queuedJobsForPool(poolOf(job.mode)).length >= queueCap(job.mode)) return res.status(503).json({ error: '현재 대기열이 가득 찼어요. 잠시 후 다시 시도해 주세요.' });
  let finishAdmission;
  const admission = { done: new Promise(resolve => { finishAdmission = resolve; }) };
  admissionRequests.add(admission);
  pendingAdmissions.add(job.uid);
  try {
  // Admission only prechecks the original price; durable completion remains
  // the sole charging point and retains the existing idempotent job ledger.
  const fbNeeded = job.needed;
  if (!job.devNoAuth) {
    try {
      await precheckExistingJobBilling(job, tokenFromReq(req), fbNeeded, (job.text || '').length);
    } catch (e) {
      const status = e.status || 402;
      return res.status(status).json({
        error: status === 402 && job.billingMode !== 'coupon'
          ? `같은 모드로 재시도하려면 ${fbNeeded}크레딧이 필요해요. 크레딧이 부족해 충전 후 다시 시도해 주세요.`
          : usageBilling.authErrorMessage(e.message),
        needed: job.billingMode === 'coupon' ? 1 : fbNeeded,
        billingMode: job.billingMode === 'coupon' ? 'coupon' : 'credit'
      });
    }
  }
  if (draining) return res.status(503).json({ error: '서버 점검 중이에요. 잠시 후 다시 시도해 주세요.' });
  const queued = { ...job, status: 'queued', stage: '같은 모드 재처리 대기 중',
    executionFeature: 'retry', retryRequestId, retryAcceptedAtMs: Date.now(), queuedAt: Date.now(),
    startedAt: null, terminalAtMs: null, retryNotBeforeMs: null, blockOffer: null,
    providerRecoveryStartedAtMs: null, providerRecoveryCount: 0, recoverableErrorCode: null, queueWaitReason: null,
    error: null, ac: new AbortController() };
  const fallbackClaim = await persistJob(queued, { requireClaim: true, expectedStatus: job.status });
  if (!fallbackClaim?.ok) {
    if (fallbackClaim?.code === 'TRANSFORM_STATE_CHANGED') {
      const current = await loadControlJob(req, res);
      if (!current) return;
      if (current.executionFeature === 'retry' && (current.retryRequestId === retryRequestId || ['queued', 'running', 'awaiting_payment', 'done'].includes(current.status))) return res.json({ ok: true, ...activeJobPayload(current) });
    }
    return res.status(fallbackClaim?.blocked || fallbackClaim?.code === 'USER_TRANSFORM_ACTIVE' ? 409 : 503).json({
      code: fallbackClaim?.code || 'TRANSFORM_JOB_PERSIST_UNAVAILABLE',
      error: fallbackClaim?.blocked
        ? '회원 탈퇴 처리가 진행 중이라 재처리를 시작할 수 없어요.'
        : fallbackClaim?.code === 'USER_TRANSFORM_ACTIVE' ? '이미 진행 중인 작업이 있어요.'
          : '작업을 안전하게 저장하지 못했어요. 잠시 후 다시 시도해 주세요.',
    });
  }
  admission.job = queued;
  jobs.set(job.id, queued);
  scheduleQueueDrain();
  res.json({ ok: true, ...activeJobPayload(queued) });
  } catch (error) { next(error); }
  finally { pendingAdmissions.delete(job.uid); admissionRequests.delete(admission); finishAdmission(); }
});

// A completed paragraph can be refined using user-supplied experience;
// failed, unchanged or blocked attempts remain uncharged.
router.post('/transform/:id/refine-paragraph', auxiliaryRoute('refine', async (req, res) => {
  if (!refineEnabled()) return res.status(404).json({ error: '지원하지 않는 기능이에요.' });
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요. (만료되었거나 서버가 재시작됨)' });
  if (!(await requireJobOwner(req, res, job))) return;
  if (job.status !== 'done') return res.status(409).json({ error: '완료된 작업에서만 문단을 보강할 수 있어요.' });
  if (job.mode !== 'blog' && job.mode !== 'polish') return res.status(409).json({ error: '기본 휴머나이징·다듬기 결과에서만 쓸 수 있어요.' });
  const memo = typeof req.body.memo === 'string' ? req.body.memo.trim() : '';
  if (memo.length < REFINE_MEMO_MIN || memo.length > REFINE_MEMO_MAX) {
    return res.status(400).json({ error: `실제 경험 메모를 ${REFINE_MEMO_MIN}~${REFINE_MEMO_MAX}자로 적어 주세요.` });
  }
  const idx = Number(req.body.paragraphIndex);
  attachRefineTargets(job); // Re-evaluate older saved jobs with the current section-aware policy.
  const targets = (job.result && job.result.refineTargets) || [];
  // 유효 대상 = 현재 타겟 ∪ 이미 보강한 문단(재시도 허용 — 단 UI는 재영업하지 않음)
  const idxAllowed = targets.some(t => t.index === idx) || (job.refineHistory || []).some(h => h.paragraphIndex === idx);
  if (!Number.isInteger(idx) || !idxAllowed) {
    return res.status(400).json({ error: '보강 대상 문단이 아니에요. 화면의 문단 카드에서 다시 시도해 주세요.' });
  }
  const paras = surfaceguard.splitParagraphsForRefine(job.result.outputText || '');
  if (idx < 0 || idx >= paras.length) return res.status(409).json({ error: '결과가 갱신됐어요. 잠시 후 다시 시도해 주세요.' });
  const gptCfg = await activeGptConfig();
  if (!gptCfg) return res.status(503).json({ error: '엔진 점검 중이에요. 잠시 후 다시 시도해 주세요.' });
  // 동시 보강 방지 — running 검사부터 refine 세팅까지 await 없음(단일 스레드 원자성).
  if (job.refine && job.refine.status === 'running') {
    return res.status(409).json({ error: '이미 문단 보강이 진행 중이에요. 끝난 뒤 다시 시도해 주세요.' });
  }
  const paraText = paras[idx].text;
  const paraLen = paraText.trim().length;
  const n = (job.refineCount || 0) + 1;
  if ((job.refineAttempts || 0) >= Math.max(2, Number(process.env.REFINE_MAX_ATTEMPTS) || 8)) {
    return res.status(429).json({ error: '이 결과의 보강 시도 한도에 도달했어요.' });
  }
  job.refineAttempts = (job.refineAttempts || 0) + 1;
  const freeLeft = Math.max(0, REFINE_FREE_COUNT - (job.refineCount || 0));
  const needed = freeLeft > 0 ? 0 : shortHumanizeCredit(paraLen);
  const prevRefine = job.refine || null;
  // 경험 메모 원문은 이 요청의 모델 호출에만 사용한다. job/refineHistory에 넣으면
  // transformJobs 영속화 과정에서 사용자 입력이 불필요하게 한 번 더 복제된다.
  job.refine = { status: 'running', paragraphIndex: idx, memoLength: memo.length, n, needed, startedAt: Date.now() };
  if (needed && !job.devNoAuth) {
    try {
      await precheckExistingJobBilling(job, tokenFromReq(req), needed, paraLen);
    } catch (e) {
      job.refine = prevRefine;
      const status = e.status || 402;
      return res.status(status).json({
        error: status === 402 && job.billingMode !== 'coupon'
          ? `문단 보강에 ${needed}크레딧이 필요해요. 충전 후 다시 시도해 주세요.`
          : usageBilling.authErrorMessage(e.message),
        needed: job.billingMode === 'coupon' ? 1 : needed,
        billingMode: job.billingMode === 'coupon' ? 'coupon' : 'credit'
      });
    }
  }
  const refineClaim = await persistJob(job, { requireClaim: true });
  if (!refineClaim?.ok) {
    job.refine = prevRefine;
    return res.status(refineClaim?.blocked ? 409 : 503).json({
      code: refineClaim?.blocked ? 'ACCOUNT_DELETION_IN_PROGRESS' : 'TRANSFORM_JOB_PERSIST_UNAVAILABLE',
      error: refineClaim?.blocked
        ? '회원 탈퇴 처리가 진행 중이라 문단 보강을 시작할 수 없어요.'
        : '문단 보강 작업을 안전하게 저장하지 못했어요.',
    });
  }
  logger.info('transform.refine_started', { jobId: job.id, uid: job.uid, mode: job.mode, paragraphIndex: idx, n, needed, memoLength: memo.length });
  res.json({ ok: true, refine: publicRefine(job) });   // 즉시 응답 — 프론트는 GET /transform/:id 폴링으로 수신
  const ac = job.auxAc || new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch {} }, REFINE_TIMEOUT_MS);
  try {
    // refine 전용 단일 호출: 전체 휴머나이즈 파이프라인(v2.5.x)은 보존 편향 지시 코어가 메모 위빙을
    // 막는다(실측 2026-08-27: userNotes·evidence 채널 모두 무위빙). 전용 프롬프트로 경험을 녹이고,
    // 무날조는 아래 결정론 게이트(measureNovelty allowedExtra=memo + 길이 상한)로 강제한다.
    const refineTool = {
      name: 'return_refined_paragraph',
      description: '보강된 문단을 반환한다.',
      input_schema: {
        type: 'object',
        properties: { outputText: { type: 'string', description: '보강된 문단 본문만 (제목·설명·따옴표 없이)' } },
        required: ['outputText']
      }
    };
    const refineSystem = [
      '너는 한국어 글의 한 문단을 다듬는 편집자다. 저자가 직접 겪은 실제 경험 한 줄이 제공된다.',
      '메모에 적힌 관찰·행동·판단을 해당 문단의 맥락에 맞게 반영하라. 이미 있는 경험을 구체화하되 새로운 일화를 요구하거나 만들지 마라.',
      '',
      '규칙(절대 준수):',
      '1. 무날조: 문단과 경험 메모에 없는 새로운 사실·수치·인명·기관명·연도를 만들지 않는다.',
      '2. 경험 메모를 그대로 복사해 붙이지 않는다 — 문단의 어조와 흐름에 맞게 1~2문장으로 풀어 쓴다.',
      '3. 문단의 원래 주장·논리 순서·종결체(반말/존댓말)를 유지한다.',
      '4. 길이는 원래 문단의 0.9~1.8배 사이로 한다.',
      '5. 결과는 문단 하나의 본문만 출력한다.',
      '6. 실험·연구 보고서는 객관적인 보고 문체와 기술 용어를 유지한다. 감상문이나 자기소개서로 바꾸지 않는다.',
      '7. 메모에 수치·원인·해결 결과가 없으면 추가하지 않는다. 기억의 불확실성을 단정으로 바꾸지 않는다.'
    ].join('\n');
    const resp = await gptAnalyze.callGpt({
      userText: '[문단]\n' + paraText + '\n\n[저자의 실제 경험 메모]\n' + memo,
      systemText: refineSystem,
      tool: refineTool,
      maxOutputTokens: 1500,
      signal: ac.signal,
      task: 'humanize',
      phase: 'main',
      mode: job.mode,
      config: gptCfg
    });
    const parsed = gptAnalyze.extractGptResult(resp, refineTool.name);
    // 문단 하나로 정규화 — 모델이 빈 줄을 넣으면 스플라이스 후 문단 수·인덱스가 틀어진다.
    const refined = require('../lib/refinementValidation').prepareRefinementCandidate({
      source: paraText, candidate: parsed && parsed.outputText,
      documentProfile: detectDocumentProfile(paraText)
    });
    // 무날조·길이 결정론 게이트 — 허용 세계 = 원 문단 ∪ 메모. 그 밖의 새 사실·과증축은 차단(무과금 유지).
    const floorGuard = require('../engine/floor');
    const novelty = refined ? floorGuard.measureNovelty(paraText, refined, memo) : { count: 0, items: [] };
    const bareLen = (s) => String(s).replace(/\s+/g, '').length;
    const lenRatio = refined ? bareLen(refined) / Math.max(1, bareLen(paraText)) : 0;
    const lost = floorGuard.measureLostFacts(paraText, refined);
    const integrity = require('../engine-gpt-prod/candidateIntegrity').auditCandidateIntegrity({
      source: paraText, before: paraText, candidate: refined, mode: 'blog',
      documentProfile: detectDocumentProfile(paraText)
    });
    let gateBlocked = !!refined && (novelty.count > 0 || lost.count > 0 || !integrity.pass || lenRatio < 0.9 || lenRatio > 1.8);
    let refinementValidation = null;
    if (refined && !gateBlocked) {
      refinementValidation = await require('../lib/refinementValidation').validateRefinement({
        source: paraText, candidate: refined, memo, signal: ac.signal, config: gptCfg
      });
      gateBlocked = !refinementValidation.pass;
    }
    if (gateBlocked) {
      logger.warn('transform.refine_gate_blocked', { jobId: job.id, uid: job.uid, paragraphIndex: idx, n, noveltyCount: novelty.count, lostFactCount: lost.count, lenRatio: Number(lenRatio.toFixed(2)) });
    }
    try {
      const reuse = surfaceguard.measureMemoReuse(refined, memo, paraText);
      if (reuse.count) logger.warn('transform.refine_memo_reuse', { jobId: job.id, uid: job.uid, n, count: reuse.count });
    } catch { /* 관측용 — 실패해도 흐름 유지 */ }
    const changed = !!refined && !gateBlocked && refined.replace(/\s+/g, ' ') !== paraText.trim().replace(/\s+/g, ' ');
    if (!changed) {
      job.refine = { status: 'done', changed: false, paragraphIndex: idx, n, needed: 0, deducted: false,
        note: gateBlocked
          ? '보강 결과가 안전 검증(무날조·분량)을 통과하지 못해 원래 문단을 유지했어요. 크레딧·무료 횟수는 쓰지 않았어요.'
          : '적어주신 내용을 반영해도 이 문단이 크게 달라지지 않아 원래 문단을 유지했어요. 크레딧·무료 횟수는 쓰지 않았어요.' };
      persistJob(job);
      logger.info('transform.refine_noop', { jobId: job.id, uid: job.uid, paragraphIndex: idx, n, gateBlocked });
      return;
    }
    // 패치: sep 보존 스플라이스 — 보강한 문단 외에는 바이트 단위로 그대로 유지.
    const current = surfaceguard.splitParagraphsForRefine(job.result.outputText || '');
    current[idx] = { ...current[idx], text: refined };
    const nextOutput = current.map(p => p.lead + p.text + p.sep).join('');
    const refinementAudit = require('../lib/refinementAudit').createRefinementAudit({
      parent: job.result.outputText, output: nextOutput, source: paraText, candidate: refined, memo,
      paragraphIndex: idx, parentEngineVersion: job.result.engineMeta?.engineVersion || job.result.refinementAudit?.parentEngineVersion,
      generationModel: resp?.model || resp?.gptMeta?.selectedModel, validation: refinementValidation
    });
    job.pendingRefinement = { outputText: nextOutput, n, needed, paraLen, paragraphIndex: idx,
      memoLength: memo.length, outputVersion: (job.outputVersion || 1) + 1, refinementAudit };
    const staged = await persistJob(job, { requireClaim: true });
    if (!staged.ok) throw new Error('REFINE_RESULT_PERSIST_UNAVAILABLE');
    await finishRefinement(job);
    return;

  } catch (e) {
    const aborted = ac.signal.aborted;
    job.refine = { status: 'error', paragraphIndex: idx, n, needed: 0,
      error: job.pendingRefinement ? '보강 완료 상태를 확인하고 있어요. 다시 시도하면 저장된 결과를 복구해요.'
        : aborted ? '문단 보강이 시간 초과로 중단됐어요. 크레딧은 차감되지 않았어요.' : '문단 보강 중 오류가 발생했어요. 크레딧은 차감되지 않았어요.' };
    persistJob(job);
    logger.error('transform.refine_failed', { jobId: job.id, uid: job.uid, paragraphIndex: idx, n, aborted, err: e });
  } finally {
    clearTimeout(timer);
  }
}));

// ── P4: 근거 승인 — 승인된 후보만 evidence로 재구성 재개. "미승인은 엔진이 차단"의 구현부:
//   엔진에 전달되는 허용 세계 자체가 승인 목록뿐이므로 미승인 사실은 novelty 게이트가 자동 차단.
router.post('/transform/:id/approve', async (req, res) => {
  const job = await loadControlJob(req, res);
  if (!job) return;
  if (job.status !== 'awaiting_approval') return res.status(409).json({ error: '지금은 승인 단계가 아니에요.' });
  if (draining) return res.status(503).json({ error: '서버가 점검을 위해 재시작 중이에요. 1~2분 후 다시 승인해 주세요. (작업은 사라지지 않아요)' });
  const ids = Array.isArray(req.body?.approved) ? req.body.approved : [];
  let approved = (job.candidates || []).filter(c => ids.includes(c.id));
  // ★승인 수 캡(2026-06-12 실측 캘리브레이션): 사실 밀도 ~350자당 1건 초과는 위빙 생존 검증이 못 버팀
  //   (성공 290자/건·17건 vs 실패 240자/건·24건=36분 후 lostFacts 차단). 초과분은 A등급·무충돌 우선으로 유지.
  const bare = (job.text || '').replace(/\s+/g, '').length;
  const cap = Number(process.env.EVIDENCE_APPROVE_CAP) || Math.max(8, Math.min(18, Math.floor(bare / 350)));
  if (approved.length > cap) {
    const rank = (c) => (c.conflict ? 2 : 0) + (c.grade === 'A' ? 0 : c.grade === 'B' ? 1 : 3);
    approved = approved.slice().sort((a, b) => rank(a) - rank(b)).slice(0, cap);
    job.note = `근거가 많아 사실 보존 검증이 가능한 상위 ${cap}건(공식 출처 우선)만 사용했어요.`;
    logger.warn('transform.evidence_approval_capped', {
      jobId: job.id,
      uid: job.uid,
      requested: ids.length,
      cap
    });
  }
  const lines = approved.map(c => `${c.fact} (출처: ${c.sourceTitle || c.host})`);
  job.approvedCount = approved.length;
  job.approvedEvidence = lines.join('\n');
  job.status = 'queued';
  job.stage = '승인 완료 · 대기 중';
  job.queuedAt = Date.now();
  logger.info('transform.evidence_approved', {
    jobId: job.id,
    uid: job.uid,
    approved: approved.length,
    candidates: (job.candidates || []).length
  });
  const approvalClaim = await persistJob(job, { requireClaim: true, expectedStatus: 'awaiting_approval' });
  if (!approvalClaim?.ok) {
    job.status = 'awaiting_approval';
    job.stage = '근거 승인 대기';
    return res.status(approvalClaim?.blocked ? 409 : 503).json({
      code: approvalClaim?.blocked ? 'ACCOUNT_DELETION_IN_PROGRESS' : 'TRANSFORM_JOB_PERSIST_UNAVAILABLE',
      error: approvalClaim?.blocked
        ? '회원 탈퇴 처리가 진행 중이라 작업을 재개할 수 없어요.'
        : '승인 작업을 안전하게 저장하지 못했어요.',
    });
  }
  jobs.set(job.id, job);
  drainQueue();
  const payload = activeJobPayload(job);
  if (job.status === 'queued') {
    logger.info('transform.queued', {
      jobId: job.id,
      uid: job.uid,
      mode: job.mode,
      reason: 'evidence_approved',
      queuePosition: payload.queuePosition,
      queueSize: payload.queueSize,
      queueEtaSec: payload.queueEtaSec
    });
  }
  res.json({ ok: true, approved: approved.length, job: payload });
});

router.get('/transform/:id', async (req, res, next) => {
  try {
  let job = jobs.get(req.params.id);
  if (db && !job?.executionToken && /^[a-f0-9]{16}$/u.test(req.params.id)) {
    const snapshot = await db.collection('transformJobs').doc(req.params.id).get();
    if (snapshot.exists) {
      const restored = snapshot.data();
      completionState.normalizeCancelledJob(restored);
      if (!TERMINAL_JOB_STATUSES.has(restored.status) || restored.pendingCompletion || restored.pendingRefinement
          || Date.now() - (restored.terminalAtMs || restored.createdAt) < JOB_TTL_MS) {
        job = { ...restored, ac: new AbortController() };
        delete job.executionToken;
      } else job = null;
    }
  }
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요. (만료되었거나 서버가 재시작됨)' });
  if (!(await requireJobOwner(req, res, job))) {
    // 인증 실패(주로 토큰 만료)로 폴링이 401을 받은 경우 — 진행/완료된 유료 작업이면 결과 유실 의심 알림.
    if (res.statusCode === 401) maybeNotifyOrphan(job);
    return;
  }
  orphan401.delete(job.id);   // 정상 폴링 1회 = 인증 회복 → 카운터 리셋
  const elapsedBase = job.status === 'running'
    ? (job.startedAt || job.createdAt)
    : job.status === 'queued'
      ? (job.queuedAt || job.createdAt)
      : job.createdAt;
  const base = {
    ok: true,
    ...require('../lib/transformCancellation').cancellationAvailability(job, { windowSec: CANCEL_WINDOW_SEC }),
    status: job.status,
    inputChars: typeof job.text === 'string' ? job.text.length : 0,
    durationMs: Math.max(0, (job.terminalAtMs || Date.now()) - job.createdAt),
    stage: job.stage,
    mode: job.mode || 'formal',
    modeSource: job.modeSource === 'defaulted' ? 'defaulted' : 'provided',
    elapsedSec: Math.round((Date.now() - elapsedBase) / 1000),
    estSec: job.estSec,
    estLowSec: job.estLowSec,
    estHighSec: job.estHighSec,
    estimateVersion: job.estimateVersion,
    estimateBasis: job.estimateBasis,
    estimatedEditableChunks: job.estimatedEditableChunks,
    estimatedTotalChunks: job.estimatedTotalChunks,
    deducted: job.deducted === true,
    restartRecoveryCount: Math.max(0, Number(job.restartRecoveryCount) || 0),
    technicalRecoveryCount: Math.max(0, Number(job.technicalRecoveryCount) || 0),
    ...queueDetails(job),
    ...providerRecovery.payload(job),
    billingMode: job.billingMode === 'coupon' ? 'coupon' : 'credit',
    ...(job.note ? { note: job.note } : {})
  };
  if (job.status === 'done') {
    if (typeof job.result?.outputText === 'string' && job.result.outputText.length > 0) {
      try {
        base.activation = await require('../lib/featureActivation').recordFirstSuccess({
          db, uid: job.uid, runId: job.id, feature: 'humanize', chars: job.text?.length, mode: job.mode,
          isInternal: isAdminUid(job.uid) || job.devNoAuth === true || job.adminHumanizeLab === true,
          context: { sourceUrl: 'https://gpkorea.ai.kr/', userAgent: req.get('user-agent') },
          nowMs: Date.now()
        });
      } catch (error) { logger.warn('marketing.activation_record_failed', { code: error?.code || 'storage_error' }); }
      publicMetrics.trackDeliveredMetric(res, {
        operation: 'humanize',
        eventId: job.id,
        uid: job.uid,
        processedCharacters: typeof job.text === 'string' ? job.text.length : 0,
        isAdmin: isAdminUid(job.uid),
        isTest: job.devNoAuth === true || job.adminHumanizeLab === true
      }, { db, logger });
    }
    return res.json({
      ...base,
      sourceProbability: job.sourceProbability ?? null,
      sourceEvidence: job.sourceEvidence || null,
      qualityStatus: job.result?.qualityStatus,
      billingDisposition: job.result?.billingDisposition || job.billingDisposition || null,
      qualityWarnings: job.result?.qualityWarnings,
      effectStatus: job.result?.effectStatus || 'normal',
      effectNotices: job.result?.effectNotices || [],
      sourceReviewWarnings: job.result?.sourceReviewWarnings,
      engineMeta: job.result?.engineMeta,
      result: job.result,
      ...(job.refine ? { refine: publicRefine(job) } : {})   // 사후 문단 보강 진행 상태(additive)
    });
  }
  if (job.status === 'queued') return res.json(base);
  if (job.status === 'awaiting_approval') return res.json({ ...base, candidates: job.candidates });
  if (job.status === 'awaiting_payment') return res.json({ ...base, ...completionState.paymentRequiredPayload(job) });
  if (job.status === 'cancelled') return res.json(base);
  if (job.status === 'blocked') return res.json({ ...base, gates: job.gates, gateDetail: job.gateDetail,
    blockOffer: { ...(job.blockOffer || {}), fallbackOffer: false, retryOffer: ['blog', 'formal', 'polish'].includes(job.mode), retryCredit: job.needed }, ...blockedResponse(job) });
  if (job.status === 'error') return res.json({ ...base, error: job.error });
  res.json(base);
  } catch (error) { next(error); }
});

router.saveJobHistory = saveJobHistory;   // 테스트용
router.maybeNotifyOrphan = maybeNotifyOrphan;   // 테스트용
router.buildArchiveDocument = buildArchiveDocument;   // 테스트용(원문·결과 비저장 계약 검증)
router.finalQualityWarningCodes = finalQualityWarningCodes;   // 이력·아카이브 경고 코드 단일화 회귀 테스트용
router.ensureTerminalTimestamp = ensureTerminalTimestamp;   // 테스트용
router.normalizeDocumentProfileOverride = normalizeDocumentProfileOverride;   // 테스트·클라이언트 계약용
router.preservationFallbackAllowed = preservationFallbackAllowed;   // 고급→보존형 다운그레이드 회귀 테스트용
router.assessEditableContent = assessEditableContent;
router.recoveryBudgetUsdForCredits = recoveryBudgetUsdForCredits;
router.recoverableTechnicalBlockReason = recoverableTechnicalBlockReason;

module.exports = router;
