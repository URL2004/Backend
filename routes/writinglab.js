// [routes/writinglab.js] 관리자 실험: 자소서 생성 랩(글쓰기 랩 Phase 1 프로토타입, 2026-08-24)
// ────────────────────────────────────────────────────────────────
// 목적: "장르 맞춤 생성 → 휴머나이징 → 무날조 검수" 결합 파이프라인의 1단계(생성)와 3단계(검수)를 제공한다.
//   2단계(휴머나이징)는 기존 /transform(adminHumanizeLab, 무과금)을 프런트가 그대로 체인해 재사용한다.
// - POST /writing-lab/generate : 문항+사실 카드 → Writer 생성(LLM 1회) + 팩트시트 기준 결정론 검사. 관리자 전용·무과금.
// - POST /writing-lab/check    : 임의 텍스트를 팩트시트 기준으로 재검사(휴머나이징 결과 재검수용). 무LLM·즉시 응답.
// 무날조 원칙: 생성 경로에는 "원문"이 없으므로, 사용자가 준 사실 카드로 팩트시트(의사 원문)를 합성해
//   기존 경험 날조 감사(engine-gpt-prod/experienceAudit)를 그대로 돌린다. 수치는 팩트시트에 없는 숫자를 후보로 보고한다.
// 운영 영향 없음: 신규 경로만 추가하며 기존 /transform·과금·히스토리는 건드리지 않는다.

const express = require('express');
const router = express.Router();
const { verifyToken, ADMIN_UIDS } = require('../config');
const { bearerToken } = require('../lib/reqtoken');
const { logger, setLogContext } = require('../lib/logger');
const compat = require('../engine-gpt-prod/compat');
const experienceAudit = require('../engine-gpt-prod/experienceAudit');

const QUESTION_MAX = 1200;
const MEMO_FIELD_MAX = 2000;
const CHECK_TEXT_MAX = 12000;
const TARGET_CHARS_MIN = 100;
const TARGET_CHARS_MAX = 3000;

// 엔진 핑거프린트·자소서 상투구(2026-07 주간 리뷰 실측 "그치지 않고" 계열 포함) — 개수만 보고, 차단은 관리자 판단.
const CLICHE_PATTERNS = [
  { key: '그치지 않고', re: /(?:에|에서)?\s*그치지\s*않(?:고|았)/g },
  { key: '머무르지 않고', re: /(?:에|에서)?\s*머무르지\s*않(?:고|았)/g },
  { key: '멈추지 않고', re: /(?:에서)?\s*멈추지\s*않(?:고|았)/g },
  { key: '단순히 ~을 넘어', re: /단순(?:히|한)\s*[^,.\n]{0,14}(?:을|를)?\s*넘어/g },
  { key: '뿐만 아니라', re: /뿐만\s*아니라/g },
  { key: '나아가', re: /(?:^|[\s,.])나아가(?=[\s,])/g }
];

// 문항 키워드 추출에서 뺄 상투어(문항 지시어) — "응답성 후보" 휴리스틱용.
const QUESTION_STOPWORDS = new Set([
  '자신', '본인', '무엇', '어떤', '어떻게', '대해', '대한', '관해', '관련', '경험', '사례', '과정',
  '작성', '서술', '기술', '설명', '말씀', '주세요', '주십시오', '바랍니다', '있는', '있다면', '있었던',
  '통해', '위해', '이내', '이상', '글자', '기준', '포함', '제외', '공백', '문항', '지원', '당사', '우리',
  '말해', '말하', '적어', '써서', '들어', '무슨', '언제', '어디', '왜요', '해서'
]);

function isAdminUid(uid) {
  return ADMIN_UIDS.includes(uid);
}

async function requireAdmin(req, res) {
  const devNoAuth = !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1';
  if (devNoAuth) return 'dev-local';
  const idToken = bearerToken(req);
  const uid = await verifyToken(idToken);
  if (!uid) {
    res.status(401).json({ error: '관리자 테스트는 로그인이 필요해요.' });
    return null;
  }
  if (!isAdminUid(uid)) {
    res.status(403).json({ error: '관리자만 사용할 수 있는 테스트 페이지입니다.' });
    return null;
  }
  setLogContext({ uid, actorUid: uid });
  return uid;
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim().slice(0, max);
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
function buildFactsheet({ company, role, question, memo, emphasis }) {
  const lines = [];
  if (company) lines.push(`[지원 회사] ${company}`);
  if (role) lines.push(`[지원 직무] ${role}`);
  if (question) lines.push(`[자기소개서 문항] ${question}`);
  if (memo.experience) lines.push(`[직접 겪은 일·경험] ${memo.experience}`);
  if (memo.caseExample) lines.push(`[구체적 사례·예시] ${memo.caseExample}`);
  if (memo.numbers) lines.push(`[정확히 아는 수치·출처] ${memo.numbers}`);
  if (memo.thoughts) lines.push(`[내 생각·입장] ${memo.thoughts}`);
  if (emphasis) lines.push(`[강조할 역량] ${emphasis}`);
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

// 결과 텍스트의 숫자 중 팩트시트(+문항)에 근거가 없는 것 — "날조 수치 후보". 판단은 관리자 몫.
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

// 문항 핵심 키워드가 본문에 안 보이면 "미반영 후보"로만 보고(휴리스틱 — 동의어는 못 본다).
function questionKeywordGaps(question, outputText) {
  const tokens = String(question || '').match(/[가-힣]{2,8}/g) || [];
  const body = String(outputText || '');
  const seen = new Set();
  const missing = [];
  for (const raw of tokens) {
    const token = raw
      .replace(/(?:에서|에게|과의|와의|으로|로서|로써|이란|라는|이라|하기|하는|했던|인가)$/u, '')
      .replace(/(?:[을를은는이가의에도])$/u, '');
    if (token.length < 2 || QUESTION_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    if (!body.includes(token) && !body.includes(token.slice(0, 2))) missing.push(token);
  }
  return missing.slice(0, 8);
}

function runFactChecks(outputText, factsheet, { question, targetChars, charLimitMode } = {}) {
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
    fabricatedNumberCandidates: fabricatedNumberCandidates(outputText, `${factsheet}\n${question || ''}`),
    cliches: clicheReport(outputText),
    questionKeywordGaps: questionKeywordGaps(question, outputText)
  };
}

function writerSystemPrompt({ targetChars, charLimitMode }) {
  const modeLabel = charLimitMode === 'no_space' ? '공백 제외' : charLimitMode === 'byte2' ? '바이트(한글 2byte)' : '공백 포함';
  const lengthLine = targetChars
    ? `- 목표 분량: ${modeLabel} 기준 ${targetChars}자의 88~100%. 절대 초과하지 않는다.`
    : '- 목표 분량: 공백 포함 600~900자.';
  return [
    '당신은 한국어 자기소개서 전문 작가다. 아래 계약을 절대 어기지 않는다.',
    '',
    '[무날조 계약 — 최우선]',
    '- 본문에 쓸 수 있는 경험·사례·수치·기간·직책·수상·자격은 사용자 입력의 [사실 카드]에 적힌 것뿐이다.',
    '- 사실 카드에 없는 경험·수치·고유명사를 절대 만들어내지 않는다. 구체 정보가 부족한 대목은 수치 없이 과정 중심으로 서술하고, 대신 followupQuestions에 지원자에게 확인할 질문을 남긴다.',
    '- 회사명·직무명은 [지원 정보]에 적힌 그대로만 쓴다. 회사에 대한 구체적 사실(매출·연혁·제품명 등)은 사실 카드에 없으면 쓰지 않는다.',
    '',
    '[문항 응답 계약]',
    '- 첫 문장부터 문항이 묻는 것에 직접 답한다(두괄식). 문항과 무관한 일반론·명언·자기 다짐으로 시작하지 않는다.',
    '- 경험 서술은 상황 → 본인의 행동 → 결과 → 배운 점의 흐름을 기본으로 하되, 소제목이나 번호로 기계적으로 나누지 않는다.',
    '- 행동의 주어는 항상 지원자 본인이 되게 쓴다.',
    '',
    '[분량 계약]',
    lengthLine,
    '',
    '[문체 계약]',
    "- 종결체는 '-습니다'로 통일하고 1인칭은 '저'를 쓴다.",
    '- 금지 표현: "~에 그치지 않고", "~에 머무르지 않고", "단순히 ~을 넘어", "뿐만 아니라"의 반복, "나아가"의 반복, "책임감 있고 성실한" 같은 형용사 나열식 자기 미화.',
    '- 문장 길이를 다양하게 섞고, 같은 종결 패턴을 세 문장 이상 반복하지 않는다.',
    '- 번역투·개조식 표현을 피하고 자연스러운 한국어 문장으로 쓴다.',
    '',
    '결과는 지정된 JSON 스키마로만 반환한다. draft에는 자기소개서 본문만 넣는다(제목·문항 반복·설명 금지).'
  ].join('\n');
}

const WRITER_TOOL = {
  name: 'writing_lab_resume_draft',
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

// ── POST /writing-lab/generate ──────────────────────────────────
router.post('/writing-lab/generate', async (req, res) => {
  try {
    const uid = await requireAdmin(req, res);
    if (!uid) return;

    const question = cleanText(req.body && req.body.question, QUESTION_MAX);
    if (question.length < 5) return res.status(400).json({ error: '자기소개서 문항을 입력해 주세요(5자 이상).' });
    const company = cleanText(req.body && req.body.company, 120);
    const role = cleanText(req.body && req.body.role, 120);
    const emphasis = cleanText(req.body && req.body.emphasis, 300);
    const memo = readMemo(req.body);
    if (!memo.experience && !memo.caseExample && !memo.numbers && !memo.thoughts) {
      return res.status(400).json({ error: '사실 카드(경험 메모)를 최소 한 칸은 채워 주세요 — 무날조 생성의 근거가 됩니다.' });
    }
    const rawTarget = Number(req.body && req.body.targetChars);
    const targetChars = Number.isFinite(rawTarget) && rawTarget > 0
      ? Math.max(TARGET_CHARS_MIN, Math.min(TARGET_CHARS_MAX, Math.round(rawTarget)))
      : 0;
    const charLimitMode = normalizeCharLimitMode(req.body && req.body.charLimitMode);

    const factsheet = buildFactsheet({ company, role, question, memo, emphasis });
    const userText = [
      '[지원 정보]',
      `회사: ${company || '(미입력)'}`,
      `직무: ${role || '(미입력)'}`,
      '',
      '[자기소개서 문항]',
      question,
      '',
      '[사실 카드 — 본문에 쓸 수 있는 유일한 근거]',
      factsheet,
      '',
      targetChars ? `[목표 분량] ${targetChars}자 (${charLimitMode === 'no_space' ? '공백 제외' : charLimitMode === 'byte2' ? '한글 2byte 바이트' : '공백 포함'})` : '[목표 분량] 600~900자(공백 포함)',
      '',
      '위 사실 카드만으로 문항에 답하는 자기소개서 본문을 작성하라.'
    ].join('\n');

    const startedAt = Date.now();
    const data = await compat.callGpt({
      userText,
      systemText: writerSystemPrompt({ targetChars, charLimitMode }),
      tool: WRITER_TOOL,
      maxOutputTokens: 4096,
      task: 'humanize_writing_lab_generate',   // 'humanize' 포함 → 운영 기본 모델(humanizePrimary) 사용
      phase: 'main',
      mode: 'writing_lab'
    });
    const parsed = compat.extractGptResult(data, WRITER_TOOL.name);
    const draft = cleanText(parsed.draft, CHECK_TEXT_MAX);
    if (!draft) return res.status(502).json({ error: '생성 결과가 비어 있습니다. 다시 시도해 주세요.' });

    const checks = runFactChecks(draft, factsheet, { question, targetChars, charLimitMode });
    const usage = data.usage || {};
    logger.info('writinglab.generate', {
      uid,
      questionLength: question.length,
      draftLength: draft.length,
      targetChars,
      charLimitMode,
      model: data.model,
      estimatedUsd: usage.estimatedUsd,
      elapsedMs: Date.now() - startedAt,
      noveltyCandidate: !!(checks.experienceNovelty && checks.experienceNovelty.candidate),
      fabricatedNumberCandidates: checks.fabricatedNumberCandidates.length
    });
    return res.json({
      ok: true,
      draft,
      usedFacts: Array.isArray(parsed.usedFacts) ? parsed.usedFacts.slice(0, 12) : [],
      followupQuestions: Array.isArray(parsed.followupQuestions) ? parsed.followupQuestions.slice(0, 6) : [],
      factsheet,
      checks,
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
      : '생성에 실패했습니다. 잠시 후 다시 시도해 주세요.';
    return res.status(502).json({ error: message, code: e && e.code ? String(e.code) : 'WRITING_LAB_GENERATE_FAILED' });
  }
});

// ── POST /writing-lab/check ─────────────────────────────────────
// 휴머나이징을 거친 결과를 같은 팩트시트 기준으로 재검사한다(무LLM·즉시).
router.post('/writing-lab/check', async (req, res) => {
  try {
    const uid = await requireAdmin(req, res);
    if (!uid) return;
    const text = cleanText(req.body && req.body.text, CHECK_TEXT_MAX);
    if (!text) return res.status(400).json({ error: '검사할 텍스트가 없습니다.' });
    const question = cleanText(req.body && req.body.question, QUESTION_MAX);
    const memo = readMemo(req.body);
    const company = cleanText(req.body && req.body.company, 120);
    const role = cleanText(req.body && req.body.role, 120);
    const emphasis = cleanText(req.body && req.body.emphasis, 300);
    const rawTarget = Number(req.body && req.body.targetChars);
    const targetChars = Number.isFinite(rawTarget) && rawTarget > 0
      ? Math.max(TARGET_CHARS_MIN, Math.min(TARGET_CHARS_MAX, Math.round(rawTarget)))
      : 0;
    const charLimitMode = normalizeCharLimitMode(req.body && req.body.charLimitMode);
    const factsheet = typeof req.body.factsheet === 'string' && req.body.factsheet.trim()
      ? cleanText(req.body.factsheet, MEMO_FIELD_MAX * 5)
      : buildFactsheet({ company, role, question, memo, emphasis });
    const checks = runFactChecks(text, factsheet, { question, targetChars, charLimitMode });
    return res.json({ ok: true, checks });
  } catch (e) {
    logger.error('writinglab.check_failed', { err: e });
    return res.status(500).json({ error: '검사에 실패했습니다.' });
  }
});

module.exports = router;
