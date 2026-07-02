// [분석 API] 텍스트/PDF AI 탐지 및 휴머나이즈 처리
// ★ 탐지(detect)·휴머나이즈·웹 검색 모두 Anthropic Claude.
// ★ Anthropic prompt caching: detect/humanize 시스템 프롬프트에 cache_control: ephemeral (5분 TTL).
// ★캐시 최소 prefix: Sonnet 4.6=1,024토큰, Haiku 4.5=4,096토큰(공식 docs 확인 2026-06-19 — 이전 "2048"은 오기).
//   cache_control은 무조건 적용하고 API가 임계 충족 시 자동 캐시(미달이면 무해한 no-op)라 비용누수는 없다.
//   FLOOR humanize system은 고정코어/가변부 2블록 분리(2026-06-16): 고정코어만 캐시 → 메모·evidence·앵커가
//   달라도 cache_read 재사용. judge system(300~1000토큰)은 Sonnet 1024 미만이라 여전히 캐시 불가.

const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');
const { getDetectSystem, getHumanizeSystem } = require('../prompts');
const { admin, db } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const { bearerToken } = require('../lib/reqtoken');   // idToken: 헤더 우선·body/query 폴백(deprecated)
const detectCalibration = require('../lib/detectCalibration');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const WEB_SEARCH_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const CLAUDE_CACHE_MIN_PREFIX_CHARS = Number(process.env.CLAUDE_CACHE_MIN_PREFIX_CHARS) || 3000;

function shortHash(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

// ── 중복 제출 디바운스(2026-06-19 실측 #57·#58: 같은 사용자가 동일 10510자를 1초 간격으로 두 번 제출 →
//   requestId 멱등이 없는 구버전 클라이언트라 이중 차감·이중 결과). requestId 멱등(creditHistory/req_*)이
//   닿지 않는 구간을 메모리 단기창으로 막는다: 같은 uid+opType+내용을 짧은 창(기본 20초) 안에 다시 보내면
//   거절(무차감). 영구 차단이 아닌 단기창이라, 분 단위로 떨어진 정상 재실행·모드비교(#106/#109 등)는 허용.
//   DEDUP_WINDOW_MS=0으로 해제. (LLM 처리가 수초 걸리는 in-flight 구간을 자연히 덮는다.)
const recentSubmits = new Map();   // key(uid:opType:sha1) → ts(ms)
const SUBMIT_DEDUP_WINDOW_MS = process.env.DEDUP_WINDOW_MS != null ? Number(process.env.DEDUP_WINDOW_MS) : 20000;
function submitDedupKey(uid, opType, text) {
  return uid + ':' + opType + ':' + crypto.createHash('sha1').update(text || '').digest('hex');
}
function recentDuplicateSubmit(key) {
  const prev = recentSubmits.get(key);
  return prev != null && (Date.now() - prev) < SUBMIT_DEDUP_WINDOW_MS;
}
setInterval(() => {
  const cut = Date.now() - Math.max(SUBMIT_DEDUP_WINDOW_MS, 60000);
  for (const [k, ts] of recentSubmits) if (ts < cut) recentSubmits.delete(k);
}, 60000).unref();

function jsonCharLength(value) {
  if (!value) return 0;
  try { return JSON.stringify(value).length; }
  catch { return 0; }
}

// ── 모드 라벨 정규화(2026-06-19 실측 #18·#57·#58: 구버전/직접호출 클라이언트가 mode를 "humanize"·빈값으로 보내
//   history mode가 비거나 원시값으로 남음 → 분석·CS·환불대응 시 어떤 모드였는지 불명). 표시·기록용 라벨만 정규화하고
//   (엔진 동작은 req.body.engine/humanizeMode가 좌우하므로 불변), 인식 못 한 입력은 로깅해 구버전 클라이언트를 식별한다.
const KNOWN_HUMANIZE_LABELS = ['글쓰기 스타일', '기본 피하기', '그대로 다듬기'];
function normalizeHumanizeModeLabel(rawMode, body) {
  if (KNOWN_HUMANIZE_LABELS.includes(rawMode)) return rawMode;
  const hm = body && body.humanizeMode;
  if (body && body.engine === 'floorV2') return (hm === 'blog' || !hm) ? '기본 피하기' : '글쓰기 스타일';
  if (hm === 'polish' || hm === 'preserve' || hm === '그대로 다듬기') return '그대로 다듬기';
  if (hm === 'blog' || hm === '기본 피하기') return '기본 피하기';
  return '글쓰기 스타일';   // 기본(assignment)
}

// 토큰 검증 + 잔량 사전 확인. Firestore 읽기만. 차감 없음.
async function precheckCredits(idToken, needed) {
  if (!idToken) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { throw Object.assign(new Error('AUTH_INVALID'), { status: 401 }); }
  const uid = decoded.uid;
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
  const d = snap.data();
  const plan = d.plan || 'free';
  if (plan === 'unlimited') return { uid, plan };
  const credits = d.credits || 0;
  if (credits < needed) throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 });
  return { uid, plan };
}

// 결과 정상 후 호출. 원자적 차감 + creditHistory 기록.
// 트랜잭션 안에서 다시 잔량을 검증해 동시 호출 레이스에서도 안전.
// ★ 멱등성(requestId): 같은 작업이 두 번 도달해도 한 번만 차감한다.
//   "차감+응답까지 끝났는데 응답 패킷만 유실 → 프런트 재시도 → 중복 차감" 민원(#11·#16 등)의 구조적 차단.
//   creditHistory 문서 ID를 requestId로 고정하고, 트랜잭션 안에서 존재하면 재차감을 건너뛴다.
// meta(선택): 관리자/이용 기록에 "정확히 무슨 작업이었는지" 표시하기 위한 설명용 필드.
//   과금 계산엔 영향 없음(순수 기록). { mode: 'polish'|'blog'|'formal'|'assignment'..., evidence, textLength, fallback }
//   값이 있을 때만 저장(구 문서·구 호출과 하위호환).
async function commitCreditDeduct(uid, needed, opType, requestId, meta = {}) {
  const userRef = db.collection('users').doc(uid);
  const histRef = requestId
    ? userRef.collection('creditHistory').doc('req_' + requestId)
    : userRef.collection('creditHistory').doc();
  await db.runTransaction(async (t) => {
    const snap = await t.get(userRef);
    if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    // 트랜잭션 규칙상 모든 read는 write보다 먼저 — 멱등 키 존재 여부를 여기서 확인.
    const dup = requestId ? (await t.get(histRef)).exists : false;
    const d = snap.data();
    if ((d.plan || 'free') === 'unlimited') return;
    if (dup) return;   // 이미 차감된 작업 — 중복 차단
    const credits = d.credits || 0;
    if (credits < needed) throw Object.assign(new Error('INSUFFICIENT_CREDITS'), { status: 402 });
    const newCredits = credits - needed;
    t.update(userRef, { credits: newCredits });
    t.set(histRef, {
      type: opType, used: needed, amount: 0, remaining: newCredits,
      ...(meta.mode ? { mode: String(meta.mode) } : {}),
      ...(meta.evidence != null ? { evidence: !!meta.evidence } : {}),
      ...(meta.textLength ? { textLength: Number(meta.textLength) || 0 } : {}),
      ...(meta.fallback ? { fallback: true } : {}),
      ...(requestId ? { requestId } : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

// 복구: 차감은 commit 됐는데 응답 전 client disconnect 등으로 결과를 못 받았을 때 호출.
// commitCreditDeduct를 뒤집어 크레딧을 되돌리고 복구 이력을 기록.
async function commitCreditRestore(uid, amount, opType, requestId) {
  const userRef = db.collection('users').doc(uid);
  const deductRef = requestId ? userRef.collection('creditHistory').doc('req_' + requestId) : null;
  const restoreRef = requestId
    ? userRef.collection('creditHistory').doc('restore_req_' + requestId)
    : userRef.collection('creditHistory').doc();
  await db.runTransaction(async (t) => {
    const snap = await t.get(userRef);
    if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    // ★ 멱등(C-09): 모든 read는 write 전에. 이미 복구됐거나(restore 문서 존재) 원 차감이
    //   없으면(차감 안 됨) 복구를 건너뛴다 — 응답만 유실된 재시도에서 중복 적립을 차단.
    if (requestId) {
      if ((await t.get(restoreRef)).exists) return;
      if (!(await t.get(deductRef)).exists) return;
    }
    const d = snap.data();
    if ((d.plan || 'free') === 'unlimited') return;
    const credits = d.credits || 0;
    const newCredits = credits + amount;
    t.update(userRef, { credits: newCredits });
    t.set(restoreRef, {
      type: `${opType}_restore`, used: -amount, amount: 0, remaining: newCredits,
      ...(requestId ? { requestId } : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

// 일시적 실패(트랜잭션 경합·네트워크) 백오프 재시도. Firestore 트랜잭션은 commit 성공 시
// throw하지 않는 원자성이 있어, throw 후 재시도해도 중복 적용이 생기지 않는다(복구 중복 방지).
// 영구적 오류(404 등)는 재시도해도 결과가 안 바뀌므로 즉시 중단.
async function retryAsync(fn, attempts = 3, baseDelayMs = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (e?.status === 404) throw e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

// 정기결제(Pro 탭) 쿠폰 검증 + 1회 차감. 결제는 텍스트 길이 1회당 쿠폰 1개.
const SUB_CHAR_LIMITS = { '1000': 1000, '5000': 5000, '10000': 10000, 'unlimited': -1 };

// 쿠폰: 토큰 검증 + 구독 유효성 + 잔량/한도 확인. Firestore 읽기만.
async function precheckCoupon(idToken, textLength) {
  if (!idToken) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { throw Object.assign(new Error('AUTH_INVALID'), { status: 401 }); }
  const uid = decoded.uid;
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
  const d = snap.data();
  const sub = d.subscription;
  if (!sub) throw Object.assign(new Error('NO_SUBSCRIPTION'), { status: 403 });
  const nextMs = sub.nextBillingAt?.toMillis ? sub.nextBillingAt.toMillis() : 0;
  const valid = sub.status === 'active' || (sub.status === 'cancelled' && nextMs > Date.now());
  if (!valid) throw Object.assign(new Error('SUBSCRIPTION_INACTIVE'), { status: 403 });
  const tier = sub.tier;
  const charLimit = SUB_CHAR_LIMITS[tier];
  if (charLimit === undefined) throw Object.assign(new Error('INVALID_TIER'), { status: 500 });
  if (charLimit !== -1 && textLength > charLimit) {
    throw Object.assign(new Error('COUPON_LIMIT_EXCEEDED'), { status: 400, charLimit });
  }
  if (tier !== 'unlimited') {
    const remaining = d.coupon?.remaining ?? 0;
    if (remaining <= 0) throw Object.assign(new Error('NO_COUPON'), { status: 402 });
  }
  return { uid, billingMode: 'coupon', tier };
}

// 쿠폰: 결과 정상 후 호출. 원자적 차감 + couponHistory 기록.
// ★ 멱등성(requestId): commitCreditDeduct와 동일 — 같은 작업 재도달 시 1회만 차감.
async function commitCouponUsage(uid, tier, opType, textLength, requestId) {
  const userRef = db.collection('users').doc(uid);
  const histRef = requestId
    ? userRef.collection('couponHistory').doc('req_' + requestId)
    : userRef.collection('couponHistory').doc();
  await db.runTransaction(async (t) => {
    const snap = await t.get(userRef);
    if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    const dup = requestId ? (await t.get(histRef)).exists : false;
    const d = snap.data();
    const sub = d.subscription;
    if (!sub) throw Object.assign(new Error('NO_SUBSCRIPTION'), { status: 403 });
    if (dup) return;   // 이미 차감된 작업 — 중복 차단
    if (tier === 'unlimited') {
      t.update(userRef, { 'coupon.used': admin.firestore.FieldValue.increment(1) });
      t.set(histRef, {
        type: 'use', tier, amount: 0, remaining: -1,
        mode: opType, textLength,
        ...(requestId ? { requestId } : {}),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return;
    }
    const remaining = d.coupon?.remaining ?? 0;
    if (remaining <= 0) throw Object.assign(new Error('NO_COUPON'), { status: 402 });
    const newRemaining = remaining - 1;
    t.update(userRef, {
      'coupon.remaining': newRemaining,
      'coupon.used': admin.firestore.FieldValue.increment(1)
    });
    t.set(histRef, {
      type: 'use', tier, amount: -1, remaining: newRemaining,
      mode: opType, textLength,
      ...(requestId ? { requestId } : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

// 쿠폰 복구: 차감 commit 후 client disconnect 등으로 결과 못 받았을 때 호출.
async function commitCouponRestore(uid, tier, opType, textLength, requestId) {
  const userRef = db.collection('users').doc(uid);
  const deductRef = requestId ? userRef.collection('couponHistory').doc('req_' + requestId) : null;
  const restoreRef = requestId
    ? userRef.collection('couponHistory').doc('restore_req_' + requestId)
    : userRef.collection('couponHistory').doc();
  await db.runTransaction(async (t) => {
    const snap = await t.get(userRef);
    if (!snap.exists) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
    // ★ 멱등(C-09): 이미 복구됐거나 원 차감이 없으면 건너뛴다(재시도 시 중복 환원 차단).
    if (requestId) {
      if ((await t.get(restoreRef)).exists) return;
      if (!(await t.get(deductRef)).exists) return;
    }
    if (tier === 'unlimited') {
      t.update(userRef, { 'coupon.used': admin.firestore.FieldValue.increment(-1) });
      t.set(restoreRef, {
        type: 'restore', tier, amount: 0, remaining: -1,
        mode: opType, textLength,
        ...(requestId ? { requestId } : {}),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return;
    }
    const d = snap.data();
    const remaining = d.coupon?.remaining ?? 0;
    const newRemaining = remaining + 1;
    t.update(userRef, {
      'coupon.remaining': newRemaining,
      'coupon.used': admin.firestore.FieldValue.increment(-1)
    });
    t.set(restoreRef, {
      type: 'restore', tier, amount: 1, remaining: newRemaining,
      mode: opType, textLength,
      ...(requestId ? { requestId } : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

function authErrorMessage(code) {
  return ({
    AUTH_REQUIRED: '로그인이 필요합니다.',
    AUTH_INVALID: '로그인 정보가 만료됐어요. 다시 로그인해주세요.',
    USER_NOT_FOUND: '사용자 정보를 찾을 수 없습니다.',
    INSUFFICIENT_CREDITS: '크레딧이 부족합니다.',
    NO_SUBSCRIPTION: 'Pro 구독이 필요합니다.',
    SUBSCRIPTION_INACTIVE: '구독이 만료되었거나 활성 상태가 아닙니다.',
    NO_COUPON: '이번 사이클의 쿠폰을 모두 사용했습니다. 다음 결제일에 갱신됩니다.',
    COUPON_LIMIT_EXCEEDED: '현재 구독 티어의 글자 수 한도를 초과했습니다.',
    INVALID_TIER: '구독 정보가 올바르지 않습니다. 관리자에 문의해주세요.'
  })[code] || '인증/결제 확인에 실패했습니다.';
}

// ★ 구조화 출력용 schema 정의 (OpenAI strict json_schema 변환용 베이스)
// ★ mode별 스키마 분기: assignment만 의문문/접속사/P3/문단비율 필드 강제
// 함수명에 "Tool"이 남아 있는 건 기존 구조 유지용 — 실제로는 OpenAI strict json_schema로 변환됨
function buildHumanizeTool(mode, lang = 'ko') {
  // ★ JSON-CoT 베스트 프랙티스(ACL submission + Pockit/Collin Wilkins 2026): reasoning 필드를 answer 필드 앞에 둠.
  //   reasoning before answer → +60% 정확도 (GSM8k 측정), 모델이 답을 선커밋한 뒤 사후 합리화하는 우회 차단.
  //   plan 필드를 outputText 앞에 두어 모델이 글 작성 *전*에 룰 적용 계획을 명시하게 한다.
  const isEn = lang === 'en';
  const baseProperties = {
    plan: {
      type: 'string',
      description: isEn
        ? "Mandatory pre-writing plan, written in English. State 1 sentence each for: (1) List every statistic, year, proper noun, and organization name from the input — mark which ones will be kept verbatim, and declare that NO new statistics/years/proper nouns will be introduced. (2) Declare that the example text's vocabulary will NOT be copied; only its tone, structure, and hedge distribution will be imitated. (3) Identify the 3 rules from the system prompt most at risk of being violated for this specific text. (4) If the original follows a stock frame, state the rearrangement direction. (5) **Natural flow first**: declare that information will NOT be compressed into one sentence; natural connectors (so / but / however / in practice / honestly / in the end) will be used between sentences to keep flow smooth. Rule satisfaction must not create a disjointed feel. 5–7 sentences."
        : '글 작성 전 필수 적용 계획. 다음 5개 항목을 1문장씩 명시: (1) 입력 글에 등장한 통계·연도·고유명사·기관명을 모두 나열하고, 출력에서 그대로 유지할 항목만 표시. 입력에 없는 새 통계·연도·고유명사는 절대 추가하지 않는다고 선언. (2) 위 예시 글의 어휘를 그대로 베끼지 않고 톤·구조·hedge 분포만 모방한다고 선언. (3) 시스템 프롬프트의 P1·P2·룰 1·2·4·5 중 이 글에 가장 위험한 룰 3개 식별. 분량은 원문 대비 0.85~1.20 유지(없는 내용으로 증축 금지) — 새 통계·사실·일화로 분량을 채우지 않는다. 부족하면 원문에 실제로 있는 정보만 복원 (P0 띄어쓰기·룰 2 콤마 누적·룰 3 GPT-ism 어휘·P1-보강 단정정의문은 서버 결정론 강제). (4) 원문 흐름이 전형 프레임이면 재배치 방향. (5) **자연 흐름 우선**: 정보를 한 문장에 압축하지 않고, 문장 사이를 자연 연결 어구(그래서/그런데/다만/물론/결국)로 매끄럽게 잇는다고 선언. 룰 충족이 단절감을 만들면 안 됨. 5~7문장.'
    },
    outputText: {
      type: 'string',
      description: isEn
        ? 'The full rewritten text, written in English. Follow the plan above.'
        : '변환된 글 전체. plan에 명시한 계획대로 작성.'
    },
    summary: {
      type: 'string',
      description: isEn
        ? 'A 2-sentence summary of the transformation, written in English.'
        : '변환 요약 2문장. 존댓말(~입니다/~합니다체)로 작성.'
    },
    detail: {
      type: 'string',
      description: isEn
        ? 'Detailed description of the techniques applied, written in English.'
        : '적용한 기법 상세. 존댓말(~입니다/~합니다체)로 작성.'
    },
    topNounCounts: {
      type: 'object',
      description: 'outputText에서 가장 많이 등장하는 주제어(명사) 상위 3개와 횟수. 예: {"배출":2,"정부":1}. 어떤 값도 4 이상이면 룰 7(어휘 다양화) 위반 — 재작성',
      additionalProperties: { type: 'integer' }
    },
    listOfThreeCount: {
      type: 'integer',
      description: '콤마/쉼표/"와"/"이나"로 3개 이상 묶은 나열 문장 수. 반드시 0 (룰 4 콤마 절 누적 금지, AI 시그너처)'
    },
    consecutiveNounSubjectMax: {
      type: 'integer',
      description: '명사 주어로 시작하는 문장의 최대 연속 개수. 2 이하 (룰 3 비명사 시작)'
    },
    shortSentenceRatio: {
      type: 'number',
      description: '15자 이하 단문 수 / 전체 문장 수. 룰 2(평균 40~55자) 정합 — 단문은 *제한* 방향(문단당 1개 정도). 정보용 측정, 강제 임계 없음.'
    },
    hedgeRatio: {
      type: 'number',
      description: '추정 어미("~인 것 같다","~라고 생각한다","~던 것 같다") 사용 문장 / 전체 문장. 목표 0.08~0.15, 상한 0.17 (룰 1 hedge 풀세트). 카피킬러는 hedge를 인간 시그너처로 학습하지만 일색이면 "무견해" 시그너처로 반전 — 너무 낮으면 LLM처럼 단정적, 너무 높으면 과교정.'
    },
    outputCharLen: {
      type: 'integer',
      description: '출력 글 공백 제외 글자 수. 목표: 입력 글자 수 × 0.85~1.20. 부족·초과 시 원문 정보 보존 기준으로 최소 수정 — 새 정보로 분량을 채우지 말 것. 너무 길면 원문에 없는 부연·반복을 삭제. 서버 실측으로 덮어씀.'
    },
    selfCheckPass: {
      type: 'boolean',
      description: '(서버가 항상 재계산하므로 모델 자기보고는 사용되지 않습니다. 임의 값을 채우거나 생략해도 무방)'
    }
  };
  const baseRequired = [
    'plan', 'outputText', 'summary', 'detail',
    'topNounCounts', 'listOfThreeCount', 'consecutiveNounSubjectMax',
    'shortSentenceRatio', 'hedgeRatio', 'outputCharLen'
  ];

  if (mode === 'assignment') {
    baseProperties.questionSentenceCount = {
      type: 'integer',
      description: '의문문("?"로 끝) 개수. 1~3건 권장 (룰 1 변형 종결 ~까요? + hedge 풀세트 의문문 분산 정합). 0건도 위반 아님.'
    };
    baseProperties.lastSentenceIsReassurance = {
      type: 'boolean',
      description: '마지막 문장이 재보증/요약/평가 패턴("~할 필요가 있다","~에 달려 있다","~얘기다","정리하자면","결론적으로","알게 됩니다","깨닫게 됩니다")이면 true. false여야 통과 (룰 1 hedge 마무리)'
    };
    baseProperties.commaClauseRatio = {
      type: 'number',
      description: '쉼표 포함 + 종결/연결어미(다/니다/며/고/어서/아서/면서/는데/지만 등)가 2개 이상인 문장 / 전체. 0.20 이하 (룰 3 콤마 절제 — KatFishNet 측정 한국어 LLM은 인간보다 콤마 2.3배 사용). 서버 실측으로 덮어씀.'
    };
    baseProperties.shortRunWithoutComma = {
      type: 'integer',
      description: '쉼표 없는 평서문 3연속 구간 개수. 룰 3 콤마 절제 정합 — 정보용 측정, 강제 임계 없음. 서버 실측으로 덮어씀.'
    };
    baseProperties.tinySentenceCount = {
      type: 'integer',
      description: '8자 이하 초단문 개수(공백 제외). 룰 2(평균 40~55자, 단문 20~30자) 정합 — 정보용 측정, 강제 임계 없음. 서버 실측으로 덮어씀.'
    };
    baseProperties.longShortAdjacencyCount = {
      type: 'integer',
      description: '40자+ 장문 바로 뒤에 10자 이하 단문이 오는 경우 수. 룰 2 정합 — 정보용 측정, 강제 임계 없음. 서버 실측으로 덮어씀.'
    };
    baseProperties.sameEndingRun = {
      type: 'integer',
      description: '같은 종결어미(습니다/됩니다/있습니다 등)로 연속 종결된 최대 문장 수. 2 이하 (룰 1 종결어미 다양화 — 4문장 연속 금지). 서버 실측으로 덮어씀.'
    };
    baseProperties.similarLengthRun = {
      type: 'integer',
      description: '한 문단 내 ±5자 이내 문장 길이 연속 최대치(15자 이상 문장만 판정). 2 이하 (룰 2 문장 길이). 서버 실측으로 덮어씀.'
    };
    baseProperties.spellingIssues = {
      type: 'array',
      description: '맞춤법/띄어쓰기 블랙리스트 적중 목록. 빈 배열이어야 통과 (P0). 서버 실측으로 덮어씀.',
      items: { type: 'string' }
    };
    baseProperties.evidenceCount = {
      type: 'integer',
      description: '사례·인용 문장 수. "[연도(YYYY)+주체+수치/기업명]" 형태로 객관 사실을 인용한 문장 개수. 서버 실측으로 덮어씀.'
    };
    baseProperties.evidenceWithoutInterpretation = {
      type: 'integer',
      description: '사례 문장 직후 글쓴이 해석/판단/의문 문장이 따라붙지 않은 케이스 수. 0이어야 통과 (절대 금지 1항 안전망). 서버 실측으로 덮어씀.'
    };
    baseProperties.evidencePerParagraphMax = {
      type: 'integer',
      description: '한 단락 안에 등장하는 사례 인용 최대 개수. 2 이하 (절대 금지 1항 안전망). 서버 실측으로 덮어씀.'
    };
    baseProperties.firstPersonAnecdoteCount = {
      type: 'integer',
      description: '1인칭(저/제가/제) + 시간(작년/지난 학기/며칠 전 등 *상대* 시간) 또는 인물(친구·룸메이트·동기·선배·교수) 또는 장소(기숙사·강의실·동아리방·카페) 동반 일화 문장 수. 목표: 글 길이 비례 = max(1, floor(문단수/3)) — 예: 3문단 이하 1건+, 6문단 2건+, 9문단 3건+. 카피킬러 "추상·일반 내용" 시그너처 직격 해소. 단순 "저는 ~생각합니다"는 일화 아님. 외부 통계·연도(YYYY)·기관명은 절대 금지. 서버 실측으로 덮어씀.'
    };
    baseProperties.consecutiveAbstractParagraphRun = {
      type: 'integer',
      description: '1인칭 구체 일화(시간·장소·인물 동반)가 0건인 문단이 연속으로 등장한 최대 길이. 3 이하 — 즉 어떤 문단도 연속 4개 이상 일반론이 되면 안 됨. 글 후반에 일반론이 몰리면 카피킬러 "추상·일반 내용 구성" 시그너처 직격. 글 초반·중반·후반 모두 일화 1개 이상 배치 권장. 서버 실측으로 덮어씀.'
    };
    baseProperties.emphaticConnectorCount = {
      type: 'integer',
      description: '강조·반전 접속사("그러나/하지만/다만/오히려/정작/막상/사실은") 출현 횟수. 1건 이상 권장 — 0건이면 카피킬러 "논점 변화 부재" 시그너처 직격. 논점 전환·강조 표지 없이 단조 진술만 이어지면 단조로움 박힘. 서버 실측으로 덮어씀.'
    };
    baseProperties.causalConnectorCount = {
      type: 'integer',
      description: '인과·논리 접속사("그래서/그러므로/때문에/따라서/덕분에/결국") 출현 횟수. 1건 이상 권장 — 0건이면 카피킬러 "논리적 전개 부재" 시그너처 직격. 근거-결과 연결 표지 없이 사실만 나열되면 단조로움 박힘. 서버 실측으로 덮어씀.'
    };
    baseProperties.abstractStatementRatio = {
      type: 'number',
      description: '추상 진술 문장 비율 — 가능·당위 종결("~할 수 있다/~할 필요가 있다/~여야 한다/~에 달려 있다") 또는 추상 명사 다발("능력/중요성/필요성/가치/의미/역량/관점/태도") 또는 일반화 부사("결국적/궁극적/근본적으로") 포함 문장 / 전체 문장. 0.50 이하 권장 — 카피킬러 "추상·일반적 내용 구성(AI는 개념·원리 중심)" 시그너처 직격. 절반 넘으면 추상 진술이 글 골격이 돼 시그너처 박힘. 서버 실측으로 덮어씀.'
    };
    baseProperties.interSentenceConnectorRatio = {
      type: 'number',
      description: '인접 문장 간 자연 흐름 연결어("그리고/또/특히/예를 들/이를테면/근데/그런데/그러니까/그렇다면/그래도/즉/한편/뭐랄까") 사용 비율 — 두 번째 이후 문장 중 연결어로 시작하는 비율. 0.20 이상 권장 — 카피킬러 "문장 간 이어짐 부자연스러움 / 단절적" 시그너처 직격. 정보를 단편적으로 나열하지 말고 흐름 연결어로 이어라. 서버 실측으로 덮어씀.'
    };
    baseProperties.assertiveSentenceCount = {
      type: 'integer',
      description: 'hedge·추측(것 같/듯/지도 모르/수 있/기도 하/생각합/봅니다/싶습) 없이 단정 종결(~합니다/~됩니다/~입니다/~여야 한다/~이다)로 끝나는 문장 수. 3건 이상 권장 — 결론·핵심 주장은 단정으로. 서버 실측으로 덮어씀.'
    };
    baseProperties.judgmentAvoidanceCount = {
      type: 'integer',
      description: '판단 회피 1인칭 ("저는 잘 모르겠습니다 / ~인지 모르겠다 / 알 수 없습니다 / 판단하기 어렵습니다") 문장 수. 0~1건만 허용 — 2건 이상은 카피킬러 "무견해·판단 회피적 성향" 시그너처 직격. 서버 실측으로 덮어씀.'
    };
    baseRequired.push(
      'questionSentenceCount',
      'lastSentenceIsReassurance',
      'commaClauseRatio', 'shortRunWithoutComma',
      'tinySentenceCount', 'longShortAdjacencyCount',
      'sameEndingRun', 'similarLengthRun', 'spellingIssues',
      'evidenceCount', 'evidenceWithoutInterpretation',
      'evidencePerParagraphMax',
      'firstPersonAnecdoteCount', 'consecutiveAbstractParagraphRun',
      'emphaticConnectorCount', 'causalConnectorCount',
      'abstractStatementRatio', 'interSentenceConnectorRatio',
      'assertiveSentenceCount', 'judgmentAvoidanceCount'
    );
  }

  return {
    name: 'return_humanized_result',
    description: '재작성된 텍스트와 셀프체크 수치를 반환한다. 수치는 outputText를 실제로 세어 채운다 (추정 금지).',
    input_schema: {
      type: 'object',
      properties: baseProperties,
      required: baseRequired
    }
  };
}

// ★ FLOOR v2 전용 lean tool(§리뷰#7): 레거시 스키마의 표면 지표 필드(firstPersonAnecdoteCount·
//   abstractStatementRatio 등)는 모델에게 "1인칭 일화 추가/추상 진술 늘리기" 같은 anti-FLOOR 행동을
//   유도한다. floorV2는 보존이 최우선이므로 outputText만 받고, 표면 지표는 서버가 실측(verifyCheckFields).
//   plan을 outputText 앞에 둬 JSON-CoT(선계획→후작성) 이점은 유지.
function buildLeanHumanizeTool(lang = 'ko') {
  const isEn = lang === 'en';
  return {
    name: 'return_humanized_result',
    description: isEn
      ? 'Return the rewritten text under the FLOOR rules (preservation-first).'
      : 'FLOOR(보존 우선) 규칙을 지켜 재작성한 텍스트를 반환한다.',
    input_schema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: isEn
            ? 'Brief pre-writing plan (2-4 sentences): (1) list the facts/numbers/proper nouns to keep verbatim and declare NO new ones will be added; (2) name the source speaker to preserve (individual "I" / organization "we" / impersonal) and declare no new speaker/anecdote; (3) state the target length. Then write outputText accordingly.'
            : '작성 전 간단 계획(2~4문장): (1) 그대로 유지할 사실·숫자·고유명사를 나열하고 새로 추가하지 않겠다고 선언, (2) 보존할 화자(개인 "나/저" / 조직 "우리" / 비인칭)를 적고 새 화자·새 일화를 만들지 않겠다고 선언, (3) 목표 분량 명시. 그런 다음 outputText를 작성.'
        },
        outputText: {
          type: 'string',
          description: isEn ? 'The full rewritten text. Follow the plan and the FLOOR above.' : '재작성한 글 전체. 위 plan과 FLOOR를 지켜 작성.'
        },
        riskFlags: {
          type: 'array',
          items: { type: 'string' },
          description: isEn
            ? 'Optional: FLOOR risks you could not fully avoid (e.g. "had to shorten a section", "uncertain proper noun kept"). Empty array if none.'
            : '선택: 완전히 피하지 못한 FLOOR 위험(예: "일부 축약 불가피", "불확실한 고유명사 유지"). 없으면 빈 배열.'
        }
      },
      required: ['plan', 'outputText']
    }
  };
}

function buildDetectTool(lang = 'ko') {
  const isEn = lang === 'en';
  return {
    name: 'return_detection_result',
    description: 'AI 생성 확률 판정 결과를 반환한다.',
    input_schema: {
      type: 'object',
      properties: {
        probability: { type: 'number', description: '0~100 사이 AI 생성 확률' },
        summary: {
          type: 'string',
          description: isEn
            ? 'Core judgment reasoning in 1–2 sentences, written in English.'
            : '핵심 판단 이유 1~2문장. 존댓말(~입니다/~합니다체)로 작성.'
        },
        detail: {
          type: 'string',
          description: isEn
            ? 'Detailed analysis of 100+ characters, written in English.'
            : '상세 분석 100자 이상. 존댓말(~입니다/~합니다체)로 작성.'
        }
      },
      required: ['probability', 'summary', 'detail']
    }
  };
}

// Anthropic Messages 응답에서 tool_use 블록 추출
// 강제 tool_choice 모드에서 모델은 항상 지정된 tool_use 블록을 반환한다.
function extractClaudeResult(data, toolName) {
  if (data?.type === 'error') {
    throw new Error(`Anthropic 응답 오류: ${data?.error?.message || 'unknown'}`);
  }
  const stopReason = data?.stop_reason;
  if (stopReason === 'refusal') {
    throw new Error('안전 필터에 의해 응답이 차단되었습니다.');
  }
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const refusal = blocks.find(b => b && b.type === 'refusal');
  if (refusal) {
    throw new Error(`안전 필터에 의해 응답이 거부되었습니다: ${refusal.message || ''}`);
  }
  const useBlock = blocks.find(b => b && b.type === 'tool_use' && b.name === toolName);
  if (!useBlock) {
    if (stopReason === 'max_tokens') {
      throw new Error('응답이 max_tokens 제한으로 잘렸습니다.');
    }
    throw new Error('모델이 구조화 응답을 반환하지 않았습니다.');
  }
  const parsed = useBlock.input && typeof useBlock.input === 'object' ? useBlock.input : {};
  // topNounCounts가 string으로 왔으면 객체로 정규화 (방어적 처리; 표준 JSON Schema에선 객체로 옴)
  if (parsed && typeof parsed.topNounCounts === 'string') {
    try { parsed.topNounCounts = JSON.parse(parsed.topNounCounts); }
    catch { parsed.topNounCounts = {}; }
  }
  if (parsed && parsed.topNounCounts && typeof parsed.topNounCounts !== 'object') {
    parsed.topNounCounts = {};
  }
  return parsed;
}

// Anthropic tools는 표준 JSON Schema(input_schema)를 그대로 받음 → 변환 불필요
function getDetectTool(lang = 'ko') {
  return buildDetectTool(lang);
}
function getHumanizeToolFor(mode, lang = 'ko') {
  return buildHumanizeTool(mode, lang);
}
function getLeanHumanizeTool(lang = 'ko') {
  return buildLeanHumanizeTool(lang);
}

// ★ 모델의 자기보고를 신뢰하지 않고 서버가 직접 실측. 실측 > 보고면 덮어쓰고 selfCheckPass를 재계산.
//   assignment 모드는 접속사 시작 비율/P3 마지막 문장/주제어 빈도/문단 비율까지 서버에서 추가 실측.
function verifyCheckFields(result, mode, inputParaCount, inputCharLen, inputText) {
  const text = result.outputText || '';
  const inText = typeof inputText === 'string' ? inputText : '';

  // 분량 90% 보장 실측: 출력 길이 / 원문 길이 (공백 제외 기준 통일)
  if (typeof inputCharLen === 'number' && inputCharLen > 0) {
    const outLen = text.replace(/\s+/g, '').length;
    const ratio = outLen / inputCharLen;
    result.lengthRatio = Number(ratio.toFixed(3));
    if (ratio < 0.9) {
      result.lengthShortfall = { input: inputCharLen, output: outLen, ratio: result.lengthRatio };
    } else {
      result.lengthShortfall = null;
    }
  }

  // 1) 3개 이상 나열: 콤마로 묶인 3요소 (한/영 모두)
  const commaListRe = /[가-힣A-Za-z0-9]+\s*,\s*[가-힣A-Za-z0-9]+\s*,\s*[가-힣A-Za-z0-9]+/g;
  // "정부, 기업, 개인" 같은 전형 + "A와 B, 그리고 C" 같은 변형
  const mixedListRe = /[가-힣]+(?:\s*(?:,|과|와))\s*[가-힣]+\s*(?:,\s*(?:그리고\s*)?|(?:과|와)\s*)[가-힣]+/g;
  const listMatches = new Set([
    ...(text.match(commaListRe) || []),
    ...(text.match(mixedListRe) || [])
  ]);
  const actualListCount = listMatches.size;

  // 2) 의문문: "?" 또는 전각 물음표로 끝나는 문장 수
  const actualQuestions = (text.match(/[?？]/g) || []).length;

  // 3) 15자 이하 단문 비율: "다./까?/요./!" 등 종결부 뒤로 분리해 공백 제외 길이 측정
  const sentences = text
    .split(/(?<=[.!?？。])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
  const charLen = (s) => s.replace(/\s+/g, '').length;
  const shortCount = sentences.filter(s => charLen(s) <= 15).length;
  const actualShortRatio = sentences.length > 0 ? shortCount / sentences.length : 0;

  const overrides = [];

  if (actualListCount > (result.listOfThreeCount || 0)) {
    overrides.push(`listOfThreeCount ${result.listOfThreeCount} → ${actualListCount}`);
    result.listOfThreeCount = actualListCount;
  }
  if (actualShortRatio < (result.shortSentenceRatio || 0)) {
    overrides.push(`shortSentenceRatio ${(result.shortSentenceRatio || 0).toFixed(2)} → ${actualShortRatio.toFixed(2)}`);
    result.shortSentenceRatio = actualShortRatio;
  }

  // ===== assignment 전용 확장 실측 =====
  if (mode === 'assignment') {
    // 의문문 실측: 모델 보고값과 다르면 덮어쓰기 (0건 위반 감지 위해 항상 주입)
    if (actualQuestions !== (result.questionSentenceCount || 0)) {
      overrides.push(`questionSentenceCount ${result.questionSentenceCount} → ${actualQuestions}`);
      result.questionSentenceCount = actualQuestions;
    }

    // 단정 정의문 카운트 — LLM overconfidence 시그너처 (학술 근거: arxiv 2510.26995, MASH 2601.08564)
    // 사용자 카피킬러 87% 감지 실측 분석: "[고유명사]는 ~사례입니다 / ~증거입니다 / ~보여줍니다" 패턴이 디텍터에 직접 잡힘.
    // 룰 5(무생물 정의문 회피)를 모델이 안 지키므로 측정→refine으로 강제.
    const declarativeRe = /[가-힣A-Za-z0-9]{2,}(?:은|는)\s+[^.!?]{4,}(사례입니다|사례이다|증거입니다|증거이다|증명입니다|증명이다|예시입니다|예시이다|상징입니다|상징이다|표현입니다|표현이다|결과입니다|결과이다|보여줍니다|보여준다|드러냅니다|드러낸다|증명합니다|증명한다|입증합니다|입증한다)[.!?]/g;
    const declarativeMatches = text.match(declarativeRe) || [];
    const actualDeclarativeDefinition = declarativeMatches.length;
    if (actualDeclarativeDefinition !== (result.declarativeDefinitionCount || 0)) {
      overrides.push(`declarativeDefinitionCount ${result.declarativeDefinitionCount} → ${actualDeclarativeDefinition}`);
      result.declarativeDefinitionCount = actualDeclarativeDefinition;
    }

    // 룰 1 마지막 문장 재보증/평가 패턴 실측 (교훈형 일반화 마무리 포함)
    const lastSentence = sentences[sentences.length - 1] || '';
    const reassureRe = new RegExp([
      '필요가 있다',
      '설득력 (있어 보이기도|있기도|있어 보이|있)',
      '얘기다',
      '정리하자면',
      '결론적으로',
      '더 중요해 보인다',
      '달려\\s?있다',
      '지속가능한지는',
      '재고할 필요',
      '(뭐|무엇|왜|어떻게|어떤지)(를|가|인지|인지를)?\\s*(조금씩|점점|서서히|비로소)?\\s*(알게|깨닫게|배우게|이해하게)\\s*(됩니다|된다|되었다|됐다)',
      '알게 됩니다[.!]?$',
      '깨닫게 됩니다[.!]?$',
      '배우게 됩니다[.!]?$',
      '된 것 같습니다[.!]?$',
      '는 것이었습니다[.!]?$'
    ].join('|'));
    const actualLastReassure = reassureRe.test(lastSentence);
    if (actualLastReassure && result.lastSentenceIsReassurance !== true) {
      overrides.push(`lastSentenceIsReassurance ${result.lastSentenceIsReassurance} → true`);
      result.lastSentenceIsReassurance = true;
    }

    // 주제어 실측: 2~4글자 한글 명사 추출 (조사 스트립 근사), 빈도 top 3 산출
    // 모델 보고에서 누락된 주제어가 실측에서 4회 이상이면 덮어쓰기
    const tokens = (text.match(/[가-힣]{2,4}/g) || [])
      .map(t => t.replace(/(은|는|이|가|을|를|에|의|와|과|도|만|로|으로|에서|에게|부터|까지)$/, ''))
      .filter(t => t.length >= 2);
    const freq = {};
    for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
    const topEntries = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const reportedCounts = result.topNounCounts || {};
    const reportedMax = Math.max(0, ...Object.values(reportedCounts));
    const actualMax = topEntries.length ? topEntries[0][1] : 0;
    if (actualMax >= 4 && actualMax > reportedMax) {
      const newCounts = Object.fromEntries(topEntries);
      overrides.push(`topNounCounts 최대 ${reportedMax} → ${actualMax} (${topEntries[0][0]})`);
      result.topNounCounts = newCounts;
    }

    // 문단 분리: 후속 룰(룰 2 similarLengthRun 등)에서 재사용
    const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

    // 문단 수 유동 실측: 입력 길이별 허용 폭(1→±0, 2~3→±1, 4+→±2) — 카피킬러 "문단 균일" 시그너처 회피 여지.
    if (typeof inputParaCount === 'number' && inputParaCount >= 1) {
      const outputParas = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
      const tolerance = inputParaCount === 1 ? 0 : inputParaCount <= 3 ? 1 : 2;
      const diff = Math.abs(outputParas.length - inputParaCount);
      if (diff > tolerance) {
        overrides.push(`paragraphCount 입력 ${inputParaCount}개 → 출력 ${outputParas.length}개 (허용 ±${tolerance} 초과)`);
        result.paragraphCountMismatch = { input: inputParaCount, output: outputParas.length, tolerance };
      } else {
        result.paragraphCountMismatch = null;
      }
    }

    // ===== P1: 쉼표 복문 비율 + 쉼표 없는 3문장 연속 구간 =====
    const clauseEndingRe = /(?:다|니다|며|고|어서|아서|면서|는데|지만|었고|이며|되어|하여|하며)\s*,/;
    const commaClauseCount = sentences.filter(s => /,/.test(s) && clauseEndingRe.test(s)).length;
    const actualCommaClauseRatio = sentences.length > 0 ? commaClauseCount / sentences.length : 0;
    if (actualCommaClauseRatio > (result.commaClauseRatio || 0)) {
      overrides.push(`commaClauseRatio ${(result.commaClauseRatio || 0).toFixed(2)} → ${actualCommaClauseRatio.toFixed(2)}`);
      result.commaClauseRatio = actualCommaClauseRatio;
    }
    let noCommaRun = 0, shortRunCount = 0;
    for (const s of sentences) {
      if (!/,/.test(s) && /[다까요][.!?？。]?$/.test(s.trim())) {
        noCommaRun++;
        if (noCommaRun === 3) shortRunCount++;
      } else {
        noCommaRun = 0;
      }
    }
    if (shortRunCount > (result.shortRunWithoutComma || 0)) {
      overrides.push(`shortRunWithoutComma ${result.shortRunWithoutComma} → ${shortRunCount}`);
      result.shortRunWithoutComma = shortRunCount;
    }

    // ===== P2: 초단문(8자 이하) + 장문(40자+)-단문(10자-) 인접 =====
    const tinyCount = sentences.filter(s => charLen(s) <= 8).length;
    if (tinyCount < (result.tinySentenceCount ?? Infinity)) {
      overrides.push(`tinySentenceCount ${result.tinySentenceCount} → ${tinyCount}`);
      result.tinySentenceCount = tinyCount;
    }
    let adjacency = 0;
    for (let i = 0; i < sentences.length - 1; i++) {
      if (charLen(sentences[i]) >= 40 && charLen(sentences[i + 1]) <= 10) adjacency++;
    }
    if (adjacency < (result.longShortAdjacencyCount ?? Infinity)) {
      overrides.push(`longShortAdjacencyCount ${result.longShortAdjacencyCount} → ${adjacency}`);
      result.longShortAdjacencyCount = adjacency;
    }

    // ===== 룰 1: 동일 종결어미 연속 =====
    const endingGroup = (s) => {
      const t = s.trim();
      if (/같습니다[.!]?$/.test(t)) return 'GATDA';
      if (/겠습니다[.!]?$/.test(t)) return 'GETDA';
      if (/였습니다[.!]?$/.test(t)) return 'YEOT';
      if (/습니다[.!]?$/.test(t)) return 'SEUPNIDA';
      if (/ㅂ니다[.!]?$/.test(t)) return 'BNIDA';
      if (/까\??$/.test(t) || /\?$/.test(t)) return 'QUESTION';
      return 'OTHER';
    };
    let curGroup = null, runLen = 0, maxSameEnding = 0;
    for (const s of sentences) {
      const g = endingGroup(s);
      if (g === curGroup) runLen++;
      else { curGroup = g; runLen = 1; }
      if (g !== 'OTHER' && g !== 'QUESTION' && runLen > maxSameEnding) maxSameEnding = runLen;
    }
    if (maxSameEnding > (result.sameEndingRun || 0)) {
      overrides.push(`sameEndingRun ${result.sameEndingRun} → ${maxSameEnding}`);
      result.sameEndingRun = maxSameEnding;
    }

    // ===== 룰 2: 문단별 ±5자 이내 문장 길이 3연속 (15자 이상만 판정) =====
    let maxSimRun = 0;
    for (const p of paragraphs) {
      const ps = p.split(/(?<=[.!?？。])\s+/).map(s => s.trim()).filter(Boolean);
      const lens = ps.map(charLen);
      let simRun = 1;
      for (let i = 1; i < lens.length; i++) {
        if (lens[i] >= 15 && lens[i - 1] >= 15 && Math.abs(lens[i] - lens[i - 1]) <= 5) {
          simRun++;
          if (simRun > maxSimRun) maxSimRun = simRun;
        } else {
          simRun = 1;
        }
      }
    }
    if (maxSimRun > (result.similarLengthRun || 0)) {
      overrides.push(`similarLengthRun ${result.similarLengthRun} → ${maxSimRun}`);
      result.similarLengthRun = maxSimRun;
    }

    // ===== 룰 3: 명사 주어 연속 실측 (모델 자기보고 덮어쓰기) =====
    const nonNounStartRe = /^(사실|솔직히|결국|오히려|막상|어쩌면|돌이켜보면|어떤|이런|이렇게|그런|그렇게|하지만|그러나|그런데|그래서|한편|또한|아직|이미|아마|정말|진짜|특히|물론)/;
    const nounSubjectRe = /^[가-힣]+(은|는|이|가)\s/;
    let nsRun = 0, nsMax = 0;
    for (const s of sentences) {
      const t = s.trim();
      if (nounSubjectRe.test(t) && !nonNounStartRe.test(t)) {
        nsRun++;
        if (nsRun > nsMax) nsMax = nsRun;
      } else {
        nsRun = 0;
      }
    }
    if (nsMax > (result.consecutiveNounSubjectMax || 0)) {
      overrides.push(`consecutiveNounSubjectMax ${result.consecutiveNounSubjectMax} → ${nsMax}`);
      result.consecutiveNounSubjectMax = nsMax;
    }

    // ===== 룰 6: hedgeRatio 실측 (한국어 카피킬러는 hedge를 인간 시그너처로 학습 — critical 폐기됨, minor만) =====
    // 통과 글 분석으로 풀 확장: 받침 차이 흡수 위해 어간 부분만 매칭("고 생각", "지도 모")
    const hedgeRe = /(인 것 같|는 것 같|고 생각|던 것 같|았던 것 같|았을지도|지도 모|일 수도 있|인 듯|지 않을까)/;
    const hedgeCount = sentences.filter(s => hedgeRe.test(s)).length;
    const actualHedge = sentences.length > 0 ? hedgeCount / sentences.length : 0;
    if (Math.abs(actualHedge - (result.hedgeRatio || 0)) > 0.03) {
      overrides.push(`hedgeRatio ${(result.hedgeRatio || 0).toFixed(2)} → ${actualHedge.toFixed(2)}`);
      result.hedgeRatio = actualHedge;
    }

    // ===== hedge 균질화 검출: 동일 hedge 표현 글 전체 누적 =====
    // 사용자 카피킬러 100% 감지 실측 — hedge 풀세트 5종을 제시해도 LLM이 한 표현("것 같습니다")만 반복 sampling.
    // sameEndingRun(연속) 검증으론 비연속 누적이 빠짐 → 풀세트 다양화가 무력화돼 "기계적 균일성" 시그너처로 직격.
    const hedgeGroupRes = [
      { name: '것 같', re: /(?:인|는|던|았던|을) 것 같/g },
      { name: '고 생각', re: /고 생각(?:합니다|한다|해)/g },
      { name: '지도 모', re: /지도 모(?:릅니다|른다|르)/g },
      { name: '수도 있', re: /(?:일|할|될|을) 수(?:도 있| 있)/g },
      { name: '지 않을까', re: /지 않을까/g },
      // "~기도 합니다" 그룹 — 사용자 실측: "것 같"을 줄였더니 LLM이 이쪽으로 옮겨 재균질화.
      // 앞에 한글 1자+ 필수로 두어 단독 "기도(prayer)"는 제외 ("흔들리기도 합니다" 같은 보조사 결합만 잡힘).
      { name: '기도 합', re: /[가-힣]+기도\s+(?:합니다|했습니다|한다|하고|하며|하기도|함)/g }
    ];
    let topHedgeName = null, topHedgeCount = 0;
    for (const g of hedgeGroupRes) {
      const cnt = (text.match(g.re) || []).length;
      if (cnt > topHedgeCount) { topHedgeCount = cnt; topHedgeName = g.name; }
    }
    if (topHedgeCount > (result.dominantHedgeCount || 0)) {
      overrides.push(`dominantHedgeCount ${result.dominantHedgeCount || 0} → ${topHedgeCount} ("${topHedgeName}")`);
      result.dominantHedgeCount = topHedgeCount;
      result.dominantHedgeName = topHedgeName;
    }

    // ===== 1인칭 anchor 카운트: 비인칭 LLM 시그너처 검출 =====
    // 사용자 카피킬러 피드백 2번 직격 — "글쓴이의 관점이 잘 드러나지 않습니다 / 간접·거리감 표현 반복 = AI 패턴".
    // 1인칭이 부재하면 수동·비인칭 일색이 돼 카피킬러 학습 시그너처와 일치. minor 게이트로 refine 유도(critical은 과교정 위험).
    const firstPersonRe = /(저는|제가|저도|저의|저 자신|저로서는|개인적으로|제 생각|제 경험|저에게는|저한테는)/g;
    const firstPersonMatches = text.match(firstPersonRe) || [];
    result.firstPersonCount = firstPersonMatches.length;
    // "저는" 단일 반복 카운트: 프롬프트 룰 6 "저는 4회+ 금지" 측정. 다른 anchor 없이 "저는"만 반복하면 단조로움 시그너처.
    result.dominantFirstPersonCount = (text.match(/저는/g) || []).length;

    // ===== 수동·비인칭 동사 비율 검출 (카피킬러 피드백 3번 직격) =====
    // "수동태, 비인칭 구조 중심 → 글쓴이 관점 부재 = AI 패턴" 직격.
    // 1인칭이 들어가도 본문 동사 대부분이 수동·중간태면 비인칭 시그너처 박힘 (사용자 실측 — 1인칭 3회였는데도 100% 감지).
    const passiveRe = /(되었습니다|됐습니다|되어 있|되고 있|졌습니다|져 있|지고 있|혔습니다|혀 있|만들어졌|만들어집|만들어지는|받게 됩니다|받게 될|받게 된|여겨졌|여겨집|여겨지는|이루어졌|이루어집|이루어지는|확인됩|확인되었|드러납|드러난|보여집|보여졌|평가받게|평가받는|움직이고 있|이어지고 있|이어집니다|진행되고 있|정비되고 있|놓여 있|걸쳐 있|담겨 있|뒤집혔|뒤집힌|이끌리|밀려|치우치|기울|느껴집|느껴졌|생각됩|생각되었|추정됩|추정되었|판단됩|판단되었)/;
    const passiveCount = sentences.filter(s => passiveRe.test(s)).length;
    const passiveRatio = sentences.length > 0 ? passiveCount / sentences.length : 0;
    result.passiveVoiceRatio = Number(passiveRatio.toFixed(3));
    result.passiveVoiceCount = passiveCount;

    // ===== 60자+ 장문 비율 검출 (카피킬러 피드백 1번 "압축·단절" 직격) =====
    // 사용자 실측: 60자+ 장문이 한 글 전체의 25%를 넘으면 "한 문단에 정보 압축, 문장 간 단절" 시그너처 박힘.
    // 콤마 누적 장문이 자주 동반됨 → commaClauseRatio와 묶어서 판단.
    const longCount = sentences.filter(s => charLen(s) >= 60).length;
    const longRatio = sentences.length > 0 ? longCount / sentences.length : 0;
    result.longSentenceRatio = Number(longRatio.toFixed(3));
    result.longSentenceCount = longCount;

    // ===== P0: 맞춤법/띄어쓰기 블랙리스트 =====
    const spellingRules = [
      { re: /것같(습니다|다|네요|아요|은)/, msg: '것같→것 같' },
      { re: /모든게/, msg: '모든게→모든 게' },
      { re: /(지식|사실|얘기|기술|감정|느낌|생각)이나중에/, msg: '~이나중에→~이 나중에' },
      { re: /(느낌|생각|기분|태도|감정|방식)부터다르/, msg: '~부터다르다→~부터 다르다' },
      { re: /(생겼|있었|없었|됐|했|갔|왔|봤|만났|나왔|들어왔|받았|줬|보냈|썼)을때/, msg: '~을때→~을 때' },
      { re: /(할|갈|올|볼|쓸|줄|받을|만날|나올|들어올|시작할|끝낼|마칠)때(마다|부터|까지|에|는|도)?/, msg: '~할때→~할 때' },
      { re: /(초등학교|중학교|고등학교|대학교|학원)\s까지/, msg: '학교 까지→학교까지' },
      { re: /(그때|이때|지금|나중|평소)\s까지/, msg: '~ 까지→~까지' },
      { re: /전날밤/, msg: '전날밤→전날 밤' },
      { re: /(어떻게|뭘|뭐|무엇을|왜|어디|어떤지|어찌|얼마나)\s*한건지/, msg: '한건지→한 건지' },
      { re: /해야할/, msg: '해야할→해야 할' },
      { re: /역효과\s였/, msg: '역효과 였습니다→역효과였습니다' },
      { re: /(부작용|효과|결과|차이|변화)\s였/, msg: '~ 였습니다→~였습니다' },
      // 의존명사 '게' 띄어쓰기 (사는게/오는게/먹는게/보는게/하는게/되는게/없는게/있는게/만드는게)
      { re: /(사는|오는|보는|먹는|하는|되는|없는|있는|만드는|쓰는|찾는|아는|모르는|가는|주는|받는|만나는|읽는|배우는|드는|남는|쌓는)게(\s|$|[.,!?])/, msg: '~는게→~는 게' },
      // 지시 관형사 '이/그/저' + 명사 붙여쓰기 (이인식/그느낌/저생각 등)
      // 주의: 것/곳/때/쪽/점은 '이것/그때' 같은 정식 합성어가 있어 제외
      { re: /(이|그|저)(인식|느낌|생각|사실|얘기|문제|결과|기능|방식|사람|기업|제품|브랜드|이미지|경험|효과|차이|변화|부분|상황|이유|순간|기준|관점|태도|행동|선택|결정|판단|평가|반응|모습|모양|특징|성격|성질|상태|조건|환경|분위기)([은는이가을를에의로]|\s|$|[.,!?])/, msg: '이/그/저+명사→띄어쓰기' },
      // 명사 + ' 입니다/인지/이다' (조사·서술격 잘못 띄움) — '인식 입니다', '관계 입니다'
      { re: /[가-힣]\s(입니다|인지|이다|이며|입니까|이었|이었습니다)(\s|$|[.,!?])/, msg: '명사 입니다→명사입니다' },
      // 합성 동사 '들여다보다/돌이켜보다/내려다보다/쳐다보다' 띄어쓰기 잘못
      { re: /(들여다|돌이켜|내려다|쳐다|올려다|훑어|살펴|돌아|들여다)\s(보|봤|본|보는|봅)/, msg: '합성동사→붙여 쓰기' },
      // '본 것' 의존명사 (이것이/그것이) + 동사 띄어쓰기 — 추가 안전망
      { re: /(된|한|할|할|쓴|본|들은|만든|받은|배운|찾은|준)걸(\s|$|[.,!?])/, msg: '~ㄴ걸→~ㄴ 걸' },
      // P0 추가 (사용자 글 실측 위반 — Pass C에서도 강제 치환됨)
      { re: /(추위|더위|비|바람|눈|햇볕|소음|적|위협|영향)\s+로부터/, msg: '~ 로부터→~로부터' },
      { re: /(구조물|건물|건축물|시설물|결과물|기능|기술|역할|수준|효과|영향|기대)이상의/, msg: '~이상의→~ 이상의' },
      { re: /(지속가능성|중요성|필요성|가치|효과|영향|결과|차이|모습|존재)\s+까지/, msg: '~ 까지→~까지' },
      { re: /(있|없|모르|아)는\s지(는|를|에|에서|보다|만|도)?([.,!?\s]|$)/, msg: '~는 지→~는지' },
      { re: /(완공|시작|건설|체결|발표|발견|도입|개최|설립)되었을때/, msg: '~되었을때→~되었을 때' },
      { re: /기도합니다/, msg: '기도합니다→기도 합니다' },
      { re: /한가지(로|만|에|가|를|도|의)/, msg: '한가지→한 가지' },
      { re: /(일|사실|영향|결과|효과|일상|문제|역할)뿐아니라/, msg: '~뿐아니라→~뿐 아니라' },
      { re: /(빠질|할|볼|쓸|올|갈|줄|얻을|받을|만날|보낼|읽을)수\s/, msg: '~ㄹ수→~ㄹ 수' },
      // ㄹ수+있/없 결합형 (사용자 글 실측 — "꺼낼수있는/통할수있을지/버틸수없지만")
      { re: /(빠질|할|볼|쓸|올|갈|잘|줄|얻을|받을|만날|보낼|읽을|꺼낼|버틸|통할|이길|살아남을|벗어날|치를|배울|이해할|판단할|해결할|찾을)수(있|없)/, msg: '~ㄹ수+있/없→~ㄹ 수 있/없' },
      // 의존명사 '데' (사용자 글 실측 — "갖추는데 있다")
      { re: /(지키|만들|살|쓰|배우|찾|보|걸|구하|이해하|받아들이|판단하|결정하|해결하|갖추|버티|통하|이기|적응하|대응하|성장하|살아남)는데\s+(있|의의|의미|도움|기여|초점|중점|목적|이유|핵심|목표|관건|보탬|어려움|걸림돌)/, msg: '~는데 (의존명사)→~는 데' }
    ];
    const spellIssues = spellingRules.filter(r => r.re.test(text)).map(r => r.msg);
    if (spellIssues.length > (result.spellingIssues?.length || 0)) {
      overrides.push(`spellingIssues ${(result.spellingIssues || []).length} → ${spellIssues.length}`);
      result.spellingIssues = spellIssues;
    }

    // ===== 절대 금지 1항 안전망: 사례 누적 / 사례 직후 해석 누락 실측 =====
    // evidence 문장 휴리스틱: 객관 사실/수치/인용 마커. 도메인 무관 일반화.
    const evidenceRe = new RegExp([
      '(?:19|20)\\d{2}',                                    // 연도
      '\\d+(?:\\.\\d+)?\\s*(?:%|％|퍼센트|배|건|명|개|곳|회|차|년|위|등)',  // 수치+단위
      '\\d+(?:,\\d{3})*\\s*(?:원|달러|엔|위안|유로|만|억|조)',          // 화폐/규모
      '(?:에 따르면|에 의하면|조사 결과|발표(?:했|에)|보고서|통계청|한국은행|기상청|p\\s*[<≤=]\\s*0\\.\\d+)'  // 인용·통계 마커
    ].join('|'));
    const evidenceFlags = sentences.map(s => evidenceRe.test(s));
    const actualEvidenceCount = evidenceFlags.filter(Boolean).length;
    if (actualEvidenceCount > (result.evidenceCount || 0)) {
      overrides.push(`evidenceCount ${result.evidenceCount} → ${actualEvidenceCount}`);
      result.evidenceCount = actualEvidenceCount;
    }

    // 사례 문장 직후 해석 누락: 다음 문장도 evidence이면 누락 카운트++
    // 마지막 문장이 evidence인 케이스는 lastSentenceIsReassurance/별도 룰에 맡기고 여기선 인접만 검출.
    let evidenceNoInterp = 0;
    for (let i = 0; i < evidenceFlags.length - 1; i++) {
      if (evidenceFlags[i] && evidenceFlags[i + 1]) evidenceNoInterp++;
    }
    if (evidenceNoInterp > (result.evidenceWithoutInterpretation || 0)) {
      overrides.push(`evidenceWithoutInterpretation ${result.evidenceWithoutInterpretation} → ${evidenceNoInterp}`);
      result.evidenceWithoutInterpretation = evidenceNoInterp;
    }

    // 단락별 사례 밀도: 한 단락당 최대 evidence 개수
    let evidencePerParaMax = 0;
    for (const p of paragraphs) {
      const ps = p.split(/(?<=[.!?？。])\s+/).map(s => s.trim()).filter(Boolean);
      const cnt = ps.filter(s => evidenceRe.test(s)).length;
      if (cnt > evidencePerParaMax) evidencePerParaMax = cnt;
    }
    if (evidencePerParaMax > (result.evidencePerParagraphMax || 0)) {
      overrides.push(`evidencePerParagraphMax ${result.evidencePerParagraphMax} → ${evidencePerParaMax}`);
      result.evidencePerParagraphMax = evidencePerParaMax;
    }

    // ===== 절대 금지 핵심: 입력에 없는 신규 사실 주입 직접 차집합 =====
    // 사용자 카피킬러 100% 감지 실측 — LLM이 학습 데이터에서 연도·통계·기관명을 끌어와 박는 게 진범.
    // evidenceCount 누적만으론 "입력에 원래 있었던 사례"와 "신규 주입"을 구분 못 함 → 입력과 직접 비교.
    if (inText) {
      const extractYears = (s) => new Set(s.match(/(?:19|20)\d{2}/g) || []);
      const extractPercents = (s) => new Set(
        (s.match(/\d+(?:\.\d+)?\s*(?:%|％|퍼센트)/g) || []).map(p => p.replace(/\s+/g, ''))
      );
      // 한글 4자+ 단어 중 기관·기업 접미사로 끝나는 고유명사 (~상공회의소/~연구원/~공사/~협회/~재단/~위원회/~기구/~연구소/~본부/~센터)
      const orgRe = /[가-힣]{2,}(?:상공회의소|연구원|공사|협회|재단|위원회|기구|연구소|본부|센터|기관)/g;
      const inYears = extractYears(inText);
      const inPcts = extractPercents(inText);
      const outYears = extractYears(text);
      const outPcts = extractPercents(text);
      const inOrgs = new Set(inText.match(orgRe) || []);
      const outOrgs = new Set(text.match(orgRe) || []);
      const novelty = [];
      for (const y of outYears) if (!inYears.has(y)) novelty.push(y);
      for (const p of outPcts) if (!inPcts.has(p)) novelty.push(p);
      for (const o of outOrgs) if (!inOrgs.has(o)) novelty.push(o);
      if (novelty.length > 0) {
        overrides.push(`noveltyInjection ${novelty.join(', ')}`);
        result.noveltyInjectionCount = novelty.length;
        result.noveltyInjectionItems = novelty;
      } else {
        result.noveltyInjectionCount = 0;
        result.noveltyInjectionItems = [];
      }
    }

    // ===== 카피킬러 "추상·구체성 부족·무견해" 시그너처 직격 실측 =====
    // 사용자 100% 케이스 진범: 원문 추상 + hedge 일색 + 메타 1인칭만 추가 → 카피킬러 직격.
    // 우리 룰이 보는 시그너처 ≠ 카피킬러 시그너처였음. 1인칭 구체 일화 / 단정 / 회피 1인칭을 별도 측정.
    const fpAnchorRe = /(?:저는|저의|저에게|저로서는|제가|제\s|개인적으로|내가|나는)/;
    const anecdoteTimeRe = /(?:어제|오늘|올해|작년|재작년|지난\s*(?:학기|학년|주|달|해|번)|이번\s*(?:학기|학년|주|달)|며칠|몇\s*(?:달|주|개월)|학년\s*때|학기|중학교\s*때|고등학교\s*때|대학교\s*때|수능|입시)/;
    const anecdotePlaceRe = /(?:기숙사|강의실|학원|학교|동아리(?:방)?|도서관|편의점|카페|식당|버스|지하철|기차|연구실|회의|회사|사무실|교실|운동장|놀이터)/;
    const anecdotePersonRe = /(?:친구|선배|후배|동기|룸메(?:이트)?|교수님?|강사|선생님|어머니|아버지|엄마|아빠|형|누나|동생|언니|오빠|팀원|동료|상사|사장)/;
    // ★ hedge 패턴 — 추정·완화 표현. hedgeRe2가 매치되면 그 문장은 hedge로 분류 (단정에서 제외).
    //   "기도 합니다 / 본다 / 생각한다 / 던 것 같 / 는지도" 같이 사용자 실측에 자주 등장한 표현 보강.
    const hedgeRe2 = /(?:것\s*같|듯하|듯이|듯합|지도\s*모|는지도|수도\s*있|수\s*있|기도\s*하|생각합|생각한다|봅니다|본다|보입니다|싶습|싶다|할\s*것\s*같|아닐까|일\s*수\s*있|지\s*않을까|던\s*것\s*같)/;
    // ★ 단정 종결 — 한국어 ~ㅂ니다/~다 종결은 어간이 다양해서 어간별 나열 불가. [가-힣]니다 / [가-힣]다 패턴으로 일반화.
    //   사용자 실측 진범: 이전 정규식이 "합니다"만 명시해서 "됐습니다 / 들어왔습니다 / 분명합니다 / 들어왔습니다" 같은 흔한 ~ㅂ니다 종결을 못 잡아 assertiveCnt 5 → 0 덮어쓰기 유발.
    const assertiveEndingRe = /(?:[가-힣]니다|[가-힣]다)$/;
    // ★ 회피 1인칭 — "답을 찾는 중 / 고민 중 / 모색하고 있" 같이 카피킬러가 "무견해" 시그너처로 잡는 우회 표현 추가.
    const avoidanceRe = /(?:잘\s*모르겠|알\s*수\s*없|판단하기\s*어렵|말하기\s*어렵|확신할\s*수\s*없|단정하기\s*어렵|답을\s*찾(?:는\s*중|고\s*있)|고민\s*중|고민하고\s*있|모색하고\s*있|찾고\s*있)/;

    let firstPersonAnecdote = 0;
    let assertiveCnt = 0;
    let avoidanceCnt = 0;
    for (const raw of sentences) {
      const s = raw.trim();
      if (!s) continue;
      const stripped = s.replace(/[.!?？。\s]+$/, '');
      const hasFirstPerson = fpAnchorRe.test(s);
      if (hasFirstPerson && (anecdoteTimeRe.test(s) || anecdotePlaceRe.test(s) || anecdotePersonRe.test(s))) {
        firstPersonAnecdote++;
      }
      if (!hedgeRe2.test(s) && assertiveEndingRe.test(stripped)) {
        assertiveCnt++;
      }
      if (hasFirstPerson && avoidanceRe.test(s)) {
        avoidanceCnt++;
      }
    }
    if (firstPersonAnecdote !== (result.firstPersonAnecdoteCount || 0)) {
      overrides.push(`firstPersonAnecdoteCount ${result.firstPersonAnecdoteCount} → ${firstPersonAnecdote}`);
      result.firstPersonAnecdoteCount = firstPersonAnecdote;
    }
    if (assertiveCnt !== (result.assertiveSentenceCount || 0)) {
      overrides.push(`assertiveSentenceCount ${result.assertiveSentenceCount} → ${assertiveCnt}`);
      result.assertiveSentenceCount = assertiveCnt;
    }
    if (avoidanceCnt !== (result.judgmentAvoidanceCount || 0)) {
      overrides.push(`judgmentAvoidanceCount ${result.judgmentAvoidanceCount} → ${avoidanceCnt}`);
      result.judgmentAvoidanceCount = avoidanceCnt;
    }

    // ===== 후반 일반론 클러스터링 감지 (consecutiveAbstractParagraphRun) =====
    // 사용자 100% 케이스: 앞 2문단만 일화, 뒤 4문단 일반론 — 글 전체 평균으론 안 잡힘.
    // 문단별 1인칭 일화 카운트 → 0건 문단 연속 최대 길이가 시그너처 측정값.
    let maxAbstractRun = 0;
    let abstractRun = 0;
    for (const para of paragraphs) {
      const paraSents = para.split(/(?<=[.!?？。])\s+|\n+/).map(s => s.trim()).filter(Boolean);
      let paraAnecdote = 0;
      for (const ps of paraSents) {
        if (fpAnchorRe.test(ps) && (anecdoteTimeRe.test(ps) || anecdotePlaceRe.test(ps) || anecdotePersonRe.test(ps))) {
          paraAnecdote++;
        }
      }
      if (paraAnecdote === 0) {
        abstractRun++;
        maxAbstractRun = Math.max(maxAbstractRun, abstractRun);
      } else {
        abstractRun = 0;
      }
    }
    if (maxAbstractRun !== (result.consecutiveAbstractParagraphRun || 0)) {
      overrides.push(`consecutiveAbstractParagraphRun ${result.consecutiveAbstractParagraphRun || 0} → ${maxAbstractRun}`);
      result.consecutiveAbstractParagraphRun = maxAbstractRun;
    }

    // ===== 흐름 표지(접속사) 측정 — 카피킬러 "논점 변화·논리적 전개 부재" 시그너처 직격 =====
    // 강조·반전 접속사: 논점 전환·강조 표지. 0건이면 "한 가지 주장 단조 반복" 시그너처.
    // 인과·논리 접속사: 논리 흐름 표지. 0건이면 "근거-결과 연결 부재" 시그너처.
    const emphaticConnectorRe = /(그러나|하지만|다만|오히려|정작|막상|그렇지만|반면(?:에)?|되려|도리어|새삼|사실은)/g;
    const causalConnectorRe = /(그래서|그러므로|왜냐하면|때문(?:에|이다|이며|입니다)|따라서|덕분에|결국|결과적으로)/g;
    const emphaticCnt = (text.match(emphaticConnectorRe) || []).length;
    const causalCnt = (text.match(causalConnectorRe) || []).length;
    if (emphaticCnt !== (result.emphaticConnectorCount || 0)) {
      overrides.push(`emphaticConnectorCount ${result.emphaticConnectorCount || 0} → ${emphaticCnt}`);
      result.emphaticConnectorCount = emphaticCnt;
    }
    if (causalCnt !== (result.causalConnectorCount || 0)) {
      overrides.push(`causalConnectorCount ${result.causalConnectorCount || 0} → ${causalCnt}`);
      result.causalConnectorCount = causalCnt;
    }

    // ===== 추상 진술 비율 측정 — 카피킬러 "추상·일반적 내용 구성" 시그너처 직격 =====
    // 가능·당위 종결 + 추상 명사 다발 + 일반화 부사 중 *하나라도* 매칭하면 그 문장은 추상 진술.
    // hedge 표현은 제외 (인간 시그너처). "할 수 있을 것 같다"는 hedge이지 추상 단정 아님.
    const abstractEndingRe = /(할 수 있|할 필요가 있|여야 한|에 달려 있|할 수밖에 없|기 마련|는 셈|는 법|라는 점|이라는 점|는 것이다|는 것입니다)/;
    const abstractNounRe = /(능력|중요성|필요성|가치|의미|역량|기여|영향|역할|기반|요인|관점|자세|태도|접근|방식|구조|체계|핵심|본질|특성|성격|면모|측면|차원)/;
    const generalizationAdvRe = /(결국적|결과적으로|궁극적으로|근본적으로|전반적으로|기본적으로|핵심적으로|본질적으로|결정적으로)/;
    let abstractCnt = 0;
    for (const raw of sentences) {
      const s = raw.trim();
      if (!s) continue;
      const hasAbstractEnding = !hedgeRe2.test(s) && abstractEndingRe.test(s);
      const hasAbstractNoun = abstractNounRe.test(s);
      const hasGenAdv = generalizationAdvRe.test(s);
      if (hasAbstractEnding || hasAbstractNoun || hasGenAdv) {
        abstractCnt++;
      }
    }
    const abstractRatio = sentences.length > 0 ? abstractCnt / sentences.length : 0;
    const abstractRatioRounded = Number(abstractRatio.toFixed(3));
    if (Math.abs(abstractRatioRounded - (result.abstractStatementRatio || 0)) > 0.03) {
      overrides.push(`abstractStatementRatio ${(result.abstractStatementRatio || 0).toFixed(2)} → ${abstractRatioRounded.toFixed(2)}`);
      result.abstractStatementRatio = abstractRatioRounded;
    }

    // ===== 흐름 연결어 비율 측정 — 카피킬러 "문장 간 이어짐 부자연스러움 / 단절적" 시그너처 직격 =====
    // 두 번째 이후 문장 중 자연 흐름 연결어로 시작하는 비율. 0.20 이상 권장.
    // emphatic/causal과 별개 axis: 일반 흐름 표지 (그리고/또/특히/근데/그러니까 등).
    const interSentenceConnectorRe = /^(?:그리고|또(?:는)?|특히|예를\s*들|이를테면|근데|그런데|그러니까|그렇다면|그러면|그래도|또한|즉|아무튼|어쨌든|한편|뭐랄까|말하자면)/;
    let connectorMatchCount = 0;
    for (let i = 1; i < sentences.length; i++) {
      const s = sentences[i].trim();
      if (interSentenceConnectorRe.test(s)) connectorMatchCount++;
    }
    const interSentRatio = sentences.length > 1 ? connectorMatchCount / (sentences.length - 1) : 0;
    const interSentRatioRounded = Number(interSentRatio.toFixed(3));
    if (Math.abs(interSentRatioRounded - (result.interSentenceConnectorRatio || 0)) > 0.03) {
      overrides.push(`interSentenceConnectorRatio ${(result.interSentenceConnectorRatio || 0).toFixed(2)} → ${interSentRatioRounded.toFixed(2)}`);
      result.interSentenceConnectorRatio = interSentRatioRounded;
    }
  }

  // 임계 기준으로 selfCheckPass 재계산. shouldRefine 임계와 정렬해 "달성 가능한 게이트"로 작동.
  let violations =
    (result.topNounCounts && Object.values(result.topNounCounts).some(n => n >= 4)) ||
    result.listOfThreeCount >= 1 ||
    result.consecutiveNounSubjectMax >= 4;  // 폐기한 옛 룰 3 잔재 정리, shouldRefine과 일치
    // shortSentenceRatio 위반 폐기 — 룰 2 갱신(평균 40~55자, 단문 *제한*)과 정면 충돌.
    // hedgeRatio 위반 폐기 (사용자 0% 통과 글 hedgeRatio 16.7% — 인간 분포가 5~20%).
    // 한국어 카피킬러는 hedge·관찰형 종결을 인간 시그너처로 학습.

  if (mode === 'assignment') {
    violations = violations
      || result.lastSentenceIsReassurance === true
      || (result.declarativeDefinitionCount || 0) >= 3
      || (result.evidenceCount || 0) >= 4
      || !!result.paragraphCountMismatch
      || (typeof result.commaClauseRatio === 'number' && result.commaClauseRatio > 0.15)
      || (typeof result.passiveVoiceRatio === 'number' && result.passiveVoiceRatio > 0.35)
      || (typeof result.longSentenceRatio === 'number' && result.longSentenceRatio > 0.40)
      // shortRunWithoutComma·tinySentenceCount·longShortAdjacencyCount 위반 폐기.
      // 룰 2(평균 40~55자, 단문 20~30자) + 룰 3(콤마 절제)과 충돌.
      // 단문 강제는 룰 2 단문 *제한* 방향과 정면 반대.
      || (result.sameEndingRun || 0) >= 4    // 프롬프트 룰 1 "4문장 연속 금지"와 일치
      || (result.similarLengthRun || 0) >= 3
      || (Array.isArray(result.spellingIssues) && result.spellingIssues.length > 0)
      || !!result.lengthShortfall
      || (result.evidenceWithoutInterpretation || 0) >= 1
      || (result.evidencePerParagraphMax || 0) >= 3
      || (result.noveltyInjectionCount || 0) >= 1
      || (result.dominantHedgeCount || 0) >= 4;
  }

  const recomputedPass = !violations;

  if (overrides.length > 0) {
    logger.debug('analyze.verify_overrides', { overrides });
  }
  if (result.selfCheckPass !== recomputedPass) {
    logger.debug('analyze.self_check_recomputed', { previous: result.selfCheckPass, recomputed: recomputedPass });
    result.selfCheckPass = recomputedPass;
  }

  return result;
}

// 2-pass refine 게이트: critical 위반 1건이거나 minor 위반이 5건 이상일 때만 재호출.
// minor refine이 자주 발동하면 모델이 "룰 더 충족하는 방향"으로 다듬어 정형성이 짙어진다 → 임계 완화.
function shouldRefine(result, mode, inputParaCount) {
  // 1인칭 일화 임계 — 글 길이 비례. 6문단이면 2건+, 9문단이면 3건+ 필요.
  // 절대치 1건 고정은 긴 글에서 부족 (사용자 100% 케이스 6문단/2건이 minor 임계도 못 넘김).
  const anecdoteThreshold = mode === 'assignment'
    ? Math.max(1, Math.floor((inputParaCount || 1) / 3))
    : 1;
  const critical =
    (result.topNounCounts && Object.values(result.topNounCounts).some(n => n >= 4))
    || (result.listOfThreeCount || 0) >= 1
    || (Array.isArray(result.spellingIssues) && result.spellingIssues.length > 0)
    || (mode === 'assignment' && !!result.paragraphCountMismatch)
    || (mode === 'assignment' && result.lastSentenceIsReassurance === true)
    || (mode === 'assignment' && (result.declarativeDefinitionCount || 0) >= 3)
    || (mode === 'assignment' && (result.evidenceCount || 0) >= 4)
    || (mode === 'assignment' && (result.evidenceWithoutInterpretation || 0) >= 1)
    || (mode === 'assignment' && (result.evidencePerParagraphMax || 0) >= 3)
    || (mode === 'assignment' && (result.noveltyInjectionCount || 0) >= 1)
    || (mode === 'assignment' && (result.dominantHedgeCount || 0) >= 4)
    || (mode === 'assignment' && typeof result.passiveVoiceRatio === 'number' && result.passiveVoiceRatio > 0.35)
    || (mode === 'assignment' && typeof result.longSentenceRatio === 'number' && result.longSentenceRatio > 0.30)
    || (mode === 'assignment' && typeof result.commaClauseRatio === 'number' && result.commaClauseRatio > 0.25)
    || (mode === 'assignment' && (result.firstPersonAnecdoteCount || 0) < anecdoteThreshold)
    || (mode === 'assignment' && (result.consecutiveAbstractParagraphRun || 0) >= 4)
    || !!result.lengthShortfall;
  if (critical) return { refine: true, reason: 'critical' };

  let minor = 0;
  // shortSentenceRatio < 0.15 minor 폐기 — 룰 2 갱신(단문 제한)과 충돌.
  // hedgeRatio 임계 변경: 7~22% → 5~17%. 근거: 통과 글 corpus hedge 16.7%가 상한 근처(reference_copykiller_passing_corpus).
  // 17% 초과면 hedge 일색 → 무견해 시그너처 직격(사용자 100% 케이스). 하한은 학술 근거(단순 paraphrase로 hedge 제거 시 감지율↑)에 따라 5% 유지.
  if (typeof result.hedgeRatio === 'number' && (result.hedgeRatio < 0.05 || result.hedgeRatio > 0.17)) minor++;
  if ((result.consecutiveNounSubjectMax || 0) >= 4) minor++;
  if (mode === 'assignment') {
    if (typeof result.commaClauseRatio === 'number' && result.commaClauseRatio > 0.15) minor++;
    if ((result.sameEndingRun || 0) >= 4) minor++;
    if ((result.similarLengthRun || 0) >= 4) minor++;
    // evidenceCount >= 4 는 critical로 격상됨(O2). minor 트리거에선 제거.
    if ((result.questionSentenceCount || 0) === 0) minor++;
    if ((result.dominantHedgeCount || 0) === 3) minor++;
    if ((result.firstPersonCount || 0) < 2) minor++;
    if ((result.dominantFirstPersonCount || 0) >= 4) minor++;  // 룰 6: "저는" 단일 4회+ 반복 시 단조로움 시그너처
    if (typeof result.passiveVoiceRatio === 'number' && result.passiveVoiceRatio > 0.25) minor++;
    if (typeof result.longSentenceRatio === 'number' && result.longSentenceRatio > 0.30) minor++;
    // firstPersonAnecdoteCount는 critical로 승격 (글 길이 비례 임계, shouldRefine 상단에서 처리).
    if ((result.assertiveSentenceCount || 0) < 3) minor++;
    if ((result.judgmentAvoidanceCount || 0) >= 2) minor++;
    // 카피킬러 "논점 변화·논리적 전개 부재" 시그너처 직격 minor.
    if ((result.emphaticConnectorCount || 0) < 1) minor++;
    if ((result.causalConnectorCount || 0) < 1) minor++;
    // 카피킬러 "추상·일반적 내용 구성" 시그너처 직격 minor. critical 임계는 실측 후 결정.
    if (typeof result.abstractStatementRatio === 'number' && result.abstractStatementRatio > 0.50) minor++;
    // 카피킬러 "문장 간 이어짐 부자연스러움 / 단절적" 시그너처 직격 minor.
    if (typeof result.interSentenceConnectorRatio === 'number' && result.interSentenceConnectorRatio < 0.20) minor++;
  }
  return { refine: minor >= 5, reason: minor >= 5 ? `minor x${minor}` : 'pass' };
}

// 셀프체크 수치를 임계와 대조해 위반된 항목을 사람이 읽을 문장으로 반환
function collectFailedFields(r, mode, inputParaCount) {
  const anecdoteThreshold = mode === 'assignment'
    ? Math.max(1, Math.floor((inputParaCount || 1) / 3))
    : 1;
  const failed = [];
  if (r.topNounCounts && Object.values(r.topNounCounts).some(n => n >= 4)) {
    const over = Object.entries(r.topNounCounts).filter(([, n]) => n >= 4).map(([k, n]) => `"${k}" ${n}회`).join(', ');
    failed.push(`주제어 4회 이상 반복(룰 5 어휘 다양화): ${over} — 지시어/유의어로 교체`);
  }
  if (r.listOfThreeCount >= 1) {
    failed.push(`3개 이상 나열 ${r.listOfThreeCount}건(룰 3 콤마 절 누적 금지, AI 시그너처) — 별도 문장으로 분리하거나 "A부터 C까지" 같은 구간 표현으로`);
  }
  if (r.lengthShortfall) {
    const pct = (r.lengthShortfall.ratio * 100).toFixed(0);
    failed.push(`분량 부족 ${pct}% (원문 ${r.lengthShortfall.input}자 → 출력 ${r.lengthShortfall.output}자, 최소 90% 보장) — 빠뜨린 원문 디테일·예시·근거를 복원해서 분량을 늘려라. 압축·요약 금지.`);
  }
  if (r.consecutiveNounSubjectMax >= 3) {
    failed.push(`명사 주어 ${r.consecutiveNounSubjectMax}연속 — 중간 문장을 부사/접속사/지시어로 시작`);
  }
  if (typeof r.hedgeRatio === 'number' && (r.hedgeRatio < 0.05 || r.hedgeRatio > 0.17)) {
    failed.push(`추정 어미 비율 ${(r.hedgeRatio * 100).toFixed(0)}%(목표 8~15%, 통과 분포 상한 16.7%) — 너무 높으면 hedge 일색이 돼 카피킬러 "무견해" 시그너처 직격(사용자 100% 케이스). 너무 낮으면 LLM처럼 단정적. hedge 풀세트는 유지하되, 결론·핵심 주장 문장은 hedge 없이 단정으로 종결해 균형.`);
  }
  if (mode === 'assignment') {
    if (r.lastSentenceIsReassurance === true) {
      failed.push(`마지막 문장이 재보증/평가(룰 1 hedge 마무리 위반) — '~할 필요가 있다/~에 달려 있다/~지속가능한지는' 대신 구체 사례·미해결 질문·관찰로 닫아라`);
    }
    if ((r.questionSentenceCount || 0) === 0) {
      failed.push(`의문문 0건(룰 1 변형 종결 권장 — 1~3건 자연 배치) — 정보를 진짜로 묻는 의문문 또는 hedge 의문문(~지 않을까요?, 정말 그럴까요?) 1건 정도 추가. 수사적 의문문은 사용 가능(인간 시그너처)`);
    }
    if (r.paragraphCountMismatch) {
      const { input, output, tolerance } = r.paragraphCountMismatch;
      failed.push(`문단 수 허용범위 초과: 입력 ${input}문단 → 출력 ${output}문단(허용 ±${tolerance ?? 0}). \\n\\n 추가/삭제를 입력 ±${tolerance ?? 0}문단 안으로 조정하라.`);
    }
    if (typeof r.commaClauseRatio === 'number' && r.commaClauseRatio > 0.15) {
      failed.push(`쉼표 복문 비율 ${(r.commaClauseRatio * 100).toFixed(0)}%(룰 3 콤마 절제, 목표 15% 이하 — KatFishNet 측정 한국어 LLM 시그너처 직격) — 쉼표로 이어붙인 긴 문장을 마침표로 끊어 독립 문장으로 재배치. 한 문장 콤마 1개 이하 권장. "A하고, B하며, C합니다" 식으로 절 3개 이어붙이면 카피킬러 "압축·단절" 시그너처 직격.`);
    }
    if (typeof r.passiveVoiceRatio === 'number' && r.passiveVoiceRatio > 0.25) {
      failed.push(`수동·비인칭 동사 ${(r.passiveVoiceRatio * 100).toFixed(0)}%(룰 7 수동태 회피, 목표 25% 이하) — 카피킬러 피드백 "수동태·비인칭 구조 중심 → 글쓴이 관점 부재" 직격. "여겨졌습니다 / 만들어집니다 / 뒤집혔습니다 / 정비되고 있고 / 이어지고 있습니다 / 평가받게 될" 같은 수동·중간태를 능동으로 전환. "기업이 ~을 한다 / 저는 ~을 본다 / 사람들은 ~을 고른다" 식의 명확한 주체+능동 동사로 절반 이상 교체.`);
    }
    if (typeof r.longSentenceRatio === 'number' && r.longSentenceRatio > 0.30) {
      failed.push(`60자+ 장문 비율 ${(r.longSentenceRatio * 100).toFixed(0)}%(룰 2 문장 길이, 목표 30% 이하) — 60자+ 문장은 글 전체에서 30% 이내로. 콤마로 절을 이어 60자+로 늘이지 말되, 마침표로 자를 때 *흐름 연결어*("그래서/근데/특히/뭐랄까")로 이어 단절감 막아라. 단순 분할만 하면 "압축·단절 서술" 시그너처 박힘.`);
    }
    if (typeof r.interSentenceConnectorRatio === 'number' && r.interSentenceConnectorRatio < 0.20) {
      failed.push(`흐름 연결어 비율 ${(r.interSentenceConnectorRatio * 100).toFixed(0)}% (목표 20%+) — 카피킬러 피드백 "문장 간 이어짐 부자연스러움 / 단절적" 직격. 인접 문장이 정보 단편으로 나열되고 있음. 두 번째 이후 문장 5개 중 1개+는 "그리고/또/특히/근데/그러니까/예를 들면" 같은 흐름 연결어로 시작해 사실 사이 연결을 만들어라.`);
    }
    if ((r.sameEndingRun || 0) >= 3) {
      failed.push(`동일 종결어미 ${r.sameEndingRun}연속(룰 1 종결어미 다양화 — 4문장 연속 금지) — 3번째 문장을 변형 종결(~까요? / ~던 것 같습니다 / ~인지도 모릅니다 / ~기도 합니다)로 교체`);
    }
    if ((r.similarLengthRun || 0) >= 3) {
      failed.push(`문장 길이 ±5자 ${r.similarLengthRun}연속(룰 2 문장 길이) — 중간 문장을 대폭 줄이거나 늘려서 리듬 파괴. 평균 40~55자 권장 + 단문(20~30자) 1개 정도로 호흡 끊기, 중장문(50~75자) 자연스럽게 섞기.`);
    }
    if (Array.isArray(r.spellingIssues) && r.spellingIssues.length > 0) {
      failed.push(`맞춤법/띄어쓰기 오류(P0): ${r.spellingIssues.join(', ')} — 해당 표기 교정`);
    }
    if ((r.evidenceWithoutInterpretation || 0) >= 1) {
      failed.push(`사례 직후 해석 누락 ${r.evidenceWithoutInterpretation}건(절대 금지 1항 안전망) — 입력에 없는 연도·기업·통계가 새로 박혔다면 모두 제거. 입력에 있어 유지한 사례는 직후에 글쓴이 판단·의문·반전 1문장을 반드시 붙여라. 사례를 연달아 나열하지 마라.`);
    }
    if ((r.evidencePerParagraphMax || 0) >= 3) {
      failed.push(`한 단락에 사례 ${r.evidencePerParagraphMax}건 누적(절대 금지 1항 안전망, 최대 2건) — 입력에 없는 사례는 모두 제거. 입력 사례라도 한 단락에 1~2개까지만 두고, 직후에 글쓴이 해석을 붙여라.`);
    }
    if ((r.declarativeDefinitionCount || 0) >= 3) {
      failed.push(`단정 정의문 ${r.declarativeDefinitionCount}건(룰 4 고유명사+사실 단정 금지) — LLM overconfidence 시그너처 직격(학술 근거: arxiv 2510.26995 LLM 84.3% overconfident, MASH 2601.08564 ASR 92%). "[고유명사]는 ~사례입니다 / ~증거입니다 / ~보여줍니다 / ~상징입니다" 같은 confident declarative 패턴이 카피킬러에 직접 잡힘. 대신 "'~를 보면 / ~ 앞에 서면 / ~ 한 채에도" 같은 관찰·능동 시작으로 절반 이상 교체. 예: "엠파이어스테이트 빌딩은 그 시대 기술력의 사례입니다" → "엠파이어스테이트 빌딩을 보면 그 시대 기술력이 한눈에 들어옵니다".`);
    }
    if ((r.evidenceCount || 0) >= 4) {
      failed.push(`전체 사례 인용 ${r.evidenceCount}건(절대 금지 1항 critical, 권장 0~2건) — 사용자 카피킬러 87% 감지 실측: 사례·정량 사실이 한 글에 4건 이상 누적되면 LLM overconfidence 시그너처로 직접 잡힘. 입력 글에 없는 연도·기관명·통계는 모두 제거. 입력 사례는 추상 진술과 글쓴이 판단으로 갈아끼우고, 꼭 필요한 한두 개만 남겨라.`);
    }
    if ((r.noveltyInjectionCount || 0) >= 1) {
      const items = Array.isArray(r.noveltyInjectionItems) ? r.noveltyInjectionItems.join(', ') : '';
      failed.push(`입력 글에 없는 신규 사실 ${r.noveltyInjectionCount}건 주입 (절대 금지 직격): ${items} — 사용자 카피킬러 100% 감지 실측의 진범. 학습 데이터에서 끌어온 연도(YYYY)·통계(%)·기관명을 모두 제거하고, 해당 문장을 입력 글에 있는 추상 진술 + 글쓴이 관찰·판단으로 갈아끼워라. "유니레버/대한상공회의소" 같은 외래 고유명사 신규 주입도 금지.`);
    }
    if ((r.dominantHedgeCount || 0) >= 3) {
      failed.push(`동일 hedge 표현 "${r.dominantHedgeName || ''}" ${r.dominantHedgeCount}회 반복 — hedge 풀세트 다양화 효과 무력화로 "기계적 균일성" 시그너처 박힘 (카피킬러 피드백 직격). 같은 hedge는 글 전체에서 2회 이하로 제한하고, 나머지는 다른 형태(~던 것 같습니다 / ~지도 모릅니다 / ~기도 합니다 / ~지 않을까요?)로 분산. 단정 평서로 끝나도 무방.`);
    }
    if ((r.firstPersonCount || 0) < 2) {
      failed.push(`1인칭 anchor ${r.firstPersonCount || 0}건 (목표 2건+) — 카피킬러 피드백 "글쓴이 관점 부재 / 간접·비인칭 서술 반복" 직격. "제가 ~ 보면서 / 저는 ~ 했을 때 / 저로서는 ~" 같은 1인칭 시점을 글 중간에 2개 이상 자연스럽게 배치.`);
    }
    if ((r.dominantFirstPersonCount || 0) >= 4) {
      failed.push(`"저는" ${r.dominantFirstPersonCount}회 반복 (룰 6 "저는 4회+ 금지", 단조로움 시그너처) — "제가/저로서는/개인적으로/저에게는" 등 다른 1인칭 anchor로 분산.`);
    }
    if ((r.firstPersonAnecdoteCount || 0) < anecdoteThreshold) {
      failed.push(`1인칭 구체 일화 ${r.firstPersonAnecdoteCount || 0}건 (목표 ${anecdoteThreshold}건+, 글 ${inputParaCount || '?'}문단 길이 비례) — 카피킬러 피드백 "추상·일반 내용 구성 / 구체적 근거 부족" 직격(사용자 100% 케이스 진범). 원문 추상 진술을 "제가 작년 학기에 ~한 적이 있다 / 제 친구가 ~한다 / 지난 달 기숙사에서 ~" 같이 시간·장소·인물 동반 1인칭 경험으로 *교체*하라. ★ 외부 통계·연도(YYYY)·기관명·기업명·인명·% 수치는 절대 금지 — 글쓴이 *개인 경험만*. "저는 생각합니다" 같은 메타 1인칭은 일화 아님. 글 후반 일반론 문단을 우선 교체.`);
    }
    if ((r.consecutiveAbstractParagraphRun || 0) >= 4) {
      failed.push(`일반론 문단 ${r.consecutiveAbstractParagraphRun}개 연속 (3 이하 필수) — 글 일부 구간이 1인칭 일화 0건으로 연속됨. 카피킬러 피드백 "추상·일반 내용" 직격 시그너처. 일화가 없는 연속 구간 중 *최소 한 문단*에 1인칭 구체 경험("제가 ~한 적이 있다 / 제 친구가 ~한다")을 추가로 끼워 넣어 끊어라. 글 초반에만 일화 몰빵하지 말고 중반·후반에도 분산.`);
    }
    if ((r.emphaticConnectorCount || 0) < 1) {
      failed.push(`강조·반전 접속사 0건 (1건+ 권장) — 카피킬러 피드백 "논점 변화 부재" 직격. 글 중간에 "그러나/하지만/다만/오히려/정작/사실은" 중 1개를 자연스럽게 배치해 논점 전환·강조 표지를 만들어라. 억지로 끼우지 말고 실제로 반전이 일어나는 자리에.`);
    }
    if ((r.causalConnectorCount || 0) < 1) {
      failed.push(`인과·논리 접속사 0건 (1건+ 권장) — 카피킬러 피드백 "논리적 전개 부재" 직격. "그래서/그러므로/때문에/따라서/덕분에" 중 1개를 자연스럽게 배치해 근거-결과 연결 표지를 만들어라. 사실 나열만 이어지면 단조 시그너처.`);
    }
    if (typeof r.abstractStatementRatio === 'number' && r.abstractStatementRatio > 0.50) {
      failed.push(`추상 진술 비율 ${(r.abstractStatementRatio * 100).toFixed(0)}% (목표 50% 이하) — 카피킬러 피드백 "추상·일반적 내용 구성(AI는 개념·원리·방법론 중심)" 직격. 가능·당위 종결("~할 수 있다/~할 필요가 있다/~여야 한다") + 추상 명사("능력/중요성/필요성/가치/관점/태도") + 일반화 부사("결국/궁극적/근본적으로")가 글 골격이 됨. 추상 진술 일부를 구체 장면·1인칭 경험("제가 작년 학기에 ~한 적이 있다 / 룸메이트가 ~했다")으로 *교체*하라. 추상 명사를 동작·사물로 풀어쓰기: "능력은 직결됩니다" → "한 학기 차이가 성적에 그대로 나타났습니다".`);
    }
    if ((r.assertiveSentenceCount || 0) < 3) {
      failed.push(`단정 종결 ${r.assertiveSentenceCount || 0}건 (목표 3건+) — hedge·추측 없이 단정으로 끝나는 문장이 부족. 결론·핵심 주장 문장은 "~합니다 / ~된다 / ~여야 한다 / ~이다" 같은 단정 종결로 마무리. hedge 자체는 유지하되, 모든 문장이 hedge로 닫히면 카피킬러 "무견해" 시그너처 직격(사용자 100% 케이스).`);
    }
    if ((r.judgmentAvoidanceCount || 0) >= 2) {
      failed.push(`판단 회피 1인칭 ${r.judgmentAvoidanceCount}건 — 카피킬러 "무견해·판단 회피적 성향" 시그너처 직격. "저는 잘 모르겠습니다 / 제가 판단하기 어렵습니다 / 알 수 없습니다" 형태 제거. 1인칭은 행동·관찰·단정과 결합("저는 ~를 했다 / 제 친구는 ~한다 / 저는 ~여야 한다고 본다").`);
    }
  }
  return failed;
}

// --- 유틸리티 함수 ---

// AbortSignal 합성·타임아웃 폴백. Node 17.3+ 호환 직접 구현(AbortSignal.any/timeout 미지원 환경 대비).
// 합성된 signal 중 하나라도 abort되면 결과 signal도 abort.
function combineSignals(...signals) {
  const ac = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { ac.abort(s.reason); break; }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

function timeoutSignal(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`timeout ${ms}ms`)), ms);
  // 다른 곳에서 먼저 abort되면 timer 정리 (메모리 누수 방지)
  ac.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
  return ac.signal;
}

function cleanText(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u034F\u061C\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[*#`]/g, '')
    .replace(/~~/g, '')
    .replace(/\.([가-힣A-Za-z])/g, '. $1')
    .replace(/,([가-힣A-Za-z])/g, ', $1')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// ============================================================
// Pass C — mechanical 위반 결정론적 후처리
// 프롬프트 generative 룰의 잔여 surface 위반을 0건 보장.
// 의미 의존 룰(종결어미/문단 비율/hedge 등)은 손대지 않음 — 2-pass 영역.
// ============================================================

// Tier 1 surface 패턴 swap (LLM 호출 X, regex/lookup만)
// 출력 로그 보면서 자주 보이는 신종 GPT-ism을 늘려가는 자산
//
// 결정적 1:1 매핑 — 의미 안전한(무생물 도입/P0 띄어쓰기/의존명사) 패턴만.
// "유의미한→의미 있는" 같은 GPT-ism 어휘는 결정적 1:1이면 그 자체로 시그너처화될 수 있어
// GPT_ISM_POOL로 분리해 매 매칭마다 무작위 선택.
const MECHANICAL_LEXICON_DETERMINISTIC = [
  // 무생물 도입 (룰: 능동 종결 + 무생물 주어 회피 — backup)
  { from: /본\s*보고서에서는\s*/g, to: '' },
  { from: /본\s*보고서는/g, to: '이 글은' },
  { from: /본\s*글에서는\s*/g, to: '' },
  // P0 띄어쓰기 — LLM이 negative instruction 못 따르므로 deterministic 강제 (사용자 글 실측 위반)
  { from: /것같(다|습니다|아요|네요|은|던)/g, to: '것 같$1' },
  { from: /(추위|더위|비|바람|눈|햇볕|소음|적|위협|영향)\s+로부터/g, to: '$1로부터' },
  { from: /(구조물|건물|건축물|시설물|결과물|기능|기술|역할|수준|효과|영향|기대)이상의/g, to: '$1 이상의' },
  { from: /(지속가능성|중요성|필요성|가치|효과|영향|결과|차이|모습|존재)\s+까지/g, to: '$1까지' },
  { from: /(있|없|모르|아|어떠하)는\s지(는|를|에|에서|보다|만|도)?([.,!?\s]|$)/g, to: '$1는지$2$3' },
  { from: /기도합니다/g, to: '기도 합니다' },
  // 합성동사 붙여쓰기 + 흔한 붙임 오류(카피킬러 "후처리된 AI 글" 띄어쓰기 신호 §v4-5)
  { from: /들여다\s+보(다|니|면|며|는|았|던|게)/g, to: '들여다보$1' },
  { from: /돌이켜\s+보(다|니|면|며|는|았|던|게|면서)/g, to: '돌이켜보$1' },
  { from: /내려다\s+보(다|니|면|며|는|았|던|게)/g, to: '내려다보$1' },
  { from: /온가족/g, to: '온 가족' },
  { from: /([가-힣])은이제([\s가-힣])/g, to: '$1은 이제$2' },
  // P0: 의존명사 띄어쓰기 추가 안전망 (사용자 글 실측)
  { from: /(완공|시작|건설|체결|발표|발견|도입|개최|설립)되었을때/g, to: '$1되었을 때' },
  { from: /(지키|만들|살|쓰|배우|찾|보|걸|구하|이해하|받아들이|판단하|결정하|해결하|갖추|버티|통하|이기|적응하|대응하|성장하|살아남)는데\s+(있|의의|의미|도움|기여|초점|중점|목적|이유|핵심|목표|관건|보탬|어려움|걸림돌)/g, to: '$1는 데 $2' },
  { from: /(지키|만들|살|쓰|배우|찾|보|걸|구하|이해하|받아들이|판단하|결정하|해결하|갖추|버티|통하|이기|적응하|대응하|성장하|살아남)는데(\s|[.,!?])/g, to: '$1는 데$2' },
  { from: /한가지(로|만|에|가|를|도|의)/g, to: '한 가지$1' },
  { from: /(일|사실|영향|결과|효과|일상|문제|역할)뿐아니라/g, to: '$1뿐 아니라' },
  { from: /(빠질|할|볼|쓸|올|갈|잘|줄|얻을|받을|만날|보낼|읽을)수\s/g, to: '$1 수 ' },
  // ㄹ수+있/없 결합형 (사용자 글 실측 — "꺼낼수있는/통할수있을지/버틸수없지만")
  { from: /(빠질|할|볼|쓸|올|갈|잘|줄|얻을|받을|만날|보낼|읽을|꺼낼|버틸|통할|이길|살아남을|벗어날|치를|드릴|배울|이해할|판단할|해결할|찾을|쓸)수(있|없)/g, to: '$1 수 $2' }
];

// GPT-ism 어휘·종결구 — 다대다 풀. 매 매칭마다 풀에서 무작위 선택해 시그너처화 회피.
// toPool 어휘들은 from 패턴과 겹치지 않으므로 swap된 결과가 다시 잡히지 않음 (이중 swap 방지).
const GPT_ISM_POOL = [
  // GPT-ism 종결 정형구
  { from: /시사하는\s*바가\s*(크다|큽니다)/g, toPool: ['의미가 큽니다', '시사점이 큽니다', '생각할 거리가 많습니다'] },
  { from: /결론적으로/g, toPool: ['정리하면', '결국', '돌이켜보면'] },
  // GPT-ism 형용사 (어미 변형 안전한 형태만)
  { from: /유의미한/g, toPool: ['의미 있는', '뜻 있는', '눈에 띄는'] },
  { from: /다각적/g, toPool: ['여러 면의', '여러 갈래의', '여러 결의'] },
  { from: /혁신적/g, toPool: ['새로운', '판을 바꾸는', '낯선'] },
  { from: /뜻깊은|소중한/g, toPool: ['의미 있는', '오래 남는', '쉽게 잊히지 않는'] },
  // 평가·감상 GPT-ism (prompts.js 룰 5 차단 리스트와 정합)
  { from: /감명받았습니다/g, toPool: ['인상 깊었습니다', '오래 남았습니다', '마음에 남았습니다'] },
  { from: /유익했습니다/g, toPool: ['도움이 됐습니다', '얻은 게 많았습니다', '값진 시간이었습니다'] },
  { from: /깨달았습니다/g, toPool: ['알게 됐습니다', '비로소 알았습니다', '그제서야 보였습니다'] }
];

// ★ 결정적 선택(M-12): 같은 입력은 같은 치환 결과 — 매칭 텍스트+위치를 해시해 풀 인덱스를 정한다.
//   Math.random 제거로 결정론 후처리의 재현성·회귀 가능성 확보(같은 글·버전이면 byte-identical).
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h; }
function pickDeterministic(pool, seed) { return pool[hashStr(String(seed)) % pool.length]; }

function enforceMechanicalRules(text) {
  if (!text) return text;
  let out = text;

  // 1) 특수문자 (룰 1 — 프롬프트에서 제거됨, 여기서 100% 강제)
  out = out.replace(/·/g, ', ');                                     // 중점 → 콤마 (3+개면 Tier 2가 다시 처리)
  out = out.replace(/([가-힣])\s+[-—–]\s+([가-힣])/g, '$1 $2');      // 줄표 (공백 사이) → 공백
  // *, #, `, ~ 는 cleanText에서 이미 제거

  // 2) 결정적 swap (무생물 도입 + P0 띄어쓰기 + 의존명사)
  for (const { from, to } of MECHANICAL_LEXICON_DETERMINISTIC) {
    out = out.replace(from, to);
  }
  // 3) GPT-ism 풀 swap — 매칭 위치별로 다른 어휘이되 결정적(같은 글이면 항상 같은 선택)
  for (const { from, toPool } of GPT_ISM_POOL) {
    out = out.replace(from, (m, offset) => pickDeterministic(toPool, m + ':' + offset));
  }

  // 정리: 중복 공백, 마침표 앞 공백
  out = out.replace(/ {2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
  return out;
}

// 입력 사전 처리용 별칭 (의도 명확화). 출력 후처리와 동일 동작이지만 호출부 가독성을 위해 분리.
const enforceInputRules = enforceMechanicalRules;

// Tier 2: 3개 이상 콤마 나열을 그 문장만 LLM 외과수술로 해체.
// 위반 문장 1개당 micro-call (~150 토큰), 다른 문장은 손대지 않음.
// ★ \n\n 단락 경계 보존: sentences를 join하지 않고 원본 text 위에서 surgical replace.
async function fixListsOfThree(text, lang, signal) {
  if (!text || !ANTHROPIC_API_KEY) return text;
  if (signal?.aborted) return text;

  // verifyCheckFields와 동일 기준으로 문장 분리(매칭 검출용)
  const sentences = text.split(/(?<=[.!?？。])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  if (sentences.length === 0) return text;

  // 3+ 콤마 나열 패턴 (한/영/숫자 모두)
  const listRe = /[가-힣A-Za-z0-9]+(?:\s*,\s*[가-힣A-Za-z0-9]+){2,}/;

  const violating = sentences.filter(s => listRe.test(s));
  if (violating.length === 0) return text;

  // 원본 text 위에서 violating 문장만 in-place 교체 → \n\n·공백 그대로 유지
  let fixed = text;
  let cursor = 0;
  for (const original of violating) {
    if (signal?.aborted) break;
    try {
      const rewritten = await rewriteListSentence(original, lang, signal);
      if (!rewritten || rewritten.length < original.length * 0.5) continue;
      const idx = fixed.indexOf(original, cursor);
      if (idx < 0) continue;  // 같은 문장 중복 시 이미 교체된 위치 스킵
      fixed = fixed.substring(0, idx) + rewritten + fixed.substring(idx + original.length);
      cursor = idx + rewritten.length;
    } catch (e) {
      // micro-call 실패 → 원문 그대로 (Pass C는 best-effort)
    }
  }
  return fixed;
}

async function rewriteListSentence(sentence, lang, signal) {
  const prompt = lang === 'en'
    ? `Rewrite the following sentence to break the 3+ comma-separated list into either a "from A through C" range expression OR 2-3 short separate sentences.
- Do NOT change vocabulary, structure, ending style, or spelling outside the list portion.
- Preserve the original tone exactly.
- Output ONLY the rewritten sentence — no quotes, no commentary, no line breaks.

Sentence: ${sentence}`
    : `다음 문장에서 콤마로 묶인 3개 이상 나열만 해체하라.
- 나열을 "A부터 C까지" 같은 구간 표현 또는 짧은 별도 문장 2~3개로 분할
- 다른 어휘·구조·종결어미·맞춤법은 절대 변경 금지
- 원문 어조 그대로 유지
- 출력은 수정된 문장만. 따옴표·해설·줄바꿈 금지

문장: ${sentence}`;

  // Claude 텍스트 생성 (tool 없이) — 외과수술용 micro-call. 실패는 best-effort 폴백.
  const microSignal = combineSignals(signal, timeoutSignal(30_000));
  let response;
  try {
    response = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: microSignal
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const data = await response.json();
  try { require('../engine/usagemeter').recordUsage({ model: MODEL, usage: data.usage, task: 'microcall' }); } catch {}   // 비용 hotspot 측정(감사 §5)
  if (data?.stop_reason === 'refusal') return null;
  const blocks = Array.isArray(data?.content) ? data.content : [];
  let out = '';
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  out = out.trim();
  return out || null;
}

// 휴머나이저 출력에 cleanText + Tier 1 + Tier 2를 일괄 적용.
// 1차 출력과 2-pass 출력 각각에 호출 → mechanical 위반 잔여 0건 보장.
// ★ em-dash 과다 톤다운(2026-06-17, #6): 휴머나이징이 본문에 대시(—)를 남발(실측 3→104회)해 오히려 LLM
//   문체 지문이 됨. 제목 블록(첫 \n\n 앞)의 "제목 — 부제" 대시는 보존하고, 본문 1,000자당 1.5개 초과면 ", "로
//   치환. 정상 사용(1~3개)은 임계값 아래라 불변. env EMDASH_CAP=0으로 해제.
function tonedownEmDash(text) {
  const t = text || '';
  const idx = t.indexOf('\n\n');
  const head = idx >= 0 ? t.slice(0, idx) : '';
  let body = idx >= 0 ? t.slice(idx) : t;
  const dashes = (body.match(/[—―–]/g) || []).length;
  const per1k = dashes / Math.max(1, (body.match(/[가-힣]/g) || []).length / 1000);
  if (per1k > 1.5) body = body.replace(/\s*[—―–]\s*/g, ', ').replace(/,\s*,/g, ',');
  return head + body;
}

async function applyPassC(result, lang, signal, ctx = {}) {
  if (!result?.outputText) return;
  // ★ ※본문/도입부/결론부 플레이스홀더 제거(2026-06-17, #14·#90): posNote("※ 본문이다" 등)가 출력에 베껴
  //   박히는 누출을 결정론으로 제거(전 모드·무LLM). cleanText 전에 떼어 잔여 이중공백은 cleanText가 정리.
  //   '※ 표는 부록 참조' 같은 정상 ※문구는 (본문|도입부|결론부)+(이다|이에요…) 패턴만 매칭해 보존.
  result.outputText = result.outputText
    .replace(/※\s*결론부(?:다|이에요|예요)[^。\n]*?비슷하게\.?/g, '')
    .replace(/※\s*(?:본문|도입부|결론부)(?:이다|이에요|예요|다)\.?/g, '');
  let t = cleanText(result.outputText);
  t = enforceMechanicalRules(t);
  t = await fixListsOfThree(t, lang, signal);
  // ★ 출고 품질 gate(2026-06-16 품질리포트 P0) — 전부 결정론(추가 LLM 0):
  //   ① 영어 편집 마커 제거 ② 격식·자소서 punch 단정 제거 ③ no-op·register 이탈 측정(표시·강도추천용).
  const og = require('../engine/outputguard');
  if (lang === 'en') {
    t = og.stripEnglishArtifacts(t);
  } else if (ctx.rawText) {   // 원문 대조가 있어야 '엔진이 더한 punch'만 안전히 지움(원문 punch는 보존)
    const strict = ctx.mode !== 'blog';   // 블로그(구어체)만 punch 1개 허용, 격식·자소서·다듬기는 0
    const pr = og.stripPunchTemplates(t, ctx.rawText, { strict });
    if (pr.removed.length) logger.info('humanize.punch_stripped', { mode: ctx.mode, count: pr.removed.length, samples: pr.removed.slice(0, 3) });
    t = pr.text;
    if (ctx.mode !== 'blog') {   // 합니다체 문서에 튄 소수 평어 문장 교정(블로그는 평어 허용 — 제외)
      const rl = og.normalizeRegisterLeaks(t, ctx.rawText);
      if (rl.fixed) { logger.info('humanize.register_fixed', { mode: ctx.mode, fixed: rl.fixed }); t = rl.text; }
    }
    if (process.env.EMDASH_CAP !== '0') t = tonedownEmDash(t);   // em-dash 남발 톤다운(#6)
  }
  // ★ 코드성 토큰 점뒤 공백 깨짐 복원(2026-06-19 감사: CONTACT.MB_MB → "CONTACT. MB_MB"). 원문 대조·무날조·전 모드.
  if (ctx.rawText) {
    const ct = require('../engine/spacing').restoreCodeTokens(t, ctx.rawText);
    if (ct.fixed) { logger.info('humanize.code_token_restored', { mode: ctx.mode, fixed: ct.fixed }); t = ct.text; }
    // ★ URL 공백 삽입 복원(2026-06-19 실측 #57·#58: "https://www. scourt. go. kr"). 원문 대조·무날조·전 모드.
    const ur = require('../engine/spacing').restoreUrls(t, ctx.rawText);
    if (ur.fixed) { logger.info('humanize.url_restored', { mode: ctx.mode, fixed: ur.fixed }); t = ur.text; }
    // ★ 편집자 메타 헤딩 제거(2026-06-20 #62: "### [수정 간호계획안]" 류 조수 프레이밍). 입력 대비 모델 주입분만.
    if (process.env.EDITORIAL_META_STRIP !== '0') {
      const em = og.stripEditorialMeta(t, ctx.rawText);
      if (em.removed) { logger.info('humanize.editorial_meta_stripped', { mode: ctx.mode, removed: em.removed }); t = em.text; }
    }
  }
  // ★ AI URL 지문 제거(2026-06-20 #68: utm_source=chatgpt.com). 원문 불요·전 모드.
  if (process.env.STRIP_AI_URL !== '0') {
    const ai = require('../engine/spacing').stripAiUrlParams(t);
    if (ai.removed) { logger.info('humanize.ai_url_param_stripped', { mode: ctx.mode, removed: ai.removed }); t = ai.text; }
  }
  result.outputText = t;
  // 품질 지표(차단 아님 — 표시·로깅용): no-op(보존형 수준)·register 이탈.
  if (ctx.rawText) {
    result.noOpScore = og.noOpScore(ctx.rawText, t);
    // 변환 약함 신호. polish(다듬기)는 보존이 목적이라 일반 임계(0.86)에선 제외하되, ★내용이 거의 100% 동일
    //   (공백만 바뀜, 0.97+)이면 "사실상 무변환"이므로 polish도 약변환으로 표기(2026-06-22 #40/#47: 다듬기가
    //   내용 불변·재시도까지 동일출력·이중과금). 차단 아님 — UI 배지/안내·강도 추천용 신호만.
    result.weakTransform = ctx.mode === 'polish' ? (result.noOpScore >= 0.97) : (result.noOpScore >= 0.86);
    result.registerLeak = lang === 'en' ? 0 : og.registerLeakCount(t, ctx.rawText);
  }
}

// ============================================================
// 입력 사전 처리 — 모델 호출 *전*에 결정론 룰을 입력 텍스트에 미리 적용.
// 모델 부담 감소 + 시스템 프롬프트 슬림화의 짝.
// ============================================================

// 한 문장 안에 콤마 2+ 누적 + 종결/연결어미 2개+ 패턴만 외과수술로 분할.
// 룰 3 콤마 절제 — 사용자 카피킬러 감지 시그너처 직격(KatFishNet: 한국어 LLM은 인간 대비 콤마 2.3배).
async function fixCommaStacking(text, lang, signal) {
  if (!text || !ANTHROPIC_API_KEY) return { text, count: 0 };
  if (signal?.aborted) return { text, count: 0 };

  const sentences = text.split(/(?<=[.!?？。])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  if (sentences.length === 0) return { text, count: 0 };

  const commaRe = /,/g;
  const clauseEndingRe = /(?:다|니다|며|고|어서|아서|면서|는데|지만|었고|이며|되어|하여|하며),/g;
  const isStacked = (s) => {
    const commas = (s.match(commaRe) || []).length;
    const endings = (s.match(clauseEndingRe) || []).length;
    return commas >= 2 && endings >= 2;
  };

  const violating = sentences.filter(isStacked);
  if (violating.length === 0) return { text, count: 0 };

  let fixed = text;
  let cursor = 0;
  let count = 0;
  for (const original of violating) {
    if (signal?.aborted) break;
    try {
      const rewritten = await rewriteCommaSentence(original, lang, signal);
      if (!rewritten || rewritten.length < original.length * 0.5) continue;
      const idx = fixed.indexOf(original, cursor);
      if (idx < 0) continue;
      fixed = fixed.substring(0, idx) + rewritten + fixed.substring(idx + original.length);
      cursor = idx + rewritten.length;
      count++;
    } catch (e) {
      // best-effort
    }
  }
  return { text: fixed, count };
}

async function rewriteCommaSentence(sentence, lang, signal) {
  const prompt = lang === 'en'
    ? `Split the following sentence: replace the 2+ comma-stacked clauses with 2-3 independent sentences using periods.
- Do NOT change vocabulary, ending style, or spelling outside the split.
- Preserve the original tone exactly.
- Output ONLY the rewritten sentences — no quotes, no commentary, no line breaks.

Sentence: ${sentence}`
    : `다음 문장에서 콤마로 이어붙인 절들을 마침표로 끊어 독립 문장 2~3개로 분할하라.
- 어휘·종결어미·맞춤법은 절대 변경 금지
- 원문 어조 그대로 유지
- 출력은 수정된 문장만. 따옴표·해설·줄바꿈 금지

문장: ${sentence}`;

  const microSignal = combineSignals(signal, timeoutSignal(30_000));
  let response;
  try {
    response = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: microSignal
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const data = await response.json();
  try { require('../engine/usagemeter').recordUsage({ model: MODEL, usage: data.usage, task: 'microcall' }); } catch {}   // 비용 hotspot 측정(감사 §5)
  if (data?.stop_reason === 'refusal') return null;
  const blocks = Array.isArray(data?.content) ? data.content : [];
  let out = '';
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  out = out.trim();
  return out || null;
}

// "[고유명사]는 ~사례/증거/상징/표현/결과입니다" 같은 단정 정의문만 관찰형으로 변환.
// 룰 4 LLM overconfidence 시그너처 직격. verifyCheckFields의 declarativeRe와 동일 패턴.
async function fixDeclarativeDefinition(text, lang, signal) {
  if (!text || !ANTHROPIC_API_KEY) return { text, count: 0 };
  if (signal?.aborted) return { text, count: 0 };

  const declarativeRe = /[가-힣A-Za-z0-9]{2,}(?:은|는)\s+[^.!?]{4,}(?:사례입니다|사례이다|증거입니다|증거이다|증명입니다|증명이다|예시입니다|예시이다|상징입니다|상징이다|표현입니다|표현이다|결과입니다|결과이다|보여줍니다|보여준다|드러냅니다|드러낸다|증명합니다|증명한다|입증합니다|입증한다)[.!?]/g;

  const matches = text.match(declarativeRe) || [];
  if (matches.length === 0) return { text, count: 0 };

  // 중복 제거 — 같은 문장이 여러 번 등장해도 한 번만 변환 시도, indexOf 커서로 위치 추적
  const unique = [...new Set(matches)];

  let fixed = text;
  let cursor = 0;
  let count = 0;
  for (const original of unique) {
    if (signal?.aborted) break;
    try {
      const rewritten = await rewriteDeclarativeSentence(original, lang, signal);
      if (!rewritten || rewritten.length < original.length * 0.5) continue;
      const idx = fixed.indexOf(original, cursor);
      if (idx < 0) continue;
      fixed = fixed.substring(0, idx) + rewritten + fixed.substring(idx + original.length);
      cursor = idx + rewritten.length;
      count++;
    } catch (e) {
      // best-effort
    }
  }
  return { text: fixed, count };
}

async function rewriteDeclarativeSentence(sentence, lang, signal) {
  const prompt = lang === 'en'
    ? `Rewrite the following sentence so it does NOT use a definitional declarative ("X is an example of Y / X demonstrates Y").
- Convert to an observation-led form ("Looking at X / Standing in front of X / If you look at X, you see ~").
- Preserve the original facts, tone, and ending style. Do NOT change spelling.
- Output ONLY the rewritten sentence — no quotes, no commentary, no line breaks.

Sentence: ${sentence}`
    : `다음 문장을 "[고유명사]는 ~사례입니다 / ~증거입니다 / ~보여줍니다" 같은 단정 정의문 대신 관찰형으로 다시 써라.
- "~을 보면 / ~ 앞에 서면 / ~ 한 채에도 / ~을 따라가다 보면" 같은 관찰·능동 시작으로 전환
- 원문의 사실·어조·종결어미는 그대로. 맞춤법 변경 금지.
- 출력은 수정된 문장 하나만. 따옴표·해설·줄바꿈 금지

문장: ${sentence}`;

  const microSignal = combineSignals(signal, timeoutSignal(30_000));
  let response;
  try {
    response = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: microSignal
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const data = await response.json();
  try { require('../engine/usagemeter').recordUsage({ model: MODEL, usage: data.usage, task: 'microcall' }); } catch {}   // 비용 hotspot 측정(감사 §5)
  if (data?.stop_reason === 'refusal') return null;
  const blocks = Array.isArray(data?.content) ? data.content : [];
  let out = '';
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  out = out.trim();
  return out || null;
}

// 입력 사전 처리 통합 — cleanText → 결정적·풀 swap → 콤마 분할 → 단정정의문 변환.
// 전체 8초 timeout 캡. micro-call 지연이 모델 호출을 막지 않도록.
async function preprocessInput(text, lang, signal) {
  if (!text) return { text, gptismCount: 0, commaSplitCount: 0, declarativeCount: 0 };

  // swap 카운트 측정 (실제 변환 전 매치 카운트)
  const before = text;
  let gptismCount = 0;
  for (const { from } of GPT_ISM_POOL) {
    gptismCount += (before.match(from) || []).length;
  }

  let t = cleanText(before);
  t = enforceInputRules(t);
  const swapOnly = t;  // micro-call 타임아웃 시 폴백

  // ★ 비용 누수 차단(감사 [C1] 확정): Promise.race timeout이 이겨도 work(=Sonnet micro-call fetch)는 계속 돌아
  //   '버린 결과'를 끝까지 과금하던 hidden cost. 로컬 AbortController를 micro-call에 넘기고, 8초 timeout 또는 부모
  //   signal에서 abort → rewriteCommaSentence의 microSignal→fetch까지 전파돼 in-flight 호출이 실제 취소된다.
  const preAc = new AbortController();
  if (signal) {
    if (signal.aborted) preAc.abort(signal.reason);
    else signal.addEventListener('abort', () => preAc.abort(signal.reason), { once: true });
  }

  const work = (async () => {
    let tt = swapOnly;
    const c = await fixCommaStacking(tt, lang, preAc.signal);
    tt = c.text;
    const d = await fixDeclarativeDefinition(tt, lang, preAc.signal);
    tt = d.text;
    return { text: tt, commaSplitCount: c.count, declarativeCount: d.count };
  })();

  let preTimer;
  const timeout = new Promise((resolve) => {
    preTimer = setTimeout(() => {
      preAc.abort(new Error('preprocess timeout 8000ms'));   // ★ work의 in-flight micro-call 취소(과금 중단)
      resolve({ text: swapOnly, commaSplitCount: 0, declarativeCount: 0, timedOut: true });
    }, 8000);
  });

  const result = await Promise.race([work, timeout]);
  clearTimeout(preTimer);
  work.catch(() => {});   // timeout 후 work가 abort로 reject해도 unhandled rejection 방지(결과는 이미 폴백 사용)
  if (result.timedOut) {
    logger.warn('analyze.preprocess_timeout_fallback');
  }

  return {
    text: result.text,
    gptismCount,
    commaSplitCount: result.commaSplitCount || 0,
    declarativeCount: result.declarativeCount || 0
  };
}

// ─── Anthropic Messages API 호출 (streaming) ─────────────────
// 시스템 프롬프트는 cache_control: ephemeral로 5분 TTL 자동 캐싱 (★Sonnet 4.6 최소 1,024토큰 / Haiku 4.5 4,096토큰 — 미만이면 무효, 공식 docs 2026-06-19).
// 구조화 출력은 tool + tool_choice 강제 호출로 처리.
//
// ★ streaming 사용 이유: max_tokens=16384에 Sonnet 출력 속도(~50-80 tok/s) 고려하면
//   non-streaming 60s wall-clock timeout이 부족해 자주 끊김. streaming은 청크가 계속
//   도착하므로 "마지막 청크 후 무응답" 시간(idle timeout)으로 hang을 검출. 진행 중인
//   long generation은 끝까지 받고, 진짜 hang(네트워크/서버 stall)만 끊는다.
// SSE 누적 결과는 non-streaming 응답과 동일한 모양({content, usage, stop_reason})으로
// 재조립해 extractClaudeResult를 그대로 재사용한다 — 호출 측 변경 없음.
async function callClaude({
  userText,
  systemText,
  systemVolatile,
  tool,
  temperature,
  maxOutputTokens,
  signal,
  task,
  phase,
  mode,
  chunkIndex,
  attempt,
  cacheZeroWarn = false
}) {
  // ★ dev 백엔드 스위치: LLM_BACKEND=claudecode면 내 Claude Code 구독(Sonnet)으로 호출 (API 키 불필요).
  //   엔진 로컬 테스트용. 프로덕션은 LLM_BACKEND 미설정 → 기존 API 경로.
  if (process.env.LLM_BACKEND === 'claudecode') {
    const { callViaClaudeCode } = require('../engine/claudecode');
    // claudecode는 단일 system 문자열만 받으므로 고정+가변을 다시 합쳐 종전과 동일한 프롬프트로 호출.
    const combinedSystem = systemVolatile ? `${systemText}\n${systemVolatile}` : systemText;
    return callViaClaudeCode({ userText, systemText: combinedSystem, tool, model: MODEL, signal });
  }
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const systemStableChars = typeof systemText === 'string' ? systemText.length : 0;
  const systemVolatileChars = typeof systemVolatile === 'string' ? systemVolatile.length : 0;
  const toolSchemaChars = jsonCharLength(tool);
  const cachePrefixChars = systemStableChars + toolSchemaChars;
  const cacheControlApplied = Boolean(systemText);
  const cacheEligible = cacheControlApplied && cachePrefixChars >= CLAUDE_CACHE_MIN_PREFIX_CHARS;
  const llmLogBase = {
    task: task || 'unspecified',
    phase: phase || 'unspecified',
    mode,
    toolName: tool?.name,
    chunkIndex,
    attempt,
    temperature,
    maxOutputTokens: typeof maxOutputTokens === 'number' ? maxOutputTokens : 8192,
    systemStableChars,
    systemVolatileChars,
    toolSchemaChars,
    cachePrefixChars,
    cacheControlApplied,
    cacheEligible,
    stablePromptHash: shortHash(systemText),
    cachePrefixHash: shortHash(`${tool ? JSON.stringify(tool) : ''}\n${systemText || ''}`)
  };

  const body = {
    model: MODEL,
    max_tokens: typeof maxOutputTokens === 'number' ? maxOutputTokens : 8192,
    messages: [{ role: 'user', content: userText }],
    stream: true
  };
  if (typeof temperature === 'number') body.temperature = temperature;

  if (systemText) {
    // ★ 캐시 분리: 고정 코어(systemText)에만 cache_control → 매 요청 동일 prefix로 cache_read 재사용.
    //   가변부(systemVolatile: 사용자 메모·evidence·앵커 회전)는 cache_control 없는 둘째 블록으로 — prefix를 안 깬다.
    //   (Sonnet 4.6 캐시 최소 prefix=1,024토큰. FLOOR 고정 코어는 이를 초과하므로 실제 캐시된다.)
    body.system = [{
      type: 'text',
      text: systemText,
      cache_control: { type: 'ephemeral' }
    }];
    if (systemVolatile) body.system.push({ type: 'text', text: systemVolatile });
  }

  if (tool) {
    body.tools = [tool];
    body.tool_choice = { type: 'tool', name: tool.name };
  }

  // 외부 signal(client disconnect) + idle timeout 합성.
  // IDLE_MS 동안 청크 무수신 시 abort. 청크 수신마다 타이머 리셋.
  const IDLE_MS = 60_000;
  const idleAc = new AbortController();
  let idleTimer = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idleAc.abort(new Error(`idle timeout ${IDLE_MS}ms`)), IDLE_MS);
  };
  resetIdle();
  const finalSignal = combineSignals(signal, idleAc.signal);

  let response;
  try {
    response = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: finalSignal
    });
  } catch (e) {
    if (idleTimer) clearTimeout(idleTimer);
    throw e;
  }

  if (!response.ok) {
    if (idleTimer) clearTimeout(idleTimer);
    // streaming 모드 에러는 단일 JSON 응답으로 옴 (스트림 시작 전)
    let msg = response.statusText;
    try {
      const errData = await response.json();
      msg = errData?.error?.message || msg;
    } catch {}
    throw new Error(`Anthropic API ${response.status}: ${msg}`);
  }

  // SSE 누적 → non-streaming 응답 모양으로 재조립.
  const contentBlocks = [];   // index → { type, ... }
  const jsonBuffers = [];     // index → tool_use partial_json 누적
  let stopReason = null;
  let usage = {};
  const decoder = new TextDecoder();
  let buf = '';

  try {
    for await (const chunk of response.body) {
      resetIdle();
      buf += decoder.decode(chunk, { stream: true });
      // SSE 이벤트는 \n\n으로 구분. 한 이벤트 안에 event:/data: 라인.
      let sepIdx;
      while ((sepIdx = buf.indexOf('\n\n')) >= 0) {
        const rawEvent = buf.slice(0, sepIdx);
        buf = buf.slice(sepIdx + 2);
        const dataLines = rawEvent
          .split('\n')
          .filter(l => l.startsWith('data: '))
          .map(l => l.slice(6));
        if (dataLines.length === 0) continue;
        let evt;
        try { evt = JSON.parse(dataLines.join('\n')); } catch { continue; }

        switch (evt.type) {
          case 'message_start':
            if (evt.message?.usage) usage = { ...usage, ...evt.message.usage };
            break;
          case 'content_block_start': {
            const idx = evt.index;
            const block = evt.content_block || {};
            if (block.type === 'tool_use') {
              contentBlocks[idx] = { type: 'tool_use', id: block.id, name: block.name, input: {} };
              jsonBuffers[idx] = '';
            } else if (block.type === 'text') {
              contentBlocks[idx] = { type: 'text', text: '' };
            } else {
              contentBlocks[idx] = { ...block };
            }
            break;
          }
          case 'content_block_delta': {
            const idx = evt.index;
            const d = evt.delta || {};
            if (d.type === 'text_delta' && contentBlocks[idx]?.type === 'text') {
              contentBlocks[idx].text += d.text || '';
            } else if (d.type === 'input_json_delta' && contentBlocks[idx]?.type === 'tool_use') {
              jsonBuffers[idx] = (jsonBuffers[idx] || '') + (d.partial_json || '');
            }
            break;
          }
          case 'content_block_stop': {
            const idx = evt.index;
            if (contentBlocks[idx]?.type === 'tool_use') {
              const raw = jsonBuffers[idx] || '';
              try {
                contentBlocks[idx].input = raw ? JSON.parse(raw) : {};
              } catch (e) {
                throw new Error(`tool_use partial_json 파싱 실패: ${e.message}`);
              }
            }
            break;
          }
          case 'message_delta':
            if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
            if (evt.usage) usage = { ...usage, ...evt.usage };
            break;
          case 'error':
            throw new Error(`Anthropic stream error: ${evt.error?.message || 'unknown'}`);
          case 'message_stop':
          case 'ping':
          default:
            break;
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }

  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  logger.info('llm.usage', {
    ...llmLogBase,
    inputTokens: usage.input_tokens || 0,
    cacheCreateTokens: cacheCreate,
    cacheReadTokens: cacheRead,
    outputTokens: usage.output_tokens || 0,
    model: MODEL,
    estimatedUsd: Number(require('../engine/usagemeter').estimateUsd(MODEL, usage).toFixed(6))   // 비용 hotspot 측정(감사 §5)
  });
  if (cacheZeroWarn && cacheEligible && cacheCreate === 0 && cacheRead === 0) {
    logger.warn('llm.cache_zero', {
      ...llmLogBase,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      model: MODEL
    });
  }

  if (stopReason === 'max_tokens') {
    logger.warn('llm.max_tokens_stop', { ...llmLogBase, model: MODEL });
  }

  return {
    type: 'message',
    content: contentBlocks.filter(Boolean),
    usage,
    stop_reason: stopReason
  };
}

// 웹 검색: Anthropic Messages API의 web_search 서버 도구 사용 (default ON).
// 실패/빈 응답이면 null 반환 → 호출 측은 기존 휴머나이즈 흐름과 동일하게 진행.
async function fetchWebSearchExamples(text, lang, signal) {
  if (!ANTHROPIC_API_KEY) return null;
  if (signal?.aborted) return null;
  try {
    const searchPrompt = lang === 'en'
      ? `Identify the topic of the following text and briefly provide 2-3 specific real-world examples or statistics related to it. Text: ${text.substring(0, 500)}`
      : `다음 글의 주제를 파악하고, 관련된 구체적인 실제 사례나 통계를 2~3개 간략히 제시해줘. 글: ${text.substring(0, 500)}`;

    const webSignal = combineSignals(signal, timeoutSignal(45_000));
    const response = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: WEB_SEARCH_MODEL,
        max_tokens: 2048,
        messages: [{ role: 'user', content: searchPrompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
      }),
      signal: webSignal
    });
    if (!response.ok) return null;
    const data = await response.json();

    const blocks = Array.isArray(data?.content) ? data.content : [];
    let outputText = '';
    for (const b of blocks) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        outputText += b.text;
      }
    }
    if (outputText.length < 50) return null;
    return outputText.substring(0, 800);
  } catch (e) {
    return null;
  }
}

// 2-pass refine용 user 프롬프트 생성 — 라우트와 runHumanize가 공유(드리프트 방지).
function buildRefineUser(humanizeText, prevOutput, failed, lang = 'ko') {
  if (lang === 'en') {
    return `[SOURCE TEXT — reference only for restoring information. Do not copy it verbatim; keep the first draft's tone]\n${humanizeText}\n\n[PREVIOUS OUTPUT]\n${prevOutput}\n\n[FAILED CHECKS]\n${failed.join('\n')}\n\nMake the smallest possible edits that fix only the failed checks. Keep all other sentences unchanged. If the output is too short, restore missing source details, evidence, or examples from [SOURCE TEXT] using the first draft's tone. Do not invent external statistics, years, organizations, company names, people, percentages, anecdotes, or feelings. If first-person concrete experience is required, use only experiences already present in the source text. Keep the conclusion's direction intact and output the full revised body text only.`;
  }
  return `[원본 텍스트 — 정보 복원 시 참고용. 그대로 옮기지 말고 1차 출력 톤 유지]\n${humanizeText}\n\n[이전 출력]\n${prevOutput}\n\n[위반 항목]\n${failed.join('\n')}\n\n위반된 부분만 최소 수정하라. 다른 문장은 그대로 유지. 분량 부족이 위반 항목에 있으면 [원본 텍스트]에서 빠진 디테일·근거·예시를 복원해 채워라(원본 문장 그대로 복사 X — 1차 출력 톤으로 다시 써라). 1인칭 구체 일화 부족 또는 추상 진술 잔존이면, 해당 문장을 글쓴이 1인칭 경험(시간·장소·인물 동반, 예: "제가 작년 학기에 ~", "제 룸메이트가 ~")으로 *교체*하라 — 단 외부 통계·연도(YYYY)·기관명·기업명·인명·% 수치는 절대 금지(개인 경험만). 판단 회피 1인칭("저는 잘 모르겠습니다 / 알 수 없습니다")은 행동·관찰·단정과 결합("저는 ~를 했다 / 저는 ~여야 한다고 본다")으로 바꿔라. 새로운 흐름 꺾기 한정어·메타 사색·종결 어미 변형은 추가하지 마라(추가하면 정형성이 짙어져 디텍터에 더 잘 잡힌다). 결론·핵심 주장 문장은 hedge 없이 단정 종결로 마무리해 균형을 잡아라.`;
}

// 엔진 단독 실행 진입점 — billing/auth/Firebase 없이 humanize 파이프라인만.
// 의미판정(semanticJudge) 트리거 사유(§리뷰#5): cheap soft-drift 외에 결정론 위험신호
//   (분량 부족·사실 소실·반복·신규 사실)도 judge로 재확인 → repair 기회 + 의미 검증.
function judgeTriggerReasons(result) {
  const r = [];
  if (result.softDrift?.flagged) r.push('softDrift');
  if (result.conclusionDrift?.flagged) r.push('conclusion_drift'); // 결론부 회의·미래·감정 증가 → 의도역전 의심 → judge 확인
  if (result.floorLength?.status === 'short') r.push('length_short');
  if ((result.lostFacts?.count || 0) > 0) r.push('lostFacts');
  if ((result.repetition?.total || 0) > 0) r.push('repetition');
  if ((result.floorNovelty?.count || 0) > 0) r.push('novelty');
  return r;
}

// GPTZero 전용 2차 우회 패스 적용 — perplexity 교란 후 FLOOR 재검사. 위반(날조·소실·화자·분량)이면
// 결과를 폐기하고 1차 출력 유지(FLOOR가 우회보다 우선). 채택 시 result.outputText를 교체하고 가드 재측정.
async function applyAntiDetect({ result, rawText, povSeed, optIn, mode, lang, speakerType, signal, floor, allowedExtra = '' }) {
  const before = result.outputText;
  let perturbed;
  try {
    perturbed = await require('../engine/antidetect').antiDetectPass(before, { lang, speakerType, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    return { applied: false, reason: 'error:' + e.message };
  }
  if (!perturbed || perturbed === before) return { applied: false, reason: 'no-change' };
  // FLOOR 재검사: 교란 결과가 사실/화자/분량/반복 위반이면 폐기.
  const viol = floor.collectFloorViolations({ result: { outputText: perturbed }, rawText, povSeed, optIn, mode, allowedExtra });
  if (viol.length) return { applied: false, reason: 'floor-violation:' + viol.map(v => v.type).join(','), rejected: true };
  // 채택 — 출력 교체 + 가드 재측정(보고/노출 게이트가 최종 텍스트 기준이 되도록).
  result.outputText = perturbed;
  result.povDrift = floor.measurePovDrift(rawText, perturbed, povSeed);
  result.floorNovelty = floor.measureNovelty(rawText, perturbed, allowedExtra);
  result.floorLength = floor.measureLength(rawText, perturbed, mode);
  result.softDrift = require('../engine/softguard').measureSoftDrift(rawText, perturbed);
  result.conclusionDrift = require('../engine/softguard').measureConclusionDrift(rawText, perturbed);
  result.repetition = floor.measureRepetition(perturbed);
  result.lostFacts = floor.measureLostFacts(rawText, perturbed);
  return { applied: true };
}

// source-internal grounding 패스(검증된 메모리스 레버, 카피킬러 64→50%): 추상 segment를 원문 anchor
// 기반 stance-sharpening으로 교체. segment마다 novelty+semanticJudge 게이트가 날조를 차단(FLOOR-안전).
// judge 이후·antiDetect 이전에 적용. 채택 시 출력 교체 + 가드 재측정.
async function applyGrounding({ result, rawText, povSeed, optIn, mode, lang, signal, floor, allowedExtra = '', ledger = null }) {
  const before = result.outputText;
  let g;
  try {
    g = await require('../engine/grounding').groundingPass(before, rawText, { lang, signal, mode, ledger });  // ★ judge ledger 재사용(중복 Sonnet 제거)
  } catch (e) {
    if (signal?.aborted) throw e;
    return { applied: false, reason: 'error:' + e.message };
  }
  if (!g || !g.text || g.text === before || !g.repaired) {
    return { applied: false, reason: 'no-change', targets: g ? g.targets : 0, before: g ? g.before : null, after: g ? g.after : null };
  }
  // 안전망: segment 게이트를 통과했어도 전체 FLOOR 한 번 더(위반이면 폐기).
  const viol = floor.collectFloorViolations({ result: { outputText: g.text }, rawText, povSeed, optIn, mode, allowedExtra });
  if (viol.length) return { applied: false, reason: 'floor-violation:' + viol.map(v => v.type).join(','), rejected: true, before: g.before, after: g.after };
  result.outputText = g.text;
  result.povDrift = floor.measurePovDrift(rawText, g.text, povSeed);
  result.floorNovelty = floor.measureNovelty(rawText, g.text, allowedExtra);
  result.floorLength = floor.measureLength(rawText, g.text, mode);
  result.repetition = floor.measureRepetition(g.text);
  result.lostFacts = floor.measureLostFacts(rawText, g.text);
  return { applied: true, repaired: g.repaired, targets: g.targets, grounded: g.grounded, cappedAt: g.cappedAt, before: g.before, after: g.after };
}

// 라우트(/analyze)의 humanize 분기와 동일 로직: preprocess → LLM → Pass C → verify → refine.
// engine-test.js(로컬 테스트)와 향후 재구축이 공유하는 services/humanizer의 시드.
async function runHumanize({ text, mode = 'assignment', lang = 'ko', signal, floorV2 = false, optIn = false, judge = false, antiDetect = false, grounding = false, userNotes = '' } = {}) {
  const selectedMode = mode;
  const floor = require('../engine/floor');
  const notes = (userNotes || '').trim();   // 사용자 경험 메모(있으면 추상 문단 구체화 재료 + novelty 허용 세계에 포함)
  if (notes) optIn = true;                    // 경험 메모 제공 = 1인칭 경험 추가 동의 → pov 게이트 개방
  const contract = require('../engine/contract').buildContract(text, { mode: selectedMode, lang, optIn }); // 단일 진실
  const povSeed = contract.povSeed; // 화자 보존 게이트 기준값(Contract에서)

  // 사전 처리(assignment만): 결정론 swap + (API 키 있을 때만)콤마/단정정의문 micro-surgery.
  let humanizeText = text;
  let preInfo = null;
  if (selectedMode === 'assignment') {
    try {
      const pp = await preprocessInput(text, lang, signal);
      humanizeText = pp.text;
      preInfo = { gptismCount: pp.gptismCount, commaSplitCount: pp.commaSplitCount, declarativeCount: pp.declarativeCount };
    } catch (e) {
      if (signal?.aborted) throw e;
    }
  }

  // ★ FLOOR v2: 보존 우선 프롬프트로 레거시 모드 프롬프트 대체(내용 파괴/변질 지시 제거). 모드는 톤 오버레이.
  //   floorV2 미설정 시 레거시 프롬프트(프로덕션 동작 불변).
  // ★ 목소리 앵커(genretransfer 이식): 보존형 재작성에서는 효과 0 실측(이식판 카피킬러 100% vs v2 94~95 — 델타 0,
  //   앵커는 생성 조형 레버라 재생성 경로에서만 작동) → 메인 경로는 STYLE_ANCHOR=1 옵트인(프롬프트 비용 절감).
  const anchorsOn = floorV2 && lang === 'ko' && selectedMode === 'assignment' && process.env.STYLE_ANCHOR === '1';
  let humanizeSystem = floorV2
    ? require('../engine/prompt').buildSystemPrompt(selectedMode, lang, { speakerType: contract.speakerType, lengthPolicy: contract.lengthPolicy, userNotes: notes, register: contract.register, anchorIdx: anchorsOn ? 0 : null })
    : { stable: getHumanizeSystem(selectedMode, lang), volatile: '' };  // ★ 캐시: 비-floor도 {stable,volatile}로 통일
  // floorV2는 lean tool(outputText 중심) — 레거시 표면지표 필드의 anti-FLOOR 유도 제거(§리뷰#7).
  const humanizeTool = floorV2 ? getLeanHumanizeTool(lang) : getHumanizeToolFor(selectedMode, lang);
  const userContent = lang === 'en'
    ? `[TEXT TO REWRITE]\n${humanizeText}`
    : `[재작성할 텍스트]\n${humanizeText}`;
  const inputParaCount = humanizeText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).length;
  const inputCharLen = humanizeText.replace(/\s+/g, '').length;

  // 1차
  const data = await callClaude({
    userText: userContent, systemText: humanizeSystem.stable, systemVolatile: humanizeSystem.volatile, tool: humanizeTool,
    temperature: 0.5, maxOutputTokens: 16384, signal,
    task: 'humanize', phase: 'humanize:first', mode: selectedMode, cacheZeroWarn: true
  });
  let result = extractClaudeResult(data, humanizeTool.name);
  await applyPassC(result, lang, signal, { rawText: humanizeText, mode: selectedMode });
  verifyCheckFields(result, selectedMode, inputParaCount, inputCharLen, humanizeText);

  // ===== 2-pass =====
  let refined = false;
  const firstResult = result;
  let refineReason = null;
  let failed = [];
  let floorViolations = [];

  if (floorV2) {
    // ★ FLOOR v2: surface는 report(§11). FLOOR critical(novelty·화자·허위참조·과확장)만 refine. 전 모드(C30).
    //   과확장은 1패스로 안 줄 수 있어 최대 2라운드 shrink/repair.
    const MAX_FLOOR_ROUNDS = 2;
    floorViolations = floor.collectFloorViolations({ result, rawText: text, povSeed, optIn, mode: selectedMode, allowedExtra: notes, anchors: anchorsOn });
    let round = 0;
    while (floorViolations.length && round < MAX_FLOOR_ROUNDS) {
      round++;
      try {
        const refineUser = floor.buildFloorRefineUser(humanizeText, result.outputText, floorViolations, lang);
        const refineData = await callClaude({
          userText: refineUser, systemText: humanizeSystem.stable, systemVolatile: humanizeSystem.volatile, tool: humanizeTool,
          temperature: 0.5, maxOutputTokens: 16384, signal,
          task: 'humanize', phase: 'humanize:floor_refine', mode: selectedMode, attempt: round, cacheZeroWarn: true
        });
        result = extractClaudeResult(refineData, humanizeTool.name);
        await applyPassC(result, lang, signal, { rawText: humanizeText, mode: selectedMode });
        verifyCheckFields(result, selectedMode, inputParaCount, inputCharLen, humanizeText);
        refined = true;
        floorViolations = floor.collectFloorViolations({ result, rawText: text, povSeed, optIn, mode: selectedMode, allowedExtra: notes, anchors: anchorsOn }); // 재검증
      } catch (e) {
        if (signal?.aborted) throw e;
        break; // 마지막 성공 결과 유지
      }
    }
    refineReason = floorViolations.length
      ? `floor-unresolved:${floorViolations.map(v => v.type).join('+')}(${round}R)`
      : (refined ? `floor-resolved(${round}R)` : 'pass(floor-clean)');
  } else {
    // legacy 경로 (프로덕션 동일)
    const decision = shouldRefine(result, selectedMode, inputParaCount);
    failed = decision.refine ? collectFailedFields(result, selectedMode, inputParaCount) : [];
    if (decision.refine) {
      refineReason = decision.reason;
      try {
        const refineUser = buildRefineUser(humanizeText, result.outputText, failed, lang);
        const refineData = await callClaude({
          userText: refineUser, systemText: humanizeSystem.stable, systemVolatile: humanizeSystem.volatile, tool: humanizeTool,
          temperature: 0.5, maxOutputTokens: 16384, signal,
          task: 'humanize', phase: 'humanize:legacy_refine', mode: selectedMode, cacheZeroWarn: true
        });
        result = extractClaudeResult(refineData, humanizeTool.name);
        await applyPassC(result, lang, signal, { rawText: humanizeText, mode: selectedMode });
        verifyCheckFields(result, selectedMode, inputParaCount, inputCharLen, humanizeText);
        refined = true;
      } catch (e) {
        if (signal?.aborted) throw e;
        result = firstResult;
      }
    }
  }

  // ★ 완전·근접 중복 제거(2026-06-19 실측 #4 앤보가트 연극보고서: 그대로 다듬기 단일패스가 exact 2 중복에 차단).
  //   청크 경로(아래 merge 단계)엔 이미 dedupe가 있는데 단일패스엔 없어, exact 중복이 floor repetition 게이트에
  //   걸려 통째 차단됐다. 중복 문장은 새 정보 0이라 후속 등장만 삭제(무손실) → 차단 대신 수리. DEDUP=0으로 해제.
  if (process.env.DEDUP !== '0') {
    const dr = require('../engine/dedupe').dedupeSentences(result.outputText);
    if (dr.removed > 0) result.outputText = dr.text;
    result.dedupe = { removed: dr.removed };
  }
  // 보존 가드 측정 결과를 result에 부착 (전 모드)
  const povDrift = floor.measurePovDrift(text, result.outputText, povSeed);
  result.povSeed = povSeed;
  result.povDrift = povDrift;
  result.floorNovelty = floor.measureNovelty(text, result.outputText, notes);
  result.floorLength = floor.measureLength(text, result.outputText, selectedMode);
  result.softDrift = require('../engine/softguard').measureSoftDrift(text, result.outputText);
  result.conclusionDrift = require('../engine/softguard').measureConclusionDrift(text, result.outputText);
  result.repetition = floor.measureRepetition(result.outputText);
  result.lostFacts = floor.measureLostFacts(text, result.outputText);
  if (selectedMode === 'thesis') result.fakeInternalRefs = floor.measureFakeInternalRefs(text, result.outputText);

  // P2-c: semanticJudge 트리거(§리뷰#5) — soft drift + 결정론 위험신호 → 위반 시 repair → 재judge(닫힌 루프).
  const judgeTrigger = judgeTriggerReasons(result);
  if (judge && (judge === 'force' || judgeTrigger.length)) {
    try {
      const j = require('../engine/judge');
      const preJudge = result.outputText;
      const jr = await j.judgeAndRepair(text, preJudge, { lang, signal, allowedExtra: notes });
      contract.softClaimLedger = jr.ledger; // Contract에 Soft Claim Ledger 채움
      // ★ judge 재작성이 결정론 FLOOR를 악화(사실 소실·과압축·날조)시키면 폐기하고 judge 이전 출력 유지(FLOOR>우회).
      let judgedOut = jr.outputText, repairRejected = false;
      if (judgedOut !== preJudge) {
        const preV = floor.collectFloorViolations({ result: { outputText: preJudge }, rawText: text, povSeed, optIn, mode: selectedMode, allowedExtra: notes });
        const postV = floor.collectFloorViolations({ result: { outputText: judgedOut }, rawText: text, povSeed, optIn, mode: selectedMode, allowedExtra: notes });
        if (postV.length > preV.length) { judgedOut = preJudge; repairRejected = true; }
      }
      if (judgedOut !== result.outputText) {
        result.outputText = judgedOut;
        // 교정으로 출력이 바뀌었으니 보존 가드 전부 재측정.
        result.povDrift = floor.measurePovDrift(text, result.outputText, povSeed);
        result.floorNovelty = floor.measureNovelty(text, result.outputText, notes);
        result.floorLength = floor.measureLength(text, result.outputText, selectedMode);
        result.softDrift = require('../engine/softguard').measureSoftDrift(text, result.outputText);
        result.conclusionDrift = require('../engine/softguard').measureConclusionDrift(text, result.outputText);
        result.repetition = floor.measureRepetition(result.outputText);
        result.lostFacts = floor.measureLostFacts(text, result.outputText);
      }
      result.judge = { ran: true, trigger: judgeTrigger, claims: jr.ledger.claims.length, dropped: jr.ledger.dropped, pass: jr.verdict.pass, violations: jr.verdict.violations, rounds: jr.rounds, ledgerHealth: jr.ledgerHealth, repairRejected };
    } catch (e) { if (signal?.aborted) throw e; result.judge = { ran: false, error: e.message }; }
  } else if (judge) {
    result.judge = { ran: false, reason: 'no risk trigger (cheap gate)' };
  }

  // ★ source-internal grounding(검증된 메모리스 레버): 추상 segment를 stance-sharpening으로 교체(antiDetect 이전).
  if (grounding) {
    result.grounding = await applyGrounding({
      result, rawText: text, povSeed, optIn, mode: selectedMode, lang, signal, floor, allowedExtra: notes,
      ledger: contract.softClaimLedger   // ★ judge가 만든 ledger 재사용(없으면 grounding이 1회 생성)
    });
  }

  // ★ Phase 0 폴리시(검출+국소 repair): 구어체 반복·register 혼합·압축. grounding 뒤, antiDetect 앞.
  if (process.env.POLISH !== '0') {
    try {
      const pol = await require('../engine/polish').polishPass(result.outputText, { lang, signal, floor, rawText: text, allowedExtra: notes });
      if (pol.text && pol.text !== result.outputText) {
        const preV = floor.collectFloorViolations({ result: { outputText: result.outputText }, rawText: text, povSeed, optIn, mode: selectedMode, allowedExtra: notes });
        const postV = floor.collectFloorViolations({ result: { outputText: pol.text }, rawText: text, povSeed, optIn, mode: selectedMode, allowedExtra: notes });
        if (postV.length <= preV.length) result.outputText = pol.text;
      }
      result.polish = { repaired: pol.repaired, stats: pol.stats };
    } catch (e) { if (signal?.aborted) throw e; result.polish = { error: e.message }; }
  }

  // ★ GPTZero 전용 2차 우회 패스(§우회): perplexity 교란 → FLOOR 재검사 → 깨지면 1차 출력 폴백.
  if (antiDetect) {
    result.antiDetect = await applyAntiDetect({
      result, rawText: text, povSeed, optIn, mode: selectedMode, lang,
      speakerType: contract.speakerType, signal, floor, allowedExtra: notes
    });
  }

  // ★ Phase 0 띄어쓰기 품질 게이트(결정론, 최종) — 공백만 조정, 사실·FLOOR 불변.
  if (process.env.SPACING !== '0') {
    const sp = require('../engine/spacing').fixSpacing(result.outputText);
    result.outputText = sp.text;
    result.spacing = { fixes: sp.fixes, warnings: sp.warnings };
  }
  // ★ 문단 정리(2026-06-12): 문단 내부 단일 줄바꿈→공백(문단 구분 \n\n 보존) — UI "애매한 두 행" 방지.
  result.outputText = require('../engine/genretransfer').tidyParagraphs(result.outputText);

  // ★ 노출 게이트(E.3): 모든 측정을 criticals/warnings로 모아 status 결정. criticals 있으면 blocked.
  result.floorReport = floor.buildFloorReport({ result, rawText: text, mode: selectedMode, povSeed, optIn, allowedExtra: notes, anchors: anchorsOn });
  const surfaceReport = floor.collectSurfaceReport(result);
  // ★ surfaceguard(§카피킬러 대응): genericness·구체 grounding·관점·균일성 측정(리포트, FLOOR 게이트 아님).
  //   inputRisk는 원문 기준(추상 일반론이면 needsUserAnchor) — 가짜 경험 생성 대신 사용자 메모 요청.
  const sguard = require('../engine/surfaceguard');
  result.surface = sguard.buildSurfaceReport(result.outputText);
  result.inputRisk = sguard.classifyInputRisk(text);
  result.contract = contract; // 단일 진실 첨부

  return {
    result,
    mode: selectedMode,
    lang,
    refined,
    refineReason,
    status: result.floorReport.status,
    floorReport: result.floorReport,
    contract,
    failedFields: failed,
    floorViolations,
    surfaceReport,
    surface: result.surface,
    inputRisk: result.inputRisk,
    preInfo,
    inputParaCount,
    inputCharLen,
    humanizeText,
    floorV2,
    optIn,
    povSeed,
    povDrift,
    grounding: result.grounding
  };
}

// server-side chunking 오케스트레이션 — 문단별 재작성 + 좌/우 경계 + 청크별 FLOOR + 병합(§7.2).
// 긴 글에서 프론트 분할(prevContext 300자)을 대체. 청크별로 novelty/화자를 잡고, 병합 후 전체 재검사.
async function runHumanizeChunked({ text, mode = 'assignment', lang = 'ko', signal, floorV2 = true, optIn = false, judge = false, antiDetect = false, grounding = false, userNotes = '', evidence = '', tonePolish = false, styleProfile = '' } = {}) {
  const floor = require('../engine/floor');
  const { splitChunks, mergeChunks, nearestChunkId } = require('../engine/chunk');
  const basicReportStyle = styleProfile === 'basic_report' || styleProfile === 'basic_style_stability';
  const basicBlogStyle = styleProfile === 'basic_blog';
  // ★ 두 종류의 허용 추가재료(§설계-evidence-grounding):
  //   memo = 사용자 경험 메모(1인칭 장면화, optIn으로 화자 게이트 개방)
  //   evid = 웹검증+학생승인 사실(3인칭 격식 인용, 화자 게이트는 닫힌 채 유지)
  //   notes = 둘의 합집합 — 기존 allowedExtra 사이트 전부가 이 변수를 쓰므로 "허용 세계 = 원문∪메모∪승인사실"이 자동 성립.
  const memo = basicReportStyle ? '' : (userNotes || '').trim();
  const evid = (evidence || '').trim();
  const notes = [memo, evid].filter(Boolean).join('\n');
  if (memo) optIn = true;
  // ★ 승인 사실은 "원문의 일부"다(§설계-evidence-grounding): FLOOR 기준 원문 = 원문∪승인사실.
  //   효과 ①분량 정책이 사실 포함 길이를 기준으로 잡혀 위빙이 과확장으로 안 찍힘
  //        ②measureLostFacts가 승인 사실의 수치·기관 누락을 위반으로 잡음 = 사실 생존 강제(repair가 깎으면 되살림).
  const textF = evid ? text + '\n\n' + evid : text;
  const contract = require('../engine/contract').buildContract(text, { mode, lang, optIn }); // 단일 진실
  const povSeed = contract.povSeed;
  const chunks = splitChunks(text);

  // ★ 승인 사실 무결성 가드(genretransfer 이식): 수치-출처 짝 검증 + 재인용 dedupe. 결정론·무비용.
  const evg = require('../engine/evidenceguard');
  const evidLines = evid ? evid.split('\n').map(l => l.trim()).filter(Boolean) : [];
  // ★ 목소리 앵커(genretransfer 이식): 재생성 경로에선 89→73→43~45% 실레버지만, 보존형 청크 재작성에선
  //   효과 0 실측(이식판 100% vs v2 94~95 — 골격 verbatim+분량 강제+원문 추종이라 분포 이동 불가, 1인칭
  //   사후패치 0/22과 동일 패턴) → 메인 경로는 STYLE_ANCHOR=1 옵트인. 누출은 anchor_leak 게이트가 차단.
  const anchorActive = floorV2 && lang === 'ko' && mode === 'assignment' && process.env.STYLE_ANCHOR === '1';
  const buildSys = (un, ev, anchorIdx = null) => floorV2
    ? require('../engine/prompt').buildSystemPrompt(mode, lang, { speakerType: contract.speakerType, lengthPolicy: contract.lengthPolicy, userNotes: un, register: contract.register, evidence: ev, anchorIdx, tonePolish, styleProfile })
    : { stable: getHumanizeSystem(mode, lang), volatile: '' };  // ★ 캐시: 비-floor도 {stable,volatile}로 통일
  let humanizeSystem = buildSys('', '', null);  // 기본(메모·evidence·앵커 없음 — 수리 패스용)
  const topicSim = (a, b) => {
    const ta = new Set((a.match(/[가-힣]{2,}/g) || []));
    if (!ta.size) return 0;
    let hit = 0; const seen = new Set();
    for (const t of (b.match(/[가-힣]{2,}/g) || [])) if (ta.has(t) && !seen.has(t)) { seen.add(t); hit++; }
    return hit / ta.size;
  };
  // ★ 메모 청크별 분배(§v4): 각 경험을 *주제가 가장 맞는* 미사용 청크 하나에만 배정.
  //   같은 경험이 여러 청크에 중복 위빙("동일 내용 과도한 반복")되던 문제 + 엉뚱한 문단에 박히는 문제 해결.
  const chunkNotes = {};
  if (floorV2 && memo) {
    const noteLines = memo.split('\n').map(l => l.trim()).filter(Boolean);
    const used = new Set();
    for (const ln of noteLines) {
      let best = -1, bestScore = 0.05;  // 최소 유사도 미만이면 억지 배치 안 함
      chunks.forEach((c, i) => {
        if (used.has(i) || !(c.position === 'body' || c.position === 'single')) return;
        const s = topicSim(ln, c.text);
        if (s > bestScore) { bestScore = s; best = i; }
      });
      if (best >= 0) { chunkNotes[best] = ln; used.add(best); }  // 안 맞으면 미배치(생성 강요 X)
    }
  }
  // ★ evidence 청크별 분배: 메모와 달리 사실은 다수(15~25개)라 청크당 1개 제한이면 L3가 못 오름 →
  //   청크당 최대 4개까지 주제 매칭 배정(서로 다른 사실이 한 문단에 오는 건 무해; 같은 사실 반복이 유해).
  //   결론 청크 제외(결론부 posNote "새 사실 추가 금지"와 충돌 + 카피킬러도 결론 일반론은 본문 근거로 희석).
  const chunkEvid = {};
  if (floorV2 && evid) {
    // 사실 예산 = 청크 크기 비례(250자당 1개, 최대 3): 200자 문단에 사실 4개를 끼우면 분량이 2~3배가 돼
    //   위빙 자체가 불가능하다(1차 실측: 17개 중 2개만 생존). 짧은 문단엔 1개만.
    const capOf = (c) => Math.min(3, Math.max(1, Math.floor(c.text.replace(/\s+/g, '').length / 250)));
    for (const ln of evidLines) {
      let best = -1, bestScore = 0.03;
      chunks.forEach((c, i) => {
        if ((chunkEvid[i] || []).length >= capOf(c)) return;
        if (!(c.position === 'body' || c.position === 'single' || c.position === 'intro')) return;
        if (c.text.replace(/\s+/g, '').length < 80) return;  // 제목·소제목·한줄 청크엔 사실 위빙 금지
        const s = topicSim(ln, c.text);
        if (s > bestScore) { bestScore = s; best = i; }
      });
      if (best >= 0) (chunkEvid[best] = chunkEvid[best] || []).push(ln);  // 안 맞으면 미배치
    }
  }
  const tool = floorV2 ? getLeanHumanizeTool(lang) : getHumanizeToolFor(mode, lang);  // floorV2 lean tool(§리뷰#7)
  const tail = (s, n) => (s || '').slice(-n);
  const head = (s, n) => (s || '').slice(0, n);

  // ★ 병렬화: 청크는 앞 청크의 '원문' 이웃만 참고(출력 의존 제거)하므로 서로 독립 → 동시 실행 가능.
  //   claudecode(CLI)는 직렬(1), API는 동시성 6. CHUNK_CONCURRENCY로 override.
  const CHUNK_CONCURRENCY = Number(process.env.CHUNK_CONCURRENCY) ||
    (process.env.LLM_BACKEND === 'claudecode' ? 1 : 6);

  async function processChunk(i) {
    if (signal?.aborted) throw new Error('aborted');
    const c = chunks[i];
    const prevRaw = i > 0 ? chunks[i - 1].text : '';                 // ★ 원문 이웃(병렬 안전)
    const nextRaw = i < chunks.length - 1 ? chunks[i + 1].text : '';
    const posNote = lang === 'en'
      ? (c.position === 'conclusion'
        ? 'Note: This is the conclusion. Do not repeat claims or calls-to-action already made earlier. Do not add new facts or future predictions. Keep the length close to the source chunk.'
        : c.position === 'intro' ? 'Note: This is the introduction.' : 'Note: This is a body section.')
      : (c.position === 'conclusion'
        ? '※ 결론부다. 앞에서 이미 말한 주장·CTA를 반복하지 말고, 새 사실·미래전망을 추가하지 마라. 길이는 원문 청크와 비슷하게.'
        : c.position === 'intro' ? '※ 도입부다.' : '※ 본문이다.');
    const boundary =
      (prevRaw ? (lang === 'en'
        ? `[PREVIOUS SOURCE CONTEXT — reference only, do not rewrite]\n...${tail(prevRaw, 150)}\n\n`
        : `[앞 부분 원문 — 문맥 참고, 다시 쓰지 말 것]\n...${tail(prevRaw, 150)}\n\n`) : '') +
      (nextRaw ? (lang === 'en'
        ? `[NEXT SOURCE CONTEXT — do not touch]\n${head(nextRaw, 100)}...\n\n`
        : `[뒤에 이어질 원문 — 손대지 말 것]\n${head(nextRaw, 100)}...\n\n`) : '');
    const userContent = lang === 'en'
      ? `${boundary}[TEXT TO REWRITE — this section only]\n${c.text}\n\n${posNote}`
      : `${boundary}[재작성할 텍스트 — 이 부분만]\n${c.text}\n\n${posNote}`;
    const chunkSys = (chunkNotes[i] || chunkEvid[i] || anchorActive)
      ? buildSys(chunkNotes[i] || '', (chunkEvid[i] || []).join('\n'), anchorActive ? i : null)   // 배정된 경험·사실 + 청크 회전 앵커
      : humanizeSystem;

    // ★ 긴 글 내성: 청크 본 호출이 (claudecode flakiness 등으로) 실패하면 1회 더 재시도하고,
    //   그래도 실패할 때만 그 청크만 원문으로 폴백한다.
    // claudecode(flaky·간헐 거부)는 3회, API는 2회 시도 후에만 raw 폴백.
    const MAX_ATTEMPTS = process.env.LLM_BACKEND === 'claudecode' ? 3 : 2;
    // ★ 기준 원문 = 청크 ∪ 배정사실(cRaw): 분량 기준이 사실 포함 길이로 잡히고, lostFacts가 사실 누락을
    //   위반으로 잡아 repair가 사실을 "깎는" 게 아니라 "되살리는" 방향으로 작동(§설계-evidence-grounding).
    //   폴백 시에도 승인 사실은 원문 그대로 덧붙인다(승인사실 verbatim 인용 = 무날조, 전체 lostFacts 정합).
    const evidHere = (chunkEvid[i] || []).join('\n');
    const cRaw = evidHere ? c.text + '\n' + evidHere : c.text;
    const rawWithEvid = evidHere ? c.text + ' ' + evidHere.replace(/\n/g, ' ') : c.text;
    // ★ 제목·소제목 청크는 LLM에 안 보내고 그대로 통과(보고서 장르 실측 버그 2건의 공통 원인):
    //   ①posNote("※ 본문이다")를 출력에 베껴 넣음 ②"뒤에 이어질 원문" 미리보기를 패러프레이즈해
    //   문단을 새로 만들고, 다음 청크가 같은 내용을 또 재작성 → 문단 중복·분량 폭증(144~162%).
    //   판정: 60자 미만 + 문장 종결이 아님(제목은 명사로 끝남: "서론"·"연구의 필요성").
    const bare = c.text.replace(/\s+/g, '');
    if (bare.length < 60 && !/[.!?…다요죠함임음까]$/.test(bare)) { c.outputText = c.text; return; }
    // ★ 수치-출처 짝 청크 게이트(이식): 출력의 짝 위반이 청크원문(∪배정사실) 수준을 넘으면 재생성.
    //   원문 자체에 출처 없이 떠도는 수치가 있을 수 있으므로 "비증가" 비교(절대 0 요구 시 오탐) — 폴백은
    //   rawWithEvid(승인사실 verbatim)라 정의상 짝 안전.
    const basePairCount = evid ? evg.checkEvidencePairing(rawWithEvid, evidLines).length : 0;
    let chunkDone = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !chunkDone; attempt++) {
      try {
        const data = await callClaude({
          userText: userContent,
          systemText: chunkSys.stable,
          systemVolatile: chunkSys.volatile,
          tool,
          temperature: 0.5,
          maxOutputTokens: 8192,
          signal,
          task: 'humanize_chunked',
          phase: 'chunk:main',
          mode,
          chunkIndex: i,
          attempt: attempt + 1,
          cacheZeroWarn: true
        });
        // ★ 토큰 상한 절단 수용 금지(2026-06-16): stop_reason=max_tokens면 청크가 중간에 잘린 것 — 요약 collapse와
        //   구분해 폐기하고 재시도, 끝내 실패하면 원문 청크로 폴백(잘린 결과를 절대 내보내지 않는다 = 분량 보존).
        if (data?.stop_reason === 'max_tokens') throw new Error('max_tokens-truncated');
        const r = extractClaudeResult(data, tool.name);
        if (floor.looksLikeRefusal(r.outputText)) throw new Error('model-refusal'); // ★ 거부문이 출력에 박히는 사고 차단 → 재시도/폴백
        if (evid && evg.checkEvidencePairing(r.outputText || '', evidLines).length > basePairCount) throw new Error('evidence-pairing'); // ★ 수치-출처 분리(재조합 위험) → 재시도/폴백
        // ★ 절단 생성 복구(2026-06-22 #209·#217): stop_reason=max_tokens가 아니어도 LLM이 문장 중간에 멈추면(end_turn)
        //   잘린 출력이 그대로 병합돼 결과가 미완으로 나간다. 입력 청크는 완결인데 출력이 절단이면 생성이 끊긴 것 →
        //   max_tokens와 동일하게 재시도(다음 attempt) → 끝내 실패 시 raw 청크 폴백(완결한 원문 보존). TRUNC_GUARD=0 해제.
        if (process.env.TRUNC_GUARD !== '0' && floor.endsTruncated(r.outputText) && !floor.endsTruncated(c.text)) throw new Error('truncated-generation');
        await applyPassC(r, lang, signal, { rawText: c.text, mode });
        c.outputText = r.outputText || rawWithEvid;
        chunkDone = true;
      } catch (e) {
        if (signal?.aborted) throw e;
        if (attempt < MAX_ATTEMPTS - 1) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); continue; } // 백오프 후 재시도
        c.outputText = rawWithEvid; c.fellBack = true; c.fallbackReason = /truncated-generation/.test(e.message) ? 'truncated' : /max_tokens/i.test(e.message) ? 'max_tokens' : /refusal/i.test(e.message) ? 'refusal' : /pairing/.test(e.message) ? 'evidence-pairing' : 'llm-error';
      }
    }
    if (!chunkDone) return; // 재시도까지 실패 → 원문(+승인사실) 폴백, repair/재검증 건너뜀
    const viol = floor.collectFloorViolations({ result: { outputText: c.outputText }, rawText: cRaw, povSeed, optIn, mode, position: c.position, chunkLevel: true, allowedExtra: notes, anchors: anchorActive });
    if (viol.length) {
      try {
        const ru = floor.buildFloorRefineUser(cRaw, c.outputText, viol, lang);
        const rd = await callClaude({
          userText: ru,
          systemText: chunkSys.stable,
          systemVolatile: chunkSys.volatile,
          tool,
          temperature: 0.5,
          maxOutputTokens: 8192,
          signal,
          task: 'humanize_chunked',
          phase: 'chunk:repair',
          mode,
          chunkIndex: i,
          cacheZeroWarn: true
        });
        if (rd?.stop_reason === 'max_tokens') throw new Error('max_tokens-truncated');   // 절단된 repair는 적용 안 함(이전 출력 유지)
        const r2 = extractClaudeResult(rd, tool.name);
        await applyPassC(r2, lang, signal, { rawText: cRaw, mode });
        // 거부문이거나 수치-출처 짝을 새로 깨면 적용 안 함(이전 출력 유지)
        if (r2.outputText && !floor.looksLikeRefusal(r2.outputText)
          && !(evid && evg.checkEvidencePairing(r2.outputText, evidLines).length > basePairCount)) c.outputText = r2.outputText;
      } catch (e) { if (signal?.aborted) throw e; }
      // ★ repair 재검증 + raw fallback(§리뷰#3): 고치고도 날조·소실·화자주입·누출이 남으면 원문 청크로 폴백
      //   (휴머나이징 포기 < 날조/소실 노출 방지 — FLOOR가 탐지기 우회보다 우선).
      const after = floor.collectFloorViolations({ result: { outputText: c.outputText }, rawText: cRaw, povSeed, optIn, mode, position: c.position, chunkLevel: true, allowedExtra: notes, anchors: anchorActive });
      const HARD = new Set(['novelty', 'lost_facts', 'pov', 'fake_ref', 'meta_leak', 'coined_term', 'anchor_leak']);
      const residual = after.filter(x => HARD.has(x.type));
      if (residual.length) {
        c.outputText = rawWithEvid;       // 원문(+승인사실 verbatim) — 사실·화자가 정의상 보존됨
        c.fellBack = true;
        c.fallbackReason = residual.map(x => x.type).join(',');
      }
    }
  }

  // 동시성 제한 풀 — 인덱스 큐를 CHUNK_CONCURRENCY개 워커가 소진.
  {
    let next = 0;
    // ★ 캐시 워밍(opt-in, CHUNK_CACHE_WARM=1): 첫 청크를 단독 실행해 FLOOR 고정코어 캐시를 먼저 채운 뒤
    //   (cache write) 나머지를 동시 실행 → 동일 prefix를 cache_read로 재사용. N개 청크가 같은 prefix를
    //   동시에 write하던 낭비(캐시 doc "concurrent-request timing")를 제거 = 입력비용↓·hit rate↑.
    //   대가는 첫 청크만큼 지연↑ — 속도 민감 시 기본 OFF, 비용/알람 우선 시 1로 켠다.
    if (process.env.CHUNK_CACHE_WARM === '1' && chunks.length > 1) { await processChunk(0); next = 1; }
    const worker = async () => { while (next < chunks.length) { await processChunk(next++); } };
    await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, worker));
  }
  const fallbackCount = chunks.filter(c => c.fellBack).length;

  const merged = mergeChunks(chunks);
  const result = { outputText: merged };
  if (styleProfile) result.styleProfile = styleProfile;
  result.povSeed = povSeed;
  result.softDrift = require('../engine/softguard').measureSoftDrift(text, merged);
  result.conclusionDrift = require('../engine/softguard').measureConclusionDrift(text, merged);
  // 트리거 판단용 결정론 측정(병합 기준).
  result.floorNovelty = floor.measureNovelty(text, merged, notes);
  result.floorLength = floor.measureLength(textF, merged, mode);
  result.repetition = floor.measureRepetition(merged);
  result.lostFacts = floor.measureLostFacts(textF, merged);

  // P2-c: semanticJudge 트리거(§리뷰#5) — soft drift + 결정론 위험신호. 닫힌세계=전체 ledger.
  //   span은 nearest_chunk_id로 매핑(§7.2).
  const judgeTrigger = judgeTriggerReasons(result);
  if (judge && (judge === 'force' || judgeTrigger.length)) {
    try {
      const j = require('../engine/judge');
      const jr = await j.judgeAndRepair(text, merged, { lang, signal, allowedExtra: notes, approvedFacts: evid });
      contract.softClaimLedger = jr.ledger;
      // ★ judge 재작성이 결정론 FLOOR를 악화시키면 폐기하고 병합본 유지(FLOOR>우회).
      let judgedOut = jr.outputText, repairRejected = false;
      if (judgedOut !== merged) {
        const preV = floor.collectFloorViolations({ result: { outputText: merged }, rawText: textF, povSeed, optIn, mode, allowedExtra: notes, anchors: anchorActive });
        const postV = floor.collectFloorViolations({ result: { outputText: judgedOut }, rawText: textF, povSeed, optIn, mode, allowedExtra: notes, anchors: anchorActive });
        // ★ 길이 급감 방어(2026-06-16 실사고): judge repair가 토큰 상한에 잘려 문서가 통째로 짧아지면, FLOOR 위반
        //   수는 오히려 줄어(=내용이 사라져) 위 가드를 통과한다. 병합본 대비 40%+ 짧아지면 절단으로 보고 병합본 유지.
        const mBare = merged.replace(/\s+/g, '').length, jBare = judgedOut.replace(/\s+/g, '').length;
        const truncated = mBare > 1500 && jBare < mBare * 0.6;
        if (truncated || postV.length > preV.length || (evid && evg.checkEvidencePairing(judgedOut, evidLines).length > evg.checkEvidencePairing(merged, evidLines).length)) { judgedOut = merged; repairRejected = true; }
      }
      if (judgedOut !== merged) result.outputText = judgedOut;
      const violations = (jr.verdict.violations || []).map(v => ({ ...v, nearest_chunk_id: nearestChunkId(chunks, v.span) }));
      result.judge = { ran: true, trigger: judgeTrigger, claims: jr.ledger.claims.length, dropped: jr.ledger.dropped, pass: jr.verdict.pass, violations, rounds: jr.rounds, ledgerHealth: jr.ledgerHealth, repairRejected };
      result.softDrift = require('../engine/softguard').measureSoftDrift(text, result.outputText);
    } catch (e) { if (signal?.aborted) throw e; result.judge = { ran: false, error: e.message }; }
  } else if (judge) {
    result.judge = { ran: false, reason: 'no risk trigger (cheap gate)' };
  }

  // ★ Step1 acceptance gate용 baseline 스냅샷(휴머나이즈+judge까지 = 검증된 안전 기준).
  //   이후 grounding/optimize/polish 스택이 이 baseline보다 나빠지면 최종에서 revert(역효과 차단).
  const baselineText = result.outputText;

  // ★ C등급(순수 추상, abstractRisk≥0.85) skip: 실측상 grounding/optimize/polish가 오히려 악화(공부 57→73)
  //   + 게이트도 그 악화를 못 잡음 → 패스를 아예 돌리지 않고 baseline 출고(품질↑·비용↓ 삼중 이득).
  //   SKIP_C=0으로 강제 해제 가능. A/B등급은 패스가 도움(college 55→46)이라 유지.
  const _ir = require('../engine/surfaceguard').classifyInputRisk(text);
  const skipPasses = _ir.skipPasses && process.env.SKIP_C !== '0';
  if (skipPasses) result.skippedPasses = { reason: 'C-grade', abstractRiskRatio: _ir.abstractRiskRatio };

  // ★ source-internal grounding(검증된 메모리스 레버): 추상 segment를 stance-sharpening으로 교체.
  //   antiDetect 이전에 적용(grounding은 의미층, antiDetect는 표면 perplexity 교란이라 마지막).
  // ★ 격식 모드(assignment/thesis)는 C등급이어도 grounding 실행: 격식 한다체는 본질적으로 비인칭·객관이라
  //   카피킬러 "주관성의 지나친 배제·비인칭" 플래그 직격(EV assignment 81% 실측). grounding이 학술적 1인칭
  //   견해·판단을 주입(문체는 한다체 유지)해 그 플래그를 끈다. blog/resume는 이미 구어로 주관이 있어 C등급 skip 유지.
  const groundingForce = (mode === 'assignment' || mode === 'thesis') && process.env.GROUND_FORMAL_C !== '0';
  // ★ B7 모드: grounding은 "말투 유지"로 합니다체를 한다체로 되돌리고 격식엔 도움도 안 됨 → skip.
  if (grounding && (!skipPasses || groundingForce) && process.env.ASSIGNMENT_B7 !== '1') {
    result.grounding = await applyGrounding({
      result, rawText: textF, povSeed, optIn, mode, lang, signal, floor, allowedExtra: notes,
      ledger: contract.softClaimLedger   // ★ judge가 만든 ledger 재사용(없으면 grounding이 1회 생성)
    });
  }

  // ★ FLOOR preV 캐시(2026-06-21 최적화): 패스 스택(optimize·polish·phrasebudget·burstiness·formalbudget·column)이
  //   매 패스 preV=collectFloorViolations(현재출력)를 전수 재계산하던 것을 캐시. collectFloorViolations는 순수함수라
  //   동일 출력·동일 옵션이면 결과 동일. result.outputText가 바뀌면(apply 경로뿐) 식별자 비교로 자동 무효화 → 항상
  //   collectFloorViolations(현재 result.outputText)와 동일. 패스가 reject/미실행이면 재사용(전수 스캔 절감). FLOOR_CACHE=0 해제.
  const _floorStd = { rawText: textF, povSeed, optIn, mode, allowedExtra: notes };
  let _floorPreText = null, _floorPreV = null;
  const floorPreV = () => {
    if (process.env.FLOOR_CACHE === '0') return floor.collectFloorViolations({ result: { outputText: result.outputText }, ..._floorStd });
    if (_floorPreText !== result.outputText) { _floorPreText = result.outputText; _floorPreV = floor.collectFloorViolations({ result: { outputText: result.outputText }, ..._floorStd }); }
    return _floorPreV;
  };

  // ★ Phase 1.5 multi-candidate 최적화(채점기 검증 후): 고위험 segment를 후보 N개 중 riskScore 최저로 교체.
  //   grounding 뒤, polish 앞. OPTIMIZE=1일 때만. FLOOR 악화 시 폐기(무해).
  // OPTIMIZE=1 적용 / OPTIMIZE_SHADOW=1 로그만(적용X, 카피킬러 대조 데이터 축적용) / 기본 off
  const optMode = (process.env.OPTIMIZE === '1' ? 'apply' : (process.env.OPTIMIZE_SHADOW === '1' ? 'shadow' : 'off'));
  if (optMode !== 'off' && !skipPasses) {
    try {
      const opt = await require('../engine/optimizer').optimizePass(result.outputText, text, { lang, signal });
      if (optMode === 'apply' && opt.text && opt.text !== result.outputText) {
        const preV = floorPreV();
        const postV = floor.collectFloorViolations({ result: { outputText: opt.text }, rawText: textF, povSeed, optIn, mode, allowedExtra: notes });
        if (postV.length <= preV.length) result.outputText = opt.text;
      }
      result.optimize = { mode: optMode, changed: opt.changed, targets: opt.targets, log: opt.log };
    } catch (e) { if (signal?.aborted) throw e; result.optimize = { error: e.message }; }
  }

  // ★ Phase 0 폴리시(검출+국소 repair): 구어체 반복·register 혼합·압축 잔여 플래그 정리.
  //   grounding 뒤, antiDetect 앞. FLOOR 악화 시 폐기(무해). C등급은 skip.
  if (process.env.POLISH !== '0' && !skipPasses) {
    try {
      const pol = await require('../engine/polish').polishPass(result.outputText, { lang, signal, floor, rawText: text, allowedExtra: notes });
      if (pol.text && pol.text !== result.outputText) {
        const preV = floorPreV();
        const postV = floor.collectFloorViolations({ result: { outputText: pol.text }, rawText: textF, povSeed, optIn, mode, allowedExtra: notes });
        if (postV.length <= preV.length) result.outputText = pol.text;
      }
      result.polish = { repaired: pol.repaired, stats: pol.stats };
    } catch (e) { if (signal?.aborted) throw e; result.polish = { error: e.message }; }
  }

  // ★ 구어체 연결어 예산(phrasebudget): C등급은 polish를 skip하므로 여기서 단독 실행(내용 불변·연결어 다양화만).
  //   거든요/근데/더라고요 등 과다 반복은 그 자체로 '기계적 균일성' 신호(도시론 실측 거든요 58→7, risk 0.630→0.520).
  //   A/B등급은 polishPass가 이미 phrasebudget을 포함하므로 중복 실행 안 함. PHRASE_C=0으로 해제.
  if (skipPasses && process.env.PHRASE_C !== '0') {
    try {
      const pbr = await require('../engine/phrasebudget').repairPhraseOveruse(result.outputText, { lang, signal, floor, rawText: text, allowedExtra: notes });
      if (pbr.text && pbr.text !== result.outputText) {
        const preV = floorPreV();
        const postV = floor.collectFloorViolations({ result: { outputText: pbr.text }, rawText: textF, povSeed, optIn, mode, allowedExtra: notes });
        if (postV.length <= preV.length) result.outputText = pbr.text;
      }
      result.phrasebudgetC = { repaired: pbr.repaired };
    } catch (e) { if (signal?.aborted) throw e; result.phrasebudgetC = { error: e.message }; }
  }

  // ★ 버스티니스(문장 길이 비균질화): '기계적 정확성·균일성' 공략. 도시론 실측 61→58 확인(Goodhart 아님).
  //   다른 패스와 달리 내용·말투 불변(문장만 쪼갬)이라 C등급에도 도움 → skipPasses 무관하게 실행. BURST=0으로 해제.
  //   순서: phrasebudget(연결어) → burstiness(문장리듬). 둘은 다른 신호라 스택 시 risk 0.630→0.452(복리).
  //   ★★ 격식 burstiness skip 실측 폐기(2026-06): EV 73→94%(+21%p) 폭등! punch 조각·문장길이 변동(burstiness)이
  //     점수를 누르던 핵심 레버였음(카피킬러=GPTZero류, burstiness를 사람글 신호로 봄). 격식도 burstiness 그대로 실행해야 함. 전 모드 적용.
  //     ★burstiness 강화(lowCV 0.8+극단 프롬프트) 실측 폐기(2026-06): EV 73→92% 악화. 과도한 길이변동/잦은 punch는 오히려 부자연→직격.
  //     moderate(lowCV 0.6+기존 프롬프트)가 sweet spot(73%). 강화도 제거도 둘 다 악화 — 73%는 burstiness가 떠받치는 국소 최적. BURST_LOWCV로 조정.
  if (process.env.BURST !== '0') {
    try {
      const _burstLowCV = process.env.BURST_LOWCV ? parseFloat(process.env.BURST_LOWCV) : 0.6;
      const br = await require('../engine/burstiness').burstinessPass(result.outputText, {
        lang,
        signal,
        floor,
        rawText: text,
        allowedExtra: notes,
        aggressive: !(basicReportStyle || basicBlogStyle),
        lowCV: (basicReportStyle || basicBlogStyle) ? Math.max(0.5, Math.min(_burstLowCV, 0.55)) : _burstLowCV,
        styleProfile
      });
      if (br.text && br.text !== result.outputText) {
        const preV = floorPreV();
        const postV = floor.collectFloorViolations({ result: { outputText: br.text }, rawText: textF, povSeed, optIn, mode, allowedExtra: notes });
        if (postV.length <= preV.length) result.outputText = br.text;
      }
      result.burstiness = { repaired: br.repaired, attempted: br.attempted };
    } catch (e) { if (signal?.aborted) throw e; result.burstiness = { error: e.message }; }
  }

  // ★ 격식 표현예산(formalbudget): 판단프레임("A가 아니라 B" 누출)·punch 재사용("그것이 핵심이다"×N)·
  //   정형 마무리 반복을 결정론 검출 → 초과 segment만 국소 다양화(Haiku) → FLOOR 재검.
  //   카피킬러 % 레버 아님(격식 밴드 73~95 확정) — "동일 표현 반복" 품질 결함 제거가 목적. FORMALBUDGET=0 해제.
  if ((mode === 'assignment' || mode === 'thesis') && process.env.FORMALBUDGET !== '0') {
    try {
      const fb = await require('../engine/formalbudget').formalBudgetPass(result.outputText, { lang, signal, floor, rawText: textF, allowedExtra: notes });
      if (fb.text && fb.text !== result.outputText) {
        const preV = floorPreV();
        const postV = floor.collectFloorViolations({ result: { outputText: fb.text }, rawText: textF, povSeed, optIn, mode, allowedExtra: notes });
        if (postV.length <= preV.length) result.outputText = fb.text;
      }
      result.formalBudget = { repaired: fb.repaired, attempted: fb.attempted, before: fb.before, after: fb.after };
    } catch (e) { if (signal?.aborted) throw e; result.formalBudget = { error: e.message }; }
  }

  // ★★ columnCleanup(번호리스트 해체+punch 병합) 실측 폐기(2026-06): EV 73→94% 폭등에 기여. punch 병합·de-list가
  //   문장 변동을 줄여 더 균일·매끈한 비인칭 산문이 됨 → 카피킬러 직격. 기본 OFF(COLUMN=1 명시해야 실행). 모듈은 보존(음성결과).
  if ((mode === 'assignment' || mode === 'thesis') && process.env.COLUMN === '1') {
    try {
      const cr = await require('../engine/columncleanup').columnCleanupPass(result.outputText, { lang, signal, floor, rawText: text, allowedExtra: notes });
      if (cr.text && cr.text !== result.outputText) {
        const preV = floorPreV();
        const postV = floor.collectFloorViolations({ result: { outputText: cr.text }, rawText: textF, povSeed, optIn, mode, allowedExtra: notes });
        if (postV.length <= preV.length) result.outputText = cr.text;
      }
      result.columnCleanup = { repaired: cr.repaired, attempted: cr.attempted, globalPunch: cr.globalPunch };
    } catch (e) { if (signal?.aborted) throw e; result.columnCleanup = { error: e.message }; }
  }

  // ★★ Step1 최종 acceptance gate: grounding+optimize+polish+버스티니스 스택이 baseline보다
  //   {중복·반복·문체혼합·추상·분량} 중 하나라도 나빠지면 baseline으로 revert.
  //   카피킬러는 의심 "영역 수"를 보므로, 이 5개 신호가 늘면 영역이 늘 가능성이 큼 → 역효과 차단.
  if (result.outputText !== baselineText) {
    const sg2 = require('../engine/surfaceguard');
    const srcLen = text.replace(/\s+/g, '').length;
    // ※ register 혼합(한다체↔해요체)은 카피킬러 신호가 아님이 v4 실측으로 확인됨(유령 지표) → 게이트에서 제외.
    //   오히려 종결 다양성을 줘 균일성을 낮추기도 하므로, 한다체 섞임 자체는 막지 않는다.
    // ★게이트는 "신뢰 가능한 재앙 신호"만 본다 — 중복·반복·큰 분량팽창.
    //   abstractRisk는 측정이 거칠어(선명한 판단문을 '더 추상'으로 오판) revert 트리거에서 제외(기록만).
    //   문체혼합은 카피킬러 비신호(v4 입증)라 이미 제외. dup/rep/length가 cap35식 참사(중복·팽창)는 잡는다.
    const dd = require('../engine/dedupe');
    const measure = (t) => ({
      dup: sg2.measureOpeningDuplication(t),
      nd: dd.measureNearDupSentences(t),     // 근접(의미) 중복 — 카피킬러 "동일 내용 과도한 반복"
      rep: floor.measureRepetition(t).total,
      abs: sg2.classifyInputRisk(t).abstractRiskRatio,   // 기록용(트리거 아님)
      len: t.replace(/\s+/g, '').length,
    });
    const b = measure(baselineText), c = measure(result.outputText);
    const reasons = [];
    if (c.dup > b.dup) reasons.push(`중복증가(${b.dup}→${c.dup})`);
    if (c.nd > b.nd) reasons.push(`근접중복증가(${b.nd}→${c.nd})`);
    if (c.rep > b.rep) reasons.push(`반복증가(${b.rep}→${c.rep})`);
    if (c.len > b.len * 1.10) reasons.push(`분량팽창(${b.len}→${c.len})`);   // baseline 대비 10%+ 팽창만 차단
    if (reasons.length) {
      result.outputText = baselineText;   // 역효과 → 안전 기준으로 되돌림
      result.acceptanceGate = { reverted: true, reasons };
    } else {
      result.acceptanceGate = { reverted: false };
    }
  }

  // ★ 분량 하한선(압축) 가드(2026-06-17, #07): 위 acceptance gate는 '팽창'(>1.10×baseline)만 막고 '압축'은
  //   못 본다(2726행). 그래서 이미 사람 글에 가까운 입력이 과압축+과매끈화되어 오히려 카피킬러 AI%가 오르는
  //   사고(#07: 원문 11%·100% 보존이 아니라 74%로 줄며 20%로 악화)를 놓쳤다. 입력 대비 공백제외 비율이 바닥
  //   미만이면 '내용 손실' 신호로 기록·노출. polish(다듬기)는 원래 축약형이라 제외. COMPRESSION_FLOOR로 조정.
  //   하드 폴백(COMPRESSION_FALLBACK=1, 기본 OFF): 손실 큰 재작성보다 원문 경량 정리가 낫다 → 원문 클린본 전달.
  if (mode !== 'polish') {
    const srcN = text.replace(/\s+/g, '').length, outN = result.outputText.replace(/\s+/g, '').length;
    const ratio = outN / Math.max(1, srcN);
    result.compressionRatio = Number(ratio.toFixed(2));
    const floorR = process.env.COMPRESSION_FLOOR ? parseFloat(process.env.COMPRESSION_FLOOR) : 0.85;
    if (ratio < floorR) {
      result.compressed = true;
      logger.warn('humanize.over_compressed', { mode, ratio: result.compressionRatio, srcN, outN });
      if (process.env.COMPRESSION_FALLBACK === '1') {
        result.outputTextPreCompFallback = result.outputText;
        result.outputText = require('../engine/spacing').fixSpacing(cleanText(text)).text;
        result.compressionFallback = true;
      }
    }
  }

  // ★ 사실 재인용 제거(genretransfer 이식, ai-study 실측): 같은 evidence 수치가 여러 문단에서 재인용되면
  //   첫 인용 문장만 유지("같은 연구를 두 번 처음처럼 인용"은 품질 결함 + 기계적 균일성 신호).
  //   청크 병렬 생성이라 usedNums 전달이 불가하므로 문서 레벨 마감으로만 잡는다. lostFacts 비악화 가드 내장. FACT_DEDUP=0 해제.
  if (evid && process.env.FACT_DEDUP !== '0') {
    const beforeFD = result.outputText;
    result.outputText = evg.dedupeFactRecitations(result.outputText, evidLines, textF);
    result.factRecitationDedup = { changed: result.outputText !== beforeFD };
  }

  // ★ 결정론 문장 중복 제거(최종): 휴머나이저가 도입부 등을 중복 생성하는 경우가 있고(변동성),
  //   이는 baseline에도 남아 게이트 revert 후에도 생존 → 게이트 이후 최종 단계에서 제거.
  //   중복 문장은 새 정보 0 → 후속 등장만 삭제(무손실). 카피킬러 "동일 내용 과도한 반복" + FLOOR repetition 직격. DEDUP=0 해제.
  if (process.env.DEDUP !== '0') {
    const dr = require('../engine/dedupe').dedupeSentences(result.outputText);
    if (dr.removed > 0) result.outputText = dr.text;
    result.dedupe = { removed: dr.removed };
  }

  // ★ GPTZero 전용 2차 우회 패스(§우회): 병합 결과에 적용 → FLOOR 재검사 → 깨지면 폐기.
  if (antiDetect) {
    result.antiDetect = await applyAntiDetect({
      result, rawText: textF, povSeed, optIn, mode, lang, speakerType: contract.speakerType, signal, floor, allowedExtra: notes
    });
  }

  // ★ Phase 0 띄어쓰기 품질 게이트(결정론, 최종) — 공백만 조정, 사실·FLOOR 불변.
  if (process.env.SPACING !== '0') {
    const sp = require('../engine/spacing').fixSpacing(result.outputText);
    result.outputText = sp.text;
    result.spacing = { fixes: sp.fixes, warnings: sp.warnings };
  }
  // ★ 문단 정리(2026-06-12): 문단 내부 단일 줄바꿈→공백(문단 구분 \n\n 보존) — UI "애매한 두 행" 방지.
  result.outputText = require('../engine/genretransfer').tidyParagraphs(result.outputText);

  // ★ Phase2 register 교정(격식 모드 화자 거리감): 비인칭 단정문 → 기존 사실만으로 필자 판단문 구조 변형. REGISTER=1만 실행(실험).
  //   노이즈 제거 위해 pre-repair 텍스트(outputTextPreRegister) 보존 → 같은 생성문에 켜고/끈 clean A/B로 카피킬러 검증.
  if ((mode === 'assignment' || mode === 'thesis') && process.env.REGISTER === '1') {
    try {
      let ledger = contract.softClaimLedger;
      if (!ledger) ledger = await require('../engine/judge').buildSoftClaimLedger(text, { lang, signal });
      result.outputTextPreRegister = result.outputText;
      const rr = await require('../engine/registerrepair').registerRepairPass(result.outputText, text, { lang, signal, floor, ledger, mode, allowedExtra: notes });
      result.outputText = rr.text;
      result.registerRepair = { repaired: rr.repaired, attempted: rr.attempted, before: rr.before, after: rr.after };
    } catch (e) { if (signal?.aborted) throw e; result.registerRepair = { error: e.message }; }
  }

  // ★ B7 학부생 보고서형 마감(ASSIGNMENT_B7): 생성·패스가 흐트러뜨린 합니다체를 강제 통일 + 1인칭 anchor 예산 캡. FLOOR strict.
  if ((mode === 'assignment' || mode === 'thesis') && process.env.ASSIGNMENT_B7 === '1') {
    try {
      const rs2 = require('../engine/registerscore');
      const bp = await require('../engine/b7polish').b7PolishPass(result.outputText, text, { lang, signal, floor, allowedExtra: notes });
      result.outputText = bp.text;
      result.b7 = { repaired: bp.repaired, attempted: bp.attempted, score: rs2.measureB7Formal(bp.text) };
    } catch (e) { if (signal?.aborted) throw e; result.b7 = { error: e.message }; }
  }

  // ★ 수치-출처 짝 문서 마감 수리(genretransfer 이식, v5 원칙①②): 짝 위반은 novelty와 달리 "수리 가능한
  //   위반" — 폐기가 아니라 수치는 보존한 채 소속 출처 표지를 복원하는 교정 1라운드. 수리 후에도 남으면
  //   floorReport critical(evidence_pairing)로 차단(조용한 재조합 날조 노출 방지).
  if (evid) {
    const basePairs = evg.checkEvidencePairing(textF, evidLines).length;   // 원문 자체에 떠도는 수치는 베이스로 허용
    let pairing = evg.checkEvidencePairing(result.outputText, evidLines);
    if (pairing.length > basePairs) {
      try {
        const vText = pairing.map((p, k) => lang === 'en'
          ? `${k + 1}. Number ${p.num} — sentence: "${p.sent}" / owning fact: ${p.owner}`
          : `${k + 1}. 수치 ${p.num} — 문장: "${p.sent}" / 소속 사실: ${p.owner}`).join('\n');
        const sys = lang === 'en'
          ? 'Editor. Fix only the specified sentences in the body. Keep each number exactly, but restore the source attribution for that number (institution/survey/study name) in the same sentence or the immediately previous sentence. Do not combine it with another institution or study. Do not add new facts. Do not change any other text. Output the full revised body text only, with no explanation or code fences.'
          : '편집자. 본문에서 지정된 문장들만 고친다: 각 문장의 수치는 빼지 말고 그대로 두되, 그 수치가 속한 출처(기관·조사명)를 같은 문장이나 직전 문장에 자연스럽게 명시해 수치-출처 연결을 복원하라. 다른 기관·조사와 결합하거나 새 사실을 추가하지 마라. 나머지 텍스트는 한 글자도 바꾸지 마라. 수정된 본문 전체만 출력(설명·코드펜스 금지).';
        const usr = lang === 'en'
          ? `[NUMBER-SOURCE SEPARATION — fix only these sentences]\n${vText}\n\n[OWNING FACTS FOR EACH NUMBER]\n${evid}\n\n[BODY]\n${result.outputText}`
          : `[수치-출처 분리 — 이 문장들만 수정]\n${vText}\n\n[각 수치의 소속 사실(승인 원장)]\n${evid}\n\n[본문]\n${result.outputText}`;
        const fixed = await require('../engine/judge').llmText({ system: sys, user: usr, signal, maxTokens: 16384 });
        if (fixed && fixed.replace(/\s+/g, '').length >= result.outputText.replace(/\s+/g, '').length * 0.85) {
          const preV = floor.collectFloorViolations({ result: { outputText: result.outputText }, rawText: textF, povSeed, optIn, mode, allowedExtra: notes, anchors: anchorActive });
          const postV = floor.collectFloorViolations({ result: { outputText: fixed }, rawText: textF, povSeed, optIn, mode, allowedExtra: notes, anchors: anchorActive });
          if (postV.length <= preV.length && evg.checkEvidencePairing(fixed, evidLines).length < pairing.length) result.outputText = fixed;
        }
      } catch (e) { if (signal?.aborted) throw e; }
      pairing = evg.checkEvidencePairing(result.outputText, evidLines);
      // ★ 결정론 최후 수단(이식, 2026-06-12 실사고): 잔여 위반은 수치 옆 출처 표지 괄호 삽입으로 해소(무날조).
      if (pairing.length > basePairs) {
        result.outputText = evg.injectOwnerMarkers(result.outputText, pairing, evidLines);
        pairing = evg.checkEvidencePairing(result.outputText, evidLines);
      }
    }
    result.evidencePairing = { violations: Math.max(0, pairing.length - basePairs), base: basePairs, items: pairing.slice(0, 5) };
  }

  // ★ 말투 일관성 결정론 정규화(2026-06-16 실사고: 존댓말 성찰문이 패스들의 한다체 펀치 주입으로 말투가 혼입되고
  //   "저"가 "나"로 추락). 격식·보존형(assignment/thesis)은 원문 말투를 따라야 하므로, 출력의 종결어미·1인칭을 원문
  //   dominant 말투로 통일한다(무날조·무LLM — 종결어미·대명사만 결정론 치환). blog는 해요체 목표라 제외(프롬프트로 처리).
  if (mode === 'assignment' || mode === 'thesis') {
    try {
      // ★ P0-1(2026-06-18 감사): ASSIGNMENT_B7은 학부생 보고서형 '합쇼체(hap)'가 목표다. 원문이 평어체(handa)여도
      //   origReg로 정규화하면 앞단 b7PolishPass가 만든 합쇼체를 도로 평어체로 되돌려(앞·뒤 패스 상쇄) 말투가 흔들린다.
      //   → B7이면 target을 'hap'으로 고정(원문 dominant 무시), 아니면 기존대로 원문 dominant 말투 보존.
      const b7 = process.env.ASSIGNMENT_B7 === '1';
      const targetReg = b7 ? 'hap' : require('../engine/surfaceguard').measureRegisterMix(text).dominant;   // 'hap'|'handa'|'haeyo'
      if (targetReg === 'hap' || targetReg === 'handa' || targetReg === 'haeyo') {
        const rn = require('../engine/registernormalize').normalizeRegister(result.outputText, targetReg);
        if (rn.changed) result.outputText = rn.text;
        result.registerNormalize = { target: targetReg, changed: rn.changed, b7: b7 || undefined };
      }
    } catch (e) { result.registerNormalize = { error: e.message }; }
  } else if (mode === 'blog' && basicReportStyle && process.env.BASIC_REPORT_REGISTER_NORM !== '0') {
    try {
      const rn = require('../engine/registernormalize').normalizeRegister(result.outputText, 'hap');
      if (rn.changed) result.outputText = rn.text;
      result.registerNormalize = { target: 'hap', changed: rn.changed, basis: 'basic_report' };
    } catch (e) { result.registerNormalize = { error: e.message }; }
  } else if (mode === 'blog' && basicBlogStyle && process.env.BASIC_BLOG_REGISTER_NORM !== '0') {
    try {
      const targetReg = contract.register === 'polite' ? 'hap' : 'haeyo';
      const rn = require('../engine/registernormalize').normalizeRegister(result.outputText, targetReg);
      if (rn.changed) result.outputText = rn.text;
      result.registerNormalize = { target: targetReg, changed: rn.changed, basis: 'basic_blog', sourceRegister: contract.register };
    } catch (e) { result.registerNormalize = { error: e.message }; }
  } else if (mode === 'blog' && process.env.BLOG_REGISTER_NORM !== '0') {
    // ★ blog 말투 일관화(2026-06-17 실측: 청크별 재작성이 앞=해요체·뒤=한다체로 갈려 중간에 어투가 바뀜).
    //   blog는 캐주얼 해요체가 *목표*이므로, dominant 무관하게 출력의 한다체·합쇼체 잔류를 항상 해요체로 통일한다
    //   (종결어미만·무날조·무LLM). 과거형 ㅆ다→ㅆ어요 일괄 규칙으로 학술 과거형 잔류까지 정리. 끄려면 BLOG_REGISTER_NORM=0.
    //   ★버그픽스(2026-06-19 실측 #3 라틴어보고서): 기존 'haeyo 우세일 때만(outReg==="haeyo")' 가드가, 출력이 한다체/
    //   합쇼체로 드리프트한 글(#3: dominant=hap, off 48%)을 통째로 건너뛰어 해요+합쇼+한다 3중 혼합을 방치했다. blog는
    //   무조건 해요 목표라 가드 제거 → 항상 normalizeRegister(haeyo). 실측: #17 off 0.47→0(완벽), #3 0.48→0.18. 이미 순해요면 changed=0(무해).
    try {
      const rn = require('../engine/registernormalize').normalizeRegister(result.outputText, 'haeyo');
      if (rn.changed) {
        result.outputText = rn.text;
        result.registerNormalize = { target: 'haeyo', changed: rn.changed, basis: 'blog' };
      }
    } catch (e) { result.registerNormalize = { error: e.message }; }
  }

  // ★ 기본 피하기 문단 정리: 내용은 그대로 두고, 1문장짜리 문단이 과하게 끊기는 결과만 자연스럽게 묶는다.
  if ((basicReportStyle || basicBlogStyle) && process.env.BASIC_HUMANIZE_FLOW_COHESION !== '0') {
    try {
      const fc = require('../engine/flowcohesion').flowCohesion(result.outputText);
      if (fc.text && fc.text !== result.outputText) result.outputText = fc.text;
      result.flowCohesion = { merged: fc.merged, beforeParas: fc.beforeParas, afterParas: fc.afterParas };
    } catch (e) { result.flowCohesion = { error: e.message }; }
  }

  // ★ 절단 마감 안전망(2026-06-22): 청크 복구가 못 잡은 잔여 절단(judge repair 등 문서 단계)도 끊긴 조각만
  //   결정론 트림해 완결 보장(청크 raw 폴백이 1차 방어, 이건 2차). TRUNC_GUARD=0 해제.
  if (process.env.TRUNC_GUARD !== '0' && floor.endsTruncated(result.outputText) && !floor.endsTruncated(text)) {
    const trimmed = floor.trimToLastComplete(result.outputText);
    if (trimmed !== result.outputText) { logger.info('humanize.truncation_trimmed', { mode, before: result.outputText.length, after: trimmed.length }); result.outputText = trimmed; }
  }
  // 최종 출력 기준 가드 재측정(judge repair·anti-detect 반영).
  const finalOut = result.outputText;
  result.povDrift = floor.measurePovDrift(text, finalOut, povSeed);
  result.floorNovelty = floor.measureNovelty(text, finalOut, notes);
  result.floorLength = floor.measureLength(textF, finalOut, mode);
  result.repetition = floor.measureRepetition(finalOut);
  result.lostFacts = floor.measureLostFacts(textF, finalOut);
  const floorViolations = floor.collectFloorViolations({ result, rawText: textF, povSeed, optIn, mode, allowedExtra: notes, anchors: anchorActive });
  result.floorReport = floor.buildFloorReport({ result, rawText: textF, mode, povSeed, optIn, allowedExtra: notes, anchors: anchorActive });
  // ★ 무변환 가드(2026-06-19 실측 #122 '그대로 다듬기'가 원문과 100% 동일 출력): 최종 출력이 원문과 동일하면
  //   휴머나이징이 일어나지 않은 것 → 조용히 과금/노출하지 않고 차단(무차감). NOOP_GUARD=0으로 해제.
  //   ★보존(다듬기, tonePolish)은 띄어쓰기 교정도 가치 있는 변환이므로 '완전 동일(공백 포함)'만 무변환으로 본다
  //   (공백만 고친 정상 다듬기를 오차단하지 않음). 회피·재작성 모드는 '내용(공백 무시) 동일'이면 무변환.
  if (process.env.NOOP_GUARD !== '0') {
    const noopBare = s => (s || '').replace(/\s+/g, '').trim();
    const isNoOp = tonePolish
      ? (finalOut.trim().length > 0 && finalOut.trim() === (text || '').trim())
      : (noopBare(finalOut).length > 0 && noopBare(finalOut) === noopBare(text));
    if (isNoOp) {
      result.floorReport.criticals.push({ gate: 'noop_unchanged', detail: '출력이 원문과 동일(휴머나이징 미적용)' });
      result.floorReport.status = 'blocked';
      logger.warn('humanize.noop_unchanged', { mode, tonePolish: !!tonePolish, len: noopBare(text).length, fallbackCount });
    }
  }
  // 짝 위반 잔존 = 재조합 날조 위험 → 노출 차단(critical).
  if (result.evidencePairing && result.evidencePairing.violations > 0) {
    result.floorReport.criticals.push({ gate: 'evidence_pairing', detail: result.evidencePairing.items.map(p => `${p.num}↛${(p.owner || '').slice(0, 30)}`).join(' | ') });
    result.floorReport.status = 'blocked';
  }
  const sguard = require('../engine/surfaceguard');
  result.surface = sguard.buildSurfaceReport(finalOut);
  result.inputRisk = _ir;   // ★ 2689행 _ir 재사용(동일 text — 요청당 classifyInputRisk 1회 절감). text 불변 보장.
  result.contract = contract;

  // ── ai%-정렬 모델 shadow(2026-06-19, CK_SHADOW=1): 로그only·무LLM·무행동변경. 생성 루프가 카피킬러 정렬
  //   신호를 처음으로 '보는' 채널. 입력/baseline/최종의 모델 risk를 남겨 온라인 검증·데이터 누적(실 rerank 승격 전 단계).
  //   현 모델 group-CV AUC 0.737이라 rerank용·관찰용이지 차단용 아님. 기본 OFF(opt-in).
  if (process.env.CK_SHADOW === '1') {
    try {
      const ckp = require('../engine/copykiller-proxy');
      if (ckp.airateAvailable()) {
        const r3 = x => (x == null ? null : Math.round(x * 1000) / 1000);
        const ri = ckp.predictAiRate(text);
        const rb = ckp.predictAiRate(baselineText);
        const rf = ckp.predictAiRate(finalOut);
        // ★ 입력 AI% 게이트 shadow(①, 행동변경 0): risk-router가 이 입력을 보존(minimal_cleanup)으로
        //   보냈을지를 함께 기록한다. worsened(역효과)와 교차하면 "게이트가 역효과 케이스를 잡는가 +
        //   임계(0.30)가 맞는가"를 라이브 트래픽으로 검증할 수 있다(라이브 플립 전 데이터 누적).
        let gateMode = null;
        try { gateMode = require('../engine/copykiller/risk-router').decideMode({ proxyRisk: ri }).mode; } catch {}
        const worsened = ri < 0.5 && rf > ri + 0.1;   // 모델이 보기에 사람글을 AI쪽으로 악화시켰나(0→100 류 조기경보)
        result.ckShadow = { inputRisk: r3(ri), baselineRisk: r3(rb), finalRisk: r3(rf), deltaVsInput: r3(rf - ri), deltaVsBaseline: r3(rf - rb), gateMode, worsened };
        logger.info('humanize.ck_shadow', {
          mode, tonePolish: !!tonePolish, inLen: (text || '').length, outLen: finalOut.length,
          inputRisk: r3(ri), baselineRisk: r3(rb), finalRisk: r3(rf),
          deltaVsInput: r3(rf - ri), deltaVsBaseline: r3(rf - rb),
          worsened,
          gateMode,                                   // 'minimal_cleanup' = 게이트라면 보존(재작성 안 함)
          gateWouldPreserve: gateMode === 'minimal_cleanup'
        });
      }
    } catch (e) { logger.warn('humanize.ck_shadow_failed', { err: e && e.message }); }
  }

  return {
    result, surface: result.surface, inputRisk: result.inputRisk,
    mode, lang, chunked: true, chunkCount: chunks.length, contract,
    status: result.floorReport.status, floorReport: result.floorReport,
    chunks: chunks.map(c => ({ index: c.index, position: c.position, inLen: c.text.length, outLen: (c.outputText || '').length, fellBack: !!c.fellBack, fallbackReason: c.fallbackReason || null })),
    fallbackCount,
    povDrift: result.povDrift, floorNovelty: result.floorNovelty, floorLength: result.floorLength,
    repetition: result.repetition, softDrift: result.softDrift, judge: result.judge,
    antiDetect: result.antiDetect, grounding: result.grounding,
    floorViolations, povSeed, optIn, floorV2: true
  };
}

// --- 라우트 ---

// ── 서버측 이용 기록 저장(2026-06-14) ────────────────────────────────────────
//   배경: 결과 저장이 그동안 브라우저 책임(클라가 users/{uid}/history에 addDoc)이라,
//   응답은 받았지만 저장에 실패하면(JS오류·즉시 이탈·쓰기 실패) "차감만 남고 결과 0건" 민원 발생.
//   해결: 단일 호출은 서버가 같은 컬렉션·스키마로 직접 저장(Admin SDK) → "차감↔저장" 원자화.
//   클라 saveHistory와 동일 스키마라 이용 기록 화면이 그대로 렌더한다.
//   requestId를 문서 ID로 사용해 재시도·중복 호출에도 1건만 남게(멱등).
async function saveAnalyzeHistory({ uid, requestId, opType, text, needed, result, mode }) {
  if (!db) return;
  const isDetect = opType === 'detect';
  const doc = {
    type: isDetect ? 'detect' : 'humanize',
    mode: mode || null,   // ★ P1(2026-06-18 실데이터: history mode 전부 None): blog/formal/polish 기록(분석·CS·환불대응)
    inputText: text || '',
    credits: typeof needed === 'number' ? needed : 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    savedBy: 'server'
  };
  if (isDetect) {
    doc.probability = (result && typeof result.probability === 'number') ? result.probability : null;
    if (result && typeof result.rawProbability === 'number') doc.rawProbability = result.rawProbability;
    if (result && result.probabilityCalibration) doc.probabilityCalibration = result.probabilityCalibration;
    doc.summary = (result && result.summary) || '';
    doc.detail = (result && result.detail) || '';
  } else {
    doc.outputText = (result && result.outputText) || '';
    doc.humanSummary = (result && result.summary) || '';
    doc.humanDetail = (result && result.detail) || '';
  }
  const col = db.collection('users').doc(uid).collection('history');
  if (requestId) await col.doc(requestId).set(doc, { merge: true });
  else await col.add(doc);
}

router.post('/analyze', async (req, res) => {
  // ★ client disconnect 추적: 응답 보내기 전에 connection 끊기면 백엔드 작업 중단.
  //   "휴머나이징 오류 + 크레딧만 차감" 민원의 주범 — 사용자가 응답 대기 중 abort하면
  //   백엔드는 모르고 진행, 차감 commit 성공 후 res.json 실패해서 결과 손실.
  const ac = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      ac.abort();
      logger.warn('analyze.client_disconnected');
    }
  });

  const { mode } = req.body;
  let { text } = req.body;
  const idToken = bearerToken(req);   // 헤더 우선(body.idToken 폴백)
  const lang = req.body.lang || 'ko';
  const billingMode = req.body.billingMode === 'coupon' ? 'coupon' : 'credit';
  // ★ 멱등 키: 프런트가 작업(청크 포함)마다 고정 발급. 재시도해도 같은 값 → 중복 차감 방지. 안전 가드 ≤80자.
  const requestId = (typeof req.body.requestId === 'string' && req.body.requestId.trim())
    ? req.body.requestId.trim().slice(0, 80).replace(/[^A-Za-z0-9:_-]/g, '')
    : null;
  // 프런트 분할 호출 시 전달되는 직전 청크 말미 (문체 참고용, ≤300자 안전 가드)
  const prevContext = typeof req.body.prevContext === 'string' && req.body.prevContext.trim()
    ? req.body.prevContext.trim().slice(-300)
    : '';
  if (!text || text.length < 5) return res.status(400).json({ error: '텍스트가 너무 짧습니다.' });
  // ★ 글자분리(PDF 추출 깨짐) 복원(2026-06-19 실측 #57·#58: 모든 글자가 공백 분리된 입력 → 과금 2배·URL 손상·품질 저하):
  //   billing·길이검사·엔진 처리 '전에' 재결합해 공정 과금·URL 보존. 정상 글(단일글자 비율 낮음)은 무동작. INPUT_REJOIN=0으로 해제.
  if (process.env.INPUT_REJOIN !== '0' && typeof text === 'string') {
    try {
      const rj = require('../engine/inputrouting').rejoinSplitChars(text);
      if (rj.changed) {
        logger.info('analyze.input_rejoined', { uid: undefined, ratio: rj.ratio, before: text.length, after: rj.text.length });
        text = rj.text;
      }
    } catch (e) { logger.warn('analyze.input_rejoin_failed', { err: e && e.message }); }
  }
  // ★ AI URL 지문 제거(2026-06-20 #68): 입력의 utm_source=chatgpt.com 류를 '엔진 처리 전'에 제거 →
  //   참고문헌 동결(verbatim 보존)로 출력 후처리를 우회하는 경로에서도 지문이 안 남는다. STRIP_AI_URL=0으로 해제.
  if (process.env.STRIP_AI_URL !== '0' && typeof text === 'string') {
    try {
      const ai = require('../engine/spacing').stripAiUrlParams(text);
      if (ai.removed) { logger.info('analyze.input_ai_url_stripped', { removed: ai.removed }); text = ai.text; }
    } catch (e) { logger.warn('analyze.input_ai_url_strip_failed', { err: e && e.message }); }
  }
  // 글자 수 상한: 크레딧 모드 30,000자(입력칸 표기와 일치), 쿠폰 모드 50,000자(무제한 티어용 안전 캡)
  const HARD_MAX = billingMode === 'coupon' ? 50000 : 30000;
  if (text.length > HARD_MAX) {
    return res.status(400).json({ error: `텍스트가 너무 깁니다. (최대 ${HARD_MAX.toLocaleString()}자)` });
  }

  const opType = mode === 'detect' ? 'detect' : 'humanize';
  // ★ 과금 정책: detect는 100자당 1크레딧 유지.
  //   humanize 계열은 신규 가입 10크레딧 체험권과 맞춰 최소 10크레딧, 이후 100자당 2크레딧.
  //   재구성(genretransfer)은 별도 라우트(transform.js)에서 길이 구간 정액.
  const creditPer100 = opType === 'humanize' ? 2 : 1;
  const rawNeeded = Math.ceil(text.length / 100) * creditPer100;
  const needed = opType === 'humanize' ? Math.max(10, rawNeeded) : rawNeeded;
  // ★ history·creditHistory에 기록할 모드 라벨(표시·분석용). 구버전 클라이언트가 빈값·원시값을 보내도
  //   엔진 파라미터로 표시 라벨을 채운다. 정규화가 일어나면 구버전 클라이언트 식별용으로 로깅.
  const historyMode = opType === 'detect' ? 'detect' : normalizeHumanizeModeLabel(mode, req.body);
  if (opType === 'humanize' && historyMode !== mode) {
    logger.info('analyze.mode_label_normalized', {
      rawMode: mode === undefined ? null : mode,
      normalized: historyMode,
      engine: req.body.engine || 'legacy',
      humanizeMode: req.body.humanizeMode || null
    });
  }

  logger.info('analyze.started', {
    opType,
    mode,
    engine: req.body.engine || 'legacy',
    humanizeMode: req.body.humanizeMode,
    billingMode,
    requestId,
    textLength: text.length,
    needed,
    creditPer100
  });

  // ★ 로컬 개발 전용 인증·과금 생략(이중 게이트): Firebase 비활성(키 미설정) + DEV_NO_AUTH=1 둘 다 필요.
  //   프로덕션은 FIREBASE_SERVICE_ACCOUNT가 항상 설정돼 있어 이 분기를 절대 타지 않는다.
  const devNoAuth = !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1';

  // 1) precheck — 토큰/잔량/구독 검증 (Firestore 읽기만, 차감 없음)
  let pre;
  try {
    pre = devNoAuth
      ? { uid: 'dev-local', plan: 'unlimited' }
      : billingMode === 'coupon'
        ? await precheckCoupon(idToken, text.length)
        : await precheckCredits(idToken, needed);
  } catch (e) {
    logger.warn('analyze.precheck_failed', { opType, billingMode, needed, requestId, err: e });
    return res.status(e.status || 500).json({
      error: authErrorMessage(e.message),
      ...(e.charLimit !== undefined ? { charLimit: e.charLimit } : {})
    });
  }
  setLogContext({ uid: pre.uid });

  // ★ 중복 제출 디바운스(2026-06-19): requestId 멱등이 없는 구버전 클라이언트의 1초 간격 이중 제출(실측 #57·#58)을
  //   막는다. LLM 호출 '전'에 기록해야 in-flight(수초)인 두 번째 요청을 잡는다. 무차감 거절.
  let dedupKey = null;
  if (SUBMIT_DEDUP_WINDOW_MS > 0 && !devNoAuth) {
    dedupKey = submitDedupKey(pre.uid, opType, text);
    if (recentDuplicateSubmit(dedupKey)) {
      logger.warn('analyze.duplicate_submit_blocked', { uid: pre.uid, requestId, opType, windowMs: SUBMIT_DEDUP_WINDOW_MS });
      return res.status(429).json({ error: '같은 내용을 방금 처리 중이거나 처리했어요. 잠시 후 다시 시도해 주세요. (중복 차감 방지)', duplicate: true });
    }
    recentSubmits.set(dedupKey, Date.now());
  }
  // 처리 실패·중단처럼 과금이 일어나지 않은 경우엔 디바운스 흔적을 지워 즉시 재시도를 허용한다(차단 자체가 의도인 422는 유지).
  const clearDedup = () => { if (dedupKey) recentSubmits.delete(dedupKey); };

  // 2) LLM 호출 + 결과 검증 (실패 시 차감 없음)
  let result;
  let usage;
  let refineUsage = null;
  let evasion = null;   // 회피 모드(floorV2) 부가 응답 — 신뢰 배지용 floorReport 등
  try {
    if (mode === 'detect') {
      const detectUserContent = prevContext
        ? `[앞 청크의 마지막 일부 — 문맥 참고용, 이 부분은 점수에 포함하지 말 것]\n${prevContext}\n\n[분석할 글]\n${text}`
        : `[분석할 글]\n${text}`;
      const detectSystem = getDetectSystem(lang);
      const detectTool = getDetectTool(lang);
      const data = await callClaude({
        userText: detectUserContent,
        systemText: detectSystem,
        tool: detectTool,
        maxOutputTokens: 4096,
        signal: ac.signal,
        task: 'analyze',
        phase: 'detect:main',
        mode: 'detect'
      });
      result = extractClaudeResult(data, detectTool.name);
      if (typeof result.probability !== 'number' || !result.summary || !result.detail) {
        throw new Error('detect_incomplete');
      }
      const calibration = await detectCalibration.applyHistoryCalibration({
        db,
        uid: pre.uid,
        text,
        probability: result.probability,
        logger,
        route: 'analyze'
      });
      if (calibration.applied) {
        result.rawProbability = calibration.rawProbability;
        result.probability = calibration.probability;
        result.probabilityCalibration = calibration.meta;
      }
      usage = data.usage;
    } else if (req.body.engine === 'floorV2') {
      // ★ 회피 모드(P2, §회피모드 제품화): floorV2 청크 엔진 — 서버측 청킹+FLOOR 게이트+신뢰 리포트.
      //   프런트가 engine:'floorV2'를 명시한 호출만 이 분기를 탄다(기존 호출 동작 100% 불변).
      //   blog 어투 회피가 1차 대상(32~41% 실측 밴드). judge는 위험신호 트리거 기반, grounding은
      //   모드·등급별 내부 로직(blog C등급 skip)을 그대로 따른다.
      const selectedMode = req.body.humanizeMode || 'blog';
      const userNotes = typeof req.body.userNotes === 'string' ? req.body.userNotes.slice(0, 2000) : '';
      const out = await runHumanizeChunked({
        text, mode: selectedMode, lang, signal: ac.signal,
        floorV2: true, optIn: false, judge: true, grounding: true, userNotes
      });
      // FLOOR 차단 = 날조·소실을 조용히 내보내지 않는다(노출 게이트 원칙). 차감 없이 종료.
      if (out.floorReport && out.floorReport.status === 'blocked') {
        const gates = (out.floorReport.criticals || []).map(c => c.gate).join(', ');
        logger.warn('analyze.floor_blocked', { uid: pre.uid, requestId, billingMode, gates });
        const blockedHint = gates.includes('lostFacts')
          ? '원문의 핵심 사실이나 수치가 빠져 차단했어요. 글을 짧게 나누거나 사실·수치가 많은 문단은 원문 표현을 더 유지해 주세요.'
          : gates.includes('novelty') || gates.includes('judge')
            ? '원문에 없던 내용이 섞여 차단했어요. 경험 메모나 추가 지시를 줄이고, 바로 결과가 필요하면 그대로 다듬기를 사용해 주세요.'
            : '원문 보존 기준을 통과하지 못해 차단했어요. 같은 글을 반복하기보다 글을 짧게 나누거나 그대로 다듬기를 사용해 주세요.';
        return res.status(422).json({
          error: `${blockedHint} 크레딧은 차감되지 않았어요.`,
          floorStatus: 'blocked',
          gates
        });
      }
      result = { outputText: out.result.outputText };
      evasion = {
        floorReport: {
          status: out.floorReport.status,
          criticals: out.floorReport.criticals,
          warnings: (out.floorReport.warnings || []).map(w => w.gate),
          metrics: out.floorReport.metrics
        },
        chunkCount: out.chunkCount,
        fallbackCount: out.fallbackCount
      };
      if (!result.outputText) throw new Error('humanize_incomplete');
    } else {
      // ★ 휴머나이저: Claude Sonnet tool_use(강제)로 호출.
      const selectedMode = req.body.humanizeMode || 'assignment';

      // ★ 사전 처리: assignment 모드에서만 결정론 룰을 입력 텍스트에 미리 적용.
      //    모델은 의미 의존 룰(P1 신규 사실 금지·룰 1·2·4 추상→구체·5 어휘 하향·6·7)에 집중.
      //    실패해도 원본으로 진행 — 사용자 결과 손실 방지.
      let humanizeText = text;
      if (selectedMode === 'assignment') {
        try {
          const pp = await preprocessInput(text, lang, ac.signal);
          humanizeText = pp.text;
          logger.debug('analyze.preprocess_completed', {
            gptismCount: pp.gptismCount,
            commaSplitCount: pp.commaSplitCount,
            declarativeCount: pp.declarativeCount
          });
        } catch (e) {
          if (ac.signal.aborted) throw e;
          logger.warn('analyze.preprocess_failed_fallback_original', { err: e });
        }
      }

      // ★ 학술 동결 블록 분리(2026-06-19 실측 #18: 6696자 보고서의 [참고자료]·학번·출처가 통째로 누락 — 레거시
      //   동기 경로는 전문을 LLM에 보내 참고문헌을 산문으로 흡수·삭제했다). 참고문헌·목차는 윤문 대상이 아니라
      //   데이터라 떼어 verbatim 보존하고 본문만 변환 후 재조립한다(transform 청크 경로와 동일 정책). assignment 전용.
      //   FREEZE_BLOCKS=0으로 해제. 본문 <200자면 splitAcademicBlocks가 동결 취소(통째 처리).
      let frozen = null;
      if (selectedMode === 'assignment' && process.env.FREEZE_BLOCKS !== '0') {
        try {
          const fb = require('../engine/freezeblocks').splitAcademicBlocks(humanizeText);
          if (fb.hasFrozen) {
            frozen = fb;
            humanizeText = fb.body;   // 본문만 LLM으로 — 참고문헌·목차는 보존
            logger.info('analyze.academic_freeze', { uid: pre.uid, requestId, hasToc: !!fb.toc, refsLen: fb.refs.length });
          }
        } catch (e) { logger.warn('analyze.academic_freeze_failed', { err: e && e.message }); }
      }

      // ★ 웹 검색: 기본 OFF (사용자 실측 진단 결과).
      //    이전 기본 ON 동작이 카피킬러 96% 감지의 진범이었음 — fetchWebSearchExamples가 외부 통계·연도·기관명을
      //    user message에 박고 "녹여 활용" 지시 → 모델이 단정 사실 + 통계 누적 → LLM overconfidence 시그너처 직격.
      //    프런트에서 useWebSearch=true 명시한 호출만 ON.
      const useWebSearch = req.body.useWebSearch === true;
      let examples = null;
      if (useWebSearch) {
        try {
          examples = await fetchWebSearchExamples(humanizeText, lang, ac.signal);
        } catch (e) {
          if (ac.signal.aborted) throw e;
          logger.warn('analyze.web_search_failed_fallback', { err: e });
        }
      }

      const humanizeSystem = getHumanizeSystem(selectedMode, lang);
      const humanizeTool = getHumanizeToolFor(selectedMode, lang);
      const prevContextBlock = prevContext
        ? (lang === 'en'
          ? `[PREVIOUS CHUNK TAIL — style-continuity reference only, do not rewrite]\n${prevContext}\n\n`
          : `[앞 청크의 마지막 일부 — 문체 연속성 참고용, 다시 변환하지 말 것]\n${prevContext}\n\n`)
        : '';
      const userContent = lang === 'en'
        ? (examples
          ? `${prevContextBlock}[TEXT TO REWRITE]\n${humanizeText}\n\n[REFERENCE EXAMPLES / STATISTICS — weave in naturally]\n${examples}`
          : `${prevContextBlock}[TEXT TO REWRITE]\n${humanizeText}`)
        : (examples
          ? `${prevContextBlock}[재작성할 텍스트]\n${humanizeText}\n\n[참고할 실제 사례/통계 (자연스럽게 녹여 활용)]\n${examples}`
          : `${prevContextBlock}[재작성할 텍스트]\n${humanizeText}`);
      const inputParaCount = humanizeText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).length;
      const inputCharLen = humanizeText.replace(/\s+/g, '').length;

      // 1차 LLM 호출
      let data;
      try {
        data = await callClaude({
          userText: userContent,
          systemText: humanizeSystem,
          tool: humanizeTool,
          temperature: 0.5,
          maxOutputTokens: 16384,
          signal: ac.signal,
          task: 'analyze',
          phase: 'humanize:first',
          mode: selectedMode,
          cacheZeroWarn: true
        });
      } catch (e) {
        if (ac.signal.aborted) throw e;
        logger.error('analyze.first_llm_failed', { err: e });
        throw e;
      }
      result = extractClaudeResult(data, humanizeTool.name);
      // Pass C: cleanText + 결정론적 mechanical 후처리 (특수문자, GPT-ism, 3+ 나열).
      // verifyCheckFields가 후처리된 텍스트를 보게 해서 2-pass가 mechanical 위반으론 발동하지 않게 함.
      await applyPassC(result, lang, ac.signal, { rawText: humanizeText, mode: selectedMode });
      verifyCheckFields(result, selectedMode, inputParaCount, inputCharLen, humanizeText);
      usage = data.usage;

      // ★ 2-pass 폴백: critical 위반 1건 또는 minor 5건+일 때만 재호출 (비용 절약).
      //   ★ try/catch로 격리 — refine 실패 시 1차 결과 그대로 반환 (사용자 결과 손실 방지).
      const refineDecision = shouldRefine(result, selectedMode, inputParaCount);
      if (refineDecision.refine) {
        try {
          const failed = collectFailedFields(result, selectedMode, inputParaCount);
          logger.warn('analyze.refine_started', { reason: refineDecision.reason, failed });
          const refineUser = buildRefineUser(humanizeText, result.outputText, failed, lang);
          const refineData = await callClaude({
            userText: refineUser,
            systemText: humanizeSystem,
            tool: humanizeTool,
            temperature: 0.5,
            maxOutputTokens: 16384,
            signal: ac.signal,
            task: 'analyze',
            phase: 'humanize:legacy_refine',
            mode: selectedMode,
            cacheZeroWarn: true
          });
          const refined = extractClaudeResult(refineData, humanizeTool.name);
          // 1차 result는 폴백용으로 보관 → refined가 정상이면 교체
          result = refined;
          await applyPassC(result, lang, ac.signal, { rawText: humanizeText, mode: selectedMode });
          verifyCheckFields(result, selectedMode, inputParaCount, inputCharLen, humanizeText);
          refineUsage = refineData.usage;
          if (result.selfCheckPass === false) {
            logger.warn('analyze.refine_self_check_still_false', { reason: refineDecision.reason });
          }
        } catch (e) {
          if (ac.signal.aborted) throw e;  // disconnect는 outer catch로 위임
          logger.warn('analyze.refine_failed_fallback_first_result', { err: e });
          // result는 1차 그대로, refineUsage는 null 유지
        }
      }

      // ★ 무변환 가드(2026-06-19 실측 #16·#26·#122: 출력이 원문과 글자 단위 100% 동일 — 휴머나이징 미적용인데 과금):
      //   출력이 (공백 무시) 입력과 동일하면 재작성이 일어나지 않은 것 → 강제 1회 재생성(표현을 바꾸라 명시),
      //   그래도 동일하면 차감 없이 차단해 "무변환 결제"를 막는다. NOOP_GUARD=0으로 해제.
      const noopNorm = s => (s || '').replace(/\s+/g, '').trim();
      // 보존(다듬기) 모드는 공백 교정도 가치 → '완전 동일'만 무변환으로 본다(공백만 고친 정상 다듬기 오차단 방지).
      const isPreserveMode = selectedMode === 'polish' || selectedMode === 'preserve';
      const noopHit = (out) => isPreserveMode
        ? ((out || '').trim() === (humanizeText || '').trim())
        : (noopNorm(out) === noopNorm(humanizeText));
      if (process.env.NOOP_GUARD !== '0' && result.outputText
        && noopNorm(humanizeText).length > 0
        && noopHit(result.outputText) && !ac.signal.aborted) {
        logger.warn('analyze.noop_detected_retry', { uid: pre.uid, requestId, mode: selectedMode, len: noopNorm(humanizeText).length });
        try {
          const noopSys = humanizeSystem + (lang === 'en'
            ? '\n\nCRITICAL: Do NOT return the input unchanged. Rephrase sentence structure and wording while preserving meaning, facts, and length.'
            : '\n\n★중요: 입력을 절대 그대로 반환하지 마라. 의미·사실·분량은 보존하되 문장 구조와 표현을 반드시 바꿔 다시 작성하라.');
          const retryData = await callClaude({
            userText: userContent,
            systemText: noopSys,
            tool: humanizeTool,
            temperature: 0.85,
            maxOutputTokens: 16384,
            signal: ac.signal,
            task: 'analyze',
            phase: 'humanize:noop_retry',
            mode: selectedMode,
            cacheZeroWarn: true
          });
          const retried = extractClaudeResult(retryData, humanizeTool.name);
          await applyPassC(retried, lang, ac.signal, { rawText: humanizeText, mode: selectedMode });
          if (retried.outputText && !noopHit(retried.outputText)) {
            result = retried;
            verifyCheckFields(result, selectedMode, inputParaCount, inputCharLen, humanizeText);
          }
        } catch (e) {
          if (ac.signal.aborted) throw e;
          logger.warn('analyze.noop_retry_failed', { uid: pre.uid, requestId, err: e });
        }
        // 재생성 후에도 동일하면 무차감 차단(결과 미노출).
        if (noopHit(result.outputText) && !ac.signal.aborted) {
          clearDedup();   // 엔진 글리치(무차감) — 즉시 재시도 허용
          logger.warn('analyze.noop_blocked', { uid: pre.uid, requestId, mode: selectedMode });
          return res.status(422).json({
            error: '변환 결과가 원문과 동일해(휴머나이징이 적용되지 않음) 결과를 내보내지 않았어요. 크레딧은 차감되지 않았어요. 잠시 후 다시 시도해 주세요.'
          });
        }
      }

      // ★ 증축 하드가드(P2-1): "다듬기"인데 원문보다 과도하게 길어지면(내용 임의 추가·증축) 결과를 내보내지 않는다.
      //   프롬프트가 원문 ×0.9~1.1을 강제하므로 1.3배 초과는 명백한 오작동 — 차감 없이 차단(민원 #100 "1000자를 몇 배로 불림").
      if (typeof result.lengthRatio === 'number' && result.lengthRatio > 1.3 && !ac.signal.aborted) {
        logger.warn('analyze.length_ratio_blocked', { uid: pre.uid, requestId, ratio: result.lengthRatio });
        return res.status(422).json({
          error: '변환 결과가 원문보다 과도하게 길어졌어요(내용이 임의로 늘어남). 크레딧은 차감되지 않았어요. 잠시 후 다시 시도해주세요.'
        });
      }

      if (!result.outputText) throw new Error('humanize_incomplete');

      // ★ 동결 블록(참고문헌·목차) 재조립 — 변환된 본문 앞뒤로 verbatim 복원(가드는 본문 기준으로 이미 통과).
      if (frozen) {
        result.outputText = require('../engine/freezeblocks').reassembleAcademic(frozen, result.outputText);
      }
    }
  } catch (err) {
    // client disconnect 시 응답 자체가 의미 없음 — 차감 안 하고 그대로 종료
    if (ac.signal.aborted) {
      clearDedup();
      logger.warn('analyze.aborted_before_deduct', { uid: pre?.uid, requestId });
      return;
    }
    clearDedup();   // 처리 실패(무차감) — 같은 내용 즉시 재시도 허용
    logger.error('analyze.llm_failed', { uid: pre?.uid, requestId, opType, err });
    return res.status(500).json({ error: '처리 중 오류가 발생했습니다. 크레딧은 차감되지 않았습니다.' });
  }

  // ★ 차감 직전 abort 체크 — 사용자가 끊었으면 차감하지 않고 종료.
  //   "결과 못 받고 크레딧만 차감" 민원의 마지막 안전망.
  if (ac.signal.aborted) {
    clearDedup();
    logger.warn('analyze.aborted_before_deduct_commit', { uid: pre.uid, requestId });
    return;
  }

  // 3) 결과 정상 → 차감 (실패 시 결과 응답 안 함)
  //   차감 + 복구 안전망: Firestore 트랜잭션(100~500ms) 중 client disconnect 시 abort 신호가
  //   트랜잭션 완료 후 도착해 res.json은 빈 socket에 쓰임 → "결과 없이 크레딧만 차감" 민원.
  //   해결: 차감 commit 후 sync 체크 + abort listener 두 단계로 post-deduct disconnect 감지해 복구.
  let deducted = false;
  let responded = false;
  let restoreDone = false;
  const doRestore = async (reason) => {
    if (restoreDone || !deducted || responded) return;
    restoreDone = true;
    logger.warn('analyze.restore_triggered', { uid: pre.uid, requestId, billingMode, reason });
    try {
      await retryAsync(async () => {
        if (billingMode === 'coupon') {
          await commitCouponRestore(pre.uid, pre.tier, opType, text.length, requestId);
        } else if (pre.plan !== 'unlimited') {
          await commitCreditRestore(pre.uid, needed, opType, requestId);
        }
      });
      logger.info('analyze.restore_completed', { uid: pre.uid, requestId, billingMode, reason });
    } catch (e) {
      logger.error('analyze.restore_failed_manual_action', { uid: pre.uid, requestId, billingMode, reason, err: e });
    }
  };

  try {
    if (devNoAuth) {
      // 로컬 개발 — 과금 없음(이중 게이트 위에서 검증)
    } else if (billingMode === 'coupon') {
      await commitCouponUsage(pre.uid, pre.tier, opType, text.length, requestId);
    } else if (pre.plan !== 'unlimited') {
      await commitCreditDeduct(pre.uid, needed, opType, requestId, { mode: historyMode, textLength: text.length });
    }
    deducted = !devNoAuth;
    logger.info('analyze.deducted', {
      uid: pre.uid,
      requestId,
      opType,
      billingMode,
      needed,
      plan: pre.plan,
      devNoAuth
    });
  } catch (e) {
    clearDedup();   // 차감 실패(무차감) — 재시도 허용
    logger.error('analyze.deduct_failed', { uid: pre.uid, requestId, opType, billingMode, needed, err: e });
    return res.status(500).json({ error: '결제 처리 중 일시적인 오류가 발생했어요. 잠시 뒤 다시 시도해주세요.' });
  }

  // 차감 후 disconnect 감지 (sync) — 이미 abort됐으면 즉시 복구(저장 전이므로 결과 미저장 = 정합).
  if (ac.signal.aborted) {
    await doRestore('post-deduct sync');
    return;
  }

  // ★ 서버 결과 영속화: "차감↔결과저장" 원자화(2026-06-14). 단일 호출은 서버가 직접 저장하고,
  //   청크 호출(requestId에 ':' 포함, >5500자)은 클라가 합쳐 저장하므로 여기선 건너뛴다(추후 /transform 통일 대상).
  const isChunkCall = !!(requestId && requestId.includes(':'));
  let historySaved = false;
  if (db && !devNoAuth && !isChunkCall) {
    try {
      await retryAsync(() => saveAnalyzeHistory({ uid: pre.uid, requestId, opType, text, needed, result, mode: historyMode }));
      historySaved = true;
    } catch (e) {
      logger.error('analyze.history_persist_failed', { uid: pre.uid, requestId, opType, billingMode, err: e });
      // 실제 크레딧이 차감된 경우엔 "결과 없는 차감"을 막으려 롤백 후 에러 — 사용자는 무과금으로 재시도 가능.
      if (billingMode === 'credit' && pre.plan !== 'unlimited') {
        await doRestore('history_persist_failed');
        return res.status(500).json({ error: '결과 저장 중 오류가 발생했어요. 크레딧은 차감되지 않았어요. 잠시 뒤 다시 시도해주세요.' });
      }
      // 쿠폰·무제한: 비과금이라 결과는 그대로 전달하고, 클라이언트 폴백 저장에 맡긴다.
    }
  }

  // 저장이 끝났으면 disconnect로 복구하지 않는다(결과가 영구 저장돼 이용 기록에서 확인 가능).
  // 미저장(청크·쿠폰·무제한 폴백)일 때만 기존처럼 "응답 못 받고 차감"을 disconnect 복구로 막는다.
  if (!historySaved) {
    ac.signal.addEventListener('abort', () => { doRestore('post-deduct listener'); }, { once: true });
  }

  // 4) 응답 — 'finish'(OS 송신 큐 완료) 시점에만 responded 마킹.
  res.once('finish', () => { responded = true; });
  logger.info('analyze.completed', {
    uid: pre.uid,
    requestId,
    opType,
    billingMode,
    deducted,
    historySaved,
    floorStatus: evasion?.floorReport?.status,
    chunkCount: evasion?.chunkCount
  });
  res.json({ ok: true, result, usage, refineUsage, ...(evasion ? { evasion } : {}), historySaved });
});

router.post('/analyze-pdf', upload.single('pdf'), async (req, res) => {
  if (process.env.ENABLE_LEGACY_ANALYZE_PDF !== '1') {
    logger.warn('analyze_pdf.disabled');
    return res.status(410).json({
      error: 'PDF 직접 분석 API는 종료되었습니다. 브라우저에서 텍스트를 추출한 뒤 /analyze를 사용해주세요.'
    });
  }

  // ★ client disconnect 추적 (PDF 경로도 동일)
  const ac = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      ac.abort();
      logger.warn('analyze_pdf.client_disconnected');
    }
  });

  if (!req.file) return res.status(400).json({ error: 'PDF 파일이 없습니다.' });
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: 'PDF 파일만 업로드 가능합니다.' });
  }

  const mode = req.body.mode || 'detect';
  const lang = req.body.lang || 'ko';
  const idToken = bearerToken(req);   // 헤더 우선(multipart form의 body.idToken 폴백)
  const billingMode = req.body.billingMode === 'coupon' ? 'coupon' : 'credit';
  const opType = mode === 'detect' ? 'detect' : 'humanize';
  const requestId = (typeof req.body.requestId === 'string' && req.body.requestId.trim())
    ? req.body.requestId.trim().slice(0, 80).replace(/[^A-Za-z0-9:_-]/g, '')
    : null;
  logger.info('analyze_pdf.started', { opType, billingMode, requestId, fileSize: req.file?.size });

  let pdfText;
  try {
    const pdfData = await pdfParse(req.file.buffer);
    pdfText = pdfData.text.trim();
  } catch (e) {
    return res.status(400).json({ error: 'PDF 파싱에 실패했습니다.' });
  }
  if (!pdfText || pdfText.length < 5) {
    return res.status(400).json({ error: 'PDF에서 텍스트를 추출할 수 없습니다.' });
  }

  const needed = Math.ceil(req.file.size / 10240);

  // 1) precheck — 토큰/잔량/구독 검증 (Firestore 읽기만, 차감 없음)
  let pre;
  try {
    pre = billingMode === 'coupon'
      ? await precheckCoupon(idToken, pdfText.length)
      : await precheckCredits(idToken, needed);
  } catch (e) {
    logger.warn('analyze_pdf.precheck_failed', { opType, billingMode, needed, requestId, err: e });
    return res.status(e.status || 500).json({
      error: authErrorMessage(e.message),
      ...(e.charLimit !== undefined ? { charLimit: e.charLimit } : {})
    });
  }
  setLogContext({ uid: pre.uid });

  // 2) LLM 호출 + 결과 검증 (실패 시 차감 없음)
  let result;
  let usage;
  try {
    const text = pdfText;
    const humanizeModePdf = req.body.humanizeMode || 'assignment';
    if (mode === 'detect') {
      const detectSystem = getDetectSystem(lang);
      const detectTool = getDetectTool(lang);
      const data = await callClaude({
        userText: lang === 'en' ? `[TEXT TO ANALYZE]\n${text}` : `[분석할 글]\n${text}`,
        systemText: detectSystem,
        tool: detectTool,
        maxOutputTokens: 4096,
        signal: ac.signal,
        task: 'analyze_pdf',
        phase: 'detect:main',
        mode: 'detect'
      });
      result = extractClaudeResult(data, detectTool.name);
      if (typeof result.probability !== 'number' || !result.summary || !result.detail) {
        throw new Error('detect_incomplete');
      }
      const calibration = await detectCalibration.applyHistoryCalibration({
        db,
        uid: pre.uid,
        text,
        probability: result.probability,
        logger,
        route: 'analyze_pdf'
      });
      if (calibration.applied) {
        result.rawProbability = calibration.rawProbability;
        result.probability = calibration.probability;
        result.probabilityCalibration = calibration.meta;
      }
      usage = data.usage;
    } else {
      // ★ 사전 처리: assignment 모드만 결정론 룰을 입력에 미리 적용.
      let humanizeText = text;
      if (humanizeModePdf === 'assignment') {
        try {
          const pp = await preprocessInput(text, lang, ac.signal);
          humanizeText = pp.text;
          logger.debug('analyze_pdf.preprocess_completed', {
            gptismCount: pp.gptismCount,
            commaSplitCount: pp.commaSplitCount,
            declarativeCount: pp.declarativeCount
          });
        } catch (e) {
          if (ac.signal.aborted) throw e;
          logger.warn('analyze_pdf.preprocess_failed_fallback_original', { err: e });
        }
      }
      const humanizeSystem = getHumanizeSystem(humanizeModePdf, lang);
      const humanizeTool = getHumanizeToolFor(humanizeModePdf, lang);
      let data;
      try {
        data = await callClaude({
          userText: lang === 'en' ? `[TEXT TO REWRITE]\n${humanizeText}` : `[재작성할 텍스트]\n${humanizeText}`,
          systemText: humanizeSystem,
          tool: humanizeTool,
          temperature: 0.5,
          maxOutputTokens: 16384,
          signal: ac.signal,
          task: 'analyze_pdf',
          phase: 'humanize:first',
          mode: humanizeModePdf,
          cacheZeroWarn: true
        });
      } catch (e) {
        if (ac.signal.aborted) throw e;
        logger.error('analyze_pdf.first_llm_failed', { err: e });
        throw e;
      }
      result = extractClaudeResult(data, humanizeTool.name);
      await applyPassC(result, lang, ac.signal, { rawText: humanizeText, mode });
      if (!result.outputText) throw new Error('humanize_incomplete');
      usage = data.usage;
    }
  } catch (err) {
    if (ac.signal.aborted) {
      logger.warn('analyze_pdf.aborted_before_deduct', { uid: pre?.uid, requestId });
      return;
    }
    logger.error('analyze_pdf.llm_failed', { uid: pre?.uid, requestId, opType, err });
    return res.status(500).json({ error: '처리 중 오류가 발생했습니다. 크레딧은 차감되지 않았습니다.' });
  }

  // ★ 차감 직전 abort 체크
  if (ac.signal.aborted) {
    logger.warn('analyze_pdf.aborted_before_deduct_commit', { uid: pre.uid, requestId });
    return;
  }

  // 3) 결과 정상 → 차감 + 복구 안전망 (/analyze와 동일 패턴 — 자세한 주석은 그쪽 참조)
  let deducted = false;
  let responded = false;
  let restoreDone = false;
  const doRestore = async (reason) => {
    if (restoreDone || !deducted || responded) return;
    restoreDone = true;
    logger.warn('analyze_pdf.restore_triggered', { uid: pre.uid, requestId, billingMode, reason });
    try {
      await retryAsync(async () => {
        if (billingMode === 'coupon') {
          await commitCouponRestore(pre.uid, pre.tier, opType, pdfText.length, requestId);
        } else if (pre.plan !== 'unlimited') {
          await commitCreditRestore(pre.uid, needed, opType, requestId);
        }
      });
      logger.info('analyze_pdf.restore_completed', { uid: pre.uid, requestId, billingMode, reason });
    } catch (e) {
      logger.error('analyze_pdf.restore_failed_manual_action', { uid: pre.uid, requestId, billingMode, reason, err: e });
    }
  };

  try {
    if (billingMode === 'coupon') {
      await commitCouponUsage(pre.uid, pre.tier, opType, pdfText.length, requestId);
    } else if (pre.plan !== 'unlimited') {
      await commitCreditDeduct(pre.uid, needed, opType, requestId);
    }
    deducted = true;
    logger.info('analyze_pdf.deducted', { uid: pre.uid, requestId, opType, billingMode, needed, plan: pre.plan });
  } catch (e) {
    logger.error('analyze_pdf.deduct_failed', { uid: pre.uid, requestId, opType, billingMode, needed, err: e });
    return res.status(500).json({ error: '결제 처리 중 일시적인 오류가 발생했어요. 잠시 뒤 다시 시도해주세요.' });
  }

  if (ac.signal.aborted) {
    await doRestore('post-deduct sync');
    return;
  }
  ac.signal.addEventListener('abort', () => { doRestore('post-deduct listener'); }, { once: true });

  // 4) 응답
  res.once('finish', () => { responded = true; });
  logger.info('analyze_pdf.completed', { uid: pre.uid, requestId, opType, billingMode, deducted });
  res.json({
    ok: true,
    result,
    usage,
    extractedText: pdfText.substring(0, 500)
  });
});

router.verifyCheckFields = verifyCheckFields;
router.collectFailedFields = collectFailedFields;
router.runHumanize = runHumanize;
router.runHumanizeChunked = runHumanizeChunked;
// ★ LLM 호출 경로 재사용(routes/detectreport.js — 백엔드 스위치·캐싱·idle 타임아웃을 한 곳에 유지)
router.callClaude = callClaude;
router.buildDetectTool = buildDetectTool;
router.extractClaudeResult = extractClaudeResult;
// ★ detect 단독 호출(검증·테스트용 — 핸들러 detect 분기와 동일 시스템·툴·경로). 반환 { probability, summary, detail }.
router.runDetect = async function runDetect(text, lang = 'ko') {
  const detectSystem = getDetectSystem(lang);
  const detectTool = getDetectTool(lang);
  const data = await callClaude({
    userText: `[분석할 글]\n${text}`,
    systemText: detectSystem, tool: detectTool,
    maxOutputTokens: 4096, task: 'analyze', phase: 'detect:validate', mode: 'detect'
  });
  return extractClaudeResult(data, detectTool.name);
};
// ★ 과금·인증 헬퍼 재사용(routes/transform.js 등 — 차감 공식·복구 로직을 한 곳에 유지)
router.precheckCredits = precheckCredits;
router.commitCreditDeduct = commitCreditDeduct;
router.commitCreditRestore = commitCreditRestore;
router.retryAsync = retryAsync;
router.saveAnalyzeHistory = saveAnalyzeHistory;   // 테스트·재사용용
router.authErrorMessage = authErrorMessage;
module.exports = router;
