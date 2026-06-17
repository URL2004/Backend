// [routes/detectreport.js] AI 감지 분리(2026-06-12) — 무료 감지 + 사용자 친화 보고서(휴머나이징 전환 퍼널)
// ────────────────────────────────────────────────────────────────
// POST /detect-report { text, idToken? } — 무과금(미끼 상품). 일일 한도(로그인=uid, 비로그인=IP)로 어뷰즈 방어.
// 보고서 재료 4종:
//   ① LLM 판정(probability·summary·detail) — 기존 detect 경로(callClaude·detect tool) 재사용
//   ② 결정론 문단 지도(surfaceguard.analyzeParagraphs, 무LLM·무비용) — "어느 문단이 왜 위험한지"
//   ③ 경로별 예상 밴드(diagnose 테이블) + 이 글 기준 비용(과금 공식과 동일 산식 — 단가 단일 출처)
//   ④ 실시간 1문장 미리보기(가장 AI스러운 문장 1개 경량 변환) — 전환을 만드는 핵심 장치
// 실패 격리: ①·④는 각자 실패해도 보고서는 나간다(결정론 ②·③만으로 성립). 둘 다 fire 후 Promise.all.

const express = require('express');
const router = express.Router();
const analyze = require('./analyze');           // callClaude·detect tool 재사용(LLM 경로 단일 출처)
const diagnose = require('./diagnose');         // 밴드 테이블 재사용
const transform = require('./transform');       // restructureCredit 재사용(단가 단일 출처)
const sg = require('../engine/surfaceguard');
const { getDetectSystem } = require('../prompts');
const { verifyToken } = require('../config');
const { logger, setLogContext } = require('../lib/logger');

const DAILY_CAP = Number(process.env.DETECT_DAILY_CAP) || 3;   // 무료 감지 하루 한도(이후 유료 100자당 1크레딧)
const daily = new Map();   // 'u:uid' | 'ip:addr' → { day, count } — 메모리(재시작 리셋은 사용자에게 유리한 방향)
setInterval(() => {
  const d = kstDay();
  for (const [k, v] of daily) if (v.day !== d) daily.delete(k);
}, 60 * 60 * 1000).unref();

function kstDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

// 문단 종류 → 사용자 언어 사유(보고서의 "알아듣기 쉬운 정리" 핵심)
const PARA_REASON = {
  concrete: '실제 경험이나 구체 수치가 있어 사람이 쓴 글로 읽혀요.',
  abstract_risk: '구체적 사례·경험 없이 일반론으로만 쓰여 있어요 — 탐지기가 가장 의심하는 유형이에요.',
  thin: '구체적 근거가 부족해요. 경험이나 수치를 더하면 안전해져요.'
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

// ④ 미리보기 후보: 위험 문단에서 30~160자, 경험 장면 아닌 문장 중 가장 긴 것
//   (일반론 문장은 길수록 AI 티가 잘 드러나 before/after 대비가 큼)
function pickAiSentence(paras, detail) {
  const cands = [];
  paras.forEach((p, i) => {
    const kind = detail[i] && detail[i].kind;
    if (kind === 'concrete') return;
    sg.splitSentences(p).forEach(s => {
      if (s.length < 30 || s.length > 160) return;
      if (sg.isLivedScene(s)) return;
      cands.push(s);
    });
  });
  if (!cands.length) return null;
  return cands.sort((a, b) => b.length - a.length)[0];
}

const REWRITE_TOOL = {
  name: 'return_rewrite',
  description: '재작성된 문장을 반환한다.',
  input_schema: {
    type: 'object',
    properties: { rewritten: { type: 'string', description: '사람이 쓴 것처럼 자연스럽게 재작성한 한 문장' } },
    required: ['rewritten']
  }
};
// 무날조 원칙은 미리보기에도 동일 적용 — 새 사실·수치·고유명사 주입 금지.
const REWRITE_SYSTEM = '너는 한국어 문장 교열가다. 사용자가 준 한 문장을 사람이 직접 쓴 것처럼 자연스럽게 다시 써라. 규칙: 새로운 사실·수치·고유명사·예시 추가 절대 금지, 원문 의미 보존, 길이는 원문의 0.8~1.3배, 균일한 문어체 종결과 기계적 나열을 깨고 자연스러운 리듬으로. 결과는 도구로만 반환한다.';

router.post('/detect-report', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  // 글자수 기준 통일: 표시 카운트와 동일하게 공백 포함 raw length으로 최소 길이 판정.
  if (text.length < 100) return res.status(400).json({ error: 'AI 감지를 하려면 최소 100자가 필요해요.' });
  if (text.length > 30000) return res.status(400).json({ error: '텍스트가 너무 깁니다. (최대 30,000자)' });

  // ★ 로컬 개발 전용(이중 게이트 — analyze.js와 동일): Firebase 비활성 + DEV_NO_AUTH=1이면
  //   일일 한도 미적용(테스트 무제한). 프로덕션은 FIREBASE_SERVICE_ACCOUNT가 항상 있어 이 분기를 안 탐.
  const devNoAuth = !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1';

  // 일일 한도 — 로그인 uid 우선(IP 공유 환경 오차단 방지), 비로그인은 IP
  const uid = await verifyToken(req.body?.idToken);
  if (uid) setLogContext({ uid });
  const key = uid ? `u:${uid}` : `ip:${req.ip || req.headers['x-forwarded-for'] || 'unknown'}`;
  const day = kstDay();
  const rec = daily.get(key);
  const used = (rec && rec.day === day) ? rec.count : 0;
  // 무료 한도(기본 3회) 소진 후엔 차단 대신 유료 감지(100자당 1크레딧, 기존 감지 단가)로 전환.
  const overFree = !devNoAuth && used >= DAILY_CAP;
  const wantPaid = req.body?.paid === true;
  const cost = Math.ceil(text.length / 100);
  const requestId = (typeof req.body?.requestId === 'string' && req.body.requestId.trim())
    ? req.body.requestId.trim().slice(0, 80).replace(/[^A-Za-z0-9:_-]/g, '') : null;

  // 무료 소진 + 유료 의사 없음 → 유료 안내(프론트가 확인받고 paid:true로 재요청)
  if (overFree && !wantPaid) {
    logger.info('detect_report.free_exhausted', { uid, used, cap: DAILY_CAP, cost });
    return res.status(402).json({ ok: false, code: 'FREE_EXHAUSTED', cost, freeCap: DAILY_CAP, message: `오늘 무료 ${DAILY_CAP}회를 모두 썼어요. 계속하려면 ${cost}크레딧이 필요해요.` });
  }
  // 유료 감지 — 로그인·잔액 선검증(차감은 성공 후)
  let paidPre = null;
  if (overFree && wantPaid) {
    if (!uid) return res.status(401).json({ error: '유료 감지는 로그인이 필요해요.', code: 'LOGIN_REQUIRED' });
    try {
      paidPre = await analyze.precheckCredits(req.body.idToken, cost);
    } catch (e) {
      return res.status(e.status || 402).json({ error: analyze.authErrorMessage(e.message), code: 'INSUFFICIENT_CREDITS', cost });
    }
  }
  logger.info('detect_report.started', { uid, textLength: text.length, usedToday: used, cap: DAILY_CAP, paid: overFree && wantPaid, devNoAuth });

  // ② 결정론 분석(무LLM) — 실패하면 보고서 자체가 성립 안 되므로 여기서만 500
  let ir, paras, detail;
  try {
    ir = sg.classifyInputRisk(text);
    paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    detail = sg.analyzeParagraphs(text).detail;
  } catch (e) {
    logger.error('detect_report.surface_failed', { uid, err: e });
    return res.status(500).json({ error: '감지 처리 중 오류가 발생했어요.' });
  }
  const grade = ir.grade || 'B';
  const copy = diagnose.COPY[grade] || diagnose.COPY.B;

  // ①·④ LLM 2건 병렬 — 각자 실패 허용
  //   maxOutputTokens 2200: 긴 글에서 detail이 길어지면 1200으론 tool JSON이 max_tokens에 잘려
  //   probability 누락(detect_incomplete) → "판정 보류" 실사고(2026-06-12). 재시도 2회로 일시 오류도 흡수.
  const detectP = analyze.retryAsync(async () => {
    const data = await analyze.callClaude({
      userText: text,
      systemText: getDetectSystem('ko'),
      tool: analyze.buildDetectTool('ko'),
      temperature: 0,
      maxOutputTokens: 2200,
      task: 'detect_report',
      phase: 'detect:main',
      mode: 'detect',
      cacheZeroWarn: true
    });
    const r = analyze.extractClaudeResult(data, 'return_detection_result');
    if (typeof r?.probability !== 'number') {
      logger.warn('detect_report.llm_incomplete', { uid, stopReason: data?.stop_reason, keys: Object.keys(r || {}) });
      throw new Error('detect_incomplete');
    }
    return r;
  }, 2).catch(e => { logger.warn('detect_report.llm_failed_fallback_engine', { uid, err: e }); return null; });

  const before = pickAiSentence(paras, detail);
  const exampleP = before
    ? (async () => {
        const data = await analyze.callClaude({
          userText: before, systemText: REWRITE_SYSTEM, tool: REWRITE_TOOL,
          temperature: 0.7, maxOutputTokens: 500,
          task: 'detect_report',
          phase: 'preview:rewrite',
          mode: 'preview'
        });
        const r = analyze.extractClaudeResult(data, 'return_rewrite');
        return r?.rewritten ? { before, after: r.rewritten } : null;
      })().catch(e => { logger.warn('detect_report.preview_failed', { uid, err: e }); return null; })
    : Promise.resolve(null);

  const [det, example] = await Promise.all([detectP, exampleP]);

  // LLM 실패 시 엔진 추정 확률 — "판정 보류" 금지(사장님 지시): 게이지는 항상 숫자를 보여준다.
  //   추상위험비율(0~1) → 22~92% 선형 매핑. 실측 감각(혼합 글 52·위험 짧은 글 88)과 대략 정합.
  const engineProb = Math.round(Math.min(92, Math.max(15, 22 + 70 * (ir.abstractRiskRatio || 0))));
  const probability = det ? Math.round(det.probability) : engineProb;

  // 과금/카운트는 성공 직전에만 — 서버 오류로 보고서를 못 받았는데 횟수 소진·차감되는 일 방지.
  const isPaidRun = overFree && wantPaid;
  if (isPaidRun) {
    // 유료 감지: 성공 후 차감(실패 시 차감 없음). unlimited 플랜은 제외. 멱등키로 중복 차감 방지.
    if (paidPre && paidPre.plan !== 'unlimited' && !req.aborted) {
      try {
        await analyze.commitCreditDeduct(paidPre.uid, cost, 'detect', requestId, { mode: 'detect', textLength: text.length });
      } catch (e) {
        logger.error('detect_report.paid_deduct_failed_manual_action', { uid, cost, requestId, err: e });
      }
    }
  } else if (!devNoAuth && !req.aborted) {
    daily.set(key, { day, count: used + 1 });   // 무료 횟수 소진
  }
  logger.info('detect_report.completed', {
    uid,
    grade,
    probability,
    probSource: det ? 'llm' : 'engine',
    remainingToday: devNoAuth ? null : DAILY_CAP - used - 1
  });

  // ③ 비용 — 실제 과금 공식과 동일 산식(다듬기 1/100자 · 블로그 2/100자 · 재구성 구간 정액)
  const len = text.length;
  const B = diagnose.BANDS;
  res.json({
    ok: true,
    free: !isPaidRun,
    charged: isPaidRun ? cost : 0,
    remainingToday: devNoAuth ? null : (overFree ? 0 : Math.max(0, DAILY_CAP - used - 1)),   // null이면 프론트가 잔여 표기 생략(dev 무제한)
    probability,
    probSource: det ? 'llm' : 'engine',
    summary: det ? det.summary : copy.desc,
    detail: det ? det.detail : null,
    grade,
    title: copy.title,
    abstractRiskRatio: ir.abstractRiskRatio,
    paragraphs: paras.map((p, i) => {
      const kind = (detail[i] && detail[i].kind) || 'thin';
      return { idx: i, kind, reason: PARA_REASON[kind], snippet: p.slice(0, 90), coach: predictCoach(p) };   // ★문단별 예측태그→메모칸 코칭
    }),
    coach: predictCoach(text, 0.5),   // ★글 전체 상위 예측태그 + 어느 경험 메모 칸을 채우면 되는지(코칭 요약)
    counts: {
      total: paras.length,
      risk: detail.filter(d => d.kind === 'abstract_risk').length,
      thin: detail.filter(d => d.kind === 'thin').length,
      safe: detail.filter(d => d.kind === 'concrete').length
    },
    example,   // { before, after } | null — null이면 프론트가 블록 자체를 숨김
    solutions: {
      polish: { band: B.POLISH_BAND[grade], credits: Math.ceil(len / 100) },
      blog: { band: B.BLOG_BAND[grade], credits: Math.ceil(len / 100) * 2 },
      restructure: {
        band: B.RESTRUCTURE_BAND,
        credits: transform.restructureCredit(len, false),
        creditsEvidence: transform.restructureCredit(len, true)
      }
    }
  });
});

module.exports = router;
