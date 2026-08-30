// [routes/writinglab.js] 글쓰기 랩 — 장르 맞춤 생성 → 휴머나이징 → 무날조 검수 (2026-08-25 다장르·실운영 확장)
// ────────────────────────────────────────────────────────────────
// 결합 파이프라인의 1단계(생성)와 3단계(검수)를 제공한다. 2단계(휴머나이징)는 기존 /transform을
// 프런트가 체인해 재사용한다(일반 사용자=정상 과금·기록, 관리자=adminHumanizeLab 무과금).
// - GET  /writing-lab/pricing  : 생성 단가표(공개) — 프런트 견적의 단일 출처
// - POST /writing-lab/generate : 장르(자소서/블로그·후기/상품·서비스 소개/일반) + 사실 카드 → Writer 생성
//     · 로그인 필수. 관리자=무과금(실험), 일반 사용자=성공 후 크레딧 차감(기존 usageBilling 멱등 패턴)
//     · 무날조: 사실 카드로 팩트시트(의사 원문)를 합성해 기존 경험 날조 감사(experienceAudit)를 재사용
//     · 의료 후기·효능 광고(의료법 56조 영역)는 후기·소개 장르에서 결정론 차단
// - POST /writing-lab/check    : 임의 텍스트를 팩트시트 기준 재검사(무LLM·무과금·즉시)
// 과금 원칙: 잔액 선확인(홀드 없음) → 생성 성공 시에만 멱등 차감 → 실패·차단 무과금(transform과 동일 규율).

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken, verifyAdminToken, ADMIN_UIDS } = require('../config');
const { bearerToken } = require('../lib/reqtoken');
const { logger, setLogContext } = require('../lib/logger');
const usageBilling = require('../lib/usageBilling');
const compat = require('../engine-gpt-prod/compat');
const experienceAudit = require('../engine-gpt-prod/experienceAudit');
const writingEngine = require('../engine-writing-v1');
const writingUsage = require('../engine-writing-v1/usage');
const { signContext, verifyContext } = require('../engine-writing-v1/contextToken');
const { compareQuantities } = require('../engine-writing-v1/numberAst');
const { extractCandidates } = require('../engine-writing-v1/extractor');
const { registrySnapshot } = require('../engine-writing-v1/policy/registry');
const writingJobs = require('../engine-writing-v1/jobStore');
const writingTelemetry = require('../engine-writing-v1/telemetry');

const TOPIC_MAX = 1200;
const MEMO_FIELD_MAX = 2000;
const CHECK_TEXT_MAX = 12000;
const TARGET_CHARS_MIN = 100;
const TARGET_CHARS_MAX = 3000;
const DAILY_GENERATE_CAP = Math.max(1, Number(process.env.WRITING_LAB_DAILY_CAP) || 30);   // 일반 사용자 일일 생성 상한(남용 방어)
const CHECK_HOURLY_CAP = Math.max(10, Number(process.env.WRITING_LAB_CHECK_HOURLY_CAP) || 120);
const EXTRACT_HOURLY_CAP = Math.max(5, Number(process.env.WRITING_LAB_EXTRACT_HOURLY_CAP) || 30);
const WRITING_LAB_V2_ENABLED = process.env.WRITING_LAB_V2_ENABLED !== '0';
const WRITING_LAB_V2_ROLLOUT_PERCENT = Math.max(0, Math.min(100, Number(process.env.WRITING_LAB_V2_ROLLOUT_PERCENT ?? 100) || 0));
const WRITING_LAB_V2_DISABLED_GENRES = new Set(String(process.env.WRITING_LAB_V2_DISABLED_GENRES || '').split(',').map(value => value.trim()).filter(Boolean));
const CLIENT_EVENT_HOURLY_CAP = 60;

// 생성 단가(크레딧) — 목표 분량 구간별 정액. 휴머나이징은 기존 /transform 단가가 별도 적용된다.
const GENERATION_PRICING = Object.freeze([
  { maxChars: 800, credits: 40 },
  { maxChars: 1500, credits: 50 },
  { maxChars: TARGET_CHARS_MAX, credits: 60 }
]);
function generationCredits(targetChars) {
  const t = targetChars || 800;
  for (const tier of GENERATION_PRICING) if (t <= tier.maxChars) return tier.credits;
  return GENERATION_PRICING[GENERATION_PRICING.length - 1].credits;
}

// ── 장르 정의: 라벨·휴머나이징 프로필·사실 카드 라벨·장르 계약 ──
const GENRES = Object.freeze({
  resume: {
    label: '자기소개서',
    documentProfile: 'resume_application',
    basicStyle: 'report',
    defaultLength: '600~900자(공백 포함)',
    register: "종결체는 '-습니다'로 통일하고 1인칭은 '저'를 쓴다.",
    topicLabel: '자기소개서 문항',
    ctx1Label: '지원 회사', ctx2Label: '지원 직무',
    factLabels: { experience: '직접 겪은 일·경험', caseExample: '구체적 사례·예시', numbers: '정확히 아는 수치·출처', thoughts: '내 생각·입장' },
    contract: [
      '[문항 응답 계약]',
      '- 첫 문장부터 문항이 묻는 것에 직접 답한다(두괄식). 문항과 무관한 일반론·명언·자기 다짐으로 시작하지 않는다.',
      '- 경험 서술은 상황 → 본인의 행동 → 결과 → 배운 점의 흐름을 기본으로 하되, 소제목이나 번호로 기계적으로 나누지 않는다.',
      '- 행동의 주어는 항상 지원자 본인이 되게 쓴다.',
      '- 회사에 대한 구체적 사실(매출·연혁·제품명 등)은 사실 카드에 없으면 쓰지 않는다.'
    ]
  },
  review_blog: {
    label: '블로그·후기',
    documentProfile: 'review_blog',
    basicStyle: 'blog',
    defaultLength: '1,000~1,500자(공백 포함)',
    register: "종결체는 '-해요'를 기본으로 자연스럽게 쓴다.",
    topicLabel: '글 주제',
    ctx1Label: '게시 플랫폼·독자', ctx2Label: '핵심 키워드',
    factLabels: { experience: '직접 경험·방문·사용 내역', caseExample: '구체적 정보·팁', numbers: '가격·날짜·수치', thoughts: '내 평가·느낌' },
    contract: [
      '[블로그·후기 계약]',
      '- 실제 경험의 시간 순서(방문 전 → 중 → 후, 사용 전 → 후)를 지어내지 말고 사실 카드에 적힌 순서만 쓴다.',
      '- 독자에게 실제로 유용한 정보(위치·가격·꿀팁 등 사실 카드 근거)를 우선하고, 감탄사·홍보 문구 반복을 피한다.',
      '- 핵심 키워드는 제목성 첫 문단과 본문에 자연스럽게 1~2회만 녹인다. 기계적 반복 금지.',
      '- 대가를 받은 글이라는 정보가 사실 카드에 있으면 글 끝에 협찬·제공 고지를 한 줄 넣는다.'
    ]
  },
  marketing: {
    label: '상품·서비스 소개',
    documentProfile: 'marketing',
    basicStyle: 'blog',
    defaultLength: '600~900자(공백 포함)',
    register: "종결체는 '-해요'와 명사형을 자연스럽게 섞는다.",
    topicLabel: '소개할 상품·서비스와 글의 목적',
    ctx1Label: '상품·서비스명', ctx2Label: '타깃 고객',
    factLabels: { experience: '상품·서비스의 사실(기능·구성)', caseExample: '고객 사례·사용 장면', numbers: '수치·인증·출처', thoughts: '강조하고 싶은 포인트' },
    contract: [
      '[상품·서비스 소개 계약]',
      '- 강점 주장은 사실 카드에 근거가 있는 것만 쓴다. 근거 없는 최상급("최고", "1위")·보장("100% 효과") 표현 금지.',
      '- 효능·치료·건강 개선 주장은 쓰지 않는다.',
      '- 행동 유도(CTA)는 글 끝에 1회만, 과장 없이.',
      '- 타깃 고객이 겪는 문제 → 해결 방식 → 근거 순서로 설득한다.'
    ]
  },
  general: {
    label: '일반 글',
    documentProfile: 'general',
    basicStyle: 'report',
    defaultLength: '700~1,000자(공백 포함)',
    register: "종결체는 '-습니다'를 기본으로 한다.",
    topicLabel: '글의 주제와 목적',
    ctx1Label: '글의 용도', ctx2Label: '읽는 사람',
    contract: [
      '[일반 글 계약]',
      '- 첫 문단에서 주제에 대한 핵심 답을 먼저 말하고(두괄식), 이후 근거와 설명을 붙인다.',
      '- 사실 카드의 내용을 재료로 삼고, 카드에 없는 사례·통계·인용을 만들어내지 않는다.'
    ],
    factLabels: { experience: '핵심 사실·내용', caseExample: '예시·사례', numbers: '수치·출처', thoughts: '내 관점·결론' }
  }
});

// 엔진 핑거프린트·상투구(7월 주간 리뷰 실측 "그치지 않고" 계열 포함) — 개수만 보고, 판단은 사용자 몫.
const CLICHE_PATTERNS = [
  { key: '그치지 않고', re: /(?:에|에서)?\s*그치지\s*않(?:고|았)/g },
  { key: '머무르지 않고', re: /(?:에|에서)?\s*머무르지\s*않(?:고|았)/g },
  { key: '멈추지 않고', re: /(?:에서)?\s*멈추지\s*않(?:고|았)/g },
  { key: '단순히 ~을 넘어', re: /단순(?:히|한)\s*[^,.\n]{0,14}(?:을|를)?\s*넘어/g },
  { key: '뿐만 아니라', re: /뿐만\s*아니라/g },
  { key: '나아가', re: /(?:^|[\s,.])나아가(?=[\s,])/g }
];

const TOPIC_STOPWORDS = new Set([
  '자신', '본인', '무엇', '어떤', '어떻게', '대해', '대한', '관해', '관련', '경험', '사례', '과정',
  '작성', '서술', '기술', '설명', '말씀', '주세요', '주십시오', '바랍니다', '있는', '있다면', '있었던',
  '통해', '위해', '이내', '이상', '글자', '기준', '포함', '제외', '공백', '문항', '지원', '당사', '우리',
  '말해', '말하', '적어', '써서', '들어', '무슨', '언제', '어디', '왜요', '해서', '소개', '후기', '리뷰'
]);

function isAdminUid(uid) {
  return ADMIN_UIDS.includes(uid);
}

function rolloutBucket(uid) {
  const hex = crypto.createHash('sha256').update(`writing-lab-v2:${uid}`).digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) % 100;
}

function canUseWritingV2(user, genre) {
  if (user?.admin) return true;
  if (!WRITING_LAB_V2_ENABLED || WRITING_LAB_V2_DISABLED_GENRES.has(String(genre || ''))) return false;
  return rolloutBucket(user?.uid || '') < WRITING_LAB_V2_ROLLOUT_PERCENT;
}

function enforceWritingV2(user, genre, res) {
  if (canUseWritingV2(user, genre)) return true;
  res.status(403).json({
    ok: false,
    code: 'WRITING_LAB_V2_NOT_AVAILABLE',
    error: '새 글쓰기 랩은 단계적으로 열고 있어요. 관리자 또는 현재 베타 대상 계정에서 이용할 수 있습니다.'
  });
  return false;
}

// ── 남용 방어: 일반 사용자 일일 생성 캡 + 검사 시간당 캡(메모리 — 재시작 리셋은 사용자에게 유리한 방향) ──
const hourlyChecks = new Map();     // uid → { hour, count }
const hourlyExtracts = new Map();   // uid → { hour, count }
const hourlyClientEvents = new Map();
setInterval(() => {
  const hour = Math.floor(Date.now() / 3600000);
  for (const [k, v] of hourlyChecks) if (v.hour !== hour) hourlyChecks.delete(k);
  for (const [k, v] of hourlyExtracts) if (v.hour !== hour) hourlyExtracts.delete(k);
  for (const [k, v] of hourlyClientEvents) if (v.hour !== hour) hourlyClientEvents.delete(k);
}, 60 * 60 * 1000).unref();

function bumpHourlyCheck(uid) {
  const hour = Math.floor(Date.now() / 3600000);
  const cur = hourlyChecks.get(uid);
  const count = cur && cur.hour === hour ? cur.count + 1 : 1;
  hourlyChecks.set(uid, { hour, count });
  return count;
}

function bumpHourlyExtract(uid) {
  const hour = Math.floor(Date.now() / 3600000);
  const cur = hourlyExtracts.get(uid);
  const count = cur && cur.hour === hour ? cur.count + 1 : 1;
  hourlyExtracts.set(uid, { hour, count });
  return count;
}

function bumpHourlyClientEvent(uid) {
  const hour = Math.floor(Date.now() / 3600000);
  const cur = hourlyClientEvents.get(uid);
  const count = cur && cur.hour === hour ? cur.count + 1 : 1;
  hourlyClientEvents.set(uid, { hour, count });
  return count;
}

// 로그인한 사용자(관리자 포함) 확인 — 반환 { uid, admin } 또는 res 전송 후 null
async function requireUser(req, res) {
  const devNoAuth = !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1';
  if (devNoAuth) return { uid: 'dev-local', admin: true, devNoAuth: true };
  const idToken = bearerToken(req);
  const uid = await verifyToken(idToken);
  if (!uid) {
    res.status(401).json({ code: 'LOGIN_REQUIRED', error: '글쓰기 랩은 로그인 후 이용할 수 있어요.' });
    return null;
  }
  setLogContext({ uid, actorUid: uid });
  let adminAccess = false;
  if (isAdminUid(uid)) {
    // 관리자 세션만 revocation을 추가 확인한다. 일반 사용자 요청에는 Auth 조회
    // 지연을 더하지 않으면서 탈취·강제 로그아웃된 관리자 토큰은 즉시 거부한다.
    adminAccess = (await verifyAdminToken(idToken)) === uid;
    if (!adminAccess) {
      res.status(401).json({ code: 'ADMIN_SESSION_REVOKED', error: '관리자 로그인이 만료됐어요. 다시 로그인해 주세요.' });
      return null;
    }
  }
  return { uid, admin: adminAccess, idToken };
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim().slice(0, max);
}

function normalizeGenre(value) {
  const v = String(value || '').trim();
  return Object.prototype.hasOwnProperty.call(GENRES, v) ? v : 'general';
}

function readMemo(body) {
  const memo = body && typeof body.memo === 'object' && body.memo ? body.memo : {};
  return {
    experience: cleanText(memo.experience, MEMO_FIELD_MAX),
    caseExample: cleanText(memo.caseExample, MEMO_FIELD_MAX),
    numbers: cleanText(memo.numbers, MEMO_FIELD_MAX),
    thoughts: cleanText(memo.thoughts, MEMO_FIELD_MAX)
  };
}

// 사실 카드 → 팩트시트(의사 원문). 생성 프롬프트와 무날조 감사가 같은 텍스트를 기준으로 쓴다.
function buildFactsheet(genreKey, { ctx1, ctx2, topic, memo, emphasis }) {
  const g = GENRES[genreKey];
  const lines = [];
  if (ctx1) lines.push(`[${g.ctx1Label}] ${ctx1}`);
  if (ctx2) lines.push(`[${g.ctx2Label}] ${ctx2}`);
  if (topic) lines.push(`[${g.topicLabel}] ${topic}`);
  if (memo.experience) lines.push(`[${g.factLabels.experience}] ${memo.experience}`);
  if (memo.caseExample) lines.push(`[${g.factLabels.caseExample}] ${memo.caseExample}`);
  if (memo.numbers) lines.push(`[${g.factLabels.numbers}] ${memo.numbers}`);
  if (memo.thoughts) lines.push(`[${g.factLabels.thoughts}] ${memo.thoughts}`);
  if (emphasis) lines.push(`[강조할 점] ${emphasis}`);
  return lines.join('\n');
}

function normalizeCharLimitMode(value) {
  const v = String(value || '').trim();
  return ['with_space', 'no_space', 'byte2'].includes(v) ? v : 'with_space';
}

function charCounts(text) {
  const value = String(text || '');
  const chars = Array.from(value);
  let byte2 = 0;
  for (const ch of chars) byte2 += ch.codePointAt(0) > 0x7f ? 2 : 1;   // 채용 폼 관례: 한글·전각 2byte
  return {
    withSpace: chars.length,
    noSpace: Array.from(value.replace(/\s+/g, '')).length,
    byte2,
    utf8: Buffer.byteLength(value, 'utf8')
  };
}

function limitCheck(counts, targetChars, mode) {
  if (!targetChars) return { applicable: false };
  const used = mode === 'no_space' ? counts.noSpace : mode === 'byte2' ? counts.byte2 : counts.withSpace;
  const ratio = used / targetChars;
  const status = ratio < 0.88 ? 'under' : ratio > 1 ? 'over' : 'pass';
  return {
    applicable: true,
    mode,
    target: targetChars,
    used,
    over: Math.max(0, used - targetChars),
    minimum: Math.ceil(targetChars * 0.88),
    maximum: targetChars,
    under: Math.max(0, Math.ceil(targetChars * 0.88) - used),
    usageRatio: Math.round(ratio * 1000) / 1000,
    status,
    pass: status === 'pass'
  };
}

// 결과 텍스트의 숫자 중 팩트시트(+주제)에 근거가 없는 것 — "날조 수치 후보". 판단은 사용자 몫.
const NUMBER_RE = /\d[\d,.]*\s*(?:%|퍼센트|퍼|명|건|회|번|년|년간|개월|주|일|시간|분|배|원|만\s*원|억|위|등|점|개|팀|과목|학점|kg|km|cm|시간대)?/g;
function numberTokens(text) {
  const found = String(text || '').match(NUMBER_RE) || [];
  return found.map(t => t.replace(/[\s,]/g, ''));
}
function fabricatedNumberCandidates(outputText, factsheet) {
  return compareQuantities(factsheet, outputText).addedTokens.slice(0, 20);
}

function clicheReport(text) {
  const value = String(text || '');
  const found = [];
  let total = 0;
  for (const { key, re } of CLICHE_PATTERNS) {
    re.lastIndex = 0;
    const count = (value.match(re) || []).length;
    if (count > 0) { found.push({ phrase: key, count }); total += count; }
  }
  return { total, found };
}

// 주제 핵심 키워드가 본문에 안 보이면 "미반영 후보"로만 보고(휴리스틱 — 동의어는 못 본다).
function topicKeywordGaps(topic, outputText) {
  const tokens = String(topic || '').match(/[가-힣]{2,8}/g) || [];
  const body = String(outputText || '');
  const seen = new Set();
  const missing = [];
  for (const raw of tokens) {
    const token = raw
      .replace(/(?:에서|에게|과의|와의|으로|로서|로써|이란|라는|이라|하기|하는|했던|인가)$/u, '')
      .replace(/(?:[을를은는이가의에도])$/u, '');
    if (token.length < 2 || TOPIC_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    if (!body.includes(token) && !body.includes(token.slice(0, 2))) missing.push(token);
  }
  return missing.slice(0, 8);
}

function runFactChecks(outputText, factsheet, { topic, targetChars, charLimitMode } = {}) {
  const counts = charCounts(outputText);
  let novelty = null;
  try {
    // 기존 경험 날조 감사 재사용: source=팩트시트(의사 원문), output=생성/휴머나이징 결과.
    novelty = experienceAudit.detectExperienceCandidate(factsheet, outputText);
  } catch (e) {
    novelty = { error: e && e.message ? e.message : 'novelty_check_failed' };
  }
  return {
    counts,
    limit: limitCheck(counts, targetChars, charLimitMode),
    experienceNovelty: novelty,
    fabricatedNumberCandidates: fabricatedNumberCandidates(outputText, `${factsheet}\n${topic || ''}`),
    cliches: clicheReport(outputText),
    topicKeywordGaps: topicKeywordGaps(topic, outputText)
  };
}

function writerSystemPrompt(genreKey, { targetChars, charLimitMode, tone }) {
  const g = GENRES[genreKey];
  const modeLabel = charLimitMode === 'no_space' ? '공백 제외' : charLimitMode === 'byte2' ? '바이트(한글 2byte)' : '공백 포함';
  const lengthLine = targetChars
    ? `- 목표 분량: ${modeLabel} 기준 ${targetChars}자의 88~100%. 절대 초과하지 않는다.`
    : `- 목표 분량: ${g.defaultLength}.`;
  const toneLine = tone === 'formal'
    ? "- 문체: 격식 있는 문어체로 쓴다."
    : tone === 'friendly'
      ? '- 문체: 친근하고 편안한 어조로 쓴다.'
      : `- ${g.register}`;
  return [
    `당신은 한국어 ${g.label} 전문 작가다. 아래 계약을 절대 어기지 않는다.`,
    '',
    '[무날조 계약 — 최우선]',
    '- 본문에 쓸 수 있는 경험·사례·수치·기간·고유명사는 사용자 입력의 [사실 카드]에 적힌 것뿐이다.',
    '- 사실 카드에 없는 경험·수치·고유명사를 절대 만들어내지 않는다. 정보가 부족하면 본문을 짧게 끝내고 followupQuestions에 확인할 질문만 남긴다.',
    '- 본문에서 정보 부족, 기록 부재, 사실 카드, 추가 확인, 다음에 기록할 내용을 설명하지 않는다.',
    '- 인용문·통계·연구 결과를 지어내지 않는다.',
    '',
    ...g.contract,
    '',
    '[분량 계약]',
    lengthLine,
    '',
    '[문체 계약]',
    toneLine,
    '- 금지 표현: "~에 그치지 않고", "~에 머무르지 않고", "단순히 ~을 넘어", "뿐만 아니라"의 반복, "나아가"의 반복, 형용사 나열식 미화.',
    '- 문장 길이를 다양하게 섞고, 같은 종결 패턴을 세 문장 이상 반복하지 않는다.',
    '- 번역투·개조식 표현을 피하고 자연스러운 한국어 문장으로 쓴다.',
    '',
    '결과는 지정된 JSON 스키마로만 반환한다. draft에는 본문만 넣는다(제목·문항 반복·메타 설명 금지).'
  ].join('\n');
}

const WRITER_TOOL = {
  name: 'writing_lab_draft',
  input_schema: {
    type: 'object',
    properties: {
      draft: { type: 'string' },
      usedFacts: { type: 'array', items: { type: 'string' } },
      followupQuestions: { type: 'array', items: { type: 'string' } }
    },
    required: ['draft', 'usedFacts', 'followupQuestions']
  }
};

function v2PreflightError(prepared, shortMode) {
  const assessment = prepared.assessment;
  if (!prepared.policy.canGenerate) {
    return {
      status: 400,
      code: assessment.status === 'POLICY_BLOCKED' ? 'POLICY_BLOCKED' : 'POLICY_REVIEW_REQUIRED',
      error: assessment.summary,
      assessment,
      policy: prepared.policy
    };
  }
  if (assessment.status === 'NEEDS_FACTS') {
    return { status: 409, code: 'MORE_FACTS_REQUIRED', error: assessment.summary, assessment };
  }
  if (assessment.status === 'LIMITED' && !shortMode) {
    return { status: 409, code: 'SHORT_MODE_CONFIRMATION_REQUIRED', error: assessment.summary, assessment };
  }
  return null;
}

function sendWritingEngineError(res, error) {
  if (error instanceof writingEngine.WritingEngineError) {
    return res.status(error.status || 400).json({
      ok: false,
      code: error.code,
      error: error.message,
      ...(error.details || {})
    });
  }
  const code = error?.code ? String(error.code) : 'WRITING_ENGINE_FAILED';
  const message = code === 'OPENAI_QUOTA_EXHAUSTED'
    ? 'API 사용량 한도로 생성에 실패했습니다. 크레딧과 생성 한도는 사용되지 않았어요.'
    : code === 'WRITING_LAB_CONTEXT_SECRET_REQUIRED' || code === 'WRITING_LAB_CONTEXT_SECRET_WEAK'
      ? '검수 보안 설정이 완료되지 않아 글쓰기를 시작할 수 없어요.'
      : code === 'BILLING_COMMIT_FAILED'
        ? '결제 확인을 완료하지 못했어요. 같은 작업을 다시 시도해도 중복 차감되지 않습니다.'
        : '글을 만드는 중 오류가 발생했어요. 크레딧과 생성 한도는 사용되지 않았어요.';
  return res.status(502).json({ ok: false, code, error: message });
}

function publicGenerationResult(result, { verificationToken, billing, usage, requestId }) {
  return {
    ok: true,
    status: 'READY',
    jobId: requestId,
    requestId,
    engineVersion: result.engineVersion,
    genre: result.genre,
    subtype: result.subtype,
    draft: result.draft,
    usedFacts: result.usedFacts,
    usedFactIds: result.usedFactIds,
    followupQuestions: result.followupQuestions,
    factsheet: result.factsheet,
    assessment: result.assessment,
    policy: result.policy,
    checks: result.checks,
    semantic: result.semantic,
    release: result.release,
    attempts: result.attempts,
    humanize: result.humanize,
    verificationToken,
    billing,
    usage
  };
}

// ── Writing Lab v2: 근거 원장 → 충족도 → 구조화 생성 → 의미 검수 ─────
router.get('/writing-lab/v2/config', (req, res) => {
  res.json({
    ok: true,
    ...writingEngine.config(),
    pricing: {
      generation: GENERATION_PRICING,
      humanize: { perHundredChars: 2, minCredits: 10 },
      dailyCap: DAILY_GENERATE_CAP
    },
    rollout: {
      enabled: WRITING_LAB_V2_ENABLED,
      percent: WRITING_LAB_V2_ROLLOUT_PERCENT,
      disabledGenres: [...WRITING_LAB_V2_DISABLED_GENRES]
    }
  });
});

router.post('/admin/writing-lab-policies', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!user.admin) return res.status(403).json({ ok: false, error: '관리자 권한이 필요해요.' });
    const registry = registrySnapshot();
    logger.info('writinglab.policy_registry_read', {
      uid: user.uid,
      launchEligible: registry.launchEligible,
      pendingDomains: registry.pendingDomains,
      invalidPackIds: registry.invalidPackIds
    });
    return res.json({ ok: true, registry });
  } catch (error) {
    logger.error('writinglab.policy_registry_failed', { err: error });
    return res.status(500).json({ ok: false, error: '정책 팩 상태를 불러오지 못했어요.' });
  }
});

router.post('/admin/writing-lab-metrics', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!user.admin) return res.status(403).json({ ok: false, error: '관리자 권한이 필요해요.' });
    const rows = await writingTelemetry.snapshot(req.body?.days);
    return res.json({ ok: true, version: 'writing-telemetry-v1', rows });
  } catch (error) {
    logger.error('writinglab.telemetry_admin_failed', { err: error });
    return res.status(500).json({ ok: false, error: '글쓰기 랩 운영 지표를 불러오지 못했어요.' });
  }
});

router.post('/writing-lab/v2/extract', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!enforceWritingV2(user, normalizeGenre(req.body?.genre), res)) return;
    if (!user.admin && bumpHourlyExtract(user.uid) > EXTRACT_HOURLY_CAP) {
      return res.status(429).json({
        ok: false,
        code: 'EXTRACT_RATE_LIMIT',
        error: '메모 분석 요청이 너무 잦아요. 직접 질문 칸에 입력하거나 잠시 후 다시 시도해 주세요.'
      });
    }
    const result = await extractCandidates({ genre: req.body?.genre, notes: req.body?.notes });
    logger.info('writinglab.v2.extract', {
      uid: user.uid,
      admin: user.admin,
      genre: result.genre,
      candidateCount: result.candidates.length
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    logger.error('writinglab.v2.extract_failed', { err: error });
    if (error?.code === 'NOTES_REQUIRED') {
      return res.status(error.status || 400).json({ ok: false, code: error.code, error: error.message });
    }
    return res.status(502).json({
      ok: false,
      code: 'NOTE_EXTRACTION_FAILED',
      error: '메모에서 정보 후보를 찾지 못했어요. 질문 칸에 직접 입력해 주세요.'
    });
  }
});

router.post('/writing-lab/v2/prepare', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const prepared = writingEngine.prepare(req.body || {});
    if (!enforceWritingV2(user, prepared.input.genre, res)) return;
    const assessmentToken = signContext({
      purpose: 'writing_lab_assessment',
      uid: user.uid,
      ledgerHash: prepared.ledger.hash,
      genre: prepared.input.genre,
      subtype: prepared.input.subtype
    }, { ttlMs: 30 * 60 * 1000 });
    logger.info('writinglab.v2.prepare', {
      uid: user.uid,
      admin: user.admin,
      genre: prepared.input.genre,
      subtype: prepared.input.subtype,
      readiness: prepared.assessment.status,
      factCount: prepared.assessment.confirmedFactCount,
      policyStatus: prepared.policy.status,
      targetFeasible: prepared.assessment.targetFeasible
    });
    void writingTelemetry.record(`PREPARE_${prepared.assessment.status}`, {
      genre: prepared.input.genre,
      policyStatus: prepared.policy.status
    });
    return res.json({ ok: true, ...prepared, assessmentToken });
  } catch (error) {
    logger.error('writinglab.v2.prepare_failed', { err: error });
    return sendWritingEngineError(res, error);
  }
});

router.post('/writing-lab/v2/generate', async (req, res) => {
  const startedAt = Date.now();
  let claimedJob = null;
  let telemetryGenre = '';
  let telemetryPolicyStatus = '';
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const shortMode = req.body?.shortMode === true;
    const prepared = writingEngine.prepare(req.body || {});
    telemetryGenre = prepared.input.genre;
    telemetryPolicyStatus = prepared.policy.status;
    if (!enforceWritingV2(user, prepared.input.genre, res)) return;
    const assessed = verifyContext(req.body?.assessmentToken);
    if (!assessed.ok) {
      return res.status(400).json({
        ok: false,
        code: assessed.code || 'ASSESSMENT_TOKEN_REQUIRED',
        error: '작성 가능 여부 확인이 만료됐어요. 입력과 설정을 다시 확인해 주세요.'
      });
    }
    if (assessed.context?.purpose !== 'writing_lab_assessment' || assessed.context?.uid !== user.uid) {
      return res.status(403).json({ ok: false, code: 'ASSESSMENT_OWNER_MISMATCH', error: '이 작성 확인 정보는 사용할 수 없어요.' });
    }
    if (assessed.context?.ledgerHash !== prepared.ledger.hash) {
      return res.status(409).json({
        ok: false,
        code: 'ASSESSMENT_STALE',
        error: '작성 확인 뒤 입력이나 설정이 바뀌었어요. 작성 가능 여부를 다시 확인해 주세요.'
      });
    }
    const preflight = v2PreflightError(prepared, shortMode);
    if (preflight) {
      return res.status(preflight.status).json({ ok: false, ...preflight });
    }
    const effectiveTarget = writingEngine.chooseTarget(prepared, shortMode);
    const requestId = writingJobs.normalizeRequestId(req.body?.requestId);
    if (!requestId) {
      return res.status(400).json({ ok: false, code: 'REQUEST_ID_REQUIRED', error: '작업 번호가 올바르지 않아요. 페이지를 새로고침한 뒤 다시 시도해 주세요.' });
    }
    const inputHash = crypto.createHash('sha256')
      .update(`${prepared.ledger.hash}:${shortMode ? 'short' : 'full'}`)
      .digest('hex');

    const existingJob = await writingJobs.get(user.uid, requestId);
    if (existingJob.inputHash && existingJob.inputHash !== inputHash) {
      return res.status(409).json({ ok: false, code: 'REQUEST_ID_INPUT_MISMATCH', error: '같은 작업 번호에 다른 입력을 사용할 수 없어요. 다시 만들기를 눌러 주세요.' });
    }
    if (existingJob.state === 'READY') return res.json(existingJob.result);
    if (existingJob.state === 'PROCESSING') {
      return res.status(202).json({ ok: true, status: 'PROCESSING', jobId: requestId, requestId });
    }

    if (!user.admin) {
      const successful = await writingUsage.successfulCount(user.uid);
      if (successful >= DAILY_GENERATE_CAP) {
        return res.status(429).json({
          ok: false,
          code: 'DAILY_CAP',
          error: `공개 가능한 글 생성은 하루 ${DAILY_GENERATE_CAP}회까지 이용할 수 있어요. 실패하거나 차단된 요청은 포함되지 않아요.`
        });
      }
    }

    const needed = generationCredits(effectiveTarget);
    let billing = { applied: false, credits: 0, plan: null };
    if (!user.admin) {
      try {
        const pre = await usageBilling.precheckCredits(user.idToken, needed);
        billing = { applied: pre.plan !== 'unlimited', credits: needed, plan: pre.plan };
      } catch (error) {
        const status = error.status || 401;
        const message = error.message === 'INSUFFICIENT_CREDITS'
          ? `크레딧이 부족해요. 이 글 생성에는 ${needed}크레딧이 필요합니다.`
          : usageBilling.authErrorMessage ? usageBilling.authErrorMessage(error.message) : '로그인이 필요해요.';
        return res.status(status).json({ ok: false, code: error.message, error: message, creditsRequired: needed });
      }
    }

    const claim = await writingJobs.begin(user.uid, requestId, inputHash);
    if (claim.state === 'ACCOUNT_DELETION') {
      return res.status(409).json({
        ok: false,
        code: 'ACCOUNT_DELETION_IN_PROGRESS',
        error: '회원 탈퇴 처리가 진행 중이라 새 글 작업을 시작할 수 없어요.',
      });
    }
    if (claim.state === 'UNAVAILABLE') {
      return res.status(503).json({
        ok: false,
        code: 'WRITING_JOB_PERSIST_UNAVAILABLE',
        error: '작업을 안전하게 저장하지 못했어요. 잠시 후 다시 시도해 주세요.',
      });
    }
    if (claim.state === 'MISMATCH' || claim.state === 'FORBIDDEN') {
      return res.status(409).json({ ok: false, code: 'REQUEST_ID_INPUT_MISMATCH', error: '이 작업 번호는 현재 입력에 사용할 수 없어요.' });
    }
    if (claim.state === 'READY') return res.json(claim.result);
    if (claim.state === 'PROCESSING') {
      return res.status(202).json({ ok: true, status: 'PROCESSING', jobId: requestId, requestId });
    }
    if (claim.state !== 'NEW') {
      return res.status(400).json({ ok: false, code: 'REQUEST_ID_REQUIRED', error: '작업 번호가 올바르지 않아요.' });
    }
    claimedJob = { uid: user.uid, requestId, inputHash, completed: false };

    const result = await writingEngine.generate(req.body || {}, { shortMode });
    const recoveryFallback = result.semantic?.deterministicProjection === true;
    const verificationToken = signContext({
      uid: user.uid,
      input: prepared.input,
      ledger: result.ledger,
      usedFactIds: result.usedFactIds,
      targetChars: result.assessment.effectiveTarget,
      policy: result.policy,
      safeDraft: result.draft,
      safeDraftRelease: result.semantic?.deterministicProjection === true
        ? 'deterministic_projection_v1'
        : 'semantic_consensus_v1'
    });

    if (!user.admin && billing.applied && !recoveryFallback) {
      try {
        await usageBilling.retryAsync(() => usageBilling.commitCreditDeduct(
          user.uid,
          needed,
          'writing_lab_v2_generate',
          requestId,
          { mode: `wl_v2_${result.genre}`, textLength: result.draft.length, engineVersion: result.engineVersion }
        ));
      } catch (error) {
        logger.error('writinglab.v2.charge_failed', { uid: user.uid, requestId, needed, err: error });
        throw new writingEngine.WritingEngineError(
          'BILLING_COMMIT_FAILED',
          '결제 확인을 완료하지 못했어요. 같은 작업을 다시 시도해도 중복 차감되지 않습니다.',
          503
        );
      }
    }
    let usageCommit = user.admin
      ? { committed: false, admin: true }
      : recoveryFallback
        ? { committed: false, recoveryFallback: true }
        : await writingUsage.commitSuccessful(user.uid, requestId, DAILY_GENERATE_CAP);
    if (!user.admin && (usageCommit.capReached || usageCommit.unavailable)) {
      let restored = !billing.applied;
      if (billing.applied) {
        try {
          await usageBilling.retryAsync(() => usageBilling.commitCreditRestore(
            user.uid,
            needed,
            'writing_lab_v2_generate',
            requestId
          ));
          restored = true;
        } catch (restoreError) {
          logger.error('writinglab.v2.cap_restore_failed', { uid: user.uid, requestId, needed, err: restoreError });
        }
      }
      if (restored) {
        throw new writingEngine.WritingEngineError(
          usageCommit.capReached ? 'DAILY_CAP' : 'WRITING_USAGE_UNAVAILABLE',
          usageCommit.capReached
            ? `공개 가능한 글 생성은 하루 ${DAILY_GENERATE_CAP}회까지 이용할 수 있어요. 이번 요청은 차감하지 않았습니다.`
            : '성공 한도 기록을 안전하게 완료하지 못해 이번 요청을 차감하지 않았어요. 잠시 후 다시 시도해 주세요.',
          usageCommit.capReached ? 429 : 503
        );
      }
      usageCommit = { ...usageCommit, reconciliationRequired: true };
    }

    const publicBilling = user.admin
      ? { applied: false, credits: 0, admin: true }
      : recoveryFallback
        ? { applied: false, credits: 0, plan: billing.plan, waivedReason: 'deterministic_recovery_fallback' }
        : { applied: billing.applied, credits: billing.applied ? needed : 0, plan: billing.plan };
    const usage = { elapsedMs: Date.now() - startedAt, daily: usageCommit };
    const payload = publicGenerationResult(result, { verificationToken, billing: publicBilling, usage, requestId });
    await writingJobs.complete(user.uid, requestId, inputHash, payload);
    claimedJob.completed = true;
    void writingTelemetry.record(recoveryFallback ? 'GENERATE_FALLBACK_READY' : 'GENERATE_READY', {
      genre: result.genre,
      policyStatus: result.policy.status,
      elapsedMs: Date.now() - startedAt
    });

    logger.info('writinglab.v2.generate', {
      uid: user.uid,
      admin: user.admin,
      genre: result.genre,
      subtype: result.subtype,
      readiness: result.assessment.status,
      shortMode,
      targetChars: result.assessment.effectiveTarget,
      draftLength: result.draft.length,
      releaseStatus: result.release.status,
      policyStatus: result.policy.status,
      generationSource: recoveryFallback ? 'deterministic_projection' : 'model_verified',
      chargedCredits: !user.admin && billing.applied && !recoveryFallback ? needed : 0,
      usageCommitted: usageCommit.committed === true,
      elapsedMs: Date.now() - startedAt
    });

    return res.json(payload);
  } catch (error) {
    if (claimedJob && !claimedJob.completed) {
      await writingJobs.fail(claimedJob.uid, claimedJob.requestId, claimedJob.inputHash, error);
      void writingTelemetry.record('GENERATE_FAILED', {
        genre: telemetryGenre,
        policyStatus: telemetryPolicyStatus,
        elapsedMs: Date.now() - startedAt
      });
    }
    logger.error('writinglab.v2.generate_failed', { elapsedMs: Date.now() - startedAt, err: error });
    return sendWritingEngineError(res, error);
  }
});

router.get('/writing-lab/v2/jobs/:jobId', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const job = await writingJobs.get(user.uid, req.params.jobId);
    if (job.state === 'INVALID' || job.state === 'NOT_FOUND') {
      return res.status(404).json({ ok: false, code: 'WRITING_JOB_NOT_FOUND', error: '복구할 글쓰기 작업을 찾지 못했어요.' });
    }
    if (job.state === 'FORBIDDEN') return res.status(403).json({ ok: false, code: 'WRITING_JOB_FORBIDDEN', error: '이 작업을 확인할 수 없어요.' });
    if (job.state === 'UNAVAILABLE') return res.status(503).json({ ok: false, code: 'WRITING_JOB_UNAVAILABLE', error: '작업 상태를 잠시 확인할 수 없어요.' });
    if (job.state === 'READY') return res.json(job.result);
    if (job.state === 'FAILED') {
      return res.status(job.error?.retryable ? 503 : 422).json({
        ok: false,
        status: 'FAILED',
        code: job.error?.code || 'WRITING_JOB_FAILED',
        error: job.error?.message || '글 생성에 실패했어요.',
        retryable: job.error?.retryable === true
      });
    }
    return res.status(202).json({ ok: true, status: 'PROCESSING', jobId: req.params.jobId });
  } catch (error) {
    logger.error('writinglab.v2.job_read_failed', { jobId: req.params.jobId, err: error });
    return res.status(500).json({ ok: false, code: 'WRITING_JOB_READ_FAILED', error: '작업 상태를 불러오지 못했어요.' });
  }
});

router.post('/writing-lab/v2/check', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!user.admin && bumpHourlyCheck(user.uid) > CHECK_HOURLY_CAP) {
      return res.status(429).json({ ok: false, code: 'CHECK_RATE_LIMIT', error: '검사 요청이 너무 잦아요. 잠시 후 다시 시도해 주세요.' });
    }
    const verified = verifyContext(req.body?.verificationToken);
    if (!verified.ok) {
      return res.status(400).json({ ok: false, code: verified.code, error: '검수 기준이 만료됐거나 올바르지 않아요. 입력 화면에서 다시 만들어 주세요.' });
    }
    if (verified.context.uid !== user.uid) {
      return res.status(403).json({ ok: false, code: 'CONTEXT_OWNER_MISMATCH', error: '다른 사용자의 검수 기준은 사용할 수 없어요.' });
    }
    const report = await writingEngine.verifyExisting(req.body?.text, verified.context);
    void writingTelemetry.record(report.release.pass ? 'FINAL_CHECK_READY' : 'FINAL_CHECK_BLOCKED', {
      genre: verified.context.input?.genre,
      policyStatus: verified.context.policy?.status
    });
    logger.info('writinglab.v2.check', {
      uid: user.uid,
      genre: verified.context.input?.genre,
      releaseStatus: report.release.status,
      reasons: report.release.reasons
    });
    return res.json(report);
  } catch (error) {
    logger.error('writinglab.v2.check_failed', { err: error });
    return sendWritingEngineError(res, error);
  }
});

router.post('/writing-lab/v2/finalize', async (req, res) => {
  const startedAt = Date.now();
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!user.admin && bumpHourlyCheck(user.uid) > CHECK_HOURLY_CAP) {
      return res.status(429).json({ ok: false, code: 'CHECK_RATE_LIMIT', error: '최종 검사 요청이 너무 잦아요. 잠시 후 다시 시도해 주세요.' });
    }
    const verified = verifyContext(req.body?.verificationToken);
    if (!verified.ok) {
      return res.status(400).json({ ok: false, code: verified.code, error: '검수 기준이 만료됐거나 올바르지 않아요. 입력 화면에서 다시 만들어 주세요.' });
    }
    if (verified.context.uid !== user.uid) {
      return res.status(403).json({ ok: false, code: 'CONTEXT_OWNER_MISMATCH', error: '다른 사용자의 검수 기준은 사용할 수 없어요.' });
    }
    const report = await writingEngine.finalizeExisting(req.body?.text, verified.context);
    const event = report.delivery?.source === 'humanized'
      ? 'FINALIZE_HUMANIZED'
      : report.delivery?.source === 'humanized_repaired'
        ? 'FINALIZE_REPAIRED'
        : report.delivery?.source === 'verified_generation_fallback'
          ? 'FINALIZE_FALLBACK'
          : 'FINALIZE_BLOCKED';
    void writingTelemetry.record(event, {
      genre: verified.context.input?.genre,
      policyStatus: verified.context.policy?.status,
      elapsedMs: Date.now() - startedAt
    });
    logger.info('writinglab.v2.finalize', {
      uid: user.uid,
      genre: verified.context.input?.genre,
      deliverySource: report.delivery?.source,
      releaseStatus: report.release?.status,
      repairRounds: report.delivery?.repairRounds,
      elapsedMs: Date.now() - startedAt
    });
    return res.json(report);
  } catch (error) {
    logger.error('writinglab.v2.finalize_failed', { elapsedMs: Date.now() - startedAt, err: error });
    return sendWritingEngineError(res, error);
  }
});

router.post('/writing-lab/v2/client-event', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!user.admin && bumpHourlyClientEvent(user.uid) > CLIENT_EVENT_HOURLY_CAP) {
      return res.status(429).json({ ok: false, code: 'CLIENT_EVENT_RATE_LIMIT', error: '운영 이벤트 한도를 초과했어요.' });
    }
    const event = String(req.body?.event || '').toUpperCase();
    const recorded = await writingTelemetry.record(event, { genre: normalizeGenre(req.body?.genre) });
    if (!recorded.recorded) return res.status(400).json({ ok: false, code: 'INVALID_CLIENT_EVENT', error: '지원하지 않는 운영 이벤트예요.' });
    return res.json({ ok: true });
  } catch (error) {
    logger.warn('writinglab.client_event_failed', { err: error });
    return res.status(500).json({ ok: false, error: '운영 이벤트를 기록하지 못했어요.' });
  }
});

// ── GET /writing-lab/pricing — 프런트 견적의 단일 출처(공개) ──
router.get('/writing-lab/pricing', (req, res) => {
  res.json({
    ok: true,
    generation: GENERATION_PRICING,
    humanize: { perHundredChars: 2, minCredits: 10 },   // 기본 휴머나이징(/transform blog) 단가 — lib/humanizePricing과 동일 산식
    dailyCap: DAILY_GENERATE_CAP,
    genres: Object.fromEntries(Object.entries(GENRES).map(([k, g]) => [k, {
      label: g.label, topicLabel: g.topicLabel, ctx1Label: g.ctx1Label, ctx2Label: g.ctx2Label,
      factLabels: g.factLabels, defaultLength: g.defaultLength, documentProfile: g.documentProfile, basicStyle: g.basicStyle
    }]))
  });
});

// ── POST /writing-lab/generate ──────────────────────────────────
router.post('/writing-lab/generate', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!user.admin && process.env.WRITING_LAB_V1_PUBLIC !== '1') {
      return res.status(410).json({
        code: 'WRITING_LAB_V1_RETIRED',
        error: '이전 글쓰기 방식은 사실 검수 기준이 낮아 종료됐어요. 새 글쓰기 랩을 이용해 주세요.'
      });
    }

    const genre = normalizeGenre(req.body && req.body.genre);
    const g = GENRES[genre];
    const topic = cleanText(req.body && (req.body.topic != null ? req.body.topic : req.body.question), TOPIC_MAX);
    if (topic.length < 5) return res.status(400).json({ error: `${g.topicLabel}을(를) 입력해 주세요(5자 이상).` });
    const ctx1 = cleanText(req.body && (req.body.context1 != null ? req.body.context1 : req.body.company), 160);
    const ctx2 = cleanText(req.body && (req.body.context2 != null ? req.body.context2 : req.body.role), 160);
    const emphasis = cleanText(req.body && req.body.emphasis, 300);
    const tone = ['formal', 'friendly'].includes(String(req.body && req.body.tone || '')) ? String(req.body.tone) : '';
    const memo = readMemo(req.body);
    if (!memo.experience && !memo.caseExample && !memo.numbers && !memo.thoughts) {
      return res.status(400).json({ code: 'FACTS_REQUIRED', error: '사실 카드를 최소 한 칸은 채워 주세요 — 지어내지 않는 생성의 근거가 됩니다.' });
    }
    const rawTarget = Number(req.body && req.body.targetChars);
    const targetChars = Number.isFinite(rawTarget) && rawTarget > 0
      ? Math.max(TARGET_CHARS_MIN, Math.min(TARGET_CHARS_MAX, Math.round(rawTarget)))
      : 0;
    const charLimitMode = normalizeCharLimitMode(req.body && req.body.charLimitMode);

    // v1 호환 경로도 단일 정규식 대신 v2 정책 팩을 사용한다.
    const legacyPolicy = writingEngine.prepare({
      genre,
      topic,
      context1: ctx1,
      context2: ctx2,
      emphasis,
      tone,
      targetChars,
      charLimitMode,
      memo
    }).policy;
    if (!legacyPolicy.canGenerate) {
      return res.status(400).json({
        code: legacyPolicy.status === 'BLOCK' ? 'POLICY_BLOCKED' : 'POLICY_REVIEW_REQUIRED',
        error: legacyPolicy.issues[0]?.message || '정책 확인이 필요한 내용이라 자동 생성할 수 없어요.',
        policy: legacyPolicy
      });
    }

    // 과금: 관리자·dev는 무과금(실험), 일반 사용자는 잔액 선확인 후 성공 시에만 차감.
    const needed = generationCredits(targetChars);
    let billing = { applied: false, credits: 0, plan: null };
    if (!user.admin) {
      const successful = await writingUsage.successfulCount(user.uid);
      if (successful >= DAILY_GENERATE_CAP) {
        return res.status(429).json({ code: 'DAILY_CAP', error: `글 생성은 하루 ${DAILY_GENERATE_CAP}회까지 이용할 수 있어요. 내일 다시 시도해 주세요.` });
      }
      let pre;
      try {
        pre = await usageBilling.precheckCredits(user.idToken, needed);
      } catch (error) {
        const status = error.status || 401;
        const msg = error.message === 'INSUFFICIENT_CREDITS'
          ? `크레딧이 부족해요. 이 글 생성에는 ${needed}크레딧이 필요합니다.`
          : usageBilling.authErrorMessage ? usageBilling.authErrorMessage(error.message) : '로그인이 필요해요.';
        return res.status(status).json({ code: error.message, error: msg, creditsRequired: needed });
      }
      billing = { applied: pre.plan !== 'unlimited', credits: needed, plan: pre.plan };
    }

    const factsheet = buildFactsheet(genre, { ctx1, ctx2, topic, memo, emphasis });
    const userText = [
      `[${g.ctx1Label}] ${ctx1 || '(미입력)'}`,
      `[${g.ctx2Label}] ${ctx2 || '(미입력)'}`,
      '',
      `[${g.topicLabel}]`,
      topic,
      '',
      '[사실 카드 — 본문에 쓸 수 있는 유일한 근거]',
      factsheet,
      '',
      targetChars
        ? `[목표 분량] ${targetChars}자 (${charLimitMode === 'no_space' ? '공백 제외' : charLimitMode === 'byte2' ? '한글 2byte 바이트' : '공백 포함'})`
        : `[목표 분량] ${g.defaultLength}`,
      '',
      `위 사실 카드만으로 ${g.topicLabel}에 맞는 ${g.label} 본문을 작성하라.`
    ].join('\n');

    const startedAt = Date.now();
    const requestId = `wlgen_${crypto.randomBytes(8).toString('hex')}`;
    const data = await compat.callGpt({
      userText,
      systemText: writerSystemPrompt(genre, { targetChars, charLimitMode, tone }),
      tool: WRITER_TOOL,
      maxOutputTokens: 6144,
      task: 'humanize_writing_lab_generate',   // 'humanize' 포함 → 운영 기본 모델(humanizePrimary) 사용
      phase: 'main',
      mode: `wl_${genre}`
    });
    const parsed = compat.extractGptResult(data, WRITER_TOOL.name);
    const draft = cleanText(parsed.draft, CHECK_TEXT_MAX);
    if (!draft) return res.status(502).json({ error: '생성 결과가 비어 있습니다. 다시 시도해 주세요.' });

    // 성공 후 차감(멱등) — 차감 실패는 결과 전달을 막지 않는다(transform의 charge_failed 규율과 동일).
    if (!user.admin && billing.applied) {
      try {
        await usageBilling.commitCreditDeduct(user.uid, needed, 'writing_lab_generate', requestId, {
          mode: `wl_${genre}`, textLength: draft.length
        });
      } catch (e) {
        billing = { ...billing, applied: false, failed: true };
        logger.error('writinglab.charge_failed', { uid: user.uid, requestId, needed, err: e });
      }
    }

    const checks = runFactChecks(draft, factsheet, { topic, targetChars, charLimitMode });
    const usageCommit = user.admin
      ? { committed: false, admin: true }
      : await writingUsage.commitSuccessful(user.uid, requestId, DAILY_GENERATE_CAP);
    const usage = data.usage || {};
    logger.info('writinglab.generate', {
      uid: user.uid,
      admin: user.admin,
      genre,
      topicLength: topic.length,
      draftLength: draft.length,
      targetChars,
      charLimitMode,
      model: data.model,
      estimatedUsd: usage.estimatedUsd,
      elapsedMs: Date.now() - startedAt,
      chargedCredits: !user.admin && billing.applied !== false && !billing.failed ? needed : 0,
      noveltyCandidate: !!(checks.experienceNovelty && checks.experienceNovelty.candidate),
      fabricatedNumberCandidates: checks.fabricatedNumberCandidates.length
    });
    return res.json({
      ok: true,
      genre,
      draft,
      usedFacts: Array.isArray(parsed.usedFacts) ? parsed.usedFacts.slice(0, 12) : [],
      followupQuestions: Array.isArray(parsed.followupQuestions) ? parsed.followupQuestions.slice(0, 6) : [],
      factsheet,
      checks,
      billing: user.admin ? { applied: false, credits: 0, admin: true } : { applied: billing.applied && !billing.failed, credits: billing.applied && !billing.failed ? needed : 0, plan: billing.plan },
      humanize: { documentProfile: g.documentProfile, basicStyle: g.basicStyle },
      usage: {
        model: data.model,
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        estimatedUsd: usage.estimatedUsd || 0,
        elapsedMs: Date.now() - startedAt,
        daily: usageCommit
      }
    });
  } catch (e) {
    logger.error('writinglab.generate_failed', { err: e });
    const message = e && e.code === 'OPENAI_QUOTA_EXHAUSTED'
      ? 'API 사용량 한도로 생성에 실패했습니다.'
      : '생성에 실패했습니다. 잠시 후 다시 시도해 주세요. 크레딧은 차감되지 않았어요.';
    return res.status(502).json({ error: message, code: e && e.code ? String(e.code) : 'WRITING_LAB_GENERATE_FAILED' });
  }
});

// ── POST /writing-lab/check ─────────────────────────────────────
// 휴머나이징을 거친 결과를 같은 팩트시트 기준으로 재검사한다(무LLM·무과금·즉시).
router.post('/writing-lab/check', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!user.admin && process.env.WRITING_LAB_V1_PUBLIC !== '1') {
      return res.status(410).json({ code: 'WRITING_LAB_V1_RETIRED', error: '이전 검수 방식은 종료됐어요. 새 글쓰기 랩에서 다시 확인해 주세요.' });
    }
    if (!user.admin && bumpHourlyCheck(user.uid) > CHECK_HOURLY_CAP) {
      return res.status(429).json({ error: '검사 요청이 너무 잦아요. 잠시 후 다시 시도해 주세요.' });
    }
    const text = cleanText(req.body && req.body.text, CHECK_TEXT_MAX);
    if (!text) return res.status(400).json({ error: '검사할 텍스트가 없습니다.' });
    const genre = normalizeGenre(req.body && req.body.genre);
    const topic = cleanText(req.body && (req.body.topic != null ? req.body.topic : req.body.question), TOPIC_MAX);
    const memo = readMemo(req.body);
    const ctx1 = cleanText(req.body && (req.body.context1 != null ? req.body.context1 : req.body.company), 160);
    const ctx2 = cleanText(req.body && (req.body.context2 != null ? req.body.context2 : req.body.role), 160);
    const emphasis = cleanText(req.body && req.body.emphasis, 300);
    const rawTarget = Number(req.body && req.body.targetChars);
    const targetChars = Number.isFinite(rawTarget) && rawTarget > 0
      ? Math.max(TARGET_CHARS_MIN, Math.min(TARGET_CHARS_MAX, Math.round(rawTarget)))
      : 0;
    const charLimitMode = normalizeCharLimitMode(req.body && req.body.charLimitMode);
    const factsheet = typeof req.body.factsheet === 'string' && req.body.factsheet.trim()
      ? cleanText(req.body.factsheet, MEMO_FIELD_MAX * 5)
      : buildFactsheet(genre, { ctx1, ctx2, topic, memo, emphasis });
    const checks = runFactChecks(text, factsheet, { topic, targetChars, charLimitMode });
    return res.json({ ok: true, checks });
  } catch (e) {
    logger.error('writinglab.check_failed', { err: e });
    return res.status(500).json({ error: '검사에 실패했습니다.' });
  }
});

module.exports = router;
