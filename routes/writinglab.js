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
const { verifyToken, ADMIN_UIDS } = require('../config');
const { bearerToken } = require('../lib/reqtoken');
const { logger, setLogContext } = require('../lib/logger');
const usageBilling = require('../lib/usageBilling');
const compat = require('../engine-gpt-prod/compat');
const experienceAudit = require('../engine-gpt-prod/experienceAudit');

const TOPIC_MAX = 1200;
const MEMO_FIELD_MAX = 2000;
const CHECK_TEXT_MAX = 12000;
const TARGET_CHARS_MIN = 100;
const TARGET_CHARS_MAX = 3000;
const DAILY_GENERATE_CAP = Math.max(1, Number(process.env.WRITING_LAB_DAILY_CAP) || 30);   // 일반 사용자 일일 생성 상한(남용 방어)
const CHECK_HOURLY_CAP = Math.max(10, Number(process.env.WRITING_LAB_CHECK_HOURLY_CAP) || 120);

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

// 의료광고 가드(후기·소개 장르): 치료경험담·효능 후기는 의료법 56조 규제 영역 — 결정론 차단.
const MEDICAL_RE = /(시술|성형|보톡스|필러|리프팅|임플란트|치아\s*교정|피부과|성형외과|한의원|의원\s*후기|병원\s*후기|클리닉|도수치료|다이어트\s*(약|주사|한약)|지방\s*흡입|줄기세포|탈모\s*치료|라식|라섹|시력\s*교정)/;

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

// ── 남용 방어: 일반 사용자 일일 생성 캡 + 검사 시간당 캡(메모리 — 재시작 리셋은 사용자에게 유리한 방향) ──
const dailyGenerates = new Map();   // uid → { day, count }
const hourlyChecks = new Map();     // uid → { hour, count }
setInterval(() => {
  const day = new Date().toISOString().slice(0, 10);
  const hour = Math.floor(Date.now() / 3600000);
  for (const [k, v] of dailyGenerates) if (v.day !== day) dailyGenerates.delete(k);
  for (const [k, v] of hourlyChecks) if (v.hour !== hour) hourlyChecks.delete(k);
}, 60 * 60 * 1000).unref();

function bumpDailyGenerate(uid) {
  const day = new Date().toISOString().slice(0, 10);
  const cur = dailyGenerates.get(uid);
  const count = cur && cur.day === day ? cur.count + 1 : 1;
  dailyGenerates.set(uid, { day, count });
  return count;
}

function bumpHourlyCheck(uid) {
  const hour = Math.floor(Date.now() / 3600000);
  const cur = hourlyChecks.get(uid);
  const count = cur && cur.hour === hour ? cur.count + 1 : 1;
  hourlyChecks.set(uid, { hour, count });
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
  return { uid, admin: isAdminUid(uid), idToken };
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
  return {
    applicable: true,
    mode,
    target: targetChars,
    used,
    over: Math.max(0, used - targetChars),
    usageRatio: Math.round((used / targetChars) * 1000) / 1000,
    pass: used <= targetChars
  };
}

// 결과 텍스트의 숫자 중 팩트시트(+주제)에 근거가 없는 것 — "날조 수치 후보". 판단은 사용자 몫.
const NUMBER_RE = /\d[\d,.]*\s*(?:%|퍼센트|퍼|명|건|회|번|년|년간|개월|주|일|시간|분|배|원|만\s*원|억|위|등|점|개|팀|과목|학점|kg|km|cm|시간대)?/g;
function numberTokens(text) {
  const found = String(text || '').match(NUMBER_RE) || [];
  return found.map(t => t.replace(/[\s,]/g, ''));
}
function fabricatedNumberCandidates(outputText, factsheet) {
  const allowed = new Set(numberTokens(factsheet));
  const allowedDigits = new Set([...allowed].map(t => t.replace(/[^\d.]/g, '')));
  const candidates = [];
  for (const token of numberTokens(outputText)) {
    if (allowed.has(token)) continue;
    const digits = token.replace(/[^\d.]/g, '');
    if (!digits || allowedDigits.has(digits)) continue;   // 단위만 달라진 같은 숫자는 허용
    if (!candidates.includes(token)) candidates.push(token);
  }
  return candidates.slice(0, 20);
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
    '- 사실 카드에 없는 경험·수치·고유명사를 절대 만들어내지 않는다. 구체 정보가 부족한 대목은 수치 없이 과정·일반 서술로 쓰고, 대신 followupQuestions에 사용자에게 확인할 질문을 남긴다.',
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

    // 의료 후기·효능 광고 가드(후기·소개 장르) — 의료법 56조 영역은 생성하지 않는다.
    if ((genre === 'review_blog' || genre === 'marketing') && MEDICAL_RE.test(`${topic}\n${ctx1}\n${ctx2}\n${memo.experience}\n${memo.caseExample}`)) {
      return res.status(400).json({
        code: 'MEDICAL_AD_BLOCKED',
        error: '의료 시술·치료 경험담과 효능 후기는 의료광고 규제(의료법 56조) 대상이라 생성해 드릴 수 없어요.'
      });
    }

    // 과금: 관리자·dev는 무과금(실험), 일반 사용자는 잔액 선확인 후 성공 시에만 차감.
    const needed = generationCredits(targetChars);
    let billing = { applied: false, credits: 0, plan: null };
    if (!user.admin) {
      const capCount = bumpDailyGenerate(user.uid);
      if (capCount > DAILY_GENERATE_CAP) {
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
        elapsedMs: Date.now() - startedAt
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
