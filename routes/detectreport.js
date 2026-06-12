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

const DAILY_CAP = Number(process.env.DETECT_DAILY_CAP) || 5;
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
  const bare = text.replace(/\s+/g, '');
  if (bare.length < 100) return res.status(400).json({ error: 'AI 감지를 하려면 최소 100자가 필요해요.' });
  if (text.length > 30000) return res.status(400).json({ error: '텍스트가 너무 깁니다. (최대 30,000자)' });

  // ★ 로컬 개발 전용(이중 게이트 — analyze.js와 동일): Firebase 비활성 + DEV_NO_AUTH=1이면
  //   일일 한도 미적용(테스트 무제한). 프로덕션은 FIREBASE_SERVICE_ACCOUNT가 항상 있어 이 분기를 안 탐.
  const devNoAuth = !process.env.FIREBASE_SERVICE_ACCOUNT && process.env.DEV_NO_AUTH === '1';

  // 일일 한도 — 로그인 uid 우선(IP 공유 환경 오차단 방지), 비로그인은 IP
  const uid = await verifyToken(req.body?.idToken);
  const key = uid ? `u:${uid}` : `ip:${req.ip || req.headers['x-forwarded-for'] || 'unknown'}`;
  const day = kstDay();
  const rec = daily.get(key);
  const used = (rec && rec.day === day) ? rec.count : 0;
  if (!devNoAuth && used >= DAILY_CAP) {
    return res.status(429).json({ error: `무료 AI 감지는 하루 ${DAILY_CAP}회까지예요. 내일 다시 이용해 주세요.` });
  }

  // ② 결정론 분석(무LLM) — 실패하면 보고서 자체가 성립 안 되므로 여기서만 500
  let ir, paras, detail;
  try {
    ir = sg.classifyInputRisk(text);
    paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    detail = sg.analyzeParagraphs(text).detail;
  } catch (e) {
    console.error('❌ /detect-report 결정론 분석 실패:', e?.message);
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
      maxOutputTokens: 2200
    });
    const r = analyze.extractClaudeResult(data, 'return_detection_result');
    if (typeof r?.probability !== 'number') {
      console.warn(`⚠️ /detect-report 판정 불완전: stop=${data?.stop_reason} keys=${Object.keys(r || {}).join(',')}`);
      throw new Error('detect_incomplete');
    }
    return r;
  }, 2).catch(e => { console.warn('⚠️ /detect-report LLM 판정 실패(엔진 추정으로 진행):', e?.message); return null; });

  const before = pickAiSentence(paras, detail);
  const exampleP = before
    ? (async () => {
        const data = await analyze.callClaude({
          userText: before, systemText: REWRITE_SYSTEM, tool: REWRITE_TOOL,
          temperature: 0.7, maxOutputTokens: 500
        });
        const r = analyze.extractClaudeResult(data, 'return_rewrite');
        return r?.rewritten ? { before, after: r.rewritten } : null;
      })().catch(e => { console.warn('⚠️ /detect-report 미리보기 실패(보고서는 진행):', e?.message); return null; })
    : Promise.resolve(null);

  const [det, example] = await Promise.all([detectP, exampleP]);

  // LLM 실패 시 엔진 추정 확률 — "판정 보류" 금지(사장님 지시): 게이지는 항상 숫자를 보여준다.
  //   추상위험비율(0~1) → 22~92% 선형 매핑. 실측 감각(혼합 글 52·위험 짧은 글 88)과 대략 정합.
  const engineProb = Math.round(Math.min(92, Math.max(15, 22 + 70 * (ir.abstractRiskRatio || 0))));
  const probability = det ? Math.round(det.probability) : engineProb;

  // 카운트는 성공 직전 증가 — 서버 오류로 보고서를 못 받았는데 횟수만 소진되는 일 방지
  if (!devNoAuth) daily.set(key, { day, count: used + 1 });

  // ③ 비용 — 실제 과금 공식과 동일 산식(다듬기 1/100자 · 블로그 2/100자 · 재구성 구간 정액)
  const len = text.length;
  const B = diagnose.BANDS;
  res.json({
    ok: true,
    free: true,
    remainingToday: devNoAuth ? null : DAILY_CAP - used - 1,   // null이면 프론트가 잔여 표기 생략(dev 무제한)
    probability,
    probSource: det ? 'llm' : 'engine',
    summary: det ? det.summary : copy.desc,
    detail: det ? det.detail : null,
    grade,
    title: copy.title,
    abstractRiskRatio: ir.abstractRiskRatio,
    paragraphs: paras.map((p, i) => {
      const kind = (detail[i] && detail[i].kind) || 'thin';
      return { idx: i, kind, reason: PARA_REASON[kind], snippet: p.slice(0, 90) };
    }),
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
