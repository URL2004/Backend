// [routes/transform.js] 회피 모드 P3 — 격식 유지 재구성(genreTransferV2) job 백엔드
// ────────────────────────────────────────────────────────────────
// 재구성은 문서 구조와 편집 청크 수에 따라 수분~90분이 걸릴 수 있어 동기 응답이 불가능 → job 방식:
//   POST /transform → 즉시 jobId 반환, 백그라운드에서 genreTransferV2 실행(클라이언트가 끊겨도 계속)
//   GET  /transform/:id → 상태 폴링(running|done|blocked|error)
// 과금(v1, 사장님 임시 승인 기본값): ★완료 시 차감(시작 시 precheck만 — "크레딧만 차감" 민원 구조적 방지),
//   단가는 확정 전이라 기존 휴머나이즈와 동일 글자수 공식(ceil(len/100)) 임시 적용.
// job 저장(v1): 서버 메모리 — 재시작 시 유실(완료 차감이라 돈 사고는 없음). Firebase 영속화는 후속(P5).
// FLOOR 게이트: 보존/의미 게이트는 기본 경고 전달, 빈 결과·프롬프트 누출·인코딩 깨짐·문장 절단만 미노출.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const analyze = require('./analyze');   // 과금 헬퍼 재사용(차감 공식 단일 출처)
const { db, verifyToken, ADMIN_UIDS } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const { bearerToken } = require('../lib/reqtoken');   // idToken 추출 단일 출처(헤더 우선·폴백 deprecated)
const inputrouting = require('../engine/inputrouting');   // 재구성 부적합 사전감지(생성 호출 '전' 차단 → API 낭비 0)
const { reviewCandidates, hostOf } = require('../engine/evidencereview');
const discord = require('../lib/discord');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const gptAnalyze = require('./analyze-gpt');
const layoutNormalizer = require('../engine/layout');
const { CONTENT_GENRES, detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');
const { estimateAdvancedTime } = require('../engine-gpt-prod/timeEstimate');
const humanizationDepth = require('../engine-gpt-prod/humanizationDepth');
const surfaceguard = require('../engine/surfaceguard');
const { isV248FeatureEnabled } = require('../lib/humanizeV248Flags');

function claudeGenreTransferV2() {
  return require('../engine/genretransfer').genreTransferV2;
}

function claudeSuggestEvidence() {
  return require('../engine/evidence').suggestEvidence;
}

const jobs = new Map();
const JOB_TTL_MS = 6 * 60 * 60 * 1000;   // 완료 후 6시간 보관
const JOB_ARCHIVE_COLLECTION = 'transformJobArchive'; // 관리자 모니터 장기 보관용(원문·결과 제외)
const TERMINAL_JOB_STATUSES = new Set(['done', 'blocked', 'error', 'cancelled']);
let draining = false;
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.createdAt > JOB_TTL_MS) {
      archiveJob(j, { expiredAtMs: now });
      jobs.delete(id); deletePersisted(id); orphan401.delete(id);
    }
  }
  const today = kstDay();
  for (const [uid, d] of dailyStarts) if (d.day !== today) dailyStarts.delete(uid);
}, 30 * 60 * 1000).unref();

// ── 비용 방어(2026-06-12): 차감이 완료 시점이라 차단·에러·취소 job의 원가(최대 $7)는 회사 부담 →
//   동시·일일 한도로 최악 비용을 캡. 한도는 "운영자가 감당 가능한 하루 최대 손실" 기준으로 env 조정.
const TRANSFORM_SAFE_ACTIVE_CAP = Math.max(1, Number(process.env.TRANSFORM_SAFE_ACTIVE_CAP) || 1);
const MAX_ACTIVE_GLOBAL = Math.min(Number(process.env.RESTRUCTURE_MAX_ACTIVE) || 3, TRANSFORM_SAFE_ACTIVE_CAP);   // 전역 동시 실행(LLM 점유) 상한 — formal(재구성)
const BLOG_MAX_ACTIVE = Math.min(Number(process.env.BLOG_MAX_ACTIVE) || 4, TRANSFORM_SAFE_ACTIVE_CAP);            // blog(기본 피하기) 전역 동시 — 짧고 저원가라 별도 풀
const MAX_QUEUE_GLOBAL = Number(process.env.RESTRUCTURE_MAX_QUEUE) || 30;    // formal 대기열 상한 — 무한 접수 방지
const BLOG_MAX_QUEUE = Number(process.env.BLOG_MAX_QUEUE) || 50;             // short 대기열 상한
const QUEUE_DRAIN_INTERVAL_MS = Number(process.env.TRANSFORM_QUEUE_TICK_MS) || 3000;
const RESTORE_QUEUE_DRAIN_DELAY_MS = Number(process.env.TRANSFORM_RESTORE_DRAIN_DELAY_MS) || 30000;
const DAILY_CAP_PER_UID = Number(process.env.RESTRUCTURE_DAILY_CAP) || 8;    // 사용자당 일일 시작 횟수(취소·차단 포함) — formal만
const CANCEL_WINDOW_SEC = Number(process.env.CANCEL_WINDOW_SEC) || 45;       // 시작 후 이 시간 안에서만 사용자 취소 허용(원가 거의 안 쓴 구간). UI 버튼은 30초, 서버는 시계·네트워크 지연 여유로 45초.
const dailyStarts = new Map();   // uid → { day, count } — 메모리 보관(재시작 시 리셋은 사용자에게 유리한 방향이라 허용)
const orphan401 = new Map();   // jobId → 폴링 GET 401 연속 횟수(결과 유실 의심 감지용)

// idToken 추출은 lib/reqtoken.bearerToken으로 단일화(헤더 우선, body/query 폴백 + deprecation 로그).
function tokenFromReq(req) { return bearerToken(req); }

function isAdminUid(uid) {
  return ADMIN_UIDS.includes(uid);
}

async function activeGptConfig() {
  const cfg = await gptRuntimeConfig.getRuntimeConfig({ db, logger });
  return gptRuntimeConfig.isGptActive(cfg) ? cfg : null;
}

function humanizeV2Enabled() {
  return String(process.env.HUMANIZE_ENGINE_V2_ENABLED || '').trim() === '1';
}

function effectConfirmationEnabled() {
  return humanizeV2Enabled()
    && isV248FeatureEnabled('effectConfirmation');
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

const NO_DELIVERY_GATES = new Set(['gpt_all_chunks_fallback', 'gpt_noop_unchanged', 'noop_unchanged']);
const STRICT_DELIVERY_GATES = new Set([
  ...NO_DELIVERY_GATES,
  'empty_or_meta_output',
  'prompt_instruction_leak',
  'encoding_corruption',
  'sentence_truncated',
  'refusal',
  'polish_unchanged',
  'humanization_depth_no_effect'
]);

function softenBlockedFloorReport(out, logName, meta = {}) {
  if (!out || !out.floorReport || out.floorReport.status !== 'blocked') return false;
  if (process.env.STRICT_QUALITY_GATE === '1') return false;
  const outputText = out.result?.outputText || out.text || '';
  if (!String(outputText || '').trim()) return false;
  const criticals = Array.isArray(out.floorReport.criticals) ? out.floorReport.criticals : [];
  const warnings = Array.isArray(out.floorReport.warnings) ? out.floorReport.warnings : [];
  if (criticals.some(isStrictDeliveryCritical)) return false;
  const gates = criticals.map(c => c.gate || c.type || 'quality_gate');
  out.floorReport.status = 'needs_review';
  out.floorReport.criticals = [];
  out.floorReport.warnings = [
    ...warnings,
    ...criticals.map(c => ({ ...c, softenedFromCritical: true }))
  ];
  logger.warn(logName, { ...meta, gates, softened: true });
  return true;
}

function isStrictDeliveryCritical(c) {
  const gate = String(c?.gate || c?.type || '').trim();
  if (STRICT_DELIVERY_GATES.has(gate)) return true;
  return /empty|meta_output|prompt_instruction_leak|encoding_corruption|sentence_truncated|refusal|polish_unchanged/i.test(gate);
}

function hasStrictDeliveryGate(gates) {
  return (Array.isArray(gates) ? gates : []).some(gate => isStrictDeliveryCritical({ gate }));
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

function adminLabRuntimeMeta(job, path) {
  const profile = job.adminLabProfile || adminLabProfileOf(job);
  return {
    version: 'admin-humanize-lab-v1',
    profile,
    path,
    billing: 'admin_test_no_credit',
    mode: job.mode || 'formal'
  };
}

function attachAdminLabResultMeta(job, result, path) {
  if (!isAdminHumanizeLabJob(job)) return result;
  const meta = adminLabRuntimeMeta(job, path);
  return {
    ...result,
    adminHumanizeLab: true,
    adminLabProfile: meta.profile,
    basicExperiment: job.basicExperiment || null,
    humanizeMeta: {
      ...(result && result.humanizeMeta ? result.humanizeMeta : {}),
      ...meta
    }
  };
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

function kstDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

// ★ 과금 정책(2026-06-12 길이 구간 정액): 재구성은 슬롯·위빙이 글자수에 비례해 원가가 길수록 큼($2.5~7) →
//   만 자 구간별 정액. 원가의 ~1.5배 마진. (~1만 200/300 · ~2만 400/500 · ~3만 600/700)
//   감지 보고서(detectreport.js)의 비용 안내도 이 함수를 재사용 — 단가 단일 출처.
function restructureCredit(len, ev) {
  var tier = len <= 10000 ? 0 : (len <= 20000 ? 1 : 2);
  var base = [200, 400, 600][tier];
  return base + (ev ? 100 : 0);
}
router.restructureCredit = restructureCredit;

// 짧은 휴머나이징 계열(blog·polish·보존형 폴백) 공통 단가.
// 신규 가입 10크레딧 체험권과 맞춰 최소 10크레딧, 이후 100자당 2크레딧.
const SHORT_HUMANIZE_MIN_CREDITS = 10;
function shortHumanizeCredit(len) {
  return Math.max(SHORT_HUMANIZE_MIN_CREDITS, Math.ceil((Number(len) || 0) / 100) * 2);
}
router.shortHumanizeCredit = shortHumanizeCredit;

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
    if (typeof analyze.commitCouponUsage !== 'function' || !job.billingTier) {
      throw new Error('coupon_billing_unavailable');
    }
    await analyze.retryAsync(() => analyze.commitCouponUsage(
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
  await analyze.retryAsync(() => analyze.commitCreditDeduct(
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
    plan: job?.plan
  });
  if (disposition !== 'charged') return disposition;

  await commitJobBilling(job, {
    creditAmount: job.needed,
    operation: job.mode === 'formal' ? 'restructure' : 'humanize',
    mode: job.mode || 'formal',
    textLength: (job.text || '').length
  });
  return job.deducted ? 'charged' : (job.plan === 'unlimited' ? 'plan_unlimited' : 'admin_no_charge');
}

function classifyBillingDisposition({
  adminNoCharge = false,
  plan = ''
} = {}) {
  if (adminNoCharge) return 'admin_no_charge';
  if (plan === 'unlimited') return 'plan_unlimited';
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
    const checked = await analyze.precheckCoupon(idToken, textLength);
    if (checked.uid !== job.uid) throw Object.assign(new Error('AUTH_INVALID'), { status: 401 });
    job.billingTier = checked.tier;
    return checked;
  }
  if (job.plan === 'unlimited') return { uid: job.uid, plan: 'unlimited' };
  return analyze.precheckCredits(idToken, creditAmount);
}
router.precheckExistingJobBilling = precheckExistingJobBilling;   // 회귀 테스트용

// 동시 실행 풀: formal(5~90분·고원가)과 short(blog·polish, 1~3분·저원가)를 분리 — 한 풀에 섞으면 서로 굶김.
function poolOf(mode) { return (mode || 'formal') === 'formal' ? 'formal' : 'short'; }

function countActive(uid, mode) {
  let running = 0, queued = 0, mine = 0;
  const pool = poolOf(mode);
  for (const j of jobs.values()) {
    if (j.status === 'running' && poolOf(j.mode) === pool) running++;
    if (j.status === 'queued' && poolOf(j.mode) === pool) queued++;
    // 승인·대기는 LLM을 안 쓰지만 사용자 기준으로는 "진행 중 작업" — 같은 사용자가 쌓아두는 건 모드 무관 차단.
    if (j.uid === uid && (j.status === 'running' || j.status === 'queued' || j.status === 'awaiting_approval')) mine++;
  }
  return { running, queued, mine };
}

function activeJobFor(uid) {
  let found = null;
  for (const j of jobs.values()) {
    if (j.uid !== uid) continue;
    if (j.status !== 'running' && j.status !== 'queued' && j.status !== 'awaiting_approval') continue;
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

function queueUnitSec(mode, estSec) {
  return poolOf(mode) === 'short' ? 120 : Math.max(300, Math.min(1200, estSec || 900));
}

function queuedJobsForPool(pool) {
  return [...jobs.values()]
    .filter(j => j.status === 'queued' && poolOf(j.mode) === pool)
    .sort((a, b) => (a.queuedAt || a.createdAt || 0) - (b.queuedAt || b.createdAt || 0));
}

function queueDetails(job) {
  if (!job || job.status !== 'queued') return {};
  const pool = poolOf(job.mode);
  const queued = queuedJobsForPool(pool);
  const position = Math.max(1, queued.findIndex(j => j.id === job.id) + 1);
  const { running } = countActive('', job.mode);
  const free = Math.max(0, poolCap(job.mode) - running);
  const wave = position <= free ? 0 : Math.ceil((position - free) / Math.max(1, poolCap(job.mode)));
  return {
    queuePosition: position,
    queueSize: queued.length,
    queueEtaSec: wave === 0 ? 15 : wave * queueUnitSec(job.mode, job.estSec)
  };
}

function activeJobPayload(job) {
  if (!job) return null;
  const elapsedBase = job.status === 'queued'
    ? (job.queuedAt || job.createdAt || Date.now())
    : (job.startedAt || job.createdAt || Date.now());
  const base = {
    id: job.id,
    status: job.status,
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
    deducted: job.deducted === true
  };
  if (job.documentProfileOverride) base.documentProfile = job.documentProfileOverride;
  Object.assign(base, queueDetails(job));
  if (job.note) base.note = job.note;
  if (job.status === 'awaiting_approval') base.candidates = job.candidates || [];
  return base;
}

function checkLimits(uid, mode) {
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
    const d = dailyStarts.get(uid);
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

// ★ 동의 기반 차단 안내 재료. 고급은 선택 강도를 끝까지 유지하므로
// 보존형 폴백을 제공하지 않는다. 기본 차단 작업에만 사용자가 원할 때
// 다듬기 결과를 별도로 받을 수 있다.
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
    fallbackOffer: preservationFallbackAllowed(job.mode),
    fallbackCredit: preservationFallbackCredit((text || '').length),
    canEvidence: job.mode === 'formal' && !job.wantEvidence,
    mode: job.mode || 'formal',
    abstractParas
  };
}

// ── job 영속화(2026-06-12): Firestore transformJobs — 재시작에도 결과·승인대기 생존.
//   90분짜리 job이 도는 서비스에서 영속화 없는 배포 = 누군가의 90분이 증발. 로컬(db 없음)은 무동작.
//   AbortController 등 비직렬화 필드는 제외하고 상태 전이 시점마다 스냅샷 저장(fire-and-forget — 저장 실패가 job을 죽이면 안 됨).
const PERSIST_FIELDS = ['id', 'status', 'stage', 'createdAt', 'uid', 'plan', 'needed', 'devNoAuth', 'deducted',
  'text', 'estSec', 'estLowSec', 'estHighSec', 'estimateVersion', 'estimateBasis', 'estimatedEditableChunks', 'estimatedTotalChunks', 'note', 'gates', 'gateDetail', 'blockOffer', 'candidates', 'approvedCount', 'result', 'error',
  'mode', 'modeSource', 'billingMode', 'billingTier', 'billingDisposition', 'effectExpectation', 'effectNoticeCode', 'effectNoticeAccepted', 'memo', 'autoCoach', 'autoCoachApplied', 'lang', 'queuedAt', 'startedAt', 'terminalAtMs', 'wantEvidence', 'approvedEvidence', 'basicStyle', 'documentProfileOverride', 'basicExperiment', 'adminHumanizeLab', 'adminLabProfile', 'layoutNlpTest', 'engineMeta'];
const ARCHIVE_FIELDS = ['id', 'status', 'stage', 'createdAt', 'uid', 'plan', 'needed', 'devNoAuth', 'deducted',
  'estSec', 'estLowSec', 'estHighSec', 'estimateVersion', 'estimateBasis', 'estimatedEditableChunks', 'estimatedTotalChunks', 'note', 'error', 'mode', 'modeSource', 'billingMode', 'billingTier', 'billingDisposition', 'effectExpectation', 'effectNoticeCode', 'effectNoticeAccepted', 'lang', 'queuedAt', 'startedAt', 'terminalAtMs', 'wantEvidence', 'approvedCount', 'basicStyle', 'documentProfileOverride', 'basicExperiment', 'adminHumanizeLab', 'adminLabProfile', 'layoutNlpTest'];

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

function persistJob(job) {
  normalizeCompletedJobState(job);
  ensureTerminalTimestamp(job);
  if (!db) return;
  const doc = {};
  for (const k of PERSIST_FIELDS) {
    const cleaned = pruneUndefinedForFirestore(job[k]);
    if (cleaned !== undefined) doc[k] = cleaned;
  }
  try {
    db.collection('transformJobs').doc(job.id).set(doc, { merge: true })
      .catch(e => logger.warn('transform.persist_failed', { jobId: job.id, uid: job.uid, status: job.status, err: e }));
    archiveJob(job);
  } catch (e) {
    logger.warn('transform.persist_failed', { jobId: job.id, uid: job.uid, status: job.status, err: e });
  }
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
  return db.collection(JOB_ARCHIVE_COLLECTION).doc(job.id).set(doc, { merge: true })
    .catch(e => logger.warn('transform.archive_failed', { jobId: job.id, uid: job.uid, status: job.status, err: e }));
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
  const usage = humanizeMeta.usage || {};
  const layoutRepair = humanizeMeta.layoutRepair || humanizeMeta.structureLock?.layoutRepair || {};
  const paragraphRepair = layoutRepair.paragraphs || {};
  const paragraphReadability = paragraphRepair.readability || engineMeta.paragraphReadability || {};
  const formattingRepair = layoutRepair.formatting || {};
  const dedupeAudit = humanizeMeta.dedupeAudit || {};
  const naturalnessShadow = result.naturalnessShadow || humanizeMeta.naturalnessShadow || {};
  const warningCodes = uniqueArchiveCodes([
    ...(Array.isArray(result.qualityWarnings) ? result.qualityWarnings : []),
    ...(Array.isArray(result.floorReport?.warnings) ? result.floorReport.warnings : [])
  ]);
  const gateCodes = job?.status === 'done'
    ? []
    : uniqueArchiveCodes([
        ...(Array.isArray(job.gates) ? job.gates : []),
        ...(Array.isArray(result.floorReport?.criticals) ? result.floorReport.criticals : [])
      ]);
  return pruneUndefinedForFirestore({
    gates: gateCodes,
    qualityStatus: archiveString(result.qualityStatus, 32),
    billingDisposition: archiveString(result.billingDisposition || job?.billingDisposition || engineMeta.billingDisposition, 48),
    qualityWarningCodes: warningCodes,
    preservationFallback: result.preservationFallback === true,
    fallbackFromMode: archiveString(result.engineMeta?.fallbackFromMode || engineMeta.fallbackFromMode, 24),
    engineVersion: archiveString(engineMeta.engineVersion || humanizeMeta.engine, 80),
    requestedMode: archiveString(engineMeta.requestedMode, 24),
    effectiveMode: archiveString(engineMeta.effectiveMode, 24),
    requestStrength: archiveString(engineMeta.requestStrength, 24),
    documentProfile: archiveString(engineMeta.documentProfile, 64),
    profileConfidence: archiveFinite(engineMeta.profileConfidence),
    profileDecisionSource: archiveString(engineMeta.profileDecisionSource, 48),
    profileMargin: archiveFinite(engineMeta.profileMargin),
    detectedDocumentProfile: archiveString(engineMeta.detectedDocumentProfile, 64),
    detectedProfileConfidence: archiveFinite(engineMeta.detectedProfileConfidence),
    requestedDocumentProfile: archiveString(engineMeta.requestedDocumentProfile, 64),
    profileOverrideApplied: engineMeta.profileOverrideApplied === true,
    profileOverrideIgnoredReason: archiveString(engineMeta.profileOverrideIgnoredReason, 48),
    semanticJudgeRan: engineMeta.semanticJudgeRan === true,
    discourseAuditVersion: archiveFinite(engineMeta.discourseAuditVersion),
    discoursePass: typeof engineMeta.discoursePass === 'boolean' ? engineMeta.discoursePass : undefined,
    discourseWarningCodes: uniqueStrictArchiveCodes(engineMeta.discourseWarningCodes),
    discourseSignalCount: archiveFinite(engineMeta.discourseSignalCount),
    discourseRepairRan: engineMeta.discourseRepairRan === true,
    repairCount: archiveFinite(engineMeta.repairCount),
    modelCallCount: archiveFinite(engineMeta.modelCallCount),
    humanizeCallCount: archiveFinite(engineMeta.humanizeCallCount),
    surfaceRetryCallCount: archiveFinite(engineMeta.surfaceRetryCallCount),
    polishRetryReason: archiveString(engineMeta.polishRetryReason, 32),
    polishEvaluativePaddingCodes: uniqueStrictArchiveCodes(engineMeta.polishEvaluativePaddingCodes),
    polishDeterministicPaddingRestoreCount: archiveFinite(engineMeta.polishDeterministicPaddingRestoreCount),
    fallbackCount: archiveFinite(engineMeta.fallbackCount ?? result.fallbackCount),
    finalNoopRecoveryCount: archiveFinite(engineMeta.finalNoopRecoveryCount),
    finalNoopRecoveryAttempted: engineMeta.finalNoopRecoveryAttempted === true,
    finalNoopRecoveryApplied: engineMeta.finalNoopRecoveryApplied === true,
    finalNoopRecoveryMethod: archiveString(engineMeta.finalNoopRecoveryMethod, 32),
    finalNoopRecoveryReason: archiveString(engineMeta.finalNoopRecoveryReason, 96),
    humanizationDepthEnabled: engineMeta.humanizationDepthEnabled === true,
    humanizationDepthApplicable: engineMeta.humanizationDepthApplicable === true,
    humanizationDepthPass: engineMeta.humanizationDepthPass === true,
    humanizationMinimumEffectPass: engineMeta.humanizationMinimumEffectPass === true,
    humanizationDepthSoftDelivered: engineMeta.humanizationDepthSoftDelivered === true,
    humanizationNoBenefitDelivered: engineMeta.humanizationNoBenefitDelivered === true,
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
    lengthRatio: archiveFinite(engineMeta.lengthRatio ?? result.floorReport?.metrics?.lengthRatio),
    humanizationTargetDepthMet: engineMeta.humanizationTargetDepthMet === true,
    humanizationDeliveryDepthBand: archiveString(engineMeta.humanizationDeliveryDepthBand, 24),
    humanizationDepthRetryCount: archiveFinite(engineMeta.humanizationDepthRetryCount),
    humanizationDepthEscalationAttemptCount: archiveFinite(engineMeta.humanizationDepthEscalationAttemptCount),
    humanizationDepthRetryApplied: engineMeta.humanizationDepthRetryApplied === true,
    humanizationDepthRetryTargetSentenceCount: archiveFinite(engineMeta.humanizationDepthRetryTargetSentenceCount),
    sectionRecoveryEnabled: engineMeta.sectionRecoveryEnabled === true,
    sectionRecoveryAttemptCount: archiveFinite(engineMeta.sectionRecoveryAttemptCount),
    sectionRecoveryAppliedCount: archiveFinite(engineMeta.sectionRecoveryAppliedCount),
    sectionRecoveryEscalationCount: archiveFinite(engineMeta.sectionRecoveryEscalationCount),
    fingerprintAuditVersion: archiveFinite(engineMeta.fingerprintAuditVersion),
    fingerprintPass: typeof engineMeta.fingerprintPass === 'boolean' ? engineMeta.fingerprintPass : undefined,
    fingerprintIssueCodes: uniqueStrictArchiveCodes(engineMeta.fingerprintIssueCodes),
    fingerprintIntroducedCount: archiveFinite(engineMeta.fingerprintIntroducedCount),
    fingerprintExcessIntroducedCount: archiveFinite(engineMeta.fingerprintExcessIntroducedCount),
    fingerprintRepairCount: archiveFinite(engineMeta.fingerprintRepairCount),
    endingStyleAuditVersion: archiveFinite(engineMeta.endingStyleAuditVersion),
    endingStylePass: typeof engineMeta.endingStylePass === 'boolean' ? engineMeta.endingStylePass : undefined,
    endingStyleIssueCount: archiveFinite(engineMeta.endingStyleIssueCount),
    endingStyleIntroducedOtherCount: archiveFinite(engineMeta.endingStyleIntroducedOtherCount),
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
    koreanDeterministicRepairCount: archiveFinite(engineMeta.koreanDeterministicRepairCount),
    koreanRefinementRetryAttemptCount: archiveFinite(engineMeta.koreanRefinementRetryAttemptCount),
    koreanRefinementRetryCount: archiveFinite(engineMeta.koreanRefinementRetryCount),
    koreanRefinementRetryApplied: engineMeta.koreanRefinementRetryApplied === true,
    finalFormattingRepairCount: archiveFinite(engineMeta.finalFormattingRepairCount ?? formattingRepair.changeCount),
    finalFormattingRepairCodes: uniqueStrictArchiveCodes(engineMeta.finalFormattingRepairCodes || formattingRepair.changeCodes),
    brokenLineBreakRepairCount: archiveFinite(engineMeta.brokenLineBreakRepairCount ?? formattingRepair.brokenLineBreakRepairCount),
    brokenParagraphBreakRepairCount: archiveFinite(engineMeta.brokenParagraphBreakRepairCount ?? formattingRepair.brokenParagraphBreakRepairCount),
    excessiveBlankLineRepairCount: archiveFinite(engineMeta.excessiveBlankLineRepairCount ?? formattingRepair.excessiveBlankLineRepairCount),
    missingSentenceSpaceRepairCount: archiveFinite(engineMeta.missingSentenceSpaceRepairCount ?? formattingRepair.missingSentenceSpaceRepairCount),
    contextualSpacingRepairCount: archiveFinite(engineMeta.contextualSpacingRepairCount ?? formattingRepair.contextualSpacingRepairCount),
    sourceReviewWarningCodes: uniqueStrictArchiveCodes(engineMeta.sourceReviewWarningCodes),
    sourceReviewWarningCount: archiveFinite(engineMeta.sourceReviewWarningCount),
    chunkFailureCodes: uniqueStrictArchiveCodes(engineMeta.chunkFailureCodes),
    chunkPrimaryFailureCodes: uniqueStrictArchiveCodes(engineMeta.chunkPrimaryFailureCodes),
    chunkResidualFailureCodes: uniqueStrictArchiveCodes(engineMeta.chunkResidualFailureCodes),
    chunkFallbackReasonCodes: uniqueStrictArchiveCodes(engineMeta.chunkFallbackReasonCodes),
    polishSpeakerRestoreCount: archiveFinite(engineMeta.polishSpeakerRestoreCount),
    polishSpeakerRestoredSentenceCount: archiveFinite(engineMeta.polishSpeakerRestoredSentenceCount),
    lineBoundaryPolicy: archiveString(engineMeta.lineBoundaryPolicy, 24),
    naturalnessRiskIncreased: naturalnessShadow.riskIncreased === true,
    naturalnessOverallRiskDelta: archiveFinite(naturalnessShadow.delta?.overallRisk),
    rhythmUniformityDelta: archiveFinite(naturalnessShadow.rhythmUniformityDelta),
    estimatedUsd: archiveFinite(humanizeMeta.estimatedUsd ?? usage.estimatedUsd),
    dedupeRemovedBlockCount: archiveFinite(dedupeAudit.removedBlockCount),
    dedupeRemovedBlockSentenceCount: archiveFinite(dedupeAudit.removedBlockSentenceCount),
    paragraphRepairPolicy: archiveString(paragraphRepair.policy, 48),
    paragraphCountBeforeRepair: archiveFinite(paragraphRepair.beforeCount),
    paragraphCountAfterRepair: archiveFinite(paragraphRepair.afterCount),
    paragraphRoleBoundaryCount: archiveFinite(paragraphRepair.roleBoundaryCount ?? engineMeta.paragraphRoleBoundaryCount),
    paragraphOverlongCount: archiveFinite(paragraphReadability.overlongCount),
    paragraphMaxBare: archiveFinite(paragraphReadability.maxBare),
    paragraphMaxSentences: archiveFinite(paragraphReadability.maxSentences)
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

function deletePersisted(id) {
  if (!db) return;
  db.collection('transformJobs').doc(id).delete()
    .catch(e => logger.warn('transform.persist_delete_failed', { jobId: id, err: e }));
}

let queueDrainPending = false;
function scheduleQueueDrain(delayMs = 0) {
  if (draining || queueDrainPending) return;
  queueDrainPending = true;
  const t = setTimeout(() => {
    queueDrainPending = false;
    drainQueue();
  }, Math.max(0, delayMs));
  if (t.unref) t.unref();
}

function drainQueue() {
  if (draining) return 0;
  let started = 0;
  started += drainQueuePool('formal');
  started += drainQueuePool('short');
  return started;
}

function drainQueuePool(pool) {
  const cap = pool === 'short' ? BLOG_MAX_ACTIVE : MAX_ACTIVE_GLOBAL;
  const running = countActive('', pool).running;
  let slots = Math.max(0, cap - running);
  if (!slots) return 0;
  let started = 0;
  for (const job of queuedJobsForPool(pool)) {
    if (slots <= 0) break;
    if (launchQueuedJob(job)) {
      slots--;
      started++;
    }
  }
  return started;
}

function launchQueuedJob(job) {
  if (!job || job.status !== 'queued') return false;
  const isShort = job.mode !== 'formal';
  const waitMs = Math.max(0, Date.now() - (job.queuedAt || job.createdAt || Date.now()));
  job.status = 'running';
  job.startedAt = Date.now();
  job.stage = isShort ? '문장 다듬는 중' : (job.wantEvidence ? '근거 검색' : '구조 계획');
  persistJob(job);
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
    queuedMs: waitMs
  });
  const hasApprovedEvidence = Object.prototype.hasOwnProperty.call(job, 'approvedEvidence');
  if (isShort) runHumanizeJob(job, job.text || '');
  else if (hasApprovedEvidence) runJob(job, job.text || '', job.approvedEvidence || '');
  else if (job.wantEvidence) runSearchPhase(job, job.text || '');
  else runJob(job, job.text || '', '');
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
  if (!db || job.devNoAuth || typeof analyze.saveAnalyzeHistory !== 'function') return;
  analyze.saveAnalyzeHistory({
    uid: job.uid,
    requestId: 'job_' + job.id,
    opType: 'humanize',
    text: text || job.text || '',
    needed: job.needed,
    result: { outputText: outputText || '' },
    mode: ['blog', 'formal', 'polish'].includes(job.mode) ? job.mode : 'formal',
    modeSource: job.modeSource === 'defaulted' ? 'defaulted' : 'provided',
    qualityStatus: job.result?.qualityStatus,
    billingDisposition: job.result?.billingDisposition || job.billingDisposition || null,
    qualityWarningCodes: (job.result?.qualityWarnings || []).map(item => item?.code).filter(Boolean),
    sourceReviewWarningCodes: (job.result?.sourceReviewWarnings || []).map(item => item?.code).filter(Boolean),
    engineMeta: job.result?.engineMeta || null
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

// 서버 시작 시 복원: done·blocked·awaiting_approval은 그대로 살리고(폴링·승인 재개 가능),
// running이었던 job은 프로세스가 죽어 실제로는 중단됨 → error로 정정(완료 차감이라 돈 사고는 없음).
async function restoreJobs() {
  if (!db) return;
  try {
    const snap = await db.collection('transformJobs').limit(500).get();
    const cutoff = Date.now() - JOB_TTL_MS;
    let kept = 0, interrupted = 0, expired = 0;
    snap.forEach(d => {
      const j = d.data();
      if (!j.createdAt || j.createdAt < cutoff) { expired++; archiveJob({ ...j, id: j.id || d.id }, { expiredAtMs: Date.now() }); deletePersisted(d.id); return; }
      j.id = j.id || d.id;
      j.ac = new AbortController();
      if (j.status === 'running') {
        j.status = 'error';
        j.stage = '중단됨(서버 재시작)';
        j.error = '서버 재시작으로 작업이 중단됐어요. 크레딧은 차감되지 않았어요 — 다시 시도해 주세요.';
        interrupted++;
        persistJob(j);
      }
      archiveJob(j);
      jobs.set(j.id, j);
      kept++;
    });
    if (kept || expired) {
      logger.info('transform.jobs_restored', { kept, interrupted, expired });
    }
    scheduleQueueDrain(RESTORE_QUEUE_DRAIN_DELAY_MS);
  } catch (e) {
    logger.warn('transform.jobs_restore_failed', { err: e });
  }
}
restoreJobs();

// ── graceful shutdown(server.js가 SIGTERM/SIGINT에서 호출): 새 작업 거부 → 진행 중 LLM 중단(비용 차단) →
//   중단 상태 영속화. 차감은 완료 시에만 일어나므로 여기서 돈이 새는 경로는 없다.
router.shutdown = async function shutdown() {
  draining = true;
  const writes = [];
  for (const j of jobs.values()) {
    if (j.status === 'running') {
      try { j.ac.abort(); } catch {}
      j.status = 'error';
      j.stage = '중단됨(서버 재시작)';
      j.error = '서버 재시작으로 작업이 중단됐어요. 크레딧은 차감되지 않았어요 — 다시 시도해 주세요.';
    }
    ensureTerminalTimestamp(j);
    if (db) {
      const doc = {};
      for (const k of PERSIST_FIELDS) {
        const cleaned = pruneUndefinedForFirestore(j[k]);
        if (cleaned !== undefined) doc[k] = cleaned;
      }
      writes.push(db.collection('transformJobs').doc(j.id).set(doc, { merge: true }).catch(() => {}));
      const archiveWrite = archiveJob(j);
      if (archiveWrite) writes.push(archiveWrite.catch(() => {}));
    }
  }
  await Promise.race([Promise.allSettled(writes), new Promise(r => setTimeout(r, 4000))]);
};
router.stats = () => {
  const formal = countActive('', 'formal');
  const short = countActive('', 'blog');
  return {
    activeJobs: formal.running + short.running,
    queuedJobs: formal.queued + short.queued,
    totalJobs: jobs.size,
    draining,
    maxActive: MAX_ACTIVE_GLOBAL
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
    const ev = gptCfg
      ? await gptAnalyze.suggestEvidence({ query: text, signal: job.ac.signal, config: gptCfg, uid: humanizeV2Enabled() ? job.uid : '' })
      : await claudeSuggestEvidence()(text, { maxSegments: Number(process.env.EVIDENCE_MAX_SEGMENTS) || 6, signal: job.ac.signal });
    const candidates = gptCfg
      ? (ev.candidates || []).map(c => ({
          fact: c.reason || c.title,
          sourceTitle: c.title || c.publisher || hostOf(c.url),
          sourceUrl: c.url,
          publisher: c.publisher
        }))
      : (ev.candidates || []);
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
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
      scheduleQueueDrain();
      return;
    }
    logger.error('transform.evidence_search_failed', { jobId: job.id, uid: job.uid, err: e });
    job.note = '근거 검색이 실패해 근거 없이 진행했어요.';
    return runJob(job, text, '');
  }
}

// 기본 휴머나이징의 명시적 다듬기 폴백만 남긴다. 고급을 선택한 작업은
// 결과 강도를 보존형으로 낮추지 않는다.
function fallbackEnabled() {
  const v = (process.env.TRANSFORM_BLOCK_FALLBACK || '').toLowerCase();
  return v !== '0' && v !== 'off' && v !== 'false';
}

function preservationFallbackAllowed(mode) {
  return fallbackEnabled() && String(mode || '') === 'blog';
}

// 기본 작업에서 사용자가 별도로 선택한 다듬기 결과의 단가.
function preservationFallbackCredit(len) {
  return shortHumanizeCredit(len);
}

function buildPreservationFallbackMeta(out, job) {
  const base = out?.engineMeta || out?.result?.engineMeta || {};
  return {
    ...base,
    requestedMode: job?.mode || base.requestedMode || 'formal',
    fallbackFromMode: job?.mode || '',
    preservationFallback: true
  };
}

// 기본 휴머나이징이 차단됐을 때 사용자가 명시적으로 선택한 경우에만
// 같은 입력을 다듬기 경로로 처리한다.
async function tryBlogPreservationFallback(job, text) {
  try {
    if (job.ac.signal.aborted) {
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
      return true;
    }
    job.stage = '원문 보존형으로 재처리 중';
    job.note = (job.note ? job.note + ' ' : '')
      + '자연화 결과에 원문 보존 위험이 남아, 원문을 최대한 보존하는 방식으로 처리했어요.';
    persistJob(job);

    const gptCfg = await activeGptConfig();
    const out = gptCfg
      ? await gptAnalyze.runHumanizeChunked({
          text,
          mode: 'polish',
          lang: job.lang || 'ko',
          signal: job.ac.signal,
          userNotes: job.memo || '',
          config: gptCfg,
          styleProfile: 'production_blog_preservation_fallback',
          documentProfileOverride: job.documentProfileOverride || '',
          allowPolish: humanizeV2Enabled(),
          uid: humanizeV2Enabled() ? job.uid : ''
        })
      : await analyze.runHumanizeChunked({
          text, mode: 'assignment', lang: job.lang || 'ko', signal: job.ac.signal,
          floorV2: true, optIn: false, judge: false, grounding: false, userNotes: job.memo || '', tonePolish: true   // ★경험 메모 보존형에도 적용(2026-06-17)
        });
    const fbCriticals = ((out.floorReport && out.floorReport.criticals) || []).map(c => c.gate);
    const fbHardHit = fbCriticals.filter(g => isStrictDeliveryCritical({ gate: g }));
    if (!out.result || !out.result.outputText || fbHardHit.length) {
      logger.warn('transform.blog_fallback_blocked', {
        jobId: job.id,
        uid: job.uid,
        mode: job.mode,
        fbCriticals,
        fbHardHit,
        gateDetail: { criticals: (out.floorReport?.criticals || []).slice(0, 8) }
      });
      return false;
    }
    const fbSoftGates = fbCriticals.filter(g => !isStrictDeliveryCritical({ gate: g }));
    if (fbSoftGates.length && out.floorReport) {
      logger.info('transform.blog_fallback_soft_delivered', { jobId: job.id, uid: job.uid, mode: job.mode, fbSoftGates });
      out.floorReport.status = 'needs_review';
      out.floorReport.warnings = [
        ...(out.floorReport.warnings || []),
        ...(out.floorReport.criticals || []).map(c => ({ ...c, softenedFromCritical: true }))
      ];
      out.floorReport.criticals = [];
    }

    const fbNeeded = preservationFallbackCredit(text.length);
    try {
      await commitJobBilling(job, {
        creditAmount: fbNeeded,
        operation: 'humanize',
        mode: 'polish',
        textLength: text.length,
        meta: { fallback: true, fromMode: 'blog' }
      });
    } catch (e) {
      logger.error('transform.blog_fallback_billing_failed_manual_action', {
        jobId: job.id, uid: job.uid, needed: fbNeeded, billingMode: job.billingMode, opType: 'humanize', err: e
      });
    }
    job.needed = job.billingMode === 'coupon' ? 1 : fbNeeded;
    const fallbackEngineMeta = buildPreservationFallbackMeta(out, job);
    job.engineMeta = fallbackEngineMeta;
    job.status = 'done';
    job.result = {
      outputText: out.result.outputText,
      preservationFallback: true,
      qualityStatus: out.qualityStatus || out.result?.qualityStatus || out.floorReport?.status || 'clean',
      qualityWarnings: out.qualityWarnings || out.result?.qualityWarnings || [],
      sourceReviewWarnings: out.sourceReviewWarnings || out.result?.sourceReviewWarnings || [],
      engineMeta: fallbackEngineMeta,
      humanizeMeta: out.result?.humanizeMeta || null,
      naturalnessShadow: out.result?.naturalnessShadow || null,
      metrics: {
        novelty: 0,
        lostFacts: 0,
        repetition: 0,
        judge: 'skip',
        lengthRatio: out.floorReport?.metrics?.lengthRatio,
        preservationFallback: true
      },
      floorReport: {
        status: out.floorReport?.status || 'clean',
        criticals: out.floorReport?.criticals || [],
        warnings: out.floorReport?.warnings || []
      },
      chunkCount: out.chunkCount,
      fallbackCount: out.fallbackCount
    };
    persistJob(job);
    saveJobHistory(job, text, out.result.outputText);
    logger.info('transform.blog_fallback_done', {
      jobId: job.id,
      uid: job.uid,
      fromMode: 'blog',
      needed: fbNeeded,
      deducted: job.deducted
    });
    return true;
  } catch (e) {
    if (job.ac.signal.aborted) {
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
      return true;
    }
    logger.error('transform.blog_fallback_failed', { jobId: job.id, uid: job.uid, mode: job.mode, err: e });
    return false;
  }
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
    job.stage = isQualityPatternLab ? '관리자 테스트 · 한국어 품질 패턴 엔진 v1'
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
    const gptTestCfg = job.gptModel
      ? { ...runtimeCfg, models: { ...(runtimeCfg.models || {}), humanizePrimary: job.gptModel } }
      : runtimeCfg;
    const labCall = activeGpt
      ? (opts) => gptAnalyze.callGpt({ ...opts, config: activeGpt })
      : analyze.callClaude;
    const labExtract = activeGpt ? gptAnalyze.extractGptResult : analyze.extractClaudeResult;
    let baselineOut = null;

    const out = isQualityPatternLab
      ? await runAdminGptLabWithOptionalNiklCompare({
        job,
        text,
        mode: tonePolish ? 'polish' : engineMode,
        lang: job.lang || 'ko',
        evidence,
        config: gptTestCfg,
        styleProfile: 'ko_quality_pattern_lab',
        baselineStyleProfile: 'admin_gpt_engine',
        testStyleProfile: 'ko_quality_pattern_lab',
        label: '한국어 품질 패턴 엔진 v1',
        forceCompare: true,
        qualityPatternLab: true,
        setBaseline: out => { baselineOut = out; }
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
      ? await require(isV6 ? '../engine/humanizeV6TestEngine' : '../engine/humanizeLabTestEngine').run({
        text,
        mode: isV6 ? (job.mode || engineMode) : engineMode,
        lang: job.lang || 'ko',
        signal: job.ac.signal,
        userNotes: job.memo || '',
        evidence: evidence || '',
        callClaude: labCall,
        extractClaudeResult: labExtract
      })
      : activeGpt
      ? await runAdminGptLabWithOptionalNiklCompare({
        job,
        text,
        mode: engineMode,
        lang: job.lang || 'ko',
        evidence,
        config: activeGpt,
        styleProfile: profile,
        label: profile,
        setBaseline: out => { baselineOut = out; }
      })
      : await analyze.runHumanizeChunked({
        text, mode: engineMode, lang: job.lang || 'ko', signal: job.ac.signal,
        floorV2: true, optIn: false, judge: false, grounding: false,
        userNotes: job.memo || '', evidence: evidence || '', tonePolish, styleProfile: profile
      });
    if (out.floorReport && out.floorReport.status === 'blocked') {
      const gates = (out.floorReport.criticals || []).map(c => c.gate);
      if (!softenBlockedFloorReport(out, 'transform.admin_humanize_lab_blocked_soft_delivered', { jobId: job.id, uid: job.uid, profile })) {
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
      qualityPatternCompare: baselineOut ? buildAdminLabQualityPatternCompare(baselineOut, out) : null,
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
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
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

async function runAdminGptLabWithOptionalNiklCompare({
  job,
  text,
  mode,
  lang,
  evidence,
  config,
  styleProfile,
  baselineStyleProfile,
  testStyleProfile,
  label,
  forceCompare = false,
  qualityPatternLab = false,
  setBaseline
}) {
  const layoutNlpTest = job.layoutNlpTest === true;
  const common = {
    text,
    mode,
    lang,
    signal: job.ac.signal,
    userNotes: job.memo || '',
    evidence: evidence || '',
    layoutNlp: layoutNlpTest ? false : null,
    config,
    documentProfileOverride: job.documentProfileOverride || '',
    allowPolish: humanizeV2Enabled() && mode === 'polish',
    uid: humanizeV2Enabled() ? job.uid : ''
  };
  const baseProfile = baselineStyleProfile || styleProfile;
  const onProfile = testStyleProfile || styleProfile;
  const shouldCompare = forceCompare === true || qualityPatternLab === true || job.niklQualityTest === true || layoutNlpTest;
  if (!shouldCompare) {
    return await gptAnalyze.runHumanizeChunked({ ...common, styleProfile: baseProfile, niklQualityTest: false, qualityPatternLab: false });
  }

  job.stage = `관리자 테스트 · ${label || 'GPT'} · 기준 결과 생성 중`;
  persistJob(job);
  const baseline = await gptAnalyze.runHumanizeChunked({ ...common, styleProfile: baseProfile, niklQualityTest: false, qualityPatternLab: false });
  if (typeof setBaseline === 'function') setBaseline(baseline);

  let testText = text;
  let preLayout = null;
  if (layoutNlpTest) {
    job.stage = `관리자 테스트 · ${label || 'GPT'} · 문서 형태 입력 복원 중`;
    persistJob(job);
    preLayout = await layoutNormalizer.formatDocument(text, {
      mode,
      phase: 'pre',
      enableNlp: true,
      timeoutMs: Number(process.env.LAYOUT_NLP_TIMEOUT_MS || 5000) || 5000
    });
    testText = preLayout.text || text;
  }

  job.stage = layoutNlpTest
    ? `관리자 테스트 · ${label || 'GPT'} · 레이아웃 NLP 결과 생성 중`
    : qualityPatternLab
    ? `관리자 테스트 · ${label || 'GPT'} · 품질 패턴 v1 결과 생성 중`
    : `관리자 테스트 · ${label || 'GPT'} · 국어원식 품질 테스트 결과 생성 중`;
  persistJob(job);
  const testOut = await gptAnalyze.runHumanizeChunked({
    ...common,
    text: testText,
    styleProfile: onProfile,
    niklQualityTest: true,
    qualityPatternLab: qualityPatternLab === true
  });
  if (layoutNlpTest && testOut?.result?.outputText) {
    job.stage = `관리자 테스트 · ${label || 'GPT'} · 문서 형태 출력 후처리 중`;
    persistJob(job);
    const postLayout = await layoutNormalizer.formatDocument(testOut.result.outputText, {
      mode,
      phase: 'post',
      enableNlp: true,
      timeoutMs: Number(process.env.LAYOUT_NLP_TIMEOUT_MS || 5000) || 5000
    });
    testOut.result.outputText = postLayout.text || testOut.result.outputText;
    testOut.result.layoutFormat = {
      enabled: true,
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

function buildAdminLabQualityPatternCompare(baselineOut, testOut) {
  const base = buildAdminLabNiklCompare(baselineOut, testOut);
  const result = testOut?.result || {};
  const delta = result.patternDelta || {};
  const audit = result.auditTrail || {};
  const protectedReport = result.protectedTermReport || {};
  const grammar = result.grammarHardError || {};
  const rhetoric = result.rhetoricalInsertion || {};
  const claim = result.claimStrengthDrift || {};
  return {
    ...base,
    compareType: 'quality_pattern_lab',
    labels: {
      baseline: '현재 GPT',
      test: '품질 패턴 v1'
    },
    qualityPattern: {
      enabled: true,
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
    persistJob(job);   // 승인 재개(awaiting→running) 전이 포함

    if (isAdminHumanizeLabJob(job) && (job.mode !== 'formal' || isFundamentalEngineJob(job) || isV6EngineJob(job) || isGptEngineJob(job) || isKoQualityPatternLabJob(job))) {
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

    // v2는 요청 모드와 원문 프로필을 한 엔진에서 분리 판정한다. formal도 동일 파이프라인으로 보낸다.
    if (humanizeV2Enabled()) {
      return await runHumanizeJob(job, text, evidence || '');
    }

    // ★ 재구성 부적합 사전 차단(2026-06-16, API 낭비 0): 자소서·생기부·탐구문이나 짧고 추상적인 글은
    //   재구성에 넣으면 LLM이 원문에 없는 사실·평가를 지어내(added_claim) 거의 확정 차단된다. ledger·슬롯·
    //   judge로 수십 번 호출을 태우기 '전에' 결정론으로 걸러 보존형으로 유도한다. 사유를 명확히 노출(무차감).
    {
      let ir = {};
      try { ir = require('../engine/surfaceguard').classifyInputRisk(text); } catch { /* 진단 실패해도 차단 판정은 진행 */ }
      const ru = inputrouting.restructureUnfit(text, ir);
      if (ru.unfit) {
        logger.warn('transform.restructure_unfit_preblock', { jobId: job.id, uid: job.uid, kind: ru.kind, textLength: (text || '').length });
        job.status = 'blocked';
        job.gates = ['restructure_unfit'];
        job.stage = blockedStage(job.gates);
        job.gateDetail = { kind: ru.kind };
        job.note = ru.reason;
        job.blockOffer = buildBlockOffer(job, text);
        persistJob(job);
        return;   // genreTransferV2 호출 안 함 → 생성 API 0
      }
    }
    // ★ 자동 코칭(2026-06-18): 사용자가 메모를 직접 안 쓰는 채택 문제 → '자동 코칭' ON이면 시작 시 1회 글에서
    //   입장(관점)을 도출해 userNotes(job.memo)에 자동 합류. 입장은 글 자체 논리의 1인칭화라 무날조(경험은
    //   자동 적용 안 함 — 안 겪은 경험 자동 주입은 날조). 효과: 비인칭·무견해 신호를 사용자 시각으로 덮어
    //   탐지율 '인하 확률↑'(확정 아님 — 추상글 변동 큼). 부적합 차단 '뒤'에 둬 차단될 글엔 호출 0.
    if (job.autoCoach) {
      try {
        const { generateCoach } = require('../lib/coachsuggest');
        const coach = await generateCoach(text, { signal: job.ac.signal });
        const stanceLines = (coach.stances || []).map(s => s.text).filter(Boolean);
        if (stanceLines.length) {
          job.memo = [job.memo, ...stanceLines].filter(Boolean).join('\n').slice(0, 2000);
          job.autoCoachApplied = stanceLines.length;
          persistJob(job);
          logger.info('transform.auto_coach_applied', { jobId: job.id, uid: job.uid, stances: stanceLines.length });
        }
      } catch (e) { logger.warn('transform.auto_coach_failed', { jobId: job.id, err: e && e.message }); }
    }
    // ★ 장문 논문 라우팅(2026-06-16 실측 zoz040224: 26,934자 논문이 단일패스 재구성에서 요약 collapse 29%·8%로 차단).
    //   단일 genreTransferV2 대신 '청크 기반 격식 회피'로 보낸다 — 우회(피하기)는 유지하되 문단별이라 접힘이 없다.
    if (inputrouting.isLongStructuredThesis(text) || inputrouting.isAcademicCited(text) || inputrouting.isFootnoteCited(text)) {
      return await runLongThesisChunked(job, text, evidence);
    }
    // ★ 과제 보고서 구조 보존(2026-07-02): Ⅰ.서론/Ⅱ.본론/Ⅲ.결론 같은 짧은 과제 보고서는 통계가 적으면
    //   isStructuredReport에 안 걸려 단일 genreTransferV2로 들어가고, 그 결과 칼럼형 문체로 바뀐다.
    //   명시적 보고서 섹션 구조는 내용보다 형식이 과제 완성도에 중요하므로 문단별 구조보존 고급 경로로 보낸다.
    if (process.env.SECTIONED_REPORT_CHUNK !== '0' && inputrouting.isSectionedAssignmentReport(text)) {
      logger.info('transform.sectioned_report_chunk', { jobId: job.id, uid: job.uid, textLength: (text || '').length });
      job.note = (job.note ? job.note + ' ' : '') + '서론·본론·결론 구조가 있는 과제 보고서라, 칼럼형 재구성 대신 구조를 보존하며 문단별로 고급 처리했어요.';
      return await runLongThesisChunked(job, text, evidence, 'production_formal_sectioned_report_pipeline');
    }
    // ★ 구조화 통계 보고서 라우팅(2026-06-18 실측 사이버불링 보고서: 원문 48% → 단일 재구성이 목차·섹션을 부수고
    //   줄글로 만들어 "간접화법·비인칭"이 글 전체를 덮음 → 93%·100%로 악화). 구조(목차·번호섹션)·통계가 점수를
    //   지켜주던 글이라, 구조를 깨는 단일 재구성 대신 구조보존 청크 우회(runLongThesisChunked: 목차·문단 보존 +
    //   문단별 우회)로 보낸다. isLongStructuredThesis의 단문판(14k 미만 사각지대). 끄려면 STRUCTURED_REPORT_CHUNK=0.
    if (process.env.STRUCTURED_REPORT_CHUNK !== '0' && inputrouting.isStructuredReport(text)) {
      logger.info('transform.structured_report_chunk', { jobId: job.id, uid: job.uid, textLength: (text || '').length });
      job.note = (job.note ? job.note + ' ' : '') + '목차·통계가 있는 구조화 보고서라, 구조를 깨는 재구성 대신 구조를 보존하며 문단별로 우회했어요.';
      return await runLongThesisChunked(job, text, evidence);
    }
    if (await activeGptConfig()) {
      logger.info('transform.gpt_prod_formal_chunk', { jobId: job.id, uid: job.uid, textLength: (text || '').length });
      return await runLongThesisChunked(job, text, evidence, 'production_formal_gpt_prod_pipeline');
    }
    // 클라이언트 disconnect로는 안 죽는다(job 방식) — 단 명시적 취소(/cancel)의 AbortController만 전달.
    const out = await claudeGenreTransferV2()(text, { evidence: evidence || '', userNotes: job.memo || '', lengthMode: job.lengthMode || 'keep', signal: job.ac.signal });
    const gates = [];
    if (out.novelty?.count) gates.push('novelty');
    // ★ B(2026-06-15 사장님 결정 "동작은 해야"): 원문 보존 게이트는 기본 소프트 처리한다.
    //   lostFacts·novelty·judge·evidence_pairing은 결과 전달+경고로 낮추고, 치명 출력만 차단한다.
    if (out.pairing?.length) gates.push('evidence_pairing');
    if (out.judge && out.judge.pass === false) gates.push('semanticJudge');
    if (gates.length) {
      // 차단 상세를 남긴다 — "왜 막혔는지" 없는 차단은 진단 불가(2753자 글 연속 차단 실사고).
      const gateDetail = {
        novelty: (out.novelty?.items || []).slice(0, 5),
        lostFacts: (out.lostFacts?.items || []).slice(0, 8),
        pairing: (out.pairing || []).slice(0, 3).map(p => `${p.num}↛${(p.owner || '').slice(0, 40)}`),
        judge: (out.judge?.violations || []).slice(0, 5).map(v => `[${v.type}] "${(v.span || '').slice(0, 70)}" — ${(v.detail || '').slice(0, 100)}`)
      };
      logger.warn('transform.blocked', {
        jobId: job.id,
        uid: job.uid,
        mode: job.mode,
        gates,
        gateDetail
      });

      // ★ 재구성 자동 복구(2026-06-16, 청크 회피): 단일패스 genreTransferV2가 원문을 부풀리며(실측 영화평 151%·
      //   주거보고서 84%) 원문에 없는 평가·주장을 합성해 semanticJudge·novelty로 막히던 글(영화평·문학비평·
      //   미래설계 보고서 등)을, 문단별로 충실히 재작성하는 청크 회피로 자동 복구한다. 우회(피하기)는 유지하되
      //   합성 주장은 생기지 않는다(두 경로 실측: genreTransferV2 차단 vs 청크 clean 통과 97%/102%). 통계 삽입
      //   placeholder 같은 날조 유발 문단은 청크별 FLOOR가 원문으로 되돌려(raw 폴백) 안전. 청크 경로도 막히면
      //   거기서 정상 차단·보존형 제안으로 넘어간다(중복 호출 없음 — 막다른 길이 아니라 한 번의 복구).
      //   끄려면 env RESTRUCTURE_CHUNK_RECOVERY=0.
      if (process.env.RESTRUCTURE_CHUNK_RECOVERY !== '0') {
        logger.info('transform.restructure_chunk_recovery', { jobId: job.id, uid: job.uid, fromGates: gates });
        return await runLongThesisChunked(job, text, evidence);
      }

      if (hasStrictDeliveryGate(gates)) {
        job.status = 'blocked';
        job.stage = blockedStage(gates);
        job.gates = gates;
        job.gateDetail = gateDetail;
        job.blockOffer = buildBlockOffer(job, text);
        persistJob(job);
        return;
      }
      logger.warn('transform.gates_soft_delivered', { jobId: job.id, uid: job.uid, mode: job.mode, gates, gateDetail });
      job.note = (job.note ? job.note + ' ' : '') + '원문 보존 게이트 경고가 있었지만 결과를 우선 전달했어요. 업로드 전 원문과 한 번 대조해 주세요.';
    }
    // ★ 붕괴 보류(2026-06-16): 분량이 원문 30% 미만으로 줄어도 기본은 결과 전달+경고.
    //   빈 결과·프롬프트 누출·인코딩 깨짐·문장 절단처럼 치명 출력일 때만 차단한다.
    if ((out.lenRatio || 0) > 0 && out.lenRatio < 0.30) {
      const gates2 = ['length_collapse'];
      logger.warn('transform.collapsed_too_short', { jobId: job.id, uid: job.uid, mode: job.mode, lenRatio: out.lenRatio, lostCount: out.lostFacts?.count || 0 });
      // ★ 붕괴도 청크 회피로 복구(문단별이라 요약 collapse가 구조적으로 없음). 끄려면 RESTRUCTURE_CHUNK_RECOVERY=0.
      if (process.env.RESTRUCTURE_CHUNK_RECOVERY !== '0') {
        logger.info('transform.restructure_chunk_recovery', { jobId: job.id, uid: job.uid, fromGates: gates2 });
        return await runLongThesisChunked(job, text, evidence);
      }
      if (hasStrictDeliveryGate(gates2)) {
        job.status = 'blocked';
        job.stage = blockedStage(gates2);
        job.gates = gates2;
        job.gateDetail = { lenRatio: Math.round((out.lenRatio || 0) * 100), lostFacts: (out.lostFacts?.items || []).slice(0, 8) };
        job.blockOffer = buildBlockOffer(job, text);
        persistJob(job);
        return;
      }
      job.note = (job.note ? job.note + ' ' : '') + `결과 분량이 원문보다 많이 줄었을 수 있어요(${Math.round((out.lenRatio || 0) * 100)}%). 원문과 대조해 주세요.`;
    }
    // ★ 날조 재수정(2026-06-17, #56·#16·#47): genreTransferV2가 원문에 없던 인용·통계·연도를 지어내도 게이트가
    //   놓친다 — genreTransferV2 내부 novelty는 자기 생성 ledger에 오염돼 0을 내지만, 원문 대비 신선 측정은
    //   정확하다(실측 #56=19·#16=15·#47=11 신규 엔티티, 나머지 100건 전부 ≤1 → 깨끗한 분리). 차단 대신 청크
    //   회피(문단별 충실 재작성, 실측 97%·날조 0)로 다시 만들어 전달한다. 신호: 신규 연도·수치·기관 ≥5 또는
    //   원문에 없는 학술인용 표지 ≥2(전체 100건 오탐 0). 끄려면 RESTRUCTURE_CHUNK_RECOVERY=0.
    if (process.env.RESTRUCTURE_CHUNK_RECOVERY !== '0') {
      const gtOut = out.text || '';   // ★ genreTransferV2는 {text:…} 반환(outputText 아님 — 2026-06-17 버그픽스: 잘못된 필드로 감지 무동작이었음)
      const fabCount = inputrouting.countFabricatedCitations(text, gtOut);
      const novCount = require('../engine/floor').measureNovelty(text, gtOut, '').count;
      const repMax = inputrouting.maxNamedRepeat(text, gtOut);   // 고유명사 과반복(#86)
      // ★ 과확장(2026-06-17 실측: genreTransferV2가 인용 없이도 263%까지 부풀림 — 정상 윤문은 ≤1.3). 날조든
      //   과확장이든 충실도 사고이므로 청크 회피로 재수정한다. 임계 1.5(정상 윤문 130% 위로 충분히 떨어짐).
      const overExpand = (out.lenRatio || 0) > 1.5;
      if (novCount >= 5 || fabCount >= 2 || repMax >= 5 || overExpand) {
        logger.warn('transform.fabrication_rerun', { jobId: job.id, uid: job.uid, novCount, fabCount, repMax, lenRatio: out.lenRatio });
        return await runLongThesisChunked(job, text, evidence);
      }
    }
    // ★ 완료 시 차감 — 실패·차단 경로는 여기 도달하지 않으므로 결과 없는 차감이 구조적으로 불가능.
    //   멱등 키로 job.id를 넘겨 재시작·재시도 중복 차감까지 차단(job.deducted 플래그 + 이중 안전).
    try {
      await commitJobBilling(job, {
        creditAmount: job.needed,
        operation: 'restructure',
        mode: 'formal',
        textLength: text.length,
        meta: { evidence: !!job.wantEvidence }
      });
    } catch (e) {
      // 차감 실패(그 사이 잔액 소진 등) — 결과는 이미 만들어졌으니 사용자에겐 전달(고객 우선), 수동 보정 로그.
      logger.error('transform.billing_failed_manual_action', {
        jobId: job.id,
        uid: job.uid,
        needed: job.needed,
        billingMode: job.billingMode,
        opType: 'restructure',
        err: e
      });
    }
    // 근거 일부 미반영(소프트 — 차단 아님): 승인 근거가 본문에 다 녹지 못한 경우 투명하게 안내.
    if (out.evidenceLost && out.evidenceLost.count > 0) {
      job.note = (job.note ? job.note + ' ' : '') + '승인하신 근거 중 일부는 본문에 자연스럽게 들어가지 않아 제외됐어요(반영된 근거만 사용).';
    }
    // ★ B: 원문 사실 누락도 소프트 — 차단 대신 결과 전달 + 경고(사용자가 연도·수치·기관명을 원문과 대조하도록).
    const lostN = out.lostFacts?.count || 0;
    if (lostN > 0) {
      logger.warn('transform.lostfacts_soft_delivered', { jobId: job.id, uid: job.uid, mode: job.mode, lostCount: lostN, items: (out.lostFacts?.items || []).slice(0, 12) });
      job.note = (job.note ? job.note + ' ' : '') + `원문의 사실 ${lostN}건(연도·수치·기관명 등)이 재구성 과정에서 빠졌을 수 있어요. 결과를 원문과 한 번 대조해 확인해 주세요.`;
    }
    job.status = 'done';
    job.result = attachAdminLabResultMeta(job, {
      outputText: out.text,
      metrics: {
        novelty: 0, lostFacts: lostN, repetition: 0,
        judge: out.judge?.error ? 'skip' : 'pass',
        lengthRatio: out.lenRatio,
        evidenceUsed: job.approvedCount || 0,
        evidenceUnwoven: out.evidenceLost ? out.evidenceLost.count : 0,
        pairingClean: true   // 게이트 통과 시점 = 수치-출처 짝 위반 0
      },
      genreRisk: out.risk?.score,
      skeleton: out.skeleton
    }, 'production_formal_pipeline');
    persistJob(job);
    if (!job.adminHumanizeLab) saveJobHistory(job, text, out.text);   // 이용 기록(서버)에도 노출 — 완료 화면을 못 봐도 결과 복원 가능
    if (job.adminHumanizeLab) {
      logger.info('transform.admin_humanize_lab_done', {
        jobId: job.id,
        uid: job.uid,
        mode: job.mode,
        profile: job.adminLabProfile || adminLabProfileOf(job),
        path: 'production_formal_pipeline',
        skeleton: out.skeleton,
        deducted: job.deducted
      });
    }
    logger.info('transform.done', {
      jobId: job.id,
      uid: job.uid,
      mode: job.mode,
      needed: job.needed,
      deducted: job.deducted,
      skeleton: out.skeleton,
      genreRisk: out.risk?.score
    });
  } catch (e) {
    if (job.ac.signal.aborted) {
      // shutdown이 이미 error(서버 재시작 안내)로 표시한 job을 "사용자 취소"로 덮어쓰면 안 됨 — abort 출처 구분.
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
      return;
    }
    logger.error('transform.failed', { jobId: job.id, uid: job.uid, mode: job.mode, err: e });
    job.status = 'error';
    job.error = '재구성 처리 중 오류가 발생했어요. 크레딧은 차감되지 않았어요.';
    persistJob(job);
  } finally {
    scheduleQueueDrain();
  }
}

// ── 장문 논문 재구성(2026-06-16): 26,934자 논문이 단일패스 genreTransferV2에서 요약 collapse(29%·8%)로 차단되던 사고.
//   해결: 단일 재구성 대신 '청크 기반 격식 회피'(runHumanizeChunked mode=assignment, tonePolish=false). 효과 ①우회(피하기)
//   유지(보존형 polish와 달리 tonePolish=false라 burstiness·grounding·register 우회 적용) ②문단별이라 요약 collapse 없음
//   ③청크별 lostFacts/novelty 게이트로 사실 보존. 과금은 재구성(formal) 단가 그대로(피하기 결과를 받으므로).
async function runLongThesisChunked(job, text, evidence, pipelinePath = 'production_formal_chunk_pipeline') {
  try {
    job.status = 'running';
    job.stage = '문단별 안전 재작성 중';   // 장문 논문·학술·재구성 복구 공용(특정 종류 단정 안 함)
    persistJob(job);
    // ★ 학술 동결 블록 분리(2026-06-19 #43): 참고문헌·목차는 윤문 대상이 아니라 데이터다. 본문에서 떼어 verbatim
    //   보존하고 본문만 우회한다(저자명 의역·절번호 붕괴 방지). 동결 없으면 통째 우회(기존과 동일).
    const freeze = require('../engine/freezeblocks');
    const fb = freeze.splitAcademicBlocks(text);   // 참고문헌 리스트·목차 동결(verbatim 보존) — 본문만 우회
    if (fb.hasFrozen) logger.info('transform.academic_freeze', { jobId: job.id, uid: job.uid, hasToc: !!fb.toc, refsLen: fb.refs.length });
    // ※ 본문 인라인 다저자 인용 박제는 보류: 플레이스홀더를 LLM이 일부 떨어뜨려(2/7) 인용 유실+floor 차단 위험(2026-06-19 실측).
    //   canonical 참고문헌 리스트는 위 split으로 안전 보존되므로, 본문 인라인 인용은 충실 재작성에 맡긴다(저우선 잔여).
    const gptCfg = await activeGptConfig();
    const out = gptCfg
      ? await gptAnalyze.runHumanizeChunked({
          text: fb.body,
          mode: 'assignment',
          lang: job.lang || 'ko',
          signal: job.ac.signal,
          userNotes: job.memo || '',
          evidence: evidence || '',
          config: gptCfg,
          styleProfile: 'production_long_chunk',
          documentProfileOverride: job.documentProfileOverride || '',
          uid: humanizeV2Enabled() ? job.uid : ''
        })
      : await analyze.runHumanizeChunked({
          text: fb.body, mode: 'assignment', lang: job.lang || 'ko', signal: job.ac.signal,
          floorV2: true, optIn: false, judge: true, grounding: true,
          userNotes: job.memo || '', evidence: evidence || '', tonePolish: false   // ★ tonePolish=false = 우회(피하기) 유지
        });
    if (out.floorReport && out.floorReport.status === 'blocked') {
      const gates = (out.floorReport.criticals || []).map(c => c.gate);
      if (softenBlockedFloorReport(out, 'transform.long_thesis_blocked_soft_delivered', { jobId: job.id, uid: job.uid, gates, chunkCount: out.chunkCount })) {
        job.note = (job.note ? job.note + ' ' : '') + '품질 게이트 경고가 있었지만 결과를 우선 전달했어요. 업로드 전 원문과 한 번 대조해 주세요.';
      } else {
      // ★ semanticJudge 소프트화(2026-06-16, zoz040224 26K 학술논문 실측): 청크 회피는 문단별 grounded 재작성이라
      //   added_claim이 남아도 대개 해석·평가 표현이다. 장문·학술글이 1~2건의
      //   added_claim으로 통째 차단되면 결과를 못 받는다. 기본은 전달 + 원문대조 경고이며,
      //   프롬프트 누출·빈 결과 같은 치명 출력만 차단한다. 끄려면 RESTRUCTURE_JUDGE_SOFT=0.
      const SOFTABLE = new Set(['semanticJudge', 'repetition']);
      const judgeCount = (out.result?.judge?.violations || []).length;
      const softMax = Number(process.env.RESTRUCTURE_JUDGE_SOFT_MAX || 2);
      const judgeSoftOK = process.env.RESTRUCTURE_JUDGE_SOFT !== '0'
        && gates.length > 0 && gates.every(g => SOFTABLE.has(g)) && judgeCount <= softMax;
      if (!judgeSoftOK) {
        logger.warn('transform.long_thesis_blocked', { jobId: job.id, uid: job.uid, gates, judgeCount, chunkCount: out.chunkCount });
        job.status = 'blocked';
        job.gates = gates;
        job.gateDetail = { criticals: (out.floorReport.criticals || []).slice(0, 8) };
        job.stage = blockedStage(gates);
        job.blockOffer = buildBlockOffer(job, text);
        persistJob(job);
        return;
      }
      // semanticJudge 소수만 차단 사유 → 전달(아래로 진행) + 원문 대조 경고.
      logger.info('transform.long_thesis_judge_soft_delivered', { jobId: job.id, uid: job.uid, judgeCount, gates, chunkCount: out.chunkCount });
      job.note = (job.note ? job.note + ' ' : '') + `원문에 없던 해석·평가 표현이 일부(${judgeCount}건) 섞였을 수 있어요. 결과를 원문과 한 번 대조해 주세요.`;
      }
    }
    if (!out.result || !out.result.outputText) throw new Error('long_thesis_incomplete');
    // ★ 동결 블록(참고문헌 리스트·목차) 재조립 — 우회된 본문 앞뒤로 verbatim 복원.
    const finalText = fb.hasFrozen ? freeze.reassembleAcademic(fb, out.result.outputText) : out.result.outputText;
    // 과금: 재구성(formal) 단가 그대로. 멱등 키 동일(job_<id>) — 재시작·재시도 중복 차감 불가.
    try {
      await commitJobBilling(job, {
        creditAmount: job.needed,
        operation: 'restructure',
        mode: 'formal',
        textLength: text.length,
        meta: { longThesis: true }
      });
    } catch (e) {
      logger.error('transform.long_thesis_billing_failed_manual_action', {
        jobId: job.id, uid: job.uid, needed: job.needed, billingMode: job.billingMode, err: e
      });
    }
    if ((out.floorReport.warnings || []).some(w => w.gate === 'lostFacts')) {
      job.note = (job.note ? job.note + ' ' : '') + '원문의 사실 일부(연도·수치·기관명 등)가 재작성 과정에서 빠졌을 수 있어요. 결과를 원문과 한 번 대조해 주세요.';
    }
    job.status = 'done';
    job.result = attachAdminLabResultMeta(job, {
      outputText: finalText,
      longThesis: true,   // UI가 "장문 논문 안전 재작성" 배지를 띄울 수 있게
      floorReport: {
        status: out.floorReport.status,
        criticals: out.floorReport.criticals,
        warnings: (out.floorReport.warnings || []).map(w => w.gate),
        metrics: out.floorReport.metrics
      },
      metrics: out.floorReport.metrics,
      chunkCount: out.chunkCount,
      fallbackCount: out.fallbackCount
    }, pipelinePath);
    persistJob(job);
    if (!job.adminHumanizeLab) saveJobHistory(job, text, finalText);
    if (job.adminHumanizeLab) {
      logger.info('transform.admin_humanize_lab_done', {
        jobId: job.id,
        uid: job.uid,
        mode: job.mode,
        profile: job.adminLabProfile || adminLabProfileOf(job),
        path: pipelinePath,
        chunkCount: out.chunkCount,
        fallbackCount: out.fallbackCount,
        deducted: job.deducted
      });
    }
    logger.info('transform.long_thesis_done', { jobId: job.id, uid: job.uid, needed: job.needed, deducted: job.deducted, chunkCount: out.chunkCount, fallbackCount: out.fallbackCount, frozen: fb.hasFrozen || undefined, path: pipelinePath });
  } catch (e) {
    if (job.ac.signal.aborted) {
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
      return;
    }
    logger.error('transform.long_thesis_failed', { jobId: job.id, uid: job.uid, err: e });
    job.status = 'error';
    job.error = '장문 논문 처리 중 오류가 발생했어요. 크레딧은 차감되지 않았어요.';
    persistJob(job);
  } finally {
    scheduleQueueDrain();
  }
}

// ── short job 러너(2026-06-13): 직접 fetch였던 블로그 변환·다듬기를 job으로 — 새로고침·창닫기 생존.
//   엔진은 기존 floorV2 청크 경로(analyze.runHumanizeChunked) 그대로(blog→blog, polish→assignment 보존형),
//   차감·게이트 원칙은 formal과 동일.
async function runHumanizeJob(job, text, evidence = '') {
  try {
    job.status = 'running';
    job.stage = '문장 다듬는 중';
    persistJob(job);
    const isPolish = job.mode === 'polish';
    const v2Enabled = humanizeV2Enabled();
    // ★ 격식 하락 방지(2026-06-19 88건 감사: 하다체/합쇼체 보고서·탐구·과학·논술문이 기본 피하기→blog 해요체로
    //   변질 38건 "~거든요/~죠"). blog인데 원문이 격식체(handa/hap) 우세면 engine을 assignment로 돌린다 —
    //   register 보존 우회(blog와 동일하게 judge·grounding=우회 ON, tonePolish=false). 진짜 해요체(캐주얼) 원문만
    //   blog 유지. isFormalDocument가 못 잡는 탐구·과학·하다체 과제문을 register 신호로 보완. (사용자 의도=우회는 유지,
    //   제출 품질만 살림.) 끄려면 FORMAL_BLOG_GUARD=0.
    let engineMode = v2Enabled ? job.mode : (isPolish ? 'assignment' : 'blog');
    if (!v2Enabled && !isPolish && process.env.FORMAL_BLOG_GUARD !== '0') {
      const reg = require('../engine/surfaceguard').measureRegisterMix(text).dominant;
      if (reg === 'handa' || reg === 'hap') {
        engineMode = 'assignment';
        job.note = (job.note ? job.note + ' ' : '') + '원문이 격식체(보고서·과제체)라, 해요체로 바꾸지 않고 격식을 살려 우회했어요.';
        logger.info('transform.formal_blog_guard', { jobId: job.id, uid: job.uid, reg });
      }
    }
    // ★ 학술 동결 블록 보존(2026-06-20 #66: 기본 피하기가 참고문헌을 흡수·손실 "조푸른솔…2025,14-32" 소실).
    //   레거시·thesis 경로처럼 blog/polish 경로에도 참고문헌·목차를 verbatim 보존(본문만 우회 후 재조립). FREEZE_BLOCKS=0 해제.
    const freeze = require('../engine/freezeblocks');
    const fb = (!v2Enabled && process.env.FREEZE_BLOCKS !== '0') ? freeze.splitAcademicBlocks(text) : { hasFrozen: false };
    const bodyText = fb.hasFrozen ? fb.body : text;
    if (fb.hasFrozen) logger.info('transform.blog_academic_freeze', { jobId: job.id, uid: job.uid, hasToc: !!fb.toc, refsLen: (fb.refs || '').length });
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
    } else if (!v2Enabled && !isPolish && job.mode === 'blog' && job.basicStyle === 'report') {
      styleProfile = 'basic_report';
      if (job.basicExperiment) {
        job.basicExperiment = {
          ...job.basicExperiment,
          applied: true,
          appliedAtMs: Date.now()
        };
      }
      logger.info('transform.basic_style_profile_applied', { jobId: job.id, uid: job.uid, basicStyle: job.basicStyle, profile: styleProfile });
    } else if (!v2Enabled && !isPolish && job.mode === 'blog' && engineMode === 'blog') {
      styleProfile = 'basic_blog';
      logger.info('transform.basic_style_profile_applied', { jobId: job.id, uid: job.uid, basicStyle: job.basicStyle || 'blog', profile: styleProfile });
    }
    const gptCfg = await activeGptConfig();
    if (v2Enabled && !gptCfg) throw new Error('HUMANIZE_ENGINE_V2 requires activeProvider=gpt');
    const out = gptCfg
      ? await gptAnalyze.runHumanizeChunked({
          text: bodyText,
          mode: engineMode,
          lang: job.lang || 'ko',
          signal: job.ac.signal,
          userNotes: job.memo || '',
          evidence: evidence || '',
          config: gptCfg,
          styleProfile: styleProfile || 'production_transform_humanize',
          basicStyle: job.basicStyle || '',
          documentProfileOverride: job.documentProfileOverride || '',
          allowPolish: v2Enabled,
          // 원본 UID는 OpenAI 요청에 직접 전달되지 않는다. v2 엔진 내부에서만
          // OPENAI_SAFETY_SALT 기반 HMAC으로 변환하며, 레거시 롤백에는 넘기지 않는다.
          uid: v2Enabled ? job.uid : ''
        })
      : await analyze.runHumanizeChunked({
          text: bodyText, mode: engineMode, lang: job.lang || 'ko', signal: job.ac.signal,
          // 과제 어투 다듬기(polish)는 회피가 목적이 아니므로 의미 게이트(semanticJudge) 분리 → 차단 급감.
          //   사실 게이트(novelty·lostFacts)는 buildFloorReport가 잡되, 기본은 결과 전달+경고로 처리한다.
          //   tonePolish: 우회/캐주얼화 블록을 뺀 "보존 우선 + 최소 손질 + 격식 과제체" 프롬프트로 분기(재창작 방지).
          // ★ P1-5(2026-06-18 감사): polish(그대로 다듬기)는 최소 수정이 목적인데 grounding(추상 문장→선명한 판단문
          //   교체)이 켜져 기대보다 많이 바뀌었다. polish면 grounding off(보존 우선), 회피 경로(blog)에선 유지.
          floorV2: true, optIn: false, judge: !isPolish && !adminSafetyLab, grounding: !isPolish && !adminSafetyLab, userNotes: job.memo || '', tonePolish: isPolish, styleProfile
        });
    // FLOOR 게이트 = 기본은 결과 전달+경고. 치명 출력만 차단한다.
    if (out.floorReport && out.floorReport.status === 'blocked') {
      const gates = (out.floorReport.criticals || []).map(c => c.gate);
      const gateDetail = { criticals: (out.floorReport.criticals || []).slice(0, 8) };
      if (!v2Enabled && softenBlockedFloorReport(out, 'transform.humanize_blocked_soft_delivered', { jobId: job.id, uid: job.uid, mode: job.mode, gates })) {
        job.note = (job.note ? job.note + ' ' : '') + '품질 게이트 경고가 있었지만 결과를 우선 전달했어요. 업로드 전 원문과 한 번 대조해 주세요.';
      } else {
        job.engineMeta = out.engineMeta || out.result?.engineMeta || null;
        logger.warn('transform.humanize_blocked', {
          jobId: job.id,
          uid: job.uid,
          mode: job.mode,
          gates,
          gateDetail
        });
        // 기본 작업에만 동의 기반 다듬기 선택지를 붙인다. 고급은 같은
        // 강도로 다시 시도하며 보존형으로 다운그레이드하지 않는다.
        job.status = 'blocked';
        job.stage = blockedStage(gates);
        job.gates = gates;
        job.gateDetail = gateDetail;
        job.blockOffer = buildBlockOffer(job, text);
        persistJob(job);
        return;
      }
    }
    if (!out.result || !out.result.outputText) throw new Error('humanize_incomplete');
    // ★ 블로그 날조 인용 결정론 제거(2026-06-17, #99): blog는 더 깨끗한 재라우팅 경로가 없으니, 원문에 없는
    //   괄호형 인용/출처만 안전 제거(문장 안 깨짐). 인라인 외부사례는 격식문서 라우팅(고급)으로 처리. polish 제외.
    if (!v2Enabled && !isPolish) {
      const sc = inputrouting.stripFabricatedCitations(text, out.result.outputText);
      if (sc.removed) {
        out.result.outputText = sc.text;
        job.note = (job.note ? job.note + ' ' : '') + '원문에 없던 출처·인용 표기를 자동으로 정리했어요.';
        logger.info('transform.blog_fab_citation_stripped', { jobId: job.id, uid: job.uid, removed: sc.removed });
      }
    }
    try {
      job.billingDisposition = humanizeV2Enabled()
        ? await resolveBillingDisposition(job, out)
        : (await commitJobBilling(job, {
            creditAmount: job.needed,
            operation: job.mode === 'formal' ? 'restructure' : 'humanize',
            mode: job.mode || 'formal',
            textLength: (job.text || '').length
          }), job.deducted ? 'charged' : (job.plan === 'unlimited' ? 'plan_unlimited' : 'admin_no_charge'));
    } catch (e) {
      // 기존 호환대로 결과는 전달하되 deducted=false가 실제 미차감을 나타낸다.
      // disposition은 이 작업의 의도된 과금 경로를 유지해 운영 불일치를 찾게 한다.
      job.billingDisposition = 'charged';
      logger.error('transform.humanize_billing_failed_manual_action', {
        jobId: job.id,
        uid: job.uid,
        mode: job.mode,
        needed: job.needed,
        billingMode: job.billingMode,
        err: e
      });
    }
    // ★ no-op(약한 변환) 안내(2026-06-16 품질리포트): 결과가 원문과 거의 같으면 강도 상향 추천.
    //   ★polish(다듬기)는 보존이 목적이라 일반 약변환은 제외하지만, 내용이 거의 100% 동일(공백만)이면 안내
    //   (2026-06-22 #40/#47: 다듬기 무변환·재시도 동일출력·이중과금 — 같은 결과 재시도 낭비 방지 안내).
    if (out.result.weakTransform) {
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
    // ★ 동결 블록(참고문헌·목차) 재조립 — 우회된 본문 앞뒤로 verbatim 복원(#66 참고문헌 손실 방지).
    const finalText = fb.hasFrozen ? freeze.reassembleAcademic(fb, out.result.outputText) : out.result.outputText;
    const v2QualityStatus = out.qualityStatus || out.result.qualityStatus || 'clean';
    const v2QualityWarnings = out.qualityWarnings || out.result.qualityWarnings || [];
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
    job.status = 'done';
    job.result = {
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
      billingDisposition: job.billingDisposition,
      sourceReviewWarnings: out.sourceReviewWarnings || out.result.sourceReviewWarnings || [],
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
      basicBlogToneCleanup: out.result.basicBlogToneCleanup || null,
      flowCohesion: out.result.flowCohesion || null
    };
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
      if (job.status !== 'error') { job.status = 'cancelled'; job.stage = '중단됨'; persistJob(job); }
      return;
    }
    logger.error('transform.humanize_failed', { jobId: job.id, uid: job.uid, mode: job.mode, err: e });
    job.status = 'error';
    job.error = '처리 중 오류가 발생했어요. 크레딧은 차감되지 않았어요.';
    persistJob(job);
  } finally {
    scheduleQueueDrain();
  }
}

router.post('/transform', async (req, res) => {
  let { text } = req.body || {};
  // idToken은 Authorization 헤더 우선(헤더 미전환 구버전 클라이언트는 body/query 폴백) — 다른 라우트와 동일하게 단일화.
  // ★버그 수정(2026-06-19): A2 보안 마이그레이션 때 이 시작 핸들러만 body 직접 추출이 남아, FE가 body 토큰 전송을
  //   끊자(lav-138) 토큰이 undefined→precheck 401→로그인 리다이렉트로 휴머나이즈 시작이 전면 차단됐었다.
  const idToken = tokenFromReq(req);
  const billingMode = req.body?.billingMode === 'coupon' ? 'coupon' : 'credit';
  const requestedModeValue = req.body?.mode;
  const mode = ['blog', 'polish', 'formal'].includes(requestedModeValue) ? requestedModeValue : 'formal';
  const modeSource = ['blog', 'polish', 'formal'].includes(requestedModeValue) ? 'provided' : 'defaulted';
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
  const hardMax = billingMode === 'coupon' ? 50000 : 30000;
  if (text.length > hardMax) {
    return res.status(400).json({ error: `텍스트가 너무 깁니다. (최대 ${hardMax.toLocaleString()}자)` });
  }
  const devNoAuth = !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1';
  const adminLabRequested = req.body && req.body.adminHumanizeLab === true;
  const requestedAdminLabProfile = adminLabRequested ? normalizeAdminLabProfile(req.body && req.body.adminLabProfile) : null;
  let adminLabUid = null;
  if (adminLabRequested) {
    if (devNoAuth) {
      adminLabUid = 'dev-local';
    } else {
      adminLabUid = await verifyToken(idToken);
      if (!adminLabUid) return res.status(401).json({ error: '관리자 테스트는 로그인이 필요해요.' });
      if (!isAdminUid(adminLabUid)) return res.status(403).json({ error: '관리자만 사용할 수 있는 테스트 페이지입니다.' });
    }
  }
  // ★ 글자분리(PDF 추출 깨짐) 복원(2026-06-19 실측 #57·#58): 모든 글자가 공백 분리된 입력을 billing·엔진 처리 전에
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
      logger.warn('transform.duplicate_input_blocked', { mode, textLength: text.length, dupRatio: dup.ratio });
      return res.status(400).json({ error: `입력에 같은 내용이 반복돼 있어요(약 ${Math.round(dup.ratio * 100)}%). 중복된 부분을 빼고 다시 시도하면 크레딧도 절약돼요.` });
    }
  }
  // ★ 영어 글 사전 차단(2026-06-16, 임계값·안내 정정 2026-06-17): 피하기(기본 blog·고급 formal)는 한국어 전용
  //   엔진이라 영어를 넣으면 번역·변형으로 원문이 망가지고, '매끈하게' 다듬을수록 오히려 AI 패턴이 강해져
  //   카피킬러 0→100% 참사(실측). '돌리기 전에' 입력 단계에서 막는다. ※ 과거엔 "다듬기로 유도"였으나 다듬기도
  //   영어를 더 검출되게 만들어 잘못된 안내였음 — 메시지는 "영어 회피 불가·원문 유지"로 정정(ENGLISH_UNFIT_REASON).
  if (inputrouting.isEnglishInput(text)) {
    logger.warn('transform.english_input_blocked', { mode, textLength: text.length });
    return res.status(400).json({ error: '현재 휴머나이징 엔진은 한국어 글만 지원해요. 영어 입력은 원문 보존을 위해 변환하지 않습니다.' });
  }
  // ★ 격식문서 → 고급 안내(2026-06-17, #21·#83·#72·#90): 보고서·계약서·논문을 기본 피하기에 넣으면 구어체로
  //   변질된다. 입력 단계에서 고급 피하기로 유도(blog만, 무차감·무API). 다듬기·고급은 그대로 통과.
  if (!humanizeV2Enabled() && !adminLabUid && mode === 'blog' && inputrouting.isFormalDocument(text)) {
    logger.warn('transform.formal_doc_to_advanced', { mode, textLength: text.length });
    return res.status(400).json({ error: inputrouting.FORMAL_GUIDANCE_REASON, route: 'formal' });
  }
  // ★ 제출자 메타데이터 제거(2026-06-17, #97): "제출자: OO학부 20260423 변정빈" 머리말이 본문에 인용 저자처럼
  //   엮이던 사고 — 돌리기 전에 떼어낸다(본문 내용 불변, 무차감). 차단 아님.
  {
    const sm = inputrouting.stripSubmitterMeta(text);
    if (sm.changed) { logger.info('transform.submitter_meta_stripped', { mode, removed: sm.changed }); text = sm.text; }
  }
  const effectBasicStyle = mode === 'blog' ? normalizeBasicStyle(req.body?.basicStyle) : 'report';
  const effectAssessment = humanizeV2Enabled()
    ? assessEffectExpectation(text, mode, effectBasicStyle)
    : { effectExpectation: 'normal', effectNoticeCode: null, requiresEffectConfirmation: false };
  const effectNoticeAccepted = req.body?.effectNoticeAccepted === true;
  if (!adminLabUid
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
  if (draining) {
    return res.status(503).json({ error: '서버가 점검을 위해 재시작 중이에요. 1~2분 후 다시 시도해 주세요.' });
  }

  const wantEvidence = mode === 'formal' && req.body.evidence === true;   // 근거 보강은 formal 전용(UI 잠금과 일치)
  // 과금: 탐지 제외 짧은 기능(blog·polish)은 최소 10크레딧 + 100자당 2크레딧. formal은 길이 구간 정액.
  const creditNeeded = (mode === 'blog' || mode === 'polish')
    ? shortHumanizeCredit(text.length)
    : restructureCredit(text.length, wantEvidence);
  const needed = billingMode === 'coupon' ? 1 : creditNeeded;
  let pre;
  try {
    pre = adminLabUid
      ? { uid: adminLabUid, plan: 'unlimited' }
      : (devNoAuth
          ? { uid: 'dev-local', plan: 'unlimited' }
          : billingMode === 'coupon'
            ? await analyze.precheckCoupon(idToken, text.length)
            : await analyze.precheckCredits(idToken, needed));
  } catch (e) {
    logger.warn('transform.precheck_failed', { mode, needed, creditNeeded, billingMode, err: e });
    return res.status(e.status || 500).json({
      error: analyze.authErrorMessage(e.message),
      ...(e.charLimit !== undefined ? { charLimit: e.charLimit } : {})
    });
  }
  setLogContext({ uid: pre.uid });
  // 한도는 인증 후(uid 확정) 검사 — 비용 방어의 본체. 시작 성공 시에만 일일 카운트(formal만).
  const limited = adminLabUid ? null : checkLimits(pre.uid, mode);
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
  if (!adminLabUid && mode === 'formal') recordStart(pre.uid);
  const adminOrDev = adminLabUid || isAdminUid(pre.uid) || (devNoAuth && pre.uid === 'dev-local');
  const preserveExperimentRequested = adminLabRequested || (req.body && req.body.humanizeExperiment === true);
  const preserveExperimentEnabled = preserveExperimentRequested && !!adminOrDev;
  const legacyBasicExperimentRequested = mode === 'blog' && req.body && req.body.basicExperiment === true && !preserveExperimentRequested;
  const legacyBasicExperimentEnabled = legacyBasicExperimentRequested && !!adminOrDev;
  if ((preserveExperimentRequested || legacyBasicExperimentRequested) && !adminOrDev) {
    logger.warn('transform.humanize_experiment_ignored_non_admin', { uid: pre.uid, mode, adminLabRequested, preserveExperimentRequested, legacyBasicExperimentRequested });
  }
  const basicStyle = mode === 'blog'
    ? (legacyBasicExperimentEnabled ? 'report' : normalizeBasicStyle(req.body && req.body.basicStyle))
    : null;
  const adminLabVersion = requestedAdminLabProfile === 'v6_engine'
    ? 'humanizing-engine-v9-cksafe'
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
  } : (legacyBasicExperimentEnabled ? {
    enabled: true,
    requested: true,
    applied: false,
    version: 'basic-report-style-v1',
    profile: 'basic_report',
    source: 'admin_job_toggle_legacy'
  } : null);

  const id = crypto.randomBytes(8).toString('hex');
  const bare = text.replace(/\s+/g, '').length;
  const isShort = mode !== 'formal';
  // 고급은 실제 v2 실행 계획의 편집 청크 수로 범위를 산출한다. estSec는 기존
  // 클라이언트·대기열 호환을 위해 보수적인 상한을 계속 제공한다.
  const advancedTimeEstimate = !isShort && humanizeV2Enabled()
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
    uid: pre.uid,
    plan: pre.plan || (billingMode === 'coupon' ? `subscription:${pre.tier || 'unknown'}` : 'free'),
    needed,
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
    lang: humanizeV2Enabled() ? 'ko' : (req.body.lang === 'en' ? 'en' : 'ko'),
    lengthMode: req.body.length === 'compact' ? 'compact' : 'keep',   // 분량 옵션(재구성 전용) — 엔진 연결(2026-06-15). 기본 keep(유지)
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
  jobs.set(id, job);
  persistJob(job);
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
});

// 로컬 jobRef를 잃어도 서버에 남은 진행/승인대기 작업으로 복귀시키는 복구 엔드포인트.
router.get('/transform/active', async (req, res) => {
  const uid = await verifyToken(tokenFromReq(req));
  if (!uid) return res.status(401).json({ error: '로그인이 필요해요.' });
  setLogContext({ uid });
  const job = activeJobFor(uid);
  res.json({ ok: true, job: activeJobPayload(job) });
});

// ── 명시적 취소: 진행 중 LLM 호출을 abort — 차감은 완료 시에만 일어나므로 취소=항상 무과금.
router.post('/transform/:id/cancel', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요.' });
  if (!(await requireJobOwner(req, res, job))) return;
  if (job.status === 'done' || job.status === 'blocked' || job.status === 'error') {
    return res.status(409).json({ error: '이미 끝난 작업이에요.' });
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
  job.ac.abort();
  job.status = 'cancelled';
  job.stage = '중단됨';
  persistJob(job);
  scheduleQueueDrain();
  logger.info('transform.cancelled_by_user', { jobId: job.id, uid: job.uid, mode: job.mode });
  res.json({ ok: true });
});

// 기본 휴머나이징 차단 작업만 사용자의 명시적 동의로 다듬기 처리한다.
// 고급 작업은 이 경로로 강도를 낮출 수 없다.
router.post('/transform/:id/accept-fallback', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요.' });
  if (!(await requireJobOwner(req, res, job))) return;
  if (job.status !== 'blocked') return res.status(409).json({ error: '차단된 작업만 보존형으로 받을 수 있어요.' });
  if (!preservationFallbackAllowed(job.mode)) return res.status(409).json({ error: '고급 작업은 보존형으로 전환하지 않아요. 고급 설정으로 다시 시도해 주세요.' });
  // ★ 크레딧 사전 검증(2026-06-16): 보존형 받기도 과금 작업이다 — 잔액이 부족하면 작업을 '돌리기 전에' 막는다.
  //   기존엔 precheck 없이 백그라운드로 돌려, 작업이 끝난 뒤 차감이 실패해도(잔액 0) 결과를 전달했다(무상 제공 구멍).
  //   재시도 버튼(POST /transform)은 이미 precheckCredits로 막히는데 이 버튼만 빠져 있어 동작이 불일치했다.
  const fbNeeded = preservationFallbackCredit((job.text || '').length);
  if (!job.devNoAuth) {
    try {
      await precheckExistingJobBilling(job, tokenFromReq(req), fbNeeded, (job.text || '').length);
    } catch (e) {
      const status = e.status || 402;
      return res.status(status).json({
        error: status === 402 && job.billingMode !== 'coupon'
          ? `보존형으로 받으려면 ${fbNeeded}크레딧이 필요해요. 크레딧이 부족해 충전 후 다시 시도해 주세요.`
          : analyze.authErrorMessage(e.message),
        needed: job.billingMode === 'coupon' ? 1 : fbNeeded,
        billingMode: job.billingMode === 'coupon' ? 'coupon' : 'credit'
      });
    }
  }
  res.json({ ok: true });   // 즉시 응답 — 보존형 재처리는 백그라운드, 프론트는 폴링으로 done 수신.
  job.status = 'running';
  job.stage = '원문 보존형으로 재처리 중';
  job.blockOffer = null;
  job.startedAt = Date.now();        // 새 시작점 — 30초 취소 창이 이 보존형 재처리 기준으로 적용되게.
  job.ac = new AbortController();     // 차단 시 abort된 컨트롤러 교체
  persistJob(job);
  try {
    const handled = await tryBlogPreservationFallback(job, job.text || '');
    if (!handled && job.status !== 'cancelled') {   // 보존형도 치명 출력이면 다시 차단
      job.status = 'blocked';
      job.stage = blockedStage(job.gates || []);
      job.blockOffer = buildBlockOffer(job, job.text || '');
      persistJob(job);
    }
  } catch (e) {
    logger.error('transform.accept_fallback_failed', { jobId: job.id, uid: job.uid, mode: job.mode, err: e });
    if (job.status !== 'done' && job.status !== 'cancelled') {
      job.status = 'blocked';
      job.blockOffer = buildBlockOffer(job, job.text || '');
      persistJob(job);
    }
  }
  scheduleQueueDrain();
});

// ── P4: 근거 승인 — 승인된 후보만 evidence로 재구성 재개. "미승인은 엔진이 차단"의 구현부:
//   엔진에 전달되는 허용 세계 자체가 승인 목록뿐이므로 미승인 사실은 novelty 게이트가 자동 차단.
router.post('/transform/:id/approve', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없어요. (만료되었거나 서버가 재시작됨)' });
  if (!(await requireJobOwner(req, res, job))) return;
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
  persistJob(job);
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

router.get('/transform/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
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
    status: job.status,
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
    ...queueDetails(job),
    ...(job.note ? { note: job.note } : {})
  };
  if (job.status === 'done') return res.json({
    ...base,
    qualityStatus: job.result?.qualityStatus,
    billingDisposition: job.result?.billingDisposition || job.billingDisposition || null,
    qualityWarnings: job.result?.qualityWarnings,
    sourceReviewWarnings: job.result?.sourceReviewWarnings,
    engineMeta: job.result?.engineMeta,
    result: job.result
  });
  if (job.status === 'queued') return res.json(base);
  if (job.status === 'awaiting_approval') return res.json({ ...base, candidates: job.candidates });
  if (job.status === 'cancelled') return res.json(base);
  if (job.status === 'blocked') return res.json({ ...base, gates: job.gates, gateDetail: job.gateDetail, blockOffer: job.blockOffer || null, ...blockedResponse(job) });
  if (job.status === 'error') return res.json({ ...base, error: job.error });
  res.json(base);
});

router.saveJobHistory = saveJobHistory;   // 테스트용
router.maybeNotifyOrphan = maybeNotifyOrphan;   // 테스트용
router.buildArchiveDocument = buildArchiveDocument;   // 테스트용(원문·결과 비저장 계약 검증)
router.ensureTerminalTimestamp = ensureTerminalTimestamp;   // 테스트용
router.normalizeDocumentProfileOverride = normalizeDocumentProfileOverride;   // 테스트·클라이언트 계약용
router.preservationFallbackAllowed = preservationFallbackAllowed;   // 고급→보존형 다운그레이드 회귀 테스트용

module.exports = router;
