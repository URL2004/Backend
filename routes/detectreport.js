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
const { BANDS, contentPresentation, filterContentCoach } = require('../lib/detectPresentation');
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
const { locatePublicEvidence, buildDetectInputDocument, assertDetectInputAdmissible } = require('../lib/detectInputDocument');
const { signDetectInterpretation } = require('../lib/detectHistoryPresentation');
const { signHistoryComparison } = require('../lib/detectHistoryComparison');
const { startDetectPreview } = require('../lib/detectPreviewTask');

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

// ★ 카피킬러-risk 프록시 코칭(2026-06-17): 실제 카피킬러 PDF 라벨로 학습한 모델(JS 이식, Python 일치 검증)이
//   문단별로 카피킬러가 붙일 태그를 예측 → '경험 메모' 어느 칸을 채우면 되는지 구체 안내. 무LLM·무비용·무날조.
//   "메모로 해결되는" 태그만 코칭(균일성 등 문체 태그는 엔진 자동 처리라 제외). 모델 없으면 조용히 skip.
const ckProxy = require('../engine/copykiller-proxy');
const TAG_COACH = {
  '구체적 근거 부족':        { fields: ['③ 정확히 아는 수치·출처', '② 구체 사례'], why: '구체 근거로 분류된 문장 비율이 낮아요. 원문에서 확인되는 근거의 연결을 살펴보세요.' },
  '추상적, 일반적 내용 구성': { fields: ['② 구체적인 사례·예시'],                why: '일반적인 설명이 반복되는지 확인하고, 필요한 곳에서 원문에 있는 사례를 연결해 보세요.' },
  '주관성의 지나친 배제':    { fields: ['④ 내 생각·입장'],                     why: '입장이 필요한 문단이라면 원문에 드러난 생각과 판단 근거를 연결해 보세요.' },
  '무견해, 판단 회피적 성향': { fields: ['④ 내 생각·입장'],                     why: '판단을 설명하는 문단이라면 원문에 있는 입장과 이유를 함께 살펴보세요.' },
  '간접 화법, 비인칭 서술':   { fields: ['④ 내 생각·입장'],                     why: '행위나 판단의 주체가 원문과 같게 드러나는지 확인해 보세요.' }
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

// 재시도 가능한 503의 최소 대기 시간. 이 응답들은 처리 상태(claim)를 남기지 않으므로 기다려야 하는
// 고정 시간이 없다. 복구 시점을 약속하지 않는 backoff 하한이며, claim이 남는 경로는 실제 남은 시간을 쓴다.
const RETRY_BACKOFF_SECONDS = 5;

function retryable503(res, body, seconds = body?.retryAfterSeconds || RETRY_BACKOFF_SECONDS) {
  res.set('Retry-After', String(seconds));
  return res.status(503).json({ ...body, retryable: true, retryAfterSeconds: seconds });
}

// 저장소·원장을 일시적으로 확인하지 못한 경우에만 쓴다. 다시 시도해도 달라지지 않는 상태는
// resultUnrecoverable로 닫는다.
function idempotencyUnavailable(res, cost, code = 'IDEMPOTENCY_RESULT_UNAVAILABLE') {
  return retryable503(res, {
    ok: false,
    code,
    error: '이전 감지 결과를 안전하게 확인하는 중이에요. 잠시 후 같은 작업 번호로 다시 시도해 주세요.',
    charged: 0,
    cost
  });
}

// 같은 작업 번호로는 더 이상 결과를 돌려줄 수 없는 확정 상태. 재분석·재차감 없이 재시도 불가로 닫는다.
//   billed: 원장에 차감이 확정됐지만 보관된 결과가 만료·삭제됐거나 읽을 수 없다.
//   그 외: 차감 전이고, 이 작업 번호에 남은 기록을 읽을 수 없어 이어서 처리할 수 없다.
function resultUnrecoverable(res, cost, billed) {
  if (billed) {
    return res.status(410).json({
      ok: false,
      code: 'DETECT_RESULT_NO_LONGER_AVAILABLE',
      error: '이 작업 번호의 감지는 이미 크레딧이 차감됐지만, 보관된 결과를 더 이상 읽을 수 없어 다시 전달할 수 없어요. '
        + '같은 작업 번호로 다시 시도해도 결과는 돌아오지 않고 추가 차감도 없어요. '
        + '다시 분석하려면 새 작업으로 시작해 주세요. 새 분석은 크레딧이 차감돼요.',
      retryable: false,
      billingCommitted: true,
      charged: 0,
      cost
    });
  }
  return res.status(409).json({
    ok: false,
    code: 'DETECT_REQUEST_UNRECOVERABLE',
    error: '이 작업 번호에 남은 기록을 읽을 수 없어 이어서 처리할 수 없어요. 크레딧은 차감되지 않았어요. '
      + '새 작업 번호로 다시 시도해 주세요.',
    retryable: false,
    charged: 0,
    cost
  });
}

function validCachedArtifact(value) {
  return !!(value && cachedPublicResponse(value.publicResponse) && value.historyResult && value.metric);
}

function retryAfterSeconds(retryAfterMs) {
  const ms = Number(retryAfterMs);
  return Number.isFinite(ms) && ms > 0
    ? Math.min(Math.ceil(detectRequests.STALE_PROCESSING_MS / 1000), Math.ceil(ms / 1000)) : null;
}

function processingResponse(res, cost, retryAfterMs) {
  const seconds = retryAfterSeconds(retryAfterMs);
  if (seconds) res.set('Retry-After', String(seconds));
  return res.status(202).json({
    ok: false,
    status: 'PROCESSING',
    code: 'DETECT_REQUEST_PROCESSING',
    error: '같은 감지 작업을 처리하고 있어요. 잠시 후 다시 확인해 주세요.',
    retryable: true,
    charged: 0,
    cost,
    // 이 시간이 지나면 같은 작업 번호를 새로 처리할 수 있다(중단된 요청이 남긴 처리 상태 포함).
    ...(seconds ? { retryAfterSeconds: seconds } : {})
  });
}

// 과금 전 실패에서 처리 상태를 정리하지 못했을 때. 이후 같은 작업 번호는 한동안 202로 보이므로
// 저장 상태 확인이 필요하다는 것과 기다릴 시간을 함께 알린다.
function claimUnreleasedResponse(res, cost, code) {
  const seconds = Math.ceil(detectRequests.STALE_PROCESSING_MS / 1000);
  res.set('Retry-After', String(seconds));
  return res.status(503).json({
    ok: false,
    code,
    error: '감지 결과를 저장하지 못했고 처리 상태도 정리하지 못했어요. 크레딧은 차감되지 않았어요. '
      + '같은 작업 번호는 최대 10분 동안 처리 중으로 보일 수 있으니, 그 뒤에 다시 시도해 주세요.',
    retryable: true,
    claimReleased: false,
    retryAfterSeconds: seconds,
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
  return retryable503(res, {
    ...common,
    code: code === 'CREDIT_LOT_INCONSISTENT' ? code : 'DETECT_BILLING_UNAVAILABLE',
    error: '크레딧 처리를 완료하지 못했어요. 결과는 전달되지 않았습니다. 잠시 후 같은 작업 번호로 다시 시도해 주세요.'
  });
}

// 핸들러가 던진 오류도 반드시 응답으로 끝낸다. Express 4는 async 거절을 받지 않아 그대로 두면
// 연결이 타임아웃까지 열려 있고 PROCESSING claim이 남는다.
//   - 차감이 확정된 뒤의 오류: 이미 고정된 결과를 그대로 전달한다(같은 작업 번호 재시도도 추가 차감 없음).
//   - 그 전의 오류: 이 요청이 잡은 PROCESSING claim만 풀고 미차감 503으로 끝낸다. staged 결과는 보존된다.
async function failDetectReportSafely(res, flow, error) {
  logger.error('detect_report.unhandled_failure', {
    uid: flow.uid || undefined,
    requestId: flow.requestId || undefined,
    billed: flow.billed === true,
    err: error
  });
  if (res.headersSent) return;
  let paidBody = null;
  try {
    paidBody = flow.deliverable ? flow.deliverable() : null;
  } catch { /* 아래 미전달 응답으로 끝낸다 */ }
  if (paidBody) {
    res.json(paidBody);
    return;
  }
  if (flow.billed) {
    retryable503(res, {
      ok: false,
      code: 'DETECT_DELIVERY_UNCONFIRMED',
      error: '감지 결과를 전달하지 못했어요. 같은 작업 번호로 다시 시도하면 추가 차감 없이 결과를 받을 수 있어요.',
      // 차감은 확정됐다. 전달하지 못했다고 해서 차감이 없었다고 말하지 않는다.
      billingCommitted: true,
      cost: flow.cost
    });
    return;
  }
  if (flow.requestBinding && flow.claimed) {
    let released = false;
    try {
      released = await detectRequests.releaseAfterModelFailure(flow.requestBinding);
    } catch (releaseError) {
      logger.warn('detect_report.unhandled_failure_release_failed', { requestId: flow.requestId, err: releaseError });
    }
    if (released === false) {
      claimUnreleasedResponse(res, flow.cost, 'DETECT_REPORT_UNAVAILABLE');
      return;
    }
  }
  const availability = require('../lib/providerAvailability');
  if (availability.isUnavailable(error)) return retryable503(res, { ...availability.publicFailure(error), cost: flow.cost });
  retryable503(res, {
    ok: false,
    code: 'DETECT_REPORT_UNAVAILABLE',
    error: '감지 결과를 완료하지 못했어요. 크레딧은 차감되지 않았어요. 잠시 후 다시 시도해 주세요.',
    charged: 0,
    cost: flow.cost
  });
}

router.post('/detect-report', async (req, res) => {
  const flow = { uid: null, requestId: null, cost: 0, requestBinding: null, claimed: false, billed: false, deliverable: null };
  try {
    await handleDetectReport(req, res, flow);
  } catch (error) {
    try {
      await failDetectReportSafely(res, flow, error);
    } catch (responseError) {
      logger.error('detect_report.unhandled_failure_response_failed', { err: responseError });
      if (!res.headersSent) res.status(503).end();
    }
  }
});

async function handleDetectReport(req, res, flow) {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  // 글자수 기준 통일: 표시 카운트와 동일하게 공백 포함 raw length으로 최소 길이 판정.
  if (text.length < 100) return res.status(400).json({ error: 'AI 감지를 하려면 최소 100자가 필요해요.' });
  if (text.length > 30000) {
    return res.status(400).json({
      ok: false,
      code: 'INPUT_TOO_LONG',
      error: '텍스트가 너무 깁니다. (최대 30,000자)',
      limit: 30000,
      actual: text.length,
      charged: 0
    });
  }
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
  // Share raw detector results with /analyze regardless of route or billing.
  // The request/charge binding above remains separate and unchanged.
  const stabilityPayloadFingerprint = (!devNoAuth && uid)
    ? detectStability.payloadFingerprint({ text, lang: 'ko' })
    : null;
  const requestBinding = requestPayloadFingerprint ? {
    uid,
    requestId,
    payloadFingerprint: requestPayloadFingerprint,
    cost
  } : null;
  Object.assign(flow, { uid, requestId, cost, requestBinding });
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

    // 손상됐거나 응답 형태가 아닌 이력 보관본은 다시 읽어도 같다. 저장소 장애와 달리 여기서 503으로
    // 멈추지 않고, 온전한 요청 캐시가 있으면 그쪽에서 replay한다.
    let historyState = historyIdempotency.state;
    if (historyState === 'READY' && !cachedPublicResponse(historyIdempotency.response)) historyState = 'UNREADABLE';
    if (historyState === 'UNREADABLE') {
      logger.error('detect_report.idempotency_history_unreadable', {
        uid,
        requestId,
        code: String(historyIdempotency.error?.code || 'DETECT_RESPONSE_CACHE_INVALID')
      });
    }
    const billedBefore = creditIdempotency.state === 'DUPLICATE';

    if (billedBefore && historyState === 'READY') {
      const replayed = replayCachedResponse(res, historyIdempotency.response, {
        charged: 0,
        remainingCredits: creditIdempotency.remainingCredits
      });
      logger.info('detect_report.idempotent_replay', {
        uid: undefined,
        clientRequestId: requestId,
        scoreSource: 'request_replay',
        idempotentReplay: true,
        probability: replayed.probability,
        charged: replayed.charged,
        remainingCredits: replayed.remainingCredits,
        lengthBucket: detectTextLengthBucket(text.length)
      });
      return;
    }
    if (!chargeEligible && historyState === 'READY') {
      replayCachedResponse(res, historyIdempotency.response, {
        charged: 0,
        remainingCredits: null
      });
      return;
    }
    if (creditIdempotency.state === 'NEW' && historyState !== 'NOT_FOUND') {
      if (historyState === 'UNREADABLE') return resultUnrecoverable(res, cost, false);
      return idempotencyReused(res, cost);
    }

    // 이미 차감된 요청은 처리 상태를 새로 잡지 않는다. 고정된 결과가 있으면 replay하고,
    // 없으면 아래에서 재분석·재차감 없이 닫는다.
    requestClaim = billedBefore
      ? await detectRequests.lookup(requestBinding)
      : await detectRequests.begin(requestBinding);
    flow.claimed = requestClaim.state === 'NEW';
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
    // 저장소를 읽지 못한 일시 장애는 차감 여부와 무관하게 재시도 가능으로 남긴다.
    if (['INVALID', 'UNAVAILABLE'].includes(requestClaim.state)) {
      return idempotencyUnavailable(res, cost, 'IDEMPOTENCY_CHECK_UNAVAILABLE');
    }
    if (requestClaim.state === 'PROCESSING') return processingResponse(res, cost, requestClaim.retryAfterMs);
    if (['RESULT_READY', 'COMPLETE'].includes(requestClaim.state)) {
      if (validCachedArtifact(requestClaim.response)) cachedArtifact = requestClaim.response;
      else requestClaim = { state: 'CORRUPT' };
    }
    // 원장·이력·요청 캐시를 모두 읽은 뒤의 확정 상태: 차감은 됐는데 돌려줄 결과가 어디에도 없다.
    if (billedBefore && !cachedArtifact) {
      logger.error('detect_report.charged_result_unrecoverable', {
        uid,
        requestId,
        historyState,
        requestState: requestClaim.state,
        cost
      });
      return resultUnrecoverable(res, cost, true);
    }
    if (requestClaim.state === 'CORRUPT') return resultUnrecoverable(res, cost, false);
    // 차감 대상이 아닌 요청에 읽을 수 없는 이력만 남은 경우도 다시 시도해서 달라지지 않는다.
    if (['INCOMPLETE', 'UNREADABLE'].includes(historyState) && !cachedArtifact) {
      await detectRequests.releaseAfterModelFailure(requestBinding);
      return resultUnrecoverable(res, cost, false);
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
    artifact = {
      publicResponse: cachedPublicResponse(cachedArtifact.publicResponse),
      historyResult: cachedArtifact.historyResult,
      metric: cachedArtifact.metric
    };
    usedCachedArtifact = true;
  } else {
    // ② 결정론 분석(무LLM) — 실패하면 보고서 자체가 성립 안 되므로 여기서만 500
    try { assertDetectInputAdmissible(text); }
    catch (error) {
      if (requestBinding) await detectRequests.releaseAfterModelFailure(requestBinding);
      return res.status(error.status || 422).json({ ok: false, code: error.code, error: error.message, charged: 0, retryable: false });
    }
    let ir, paras, analysisParas, previewParas, detail, reportMeasurements;
    try {
      paras = sg.splitParagraphsForReport(text);
      const surface = require('../lib/detectSurfaceInput').buildDetectSurfaceInput(paras);
      analysisParas = surface.analysisParagraphs;
      previewParas = surface.previewParagraphs;
      ir = sg.classifyInputRisk(surface.text);
      detail = surface.detail;
      reportMeasurements = surface.measurements;
    } catch (error) {
      if (requestBinding) await detectRequests.releaseAfterModelFailure(requestBinding);
      logger.error('detect_report.surface_failed', { uid, err: error });
      return res.status(500).json({ error: '감지 처리 중 오류가 발생했어요.', charged: 0, cost });
    }
    const grade = ir.grade || 'B';
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
      }, async sharedSignal => {
        const detected = await gptAnalyze.runDetect(text, 'ko', {
          config: gptCfg,
          route: 'detect_report',
          allowLocalFallback: false,
          uid: uid || '',
          signal: sharedSignal,
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

    const before = pickAiSentence(previewParas, detail);
    const previewTask = startDetectPreview(async signal => {
          if (!before) return null;
          const gptCfg = await activeGptConfig();
          if (!gptCfg) throw Object.assign(new Error('GPT_PROVIDER_UNAVAILABLE'), { code: 'GPT_PROVIDER_UNAVAILABLE' });
          const result = await gptAnalyze.rewriteSentence({ text: before, lang: 'ko', config: gptCfg, uid: uid || '', signal });
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
        }, {
          onError: error => logger.warn('detect_report.preview_failed', { uid, err: error }),
          onOutcome: outcome => logger.info('detect_report.preview_outcome', { requestId, ...outcome })
        });
    const det = await detectP;
    if (!det) previewTask.cancel();
    const example = await previewTask.result;
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
      const availability = require('../lib/providerAvailability');
      if (availability.isUnavailable(detectError)) return retryable503(res, { ...availability.publicFailure(detectError), cost });
      return retryable503(res, {
        ok: false,
        error: 'AI 감지 모델 응답을 받지 못했어요. 크레딧은 차감되지 않았어요. 잠시 후 다시 시도해 주세요.',
        code: 'DETECT_MODEL_UNAVAILABLE',
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
      return retryable503(res, {
        ok: false,
        code: 'DETECT_CALIBRATION_UNAVAILABLE',
        error: '감지 결과를 안전하게 확정하지 못했어요. 크레딧은 차감되지 않았습니다.',
        charged: 0,
        cost
      });
    }
    // 표시 척도(개발 후보, 기본 OFF): 엔진·이력 보정 뒤 화면에 내보내는 숫자만 바꾼다. rawProbability·캐시·원글 상한은 그대로.
    const scale = require('../lib/detectScaleCalibration').applyScaleCalibration({
      probability: calibration.probability, chars: text.length, profile: advancedRouting.profile, probSource: 'llm'
    });
    const probability = scale.probability;
    // 척도가 적용된 점수는 이력의 원글 점수와 같은 자가 아니므로 증감 비교는 내보내지 않는다.
    const historyComparison = scale.applied ? null : (calibration.comparison || null);
    const narrated = applyDetectNarrativePolicy(det, probability);
    narrated.signalEvidence = locatePublicEvidence(narrated.signalEvidence, text);
    // 문장 지도와 보고서 계측은 무LLM·무추가비용이다. 권위 점수 모델이 성공한 뒤에만
    // 공개 보고서에 결합하고, 지도 생성 실패는 점수·과금 흐름과 분리한다.
    let sentenceMap = null;
    try {
      sentenceMap = buildSentenceMap(analysisParas, detail, { sourceParagraphs: paras, source: text });
    } catch (error) {
      logger.warn('detect_report.sentence_map_failed', { uid, err: error && error.message });
    }
    narrated.signalEvidence = require('../lib/detectReportLocations').projectReportEvidence(narrated.signalEvidence, sentenceMap);
    const publicInputDocument = buildDetectInputDocument(text);
    const reportView = buildDetectReportView({
      sourceText: text,
      sourceParagraphs: analysisParas,
      probability,
      probSource: 'llm',
      confidence: det.confidence,
      finalCandidateConsistency: det.detectDiagnostics?.finalCandidateConsistency,
      detectDiagnostics: det.detectDiagnostics,
      textLength: text.length,
      riskLevel: narrated.riskLevel,
      calibrationApplied: calibration.applied,
      preCalibrationProbability: rawProbability,
      statisticalSupport: det.statisticalSupport,
      statisticalReference: det.statisticalReference,
      inputIncomplete: publicInputDocument.inputIncomplete,
      eligibleSentenceCount: publicInputDocument.eligibleSentenceCount,
      // 원인 레이더 축 정책용 — 글 종류·신뢰도(이미 계산된 값, 추가 비용 없음)
      documentProfile: {
        profile: advancedRouting.profile,
        confidence: advancedRouting.confidence,
        profileMargin: advancedRouting.profileMargin
      },
      signalEvidence: narrated.signalEvidence,
      signals: narrated.signals,
      // 다듬을 대상(위치 검증 문장) 계산용 — 계측이 문장 단위로 잡은 일반 표현·종결 반복도 근거로 센다.
      sentenceMap,
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
    const interpretation = reportView.interpretation;
    const contentDisplay = contentPresentation(reportView, detail);
    const publicSummary = interpretation.headline;
    const publicDetail = [interpretation.description, interpretation.evidence.reason,
      ...interpretation.nextSteps, ...interpretation.limitations].join('\n\n');
    const len = text.length;
    const B = BANDS;
    const historyResult = {
      probability,
      ...require('../lib/detectStatisticalAssist').projectProvenance(det),
      ...require('../lib/detectScorePresentation').scorePresentation(calibration),
      statisticalReference: require('../lib/detectStatisticalAssist').sanitizeReference(det.statisticalReference),
      historyComparison,
      ...(scale.meta ? { scaleCalibration: scale.meta } : {}),
      riskLevel: narrated.riskLevel,
      riskLabel: narrated.riskLabel,
      summary: publicSummary,
      detail: publicDetail,
      interpretation,
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
      detectDiagnostics: require('../lib/detectDiagnostics').withDisplayedScore(det.detectDiagnostics, probability),
      statisticalSupport: require('../lib/detectStatisticalAssist').sanitizeSupport(det.statisticalSupport),
      causeScoreAdjusted: det.causeScoreAdjusted === true,
      causeScoreCeiling: Number.isFinite(Number(det.causeScoreCeiling)) ? det.causeScoreCeiling : null,
      causeScoreAdjustmentCode: det.causeScoreAdjustmentCode || null,
      documentProfile: advancedRouting.profile,
      profileConfidence: advancedRouting.confidence,
      profileMargin: advancedRouting.profileMargin,
      profileAmbiguous: reportView.measuredEvidence?.axisPolicy?.ambiguousProfile === true,
      ...(calibration.meta ? {
        probabilityCalibration: calibration.meta
      } : {})
    };
    const publicResponse = {
      ok: true,
      ...require('../lib/detectStatisticalAssist').projectProvenance(det),
      ...require('../lib/detectScorePresentation').scorePresentation(calibration),
      statisticalReference: require('../lib/detectStatisticalAssist').sanitizeReference(det.statisticalReference),
      free: false,
      charged: chargeEligible ? cost : 0,
      historySaved: false,
      probability,
      historyComparison,
      historyComparisonProof: signHistoryComparison(uid, text, probability, historyComparison),
      ...(scale.meta ? { scaleCalibration: scale.meta, rawProbability } : {}),
      ...(calibration.applied ? {
        rawProbability: calibration.rawProbability,
        calibrated: true,
        probabilityCalibration: calibration.meta
      } : {}),
      probSource: 'llm',
      riskLevel: narrated.riskLevel,
      riskLabel: narrated.riskLabel,
      summary: publicSummary,
      detail: publicDetail,
      interpretation,
      interpretationProof: signDetectInterpretation(uid, text, interpretation),
      reportView,
      sentenceMap,
      // 퍼널 계측용 — 화면에 표시하지 않고 휴머나이징 요청·이벤트에 최초 감지기 버전으로 실린다.
      detectorVersion: det.gptMeta?.engine || null,
      grade: contentDisplay.grade,
      title: contentDisplay.title,
      contentAssessmentStatus: contentDisplay.assessmentStatus,
      abstractRiskRatio: contentDisplay.grade === null ? null : ir.abstractRiskRatio,
      restructureUnfit: advancedRouting.effectiveUnfit.unfit === true,
      restructureUnfitReason: advancedRouting.effectiveUnfit.reason || null,
      restructureUnfitKind: advancedRouting.effectiveUnfit.kind || null,
      advancedEligible: advancedRouting.advancedEligible,
      recommendedMode: advancedRouting.recommendedMode,
      recommendationCode: advancedRouting.recommendationCode || null,
      recommendationReason: advancedRouting.recommendationReason || null,
      recommendationVersion: advancedRouting.recommendationVersion,
      recommendationSignals: advancedRouting.recommendationSignals,
      documentProfile: advancedRouting.profile,
      profileConfidence: Number(advancedRouting.confidence.toFixed(4)),
      profileMargin: advancedRouting.profileMargin,
      routingOverride: advancedRouting.routingOverride || null,
      advancedTimeEstimate,
      paragraphs: paras.map((paragraph, index) => {
        const presentation = contentDisplay.paragraphs[index];
        return {
          idx: index,
          ...presentation,
          ...(detail[index]?.excluded ? { excluded: true } : {}),
          snippet: paragraph.slice(0, 140),
          text: paragraph.length > 140 ? paragraph : undefined,
          coach: detail[index]?.excluded ? null : filterContentCoach(predictCoach(analysisParas[index]), reportView,
            { evidenceStatus: presentation.assessmentStatus, findingStatus: presentation.findingStatus,
              contentContext: presentation.contentContext, sentenceCount: detail[index]?.sents || 0 })
        };
      }),
      coach: filterContentCoach(predictCoach(analysisParas.join('\n\n'), 0.5), reportView,
        { sentenceCount: reportView.contentEvidence.total }),
      counts: {
        total: paras.length,
        risk: contentDisplay.paragraphs.filter(item => item.kind === 'abstract_risk').length,
        thin: contentDisplay.paragraphs.filter(item => item.kind === 'thin').length,
        notAssessed: contentDisplay.paragraphs.filter(item => item.kind === 'not_assessed').length,
        excluded: detail.filter(item => item.excluded).length,
        safe: contentDisplay.paragraphs.filter(item => item.kind === 'concrete').length
      },
      example,
      exampleStatus: example ? 'ready' : (before ? 'unavailable' : 'no_candidate'),
      exampleUnavailableReason: example ? null : previewTask.outcome?.status || 'no_example',
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
        grade: contentDisplay.grade,
        ...require('../lib/detectStatisticalAssist').projectProvenance(det),
        probability,
        rawProbability,
        modelProbability: Number.isFinite(Number(det.modelProbability)) ? det.modelProbability : rawProbability,
        detectDiagnostics: require('../lib/detectDiagnostics').withDisplayedScore(det.detectDiagnostics, probability),
        statisticalSupport: require('../lib/detectStatisticalAssist').sanitizeSupport(det.statisticalSupport),
        causeScoreAdjusted: det.causeScoreAdjusted === true,
        causeScoreCeiling: Number.isFinite(Number(det.causeScoreCeiling)) ? det.causeScoreCeiling : null,
        causeScoreAdjustmentCode: det.causeScoreAdjustmentCode || null,
        calibrated: calibration.applied,
        calibration: calibration.meta || null,
        scaleCalibration: scale.meta,
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
        // 유도 계약(접근/추천) — 밴드별로 유도가 얼마나 열렸는지 로그로 센다. 본문·문장 내용은 없다.
        conversionAccess: reportView.conversion.access,
        conversionRecommend: reportView.conversion.recommend,
        conversionCandidates: reportView.conversion.candidateSentences,
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
      if (staged.state === 'TOO_LARGE') {
        // 같은 입력은 같은 크기의 결과를 만든다. 재시도 가능으로 답하면 503이 끝없이 반복된다.
        await detectRequests.releaseAfterModelFailure(requestBinding);
        logger.error('detect_report.result_cache_too_large', {
          uid,
          requestId,
          lengthBucket: detectTextLengthBucket(text.length)
        });
        return res.status(422).json({
          ok: false,
          code: 'DETECT_RESULT_TOO_LARGE',
          error: '분석 결과가 너무 커서 안전하게 저장하지 못했어요. 크레딧은 차감되지 않았어요. 글을 나누어 다시 분석해 주세요.',
          retryable: false,
          charged: 0,
          cost
        });
      }
      // 먼저 고정된 결과가 읽히지 않는다. 같은 작업 번호로는 달라지지 않으므로 재시도 불가로 닫는다(차감 전).
      if (staged.state === 'CORRUPT' || (['RESULT_READY', 'COMPLETE'].includes(staged.state)
          && staged.response && staged.response !== artifact && !validCachedArtifact(staged.response))) {
        return resultUnrecoverable(res, cost, false);
      }
      if (!['RESULT_READY', 'COMPLETE'].includes(staged.state) || !staged.response) {
        // 저장소 장애라면 claim 정리도 실패할 수 있다. 그때는 남는 처리 상태를 숨기지 않는다.
        const released = await detectRequests.releaseAfterModelFailure(requestBinding);
        if (released === false) return claimUnreleasedResponse(res, cost, 'IDEMPOTENCY_CACHE_UNAVAILABLE');
        return idempotencyUnavailable(res, cost, 'IDEMPOTENCY_CACHE_UNAVAILABLE');
      }
      if (staged.response !== artifact) {
        artifact = { ...staged.response, publicResponse: cachedPublicResponse(staged.response.publicResponse) };
        // Serialization clones even a newly staged result. Object identity is
        // not evidence of replay; the transaction tells us if an older result won.
        usedCachedArtifact = usedCachedArtifact || staged.reused === true;
      }
    }
  }

  if (req.aborted) return;

  let charged = chargeEligible && creditIdempotency.state !== 'DUPLICATE' ? cost : 0;
  let remainingCredits = creditIdempotency.remainingCredits;
  let responseBody = null;
  const deliveredBody = () => ({
    ...artifact.publicResponse,
    charged,
    historySaved: false,
    ...(Number.isFinite(Number(remainingCredits))
      ? { remainingCredits: Math.max(0, Math.floor(Number(remainingCredits))) }
      : {}),
    ...(usedCachedArtifact ? { idempotentReplay: true } : {})
  });
  // 차감이 확정된 순간부터는 뒤따르는 저장·계측 오류와 무관하게 이 결과를 전달할 수 있다.
  flow.deliverable = () => responseBody || (flow.billed ? deliveredBody() : null);
  if (chargeEligible && creditIdempotency.state === 'DUPLICATE') flow.billed = true;
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
        flow.billed = true;
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
        flow.billed = true;
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

  responseBody = deliveredBody();
  try {
    const meta = require('../lib/metaConversions');
    responseBody.activation = await require('../lib/featureActivation').recordFirstSuccess({
      db, uid, runId: requestId, feature: 'detect', chars: text.length,
      isInternal: devNoAuth || ADMIN_UIDS.includes(uid),
      context: { ...meta.normalizeContext(req.body?.meta), userAgent: req.get('user-agent') }
    });
  } catch (error) { logger.warn('marketing.activation_record_failed', { code: error?.code || 'storage_error' }); }
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
        // 이력에 먼저 저장된 응답이 이 요청의 결과다. 형태가 맞지 않으면 차감된 결과를 막지 않고
        // 고정된 결과를 그대로 전달하되, 다시 열 수 있는 이력으로 저장됐다고 말하지 않는다.
        const existing = cachedPublicResponse(saved.response);
        if (existing) {
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
        } else {
          historySaved = false;
          logger.error('detect_report.idempotency_history_unreadable', { uid, requestId, code: 'DETECT_RESPONSE_CACHE_INVALID' });
        }
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
    recommendedMode: responseBody.recommendedMode,
    recommendationVersion: responseBody.recommendationVersion,
    recommendationCode: responseBody.recommendationCode,
    recommendationSignals: responseBody.recommendationSignals,
    uid,
    grade: metric.grade,
    probability: metric.probability,
    rawProbability: metric.calibrated ? metric.rawProbability : undefined,
    calibrated: metric.calibrated,
    calibration: metric.calibration || undefined,
    scaleCalibration: metric.scaleCalibration || undefined,
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
    scoreSource: usedCachedArtifact ? 'request_replay' : metric.detectCacheHit ? 'cached_llm' : 'llm',
    idempotentReplay: usedCachedArtifact,
    probability: metric.probability,
    rawProbability: metric.rawProbability,
    modelProbability: metric.modelProbability,
    detectDiagnostics: metric.detectDiagnostics,
    statisticalSupport: metric.statisticalSupport,
    ...require('../lib/detectStatisticalAssist').projectProvenance(metric),
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
    scaleCalibration: metric.scaleCalibration || undefined,
    charged,
    latencyMs: metric.scoreLatencyMs,
    lengthBucket: detectTextLengthBucket(text.length)
  });

  // CPU-only comparison after the successful billing/history path. It never
  // replaces the public score and is not stored in a user-visible result.
  if (!usedCachedArtifact) {
    const evidenceShadow = require('../lib/detectEvidenceShadow').evaluateShadow(text, metric, { sampleKey: requestId || '' });
    if (evidenceShadow) logger.info('detect_report.evidence_shadow', {
      uid: undefined,
      requestId: requestId || undefined, detectorVersion: metric.detectorVersion,
      detectCacheHit: metric.detectCacheHit === true, ...evidenceShadow
    });
  }

  publicMetrics.trackDeliveredMetric(res, {
    operation: 'detect',
    eventId: requestId || String(res.getHeader('x-request-id') || crypto.randomUUID()),
    uid,
    processedCharacters: text.length,
    isAdmin: ADMIN_UIDS.includes(uid),
    isTest: devNoAuth
  }, { db, logger });
  return res.json(responseBody);
}

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

router.failDetectReportSafely = failDetectReportSafely;   // 회귀 테스트용
module.exports = router;
