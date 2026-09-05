// [routes/detectreport.js] AI 감지 분리(2026-06-12) — 사용자 친화 보고서(휴머나이징 전환 퍼널)
// ────────────────────────────────────────────────────────────────
// POST /detect-report { text } — 항상 유료(100자당 1크레딧·로그인 필수, 2026-07-20 무료 제공 제거).
// 보고서 재료 4종:
//   ① LLM 판정(probability·summary·detail) — GPT detect 경로 재사용
//   ② 결정론 문단 지도(surfaceguard.analyzeParagraphs, 무LLM·무비용) — "어느 문단이 왜 위험한지"
//   ③ 경로별 예상 밴드(diagnose 테이블) + 이 글 기준 비용(과금 공식과 동일 산식 — 단가 단일 출처)
//   ④ 실시간 1문장 미리보기(가장 AI스러운 문장 1개 경량 변환) — 전환을 만드는 핵심 장치
// 실패 격리: ④ 미리보기 실패는 보고서에서 숨긴다. ① 권위 점수 모델이 최종 실패하거나
// 불완전하면 결정론 점수로 대체하지 않고 503·무차감으로 종료한다. 둘은 fire 후 Promise.all.

const express = require('express');
const router = express.Router();
const billing = require('../lib/usageBilling');
const { BANDS, COPY } = require('../lib/detectPresentation');
const { restructureCredit, shortHumanizeCredit } = require('../lib/humanizePricing');
const sg = require('../engine/surfaceguard');
const { resolveAdvancedRouting } = require('../engine-gpt-prod/advancedRouting');
const { estimateAdvancedTime } = require('../engine-gpt-prod/timeEstimate');
const crypto = require('crypto');
const { db, verifyToken, ADMIN_UIDS } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const { bearerToken } = require('../lib/reqtoken');   // idToken: 헤더 우선·body 폴백(deprecated)
const detectCalibration = require('../lib/detectCalibration');
const { applyDetectNarrativePolicy } = require('../lib/detectNarrativePolicy');
const history = require('../lib/historyService');
const detectRequests = require('../lib/detectRequestStore');
const detectStability = require('../lib/detectResultStability');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const gptAnalyze = require('./analyze-gpt');
const inputrouting = require('../engine/inputrouting');
const publicMetrics = require('../lib/publicMetrics');
const { buildDetectReportView, buildSentenceMap, pickAiSentence, splitExamplePreview } = require('../lib/detectReportView');

// (무료 감지 일일 한도 로직 제거 — 2026-07-20 사장님 결정으로 감지는 항상 유료.
//  기존 무료 3회/일 캡은 CF 엣지 IP 키 버그로 사실상 무제한이었음. 복원 시 git 이력 참조.)

// ── 코치 후보 어뷰즈 방어(H-05): 무인증 LLM 호출이라 (1) App Check(선택·env게이트), (2) IP별 시간당 캡,
//   (3) 텍스트 해시 캐시로 봇 반복호출·중복 비용을 막는다. 완전한 분산 캡(Firestore)은 결제·운영 단계.
const COACH_IP_HOURLY_CAP = Number(process.env.COACH_IP_HOURLY_CAP) || 20;
const coachIp = new Map();      // ip → { hour, count }
const coachCache = new Map();   // textHash → { stances, experiences } (FIFO, 최대 500)
setInterval(() => {
  const h = Math.floor(Date.now() / 3600000);
  for (const [k, v] of coachIp) if (v.hour !== h) coachIp.delete(k);
}, 60 * 60 * 1000).unref();
function coachHour() { return Math.floor(Date.now() / 3600000); }
// ★ 2026-07-20: req.ip는 CF 엣지 IP(매 요청 변동) — 실제 클라이언트 IP는 cf-connecting-ip 기준(lib/clientip)
const { realClientIp } = require('../lib/clientip');
function clientIp(req) {
  return realClientIp(req);
}

// 문단 종류 → 사용자 언어 사유(보고서의 "알아듣기 쉬운 정리" 핵심)
const PARA_REASON = {
  concrete: '실제 경험처럼 유지할 근거가 관찰돼요. 이 분류는 문체 판정과 별개예요.',
  abstract_risk: '구체적 사례·경험 없이 일반론 비중이 높아 문체 신호가 커질 수 있어요.',
  thin: '구체적 근거가 부족해요. 원문에 있는 경험이나 확인 가능한 수치를 보강해 보세요.'
};

// ★ 카피킬러-risk 프록시 코칭(2026-06-17): 실제 카피킬러 PDF 라벨로 학습한 모델(JS 이식, Python 일치 검증)이
//   문단별로 카피킬러가 붙일 태그를 예측 → '경험 메모' 어느 칸을 채우면 되는지 구체 안내. 무LLM·무비용·무날조.
//   "메모로 해결되는" 태그만 코칭(균일성 등 문체 태그는 엔진 자동 처리라 제외). 모델 없으면 조용히 skip.
const ckProxy = require('../engine/copykiller-proxy');
const TAG_COACH = {
  '구체적 근거 부족':        { fields: ['③ 정확히 아는 수치·출처', '② 구체 사례'], why: '주장만 있고 뒷받침 근거가 약해요' },
  '추상적, 일반적 내용 구성': { fields: ['② 구체적인 사례·예시'],                why: '일반론 위주예요 — 실제 사례가 필요해요' },
  '주관성의 지나친 배제':    { fields: ['④ 내 생각·입장'],                     why: '글쓴이 입장이 안 보여요' },
  '무견해, 판단 회피적 성향': { fields: ['④ 내 생각·입장'],                     why: '판단이 흐릿해 AI스럽게 보여요' },
  '간접 화법, 비인칭 서술':   { fields: ['④ 내 생각(능동 단정문)'],            why: '비인칭·간접 표현이 많아요' }
};
const COACH_TAGS = Object.keys(TAG_COACH);
function predictCoach(text, minP) {
  if (!ckProxy.available() || !text || text.replace(/\s/g, '').length < 30) return null;
  let pr; try { pr = ckProxy.predict(text); } catch { return null; }
  if (!pr) return null;
  const top = COACH_TAGS.map(t => ({ tag: t, p: pr['tag:' + t] || 0 }))
    .filter(x => x.p >= (minP || 0.6)).sort((a, b) => b.p - a.p).slice(0, 2);
  return top.length ? top.map(x => ({ tag: x.tag, fields: TAG_COACH[x.tag].fields, why: TAG_COACH[x.tag].why })) : null;
}

async function activeGptConfig() {
  const cfg = await gptRuntimeConfig.getRuntimeConfig({ db, logger });
  return gptRuntimeConfig.isGptActive(cfg) ? cfg : null;
}

const DETECT_REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,79}$/u;

function parseDetectRequestId(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate) return { requestId: null, errorCode: 'REQUEST_ID_REQUIRED' };
  if (!DETECT_REQUEST_ID_RE.test(candidate)) {
    return { requestId: null, errorCode: 'INVALID_REQUEST_ID' };
  }
  return { requestId: candidate, errorCode: null };
}

function detectTextLengthBucket(length) {
  const safeLength = Math.max(0, Math.floor(Number(length) || 0));
  if (safeLength < 500) return '100-499';
  if (safeLength < 1000) return '500-999';
  if (safeLength < 3000) return '1000-2999';
  if (safeLength < 10000) return '3000-9999';
  return '10000-30000';
}

function idempotencyReused(res, cost) {
  return res.status(409).json({
    ok: false,
    code: 'IDEMPOTENCY_KEY_REUSED',
    error: '같은 작업 번호에 다른 글이나 비용을 사용할 수 없어요. 새 작업 번호로 다시 시도해 주세요.',
    retryable: false,
    charged: 0,
    cost
  });
}

function idempotencyUnavailable(res, cost, code = 'IDEMPOTENCY_RESULT_UNAVAILABLE') {
  return res.status(503).json({
    ok: false,
    code,
    error: '이전 감지 결과를 안전하게 확인하는 중이에요. 잠시 후 같은 작업 번호로 다시 시도해 주세요.',
    retryable: true,
    charged: 0,
    cost
  });
}

function processingResponse(res, cost) {
  return res.status(202).json({
    ok: false,
    status: 'PROCESSING',
    code: 'DETECT_REQUEST_PROCESSING',
    error: '같은 감지 작업을 처리하고 있어요. 잠시 후 다시 확인해 주세요.',
    retryable: true,
    charged: 0,
    cost
  });
}

function cachedPublicResponse(value) {
  const response = value && typeof value === 'object' ? value : null;
  if (!response || response.ok !== true || !Number.isFinite(response.probability)) return null;
  return JSON.parse(JSON.stringify(response));
}

function replayCachedResponse(res, cached, { charged, remainingCredits }) {
  const response = cachedPublicResponse(cached);
  if (!response) return null;
  response.charged = Math.max(0, Math.floor(Number(charged) || 0));
  response.idempotentReplay = true;
  if (Number.isFinite(Number(remainingCredits))) {
    response.remainingCredits = Math.max(0, Math.floor(Number(remainingCredits)));
  }
  res.json(response);
  return response;
}

function billingFailureResponse(res, error, cost, remainingCredits) {
  const code = String(error?.code || error?.message || 'DETECT_BILLING_UNAVAILABLE');
  const common = {
    ok: false,
    charged: 0,
    cost,
    ...(Number.isFinite(Number(remainingCredits))
      ? { remainingCredits: Math.max(0, Math.floor(Number(remainingCredits))) }
      : {})
  };
  if (code === 'IDEMPOTENCY_KEY_REUSED') return idempotencyReused(res, cost);
  if (code === 'INSUFFICIENT_CREDITS') {
    return res.status(402).json({
      ...common,
      code,
      error: '크레딧이 부족합니다. 충전 후 같은 작업 번호로 다시 시도해 주세요.',
      retryable: true
    });
  }
  if (code === 'ACCOUNT_DELETION_IN_PROGRESS') {
    return res.status(409).json({
      ...common,
      code,
      error: '회원 탈퇴 처리가 진행 중이라 크레딧을 차감할 수 없어요.',
      retryable: false
    });
  }
  if (['AUTH_REQUIRED', 'AUTH_INVALID', 'USER_NOT_FOUND'].includes(code)) {
    return res.status(code === 'USER_NOT_FOUND' ? 404 : 401).json({
      ...common,
      code,
      error: code === 'USER_NOT_FOUND' ? '사용자 정보를 찾을 수 없습니다.' : '로그인 정보를 다시 확인해 주세요.',
      retryable: false
    });
  }
  return res.status(503).json({
    ...common,
    code: code === 'CREDIT_LOT_INCONSISTENT' ? code : 'DETECT_BILLING_UNAVAILABLE',
    error: '크레딧 처리를 완료하지 못했어요. 결과는 전달되지 않았습니다. 잠시 후 같은 작업 번호로 다시 시도해 주세요.',
    retryable: true
  });
}

router.post('/detect-report', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  // 글자수 기준 통일: 표시 카운트와 동일하게 공백 포함 raw length으로 최소 길이 판정.
  if (text.length < 100) return res.status(400).json({ error: 'AI 감지를 하려면 최소 100자가 필요해요.' });
  if (text.length > 30000) return res.status(400).json({ error: '텍스트가 너무 깁니다. (최대 30,000자)' });
  const readability = inputrouting.assessInputReadability(text);
  if (!readability.readable) {
    logger.warn('detect_report.unreadable_input_blocked', { reason: readability.reason, textLength: text.length });
    return res.status(422).json({ code: 'UNREADABLE_INPUT', reason: readability.reason, error: inputrouting.UNREADABLE_INPUT_MESSAGE });
  }

  // ★ 로컬 개발 전용(이중 게이트 — analyze.js와 동일): Firebase 비활성 + DEV_NO_AUTH=1이면
  //   인증·과금 미적용(테스트 무제한). 프로덕션은 FIREBASE_SERVICE_ACCOUNT가 항상 있어 이 분기를 안 탐.
  const devNoAuth = !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1';

  // ★ 무료 제공 제거(사장님 결정 2026-07-20): 항상 유료(100자당 1크레딧·로그인 필수).
  //   무료 3회/일 캡은 CF 엣지 IP 키 버그로 사실상 무제한이었고(2,2,1,0 실측), 어뷰즈 방어도
  //   과금이 가장 확실하다. 차감은 기존 유료 경로 그대로: 선검증 → 성공 후 멱등 차감.
  const idToken = bearerToken(req);   // 헤더 우선(body.idToken 폴백)
  const uid = await verifyToken(idToken);
  if (uid) setLogContext({ uid });
  const cost = Math.ceil(text.length / 100);
  const parsedRequestId = parseDetectRequestId(req.body?.requestId);
  const requestId = parsedRequestId.requestId;

  // 먼저 인증 계정의 플랜만 확인한다. 잔액 검사는 아래 멱등 replay 조회 뒤에 해야
  // 최초 응답 유실 뒤 잔액이 0이어도 이미 결제된 결과를 회수할 수 있다.
  let paidPre = null;
  if (!devNoAuth) {
    if (!uid) return res.status(401).json({ error: 'AI 감지는 로그인이 필요해요.', code: 'LOGIN_REQUIRED', cost });
    try {
      paidPre = await billing.getCreditAccountState(uid);
    } catch (e) {
      return res.status(e.status || 503).json({
        error: billing.authErrorMessage(e.message),
        code: e.message === 'USER_NOT_FOUND' ? 'USER_NOT_FOUND' : 'ACCOUNT_STATE_UNAVAILABLE',
        charged: 0,
        cost
      });
    }
    // 크레딧 차감 대상은 클라이언트가 같은 키를 재사용해야만 안전하게 멱등 처리할 수 있다.
    // dev 무인증과 unlimited는 차감 자체가 없으므로 기존 내부 호출 호환성을 유지한다.
    if (paidPre.plan !== 'unlimited' && parsedRequestId.errorCode) {
      const missing = parsedRequestId.errorCode === 'REQUEST_ID_REQUIRED';
      logger.warn('detect_report.request_id_rejected', {
        uid,
        reason: missing ? 'missing' : 'invalid',
        textLength: text.length,
        cost
      });
      return res.status(400).json({
        ok: false,
        code: parsedRequestId.errorCode,
        error: missing
          ? '안전한 크레딧 처리를 위해 작업 번호가 필요해요. 페이지를 새로고침한 뒤 다시 시도해 주세요.'
          : '작업 번호 형식이 올바르지 않아요. 페이지를 새로고침한 뒤 다시 시도해 주세요.',
        retryable: false,
        charged: 0,
        cost
      });
    }
  }
  let chargeEligible = !devNoAuth && paidPre && paidPre.plan !== 'unlimited';
  const requestPayloadFingerprint = (!devNoAuth && requestId)
    ? billing.creditRequestPayloadFingerprint({ opType: 'detect', needed: cost, text })
    : null;
  // requestId가 없는 무제한 플랜도 동일 글 재검사 점수는 안정화한다. 지문은
  // 기존 과금 결합 함수만 재사용하며 원문이나 지문을 로그에 남기지 않는다.
  const stabilityPayloadFingerprint = (!devNoAuth && uid)
    ? (requestPayloadFingerprint
      || billing.creditRequestPayloadFingerprint({ opType: 'detect', needed: cost, text }))
    : null;
  const requestBinding = requestPayloadFingerprint ? {
    uid,
    requestId,
    payloadFingerprint: requestPayloadFingerprint,
    cost
  } : null;
  let creditIdempotency = { state: 'NOT_APPLICABLE', remainingCredits: null };
  let requestClaim = null;
  let cachedArtifact = null;

  if (requestBinding) {
    if (chargeEligible) {
      try {
        creditIdempotency = await billing.precheckCreditDeductIdempotency(
          uid,
          cost,
          'detect',
          requestId,
          requestPayloadFingerprint
        );
      } catch (error) {
        if (error?.code === 'IDEMPOTENCY_KEY_REUSED') return idempotencyReused(res, cost);
        logger.error('detect_report.idempotency_ledger_check_failed', { uid, requestId, err: error });
        return idempotencyUnavailable(res, cost, 'IDEMPOTENCY_CHECK_UNAVAILABLE');
      }
    }

    const historyIdempotency = await history.getDetectHistoryIdempotency({
      uid,
      requestId,
      needed: cost,
      requestPayloadFingerprint
    });
    if (historyIdempotency.state === 'UNAVAILABLE') {
      logger.error('detect_report.idempotency_history_check_failed', {
        uid,
        requestId,
        err: historyIdempotency.error
      });
      return idempotencyUnavailable(res, cost, 'IDEMPOTENCY_CHECK_UNAVAILABLE');
    }
    if (historyIdempotency.state === 'MISMATCH') return idempotencyReused(res, cost);

    if (creditIdempotency.state === 'DUPLICATE' && historyIdempotency.state === 'READY') {
      const replayed = replayCachedResponse(res, historyIdempotency.response, {
        charged: 0,
        remainingCredits: creditIdempotency.remainingCredits
      });
      if (replayed) {
        logger.info('detect_report.idempotent_replay', {
          uid: undefined,
          clientRequestId: requestId,
          scoreSource: 'cached_llm',
          probability: replayed.probability,
          charged: replayed.charged,
          remainingCredits: replayed.remainingCredits,
          lengthBucket: detectTextLengthBucket(text.length)
        });
        return;
      }
      return idempotencyUnavailable(res, cost);
    }
    if (!chargeEligible && historyIdempotency.state === 'READY') {
      const replayed = replayCachedResponse(res, historyIdempotency.response, {
        charged: 0,
        remainingCredits: null
      });
      if (replayed) return;
      return idempotencyUnavailable(res, cost);
    }
    if (creditIdempotency.state === 'NEW' && historyIdempotency.state !== 'NOT_FOUND') {
      return idempotencyReused(res, cost);
    }
    if (!chargeEligible && historyIdempotency.state === 'INCOMPLETE') {
      return idempotencyUnavailable(res, cost);
    }

    requestClaim = await detectRequests.begin(requestBinding);
    if (requestClaim.state === 'MISMATCH') return idempotencyReused(res, cost);
    if (requestClaim.state === 'ACCOUNT_DELETION') {
      return res.status(409).json({
        ok: false,
        code: 'ACCOUNT_DELETION_IN_PROGRESS',
        error: '회원 탈퇴 처리가 진행 중이라 감지를 시작할 수 없어요.',
        retryable: false,
        charged: 0,
        cost
      });
    }
    if (['INVALID', 'UNAVAILABLE'].includes(requestClaim.state)) {
      return idempotencyUnavailable(res, cost, 'IDEMPOTENCY_CHECK_UNAVAILABLE');
    }
    if (requestClaim.state === 'PROCESSING') return processingResponse(res, cost);
    if (['RESULT_READY', 'COMPLETE'].includes(requestClaim.state)) {
      cachedArtifact = requestClaim.response;
    }
    if (creditIdempotency.state === 'DUPLICATE' && requestClaim.state === 'NEW') {
      await detectRequests.releaseAfterModelFailure(requestBinding);
      return idempotencyUnavailable(res, cost);
    }
    if (chargeEligible && creditIdempotency.state === 'NEW' && requestClaim.state === 'COMPLETE') {
      return idempotencyReused(res, cost);
    }
  }

  // 신규 차감 또는 아직 결제되지 않은 staged 결과에만 현재 잔액을 검사한다.
  // 이미 원장에 결합된 duplicate replay는 잔액 0이어도 이 검사를 건너뛴다.
  if (chargeEligible && creditIdempotency.state !== 'DUPLICATE') {
    try {
      paidPre = await billing.precheckCredits(idToken, cost);
      if (paidPre.plan === 'unlimited') chargeEligible = false;
    } catch (error) {
      if (requestBinding && requestClaim?.state === 'NEW') {
        await detectRequests.releaseAfterModelFailure(requestBinding);
      }
      return billingFailureResponse(res, error, cost, paidPre?.credits);
    }
  }
  logger.info('detect_report.started', { uid, textLength: text.length, cost, devNoAuth });

  let artifact = null;
  let usedCachedArtifact = false;
  if (cachedArtifact) {
    const publicResponse = cachedPublicResponse(cachedArtifact.publicResponse);
    if (!publicResponse || !cachedArtifact.historyResult || !cachedArtifact.metric) {
      return idempotencyUnavailable(res, cost);
    }
    artifact = {
      publicResponse,
      historyResult: cachedArtifact.historyResult,
      metric: cachedArtifact.metric
    };
    usedCachedArtifact = true;
  } else {
    // ② 결정론 분석(무LLM) — 실패하면 보고서 자체가 성립 안 되므로 여기서만 500
    let ir, paras, detail, reportMeasurements;
    try {
      paras = sg.splitParagraphsForReport(text);
      const joined = paras.join('\n\n');
      ir = sg.classifyInputRisk(joined);
      detail = sg.analyzeParagraphs(joined).detail;
      reportMeasurements = {
        uniformity: sg.measureUniformity(joined),
        genericness: sg.measureGenericness(joined),
        realAnchorDensity: sg.measureRealAnchorDensity(joined),
        stance: sg.measureStance(joined),
        detail
      };
    } catch (error) {
      if (requestBinding) await detectRequests.releaseAfterModelFailure(requestBinding);
      logger.error('detect_report.surface_failed', { uid, err: error });
      return res.status(500).json({ error: '감지 처리 중 오류가 발생했어요.', charged: 0, cost });
    }
    const grade = ir.grade || 'B';
    const copy = COPY[grade] || COPY.B;
    const advancedRouting = resolveAdvancedRouting(text, ir);
    let advancedTimeEstimate = null;
    try {
      advancedTimeEstimate = estimateAdvancedTime(text);
    } catch (error) {
      logger.warn('detect_report.time_estimate_failed', { err: error });
    }

    // ①·④ LLM 2건 병렬. 미리보기 실패는 격리하지만 점수 모델 실패는
    // 서로 다른 척도의 로컬 숫자로 바꾸지 않는다.
    const scoreStartedAt = Date.now();
    let detectError = null;
    let stabilityMeta = {
      cacheHit: false,
      source: 'live',
      cacheVariant: '',
      promptVersion: String(gptAnalyze.DETECT_PROMPT_VERSION || '')
    };
    const detectP = (async () => {
      const gptCfg = await activeGptConfig();
      if (!gptCfg) throw Object.assign(new Error('GPT_PROVIDER_UNAVAILABLE'), { code: 'GPT_PROVIDER_UNAVAILABLE' });
      const cacheVariant = detectStability.variantForConfig(gptCfg, {
        detectorVersion: gptAnalyze.DETECT_VERSION,
        promptVersion: gptAnalyze.DETECT_PROMPT_VERSION,
        documentProfile: `${advancedRouting.profile}:${Number(advancedRouting.confidence).toFixed(2)}:${advancedRouting.profileMargin ?? 'na'}`
      });
      const stable = await detectStability.getOrCompute({
        uid,
        payloadFingerprint: stabilityPayloadFingerprint,
        cacheVariant
      }, async () => {
        const detected = await gptAnalyze.runDetect(text, 'ko', {
          config: gptCfg,
          route: 'detect_report',
          allowLocalFallback: false,
          uid: uid || '',
          documentProfile: {
            profile: advancedRouting.profile,
            confidence: advancedRouting.confidence,
            profileMargin: advancedRouting.profileMargin
          }
        });
        if (!Number.isFinite(detected?.probability)) {
          throw Object.assign(new Error('detect_incomplete'), { code: 'DETECT_INCOMPLETE' });
        }
        return detected;
      });
      const result = stable.result;
      if (!Number.isFinite(result?.probability)) {
        throw Object.assign(new Error('detect_incomplete'), { code: 'DETECT_INCOMPLETE' });
      }
      stabilityMeta = {
        cacheHit: stable.cacheHit === true,
        source: String(stable.source || 'live').slice(0, 20),
        cacheVariant,
        promptVersion: String(result.gptMeta?.detectPromptVersion
          || gptAnalyze.DETECT_PROMPT_VERSION
          || '').slice(0, 80)
      };
      return result;
    })().catch(error => {
      detectError = error;
      return null;
    });

    const before = pickAiSentence(paras, detail);
    const previewController = new AbortController();
    const previewTimer = setTimeout(() => previewController.abort(), 6000);
    let completedExample = null;
    const exampleP = before
      ? (async () => {
          const gptCfg = await activeGptConfig();
          if (!gptCfg) throw Object.assign(new Error('GPT_PROVIDER_UNAVAILABLE'), { code: 'GPT_PROVIDER_UNAVAILABLE' });
          const result = await gptAnalyze.rewriteSentence({ text: before, lang: 'ko', config: gptCfg, uid: uid || '', signal: previewController.signal });
          if (!result?.rewritten) return null;
          // 다듬은 문장은 가장 많이 바뀐 자리만 공개하고 나머지는 휴머나이징으로 보낸다(원문 나머지는 응답에 싣지 않는다).
          const gate = splitExamplePreview(result.rewritten, before);
          return gate ? {
            before,
            after: gate.preview,
            afterParts: gate.parts,
            afterHidden: gate.hiddenLength,
            afterLength: gate.totalLength,
            afterAnchor: gate.anchor,
            meaningfulChange: gate.meaningfulChange === true,
            changeKind: gate.changeKind,
            beforeFocus: gate.beforeFocus,   // 원문에서 바뀌는 자리 — 사용자 글이라 가릴 것 없다
            afterFocus: gate.afterFocus,     // 전체 rewrite 좌표 안의 공개 변경 교집합 — 삭제는 길이 0 위치
            gated: gate.gated
          } : null;
        })().catch(error => { logger.warn('detect_report.preview_failed', { uid, err: error }); return null; })
      : Promise.resolve(null);

    void exampleP.then(value => { completedExample = value; }).finally(() => clearTimeout(previewTimer));
    const det = await detectP;
    const example = completedExample;
    previewController.abort();
    clearTimeout(previewTimer);
    const shadowEngineProbability = Math.round(Math.min(92, Math.max(15, 22 + 70 * (ir.abstractRiskRatio || 0))));
    const scoreLatencyMs = Date.now() - scoreStartedAt;
    if (!det) {
      if (requestBinding) await detectRequests.releaseAfterModelFailure(requestBinding);
      const upstreamErrorCode = String(detectError?.code || detectError?.name || 'DETECT_FAILED')
        .replace(/[^A-Za-z0-9_.:-]/g, '')
        .slice(0, 80) || 'DETECT_FAILED';
      const blockedMetric = {
        uid: undefined,
        requestId: requestId || undefined,
        outcome: 'blocked',
        scoreSource: 'none',
        shadowEngineProbability,
        upstreamCode: upstreamErrorCode,
        retryable: true,
        latencyMs: scoreLatencyMs,
        lengthBucket: detectTextLengthBucket(text.length)
      };
      logger.warn('detect_report.scoring_unavailable', blockedMetric);
      logger.info('detect_report.score_outcome', blockedMetric);
      return res.status(503).json({
        ok: false,
        error: 'AI 감지 모델 응답을 받지 못했어요. 크레딧은 차감되지 않았어요. 잠시 후 다시 시도해 주세요.',
        code: 'DETECT_MODEL_UNAVAILABLE',
        retryable: true,
        charged: 0,
        cost
      });
    }

    const rawProbability = Math.round(det.probability);
    let calibration;
    try {
      calibration = await detectCalibration.applyHistoryCalibration({
        db,
        uid,
        text,
        probability: rawProbability,
        logger,
        route: 'detect_report'
      });
    } catch (error) {
      if (requestBinding) await detectRequests.releaseAfterModelFailure(requestBinding);
      logger.error('detect_report.calibration_failed', { uid, requestId, err: error });
      return res.status(503).json({
        ok: false,
        code: 'DETECT_CALIBRATION_UNAVAILABLE',
        error: '감지 결과를 안전하게 확정하지 못했어요. 크레딧은 차감되지 않았습니다.',
        retryable: true,
        charged: 0,
        cost
      });
    }
    const probability = calibration.probability;
    const narrated = applyDetectNarrativePolicy(det, probability);
    // 문장 지도와 보고서 계측은 무LLM·무추가비용이다. 권위 점수 모델이 성공한 뒤에만
    // 공개 보고서에 결합하고, 지도 생성 실패는 점수·과금 흐름과 분리한다.
    let sentenceMap = null;
    try {
      sentenceMap = buildSentenceMap(paras, detail);
    } catch (error) {
      logger.warn('detect_report.sentence_map_failed', { uid, err: error && error.message });
    }
    const reportView = buildDetectReportView({
      probability,
      probSource: 'llm',
      riskLevel: narrated.riskLevel,
      calibrationApplied: calibration.applied,
      preCalibrationProbability: rawProbability,
      // 원인 레이더 축 정책용 — 글 종류·신뢰도(이미 계산된 값, 추가 비용 없음)
      documentProfile: {
        profile: advancedRouting.profile,
        confidence: advancedRouting.confidence,
        profileMargin: advancedRouting.profileMargin
      },
      signalEvidence: narrated.signalEvidence,
      signals: narrated.signals,
      measurements: sentenceMap
        ? {
            ...reportMeasurements,
            uniformity: {
              ...reportMeasurements.uniformity,
              maxEndingRun: sentenceMap.maxEndingRun
            }
          }
        : reportMeasurements
    });
    const len = text.length;
    const B = BANDS;
    const historyResult = {
      probability,
      riskLevel: narrated.riskLevel,
      riskLabel: narrated.riskLabel,
      summary: narrated.summary,
      detail: narrated.detail,
      reportView,
      sentenceMap,
      signals: narrated.signals,
      signalEvidence: narrated.signalEvidence,
      confidence: det.confidence,
      gptMeta: {
        selectedModel: det.gptMeta?.selectedModel,
        engine: det.gptMeta?.engine,
        escalated: det.gptMeta?.escalated === true,
        detectPromptVersion: stabilityMeta.promptVersion,
        detectCacheVariant: stabilityMeta.cacheVariant,
        detectCacheHit: stabilityMeta.cacheHit,
        detectCacheSource: stabilityMeta.source
      },
      probSource: 'llm',
      rawProbability,
      modelProbability: Number.isFinite(Number(det.modelProbability)) ? det.modelProbability : rawProbability,
      causeScoreAdjusted: det.causeScoreAdjusted === true,
      causeScoreCeiling: Number.isFinite(Number(det.causeScoreCeiling)) ? det.causeScoreCeiling : null,
      causeScoreAdjustmentCode: det.causeScoreAdjustmentCode || null,
      documentProfile: advancedRouting.profile,
      profileConfidence: advancedRouting.confidence,
      profileMargin: advancedRouting.profileMargin,
      profileAmbiguous: reportView.measuredEvidence?.axisPolicy?.ambiguousProfile === true,
      ...(calibration.applied ? {
        probabilityCalibration: calibration.meta
      } : {})
    };
    const publicResponse = {
      ok: true,
      free: false,
      charged: chargeEligible ? cost : 0,
      historySaved: false,
      probability,
      ...(calibration.applied ? {
        rawProbability: calibration.rawProbability,
        calibrated: true,
        probabilityCalibration: calibration.meta
      } : {}),
      probSource: 'llm',
      riskLevel: narrated.riskLevel,
      riskLabel: narrated.riskLabel,
      summary: narrated.summary,
      detail: narrated.detail,
      reportView,
      sentenceMap,
      grade,
      title: copy.title,
      abstractRiskRatio: ir.abstractRiskRatio,
      restructureUnfit: advancedRouting.effectiveUnfit.unfit === true,
      restructureUnfitReason: advancedRouting.effectiveUnfit.reason || null,
      restructureUnfitKind: advancedRouting.effectiveUnfit.kind || null,
      advancedEligible: advancedRouting.advancedEligible,
      recommendedMode: advancedRouting.recommendedMode,
      recommendationCode: advancedRouting.recommendationCode || null,
      recommendationReason: advancedRouting.recommendationReason || null,
      documentProfile: advancedRouting.profile,
      profileConfidence: Number(advancedRouting.confidence.toFixed(4)),
      profileMargin: advancedRouting.profileMargin,
      routingOverride: advancedRouting.routingOverride || null,
      advancedTimeEstimate,
      paragraphs: paras.map((paragraph, index) => {
        const kind = (detail[index] && detail[index].kind) || 'thin';
        return {
          idx: index,
          kind,
          reason: PARA_REASON[kind],
          snippet: paragraph.slice(0, 140),
          text: paragraph.length > 140 ? paragraph : undefined,
          coach: predictCoach(paragraph)
        };
      }),
      coach: predictCoach(text, 0.5),
      counts: {
        total: paras.length,
        risk: detail.filter(item => item.kind === 'abstract_risk').length,
        thin: detail.filter(item => item.kind === 'thin').length,
        safe: detail.filter(item => item.kind === 'concrete').length
      },
      example,
      exampleStatus: example ? 'ready' : (before ? 'unavailable' : 'no_candidate'),
      exampleSource: before || null,
      solutions: {
        polish: { band: B.POLISH_BAND[grade], credits: shortHumanizeCredit(len) },
        blog: { band: B.BLOG_BAND[grade], credits: shortHumanizeCredit(len) },
        restructure: {
          band: B.RESTRUCTURE_BAND,
          credits: restructureCredit(len, false),
          creditsEvidence: restructureCredit(len, true)
        }
      }
    };
    artifact = {
      publicResponse,
      historyResult,
      metric: {
        grade,
        probability,
        rawProbability,
        modelProbability: Number.isFinite(Number(det.modelProbability)) ? det.modelProbability : rawProbability,
        causeScoreAdjusted: det.causeScoreAdjusted === true,
        causeScoreCeiling: Number.isFinite(Number(det.causeScoreCeiling)) ? det.causeScoreCeiling : null,
        causeScoreAdjustmentCode: det.causeScoreAdjustmentCode || null,
        calibrated: calibration.applied,
        calibration: calibration.applied ? calibration.meta : null,
        riskLevel: narrated.riskLevel,
        riskLabel: narrated.riskLabel,
        narrativeConsistencyAdjusted: narrated.narrativeConsistencyAdjusted,
        reportViewStatus: reportView.status,
        causeCoverageStatus: reportView.causeAnalysis.status,
        causeCoverage: reportView.causeAnalysis.coverage,
        causeRequiredCount: reportView.causeAnalysis.requiredIndependentSignals,
        causeQualifyingCount: reportView.causeAnalysis.qualifyingIndependentSignals,
        causeCoverageCodes: reportView.causeAnalysis.codes,
        documentProfile: advancedRouting.profile,
        profileConfidence: advancedRouting.confidence,
        profileMargin: advancedRouting.profileMargin,
        profileAmbiguous: reportView.measuredEvidence?.axisPolicy?.ambiguousProfile === true,
        professorRadarBand: reportView.professorRadar.band,
        shadowEngineProbability,
        confidence: ['low', 'medium', 'high'].includes(det.confidence) ? det.confidence : null,
        selectedModel: det.gptMeta?.selectedModel || null,
        detectorVersion: det.gptMeta?.engine || null,
        escalated: det.gptMeta?.escalated === true,
        detectPromptVersion: stabilityMeta.promptVersion,
        detectCacheVariant: stabilityMeta.cacheVariant,
        detectCacheHit: stabilityMeta.cacheHit,
        detectCacheSource: stabilityMeta.source,
        scoreLatencyMs
      }
    };

    // 결과를 과금 전에 durable cache에 고정한다. commit 응답 유실·동시 재시도도
    // 같은 requestId에서는 이 결과만 재사용하며 모델을 다시 호출하지 않는다.
    if (requestBinding) {
      const staged = await detectRequests.stageResult(requestBinding, artifact);
      if (staged.state === 'MISMATCH') return idempotencyReused(res, cost);
      if (staged.state === 'ACCOUNT_DELETION') {
        return billingFailureResponse(res, { code: 'ACCOUNT_DELETION_IN_PROGRESS' }, cost, null);
      }
      if (!['RESULT_READY', 'COMPLETE'].includes(staged.state) || !staged.response) {
        await detectRequests.releaseAfterModelFailure(requestBinding);
        return idempotencyUnavailable(res, cost, 'IDEMPOTENCY_CACHE_UNAVAILABLE');
      }
      if (staged.response !== artifact) {
        const stagedPublic = cachedPublicResponse(staged.response.publicResponse);
        if (!stagedPublic || !staged.response.historyResult || !staged.response.metric) {
          return idempotencyUnavailable(res, cost);
        }
        artifact = { ...staged.response, publicResponse: stagedPublic };
        usedCachedArtifact = true;
      }
    }
  }

  if (req.aborted) return;

  let charged = chargeEligible && creditIdempotency.state !== 'DUPLICATE' ? cost : 0;
  let remainingCredits = creditIdempotency.remainingCredits;
  if (chargeEligible && creditIdempotency.state !== 'DUPLICATE') {
    let deduction = null;
    let commitError = null;
    try {
      deduction = await billing.retryAsync(() => billing.commitCreditDeduct(
        paidPre.uid,
        cost,
        'detect',
        requestId,
        {
          mode: 'detect',
          textLength: text.length,
          requestPayloadFingerprint
        }
      ), 2);
    } catch (error) {
      commitError = error;
    }

    if (deduction) {
      const deductedAmount = Number(deduction.current) - Number(deduction.next);
      const confirmed = deduction.duplicate === true
        || (Number.isFinite(deductedAmount) && Math.round(deductedAmount) === cost);
      if (!confirmed) {
        commitError = Object.assign(new Error('DETECT_BILLING_UNCONFIRMED'), {
          code: 'DETECT_BILLING_UNCONFIRMED',
          status: 503
        });
      } else {
        remainingCredits = deduction.next;
        if (deduction.duplicate === true) charged = 0;
      }
    } else if (!commitError) {
      commitError = Object.assign(new Error('DETECT_BILLING_UNCONFIRMED'), {
        code: 'DETECT_BILLING_UNCONFIRMED',
        status: 503
      });
    }

    if (commitError) {
      let confirmedAfterError = null;
      try {
        confirmedAfterError = await billing.precheckCreditDeductIdempotency(
          uid,
          cost,
          'detect',
          requestId,
          requestPayloadFingerprint
        );
      } catch (checkError) {
        if (checkError?.code === 'IDEMPOTENCY_KEY_REUSED') {
          await detectRequests.recordBillingFailure(requestBinding, checkError);
          return idempotencyReused(res, cost);
        }
      }
      if (confirmedAfterError?.state === 'DUPLICATE') {
        remainingCredits = confirmedAfterError.remainingCredits;
        charged = 0;
        logger.warn('detect_report.billing_commit_ambiguous_recovered', {
          uid,
          requestId,
          cost,
          err: commitError
        });
      } else {
        await detectRequests.recordBillingFailure(requestBinding, commitError);
        const expectedRejection = ['INSUFFICIENT_CREDITS', 'ACCOUNT_DELETION_IN_PROGRESS']
          .includes(String(commitError?.code || commitError?.message || ''));
        logger[expectedRejection ? 'warn' : 'error']('detect_report.billing_commit_failed', {
          uid,
          requestId,
          cost,
          err: commitError
        });
        return billingFailureResponse(
          res,
          commitError,
          cost,
          confirmedAfterError?.remainingCredits
        );
      }
    }
  }

  if (req.aborted) return;

  let responseBody = {
    ...artifact.publicResponse,
    charged,
    historySaved: false,
    ...(Number.isFinite(Number(remainingCredits))
      ? { remainingCredits: Math.max(0, Math.floor(Number(remainingCredits))) }
      : {}),
    ...(usedCachedArtifact ? { idempotentReplay: true } : {})
  };
  let historySaved = false;
  if (!devNoAuth && uid) {
    const responseForCache = { ...responseBody, historySaved: true };
    try {
      const saved = await history.saveAnalyzeHistory({
        uid,
        requestId,
        opType: 'detect',
        text,
        needed: cost,
        result: artifact.historyResult,
        mode: 'detect',
        requestPayloadFingerprint,
        detectResponseCache: responseForCache
      });
      historySaved = saved?.saved === true;
      if (saved?.duplicate && saved.response) {
        const existing = cachedPublicResponse(saved.response);
        if (!existing) return idempotencyUnavailable(res, cost);
        responseBody = {
          ...existing,
          charged,
          historySaved: true,
          ...(Number.isFinite(Number(remainingCredits))
            ? { remainingCredits: Math.max(0, Math.floor(Number(remainingCredits))) }
            : {}),
          idempotentReplay: true
        };
        usedCachedArtifact = true;
      }
    } catch (error) {
      if (error?.code === 'IDEMPOTENCY_KEY_REUSED') return idempotencyReused(res, cost);
      logger.warn('detect_report.history_persist_failed', { uid, requestId, err: error });
    }
  }
  responseBody.historySaved = historySaved;

  if (requestBinding) {
    const completed = await detectRequests.complete(requestBinding, {
      ...artifact,
      publicResponse: responseBody
    });
    if (!['COMPLETE'].includes(completed.state)) {
      logger.error('detect_report.idempotency_complete_unconfirmed', {
        uid,
        requestId,
        state: completed.state
      });
    }
  }

  const metric = artifact.metric;
  logger.info('detect_report.completed', {
    uid,
    grade: metric.grade,
    probability: metric.probability,
    rawProbability: metric.calibrated ? metric.rawProbability : undefined,
    calibrated: metric.calibrated,
    calibration: metric.calibrated ? metric.calibration : undefined,
    probSource: 'llm',
    riskLevel: metric.riskLevel,
    riskLabel: metric.riskLabel,
    narrativeConsistencyAdjusted: metric.narrativeConsistencyAdjusted,
    reportViewStatus: metric.reportViewStatus,
    causeCoverageStatus: metric.causeCoverageStatus,
    causeCoverage: metric.causeCoverage,
    causeRequiredCount: metric.causeRequiredCount,
    causeQualifyingCount: metric.causeQualifyingCount,
    causeCoverageCodes: metric.causeCoverageCodes,
    causeScoreAdjusted: metric.causeScoreAdjusted,
    modelProbability: metric.causeScoreAdjusted ? metric.modelProbability : undefined,
    documentProfile: metric.documentProfile,
    profileConfidence: metric.profileConfidence,
    profileMargin: metric.profileMargin,
    profileAmbiguous: metric.profileAmbiguous,
    professorRadarBand: metric.professorRadarBand,
    charged,
    remainingCredits,
    historySaved,
    idempotentReplay: usedCachedArtifact,
    detectCacheHit: metric.detectCacheHit,
    detectCacheSource: metric.detectCacheSource
  });
  logger.info('detect_report.score_outcome', {
    uid: undefined,
    requestId: requestId || undefined,
    outcome: 'delivered',
    scoreSource: usedCachedArtifact || metric.detectCacheHit ? 'cached_llm' : 'llm',
    probability: metric.probability,
    rawProbability: metric.rawProbability,
    modelProbability: metric.modelProbability,
    causeScoreAdjusted: metric.causeScoreAdjusted,
    causeScoreCeiling: metric.causeScoreCeiling,
    causeScoreAdjustmentCode: metric.causeScoreAdjustmentCode || undefined,
    causeCoverageStatus: metric.causeCoverageStatus,
    causeCoverage: metric.causeCoverage,
    causeRequiredCount: metric.causeRequiredCount,
    causeQualifyingCount: metric.causeQualifyingCount,
    causeCoverageCodes: metric.causeCoverageCodes,
    documentProfile: metric.documentProfile,
    profileConfidence: metric.profileConfidence,
    profileMargin: metric.profileMargin,
    profileAmbiguous: metric.profileAmbiguous,
    shadowEngineProbability: metric.shadowEngineProbability,
    scoreDeltaFromShadow: metric.rawProbability - metric.shadowEngineProbability,
    confidence: metric.confidence || undefined,
    selectedModel: metric.selectedModel || undefined,
    detectorVersion: metric.detectorVersion || undefined,
    escalated: metric.escalated,
    detectPromptVersion: metric.detectPromptVersion || undefined,
    detectCacheHit: metric.detectCacheHit,
    detectCacheSource: metric.detectCacheSource,
    calibrated: metric.calibrated,
    charged,
    latencyMs: metric.scoreLatencyMs,
    lengthBucket: detectTextLengthBucket(text.length)
  });

  publicMetrics.trackDeliveredMetric(res, {
    operation: 'detect',
    eventId: requestId || String(res.getHeader('x-request-id') || crypto.randomUUID()),
    uid,
    processedCharacters: text.length,
    isAdmin: ADMIN_UIDS.includes(uid),
    isTest: devNoAuth
  }, { db, logger });
  return res.json(responseBody);
});

// ── 자동 코칭 후보(2026-06-18): 시작 직전 선택 모달용. 글에서 입장·경험 후보를 생성해 반환 →
//   프론트가 체크박스로 보여주고, 사용자가 고른 것만 memo로 합쳐 /transform에 보낸다(체크=저자 승인=무날조).
//   무과금·무인증(diagnose류 사전 헬퍼). 짧은 글/실패는 빈 배열(흐름 안 막음).
router.post('/coach-suggest', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (text.replace(/\s/g, '').length < 80) return res.json({ ok: true, stances: [], experiences: [] });
  if (text.length > 30000) return res.status(400).json({ ok: false, error: '텍스트가 너무 깁니다.' });
  const readability = inputrouting.assessInputReadability(text);
  if (!readability.readable) {
    return res.status(422).json({ ok: false, code: 'UNREADABLE_INPUT', reason: readability.reason, error: inputrouting.UNREADABLE_INPUT_MESSAGE });
  }

  // (1) IP별 시간당 캡 — 봇 반복호출로 인한 LLM 비용·동시성 소진 차단.
  const ip = clientIp(req);
  const hour = coachHour();
  const rec = coachIp.get(ip);
  const count = rec && rec.hour === hour ? rec.count : 0;
  if (ip && count >= COACH_IP_HOURLY_CAP) {
    logger.warn('coach_suggest.ip_capped', { ip, count });
    return res.status(429).json({ ok: true, stances: [], experiences: [], capped: true });
  }

  // (2) 텍스트 해시 캐시 — 동일 입력 재호출은 LLM 없이 즉시 응답(중복 클릭·재시도 비용 제거).
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const cached = coachCache.get(hash);
  if (cached) return res.json({ ok: true, stances: cached.stances, experiences: cached.experiences });

  try {
    const { generateCoach } = require('../lib/coachsuggest');
    const out = await generateCoach(text);
    const result = { stances: out.stances || [], experiences: out.experiences || [] };
    coachCache.set(hash, result);
    if (coachCache.size > 500) coachCache.delete(coachCache.keys().next().value);
    if (ip) coachIp.set(ip, { hour, count: count + 1 });
    res.json({ ok: true, ...result });
  } catch (e) {
    logger.warn('coach_suggest.failed', { err: e && e.message });
    res.json({ ok: true, stances: [], experiences: [] });
  }
});

module.exports = router;
