// [routes/detectreport.js] AI 감지 분리(2026-06-12) — 사용자 친화 보고서(휴머나이징 전환 퍼널)
// ────────────────────────────────────────────────────────────────
// POST /detect-report { text } — 항상 유료(100자당 1크레딧·로그인 필수, 2026-07-20 무료 제공 제거).
// 보고서 재료 4종:
//   ① LLM 판정(probability·summary·detail) — GPT detect 경로 재사용
//   ② 결정론 문단 지도(surfaceguard.analyzeParagraphs, 무LLM·무비용) — "어느 문단이 왜 위험한지"
//   ③ 경로별 예상 밴드(diagnose 테이블) + 이 글 기준 비용(과금 공식과 동일 산식 — 단가 단일 출처)
//   ④ 실시간 1문장 미리보기(가장 AI스러운 문장 1개 경량 변환) — 전환을 만드는 핵심 장치
// 실패 격리: ①·④는 각자 실패해도 보고서는 나간다(결정론 ②·③만으로 성립). 둘 다 fire 후 Promise.all.

const express = require('express');
const router = express.Router();
const billing = require('../lib/usageBilling');
const { BANDS, COPY } = require('../lib/detectPresentation');
const { restructureCredit, shortHumanizeCredit } = require('../lib/humanizePricing');
const sg = require('../engine/surfaceguard');
const { resolveAdvancedRouting } = require('../engine-gpt-prod/advancedRouting');
const { estimateAdvancedTime } = require('../engine-gpt-prod/timeEstimate');
const crypto = require('crypto');
const { db, verifyToken, verifyAppCheck } = require('../config');
const { logger, setLogContext } = require('../lib/logger');
const { bearerToken } = require('../lib/reqtoken');   // idToken: 헤더 우선·body 폴백(deprecated)
const detectCalibration = require('../lib/detectCalibration');
const { applyDetectNarrativePolicy } = require('../lib/detectNarrativePolicy');
const history = require('../lib/historyService');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const gptAnalyze = require('./analyze-gpt');
const inputrouting = require('../engine/inputrouting');

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

async function activeGptConfig() {
  const cfg = await gptRuntimeConfig.getRuntimeConfig({ db, logger });
  return gptRuntimeConfig.isGptActive(cfg) ? cfg : null;
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
  const requestId = (typeof req.body?.requestId === 'string' && req.body.requestId.trim())
    ? req.body.requestId.trim().slice(0, 80).replace(/[^A-Za-z0-9:_-]/g, '') : null;

  // 로그인·잔액 선검증(차감은 성공 후)
  let paidPre = null;
  if (!devNoAuth) {
    if (!uid) return res.status(401).json({ error: 'AI 감지는 로그인이 필요해요.', code: 'LOGIN_REQUIRED', cost });
    try {
      paidPre = await billing.precheckCredits(idToken, cost);
    } catch (e) {
      return res.status(e.status || 402).json({ error: billing.authErrorMessage(e.message), code: 'INSUFFICIENT_CREDITS', cost });
    }
  }
  logger.info('detect_report.started', { uid, textLength: text.length, cost, devNoAuth });

  // ② 결정론 분석(무LLM) — 실패하면 보고서 자체가 성립 안 되므로 여기서만 500
  //   ★ 문단 분리(2026-07-20): 빈 줄 없는 붙여넣기에서 전체가 1문단이 되던 실사고 →
  //   splitParagraphsForReport(빈줄→줄바꿈→항목머리→문장묶음 폴백)로 나누고,
  //   등급·문단상세도 같은 경계(joined)로 계산해 인덱스·판정을 정합시킨다.
  let ir, paras, detail;
  try {
    paras = sg.splitParagraphsForReport(text);
    const joined = paras.join('\n\n');
    ir = sg.classifyInputRisk(joined);
    detail = sg.analyzeParagraphs(joined).detail;
  } catch (e) {
    logger.error('detect_report.surface_failed', { uid, err: e });
    return res.status(500).json({ error: '감지 처리 중 오류가 발생했어요.' });
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

  // ①·④ LLM 2건 병렬 — 각자 실패 허용
  //   maxOutputTokens 2200: 긴 글에서 detail이 길어지면 1200으론 tool JSON이 max_tokens에 잘려
  //   probability 누락(detect_incomplete) → "판정 보류" 실사고(2026-06-12). 재시도 2회로 일시 오류도 흡수.
  const detectP = billing.retryAsync(async () => {
    const gptCfg = await activeGptConfig();
    if (!gptCfg) throw Object.assign(new Error('GPT_PROVIDER_UNAVAILABLE'), { code: 'GPT_PROVIDER_UNAVAILABLE' });
    const r = await gptAnalyze.runDetect(text, 'ko', {
      config: gptCfg,
      route: 'detect_report',
      allowLocalFallback: false,
      uid: uid || ''
    });
    if (typeof r?.probability !== 'number') throw new Error('detect_incomplete');
    return r;
  }, 2).catch(e => { logger.warn('detect_report.llm_failed_fallback_engine', { uid, err: e }); return null; });

  const before = pickAiSentence(paras, detail);
  const exampleP = before
    ? (async () => {
        const gptCfg = await activeGptConfig();
        if (!gptCfg) throw Object.assign(new Error('GPT_PROVIDER_UNAVAILABLE'), { code: 'GPT_PROVIDER_UNAVAILABLE' });
        const r = await gptAnalyze.rewriteSentence({ text: before, lang: 'ko', config: gptCfg, uid: uid || '' });
        return r?.rewritten ? { before, after: r.rewritten } : null;
      })().catch(e => { logger.warn('detect_report.preview_failed', { uid, err: e }); return null; })
    : Promise.resolve(null);

  const [det, example] = await Promise.all([detectP, exampleP]);

  // LLM 실패 시 엔진 추정 확률 — "판정 보류" 금지(사장님 지시): 게이지는 항상 숫자를 보여준다.
  //   추상위험비율(0~1) → 22~92% 선형 매핑. 실측 감각(혼합 글 52·위험 짧은 글 88)과 대략 정합.
  const engineProb = Math.round(Math.min(92, Math.max(15, 22 + 70 * (ir.abstractRiskRatio || 0))));
  const rawProbability = det ? Math.round(det.probability) : engineProb;
  const calibration = await detectCalibration.applyHistoryCalibration({
    db,
    uid,
    text,
    probability: rawProbability,
    logger,
    route: 'detect_report'
  });
  const probability = calibration.probability;
  const narrated = applyDetectNarrativePolicy(det || {
    probability,
    signals: [],
    confidence: 'low'
  }, probability);

  // 과금은 성공 직전에만 — 서버 오류로 보고서를 못 받았는데 차감되는 일 방지.
  // unlimited 플랜은 차감 제외. 멱등키로 중복 차감 방지.
  const charged = (!devNoAuth && paidPre && paidPre.plan !== 'unlimited') ? cost : 0;
  if (charged && !req.aborted) {
    try {
      await billing.commitCreditDeduct(paidPre.uid, cost, 'detect', requestId, { mode: 'detect', textLength: text.length });
    } catch (e) {
      logger.error('detect_report.paid_deduct_failed_manual_action', { uid, cost, requestId, err: e });
    }
  }

  // 감지 보고서도 /analyze와 같은 users/{uid}/history 스키마에 저장한다.
  // requestId를 문서 ID로 사용해 재시도·중복 클릭이 관리자 작업 기록을 중복 생성하지 않게 한다.
  let historySaved = false;
  if (!devNoAuth && uid && !req.aborted) {
    const historyResult = {
      ...narrated,
      ...(calibration.applied ? {
        rawProbability: calibration.rawProbability,
        probabilityCalibration: calibration.meta
      } : {})
    };
    try {
      await history.saveAnalyzeHistory({
        uid,
        requestId,
        opType: 'detect',
        text,
        needed: cost,
        result: historyResult,
        mode: 'detect'
      });
      historySaved = true;
    } catch (e) {
      // 감지 결과 전달·과금은 성공했으므로 이력 저장 장애만 격리한다.
      logger.warn('detect_report.history_persist_failed', { uid, requestId, err: e });
    }
  }
  logger.info('detect_report.completed', {
    uid,
    grade,
    probability,
    rawProbability: calibration.applied ? calibration.rawProbability : undefined,
    calibrated: calibration.applied,
    calibration: calibration.applied ? calibration.meta : undefined,
    probSource: det ? 'llm' : 'engine',
    riskLevel: narrated.riskLevel,
    riskLabel: narrated.riskLabel,
    narrativeConsistencyAdjusted: narrated.narrativeConsistencyAdjusted,
    charged,
    historySaved
  });

  // ③ 비용 — 실제 과금 공식과 동일 산식(다듬기 1/100자 · 블로그 2/100자 · 재구성 구간 정액)
  const len = text.length;
  const B = BANDS;
  res.json({
    ok: true,
    free: false,          // 무료 제공 제거(2026-07-20) — 항상 유료
    charged,              // unlimited 플랜·dev는 0
    historySaved,
    probability,
    ...(calibration.applied ? {
      rawProbability: calibration.rawProbability,
      calibrated: true,
      probabilityCalibration: calibration.meta
    } : {}),
    probSource: det ? 'llm' : 'engine',
    riskLevel: narrated.riskLevel,
    riskLabel: narrated.riskLabel,
    summary: narrated.summary,
    detail: narrated.detail,
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
    routingOverride: advancedRouting.routingOverride || null,
    advancedTimeEstimate,
    paragraphs: paras.map((p, i) => {
      const kind = (detail[i] && detail[i].kind) || 'thin';
      // snippet=미리보기(140자), text=문단 전문(프론트 "전체보기" 토글용 — 미리보기보다 길 때만 포함)
      return { idx: i, kind, reason: PARA_REASON[kind], snippet: p.slice(0, 140), text: p.length > 140 ? p : undefined, coach: predictCoach(p) };   // ★문단별 예측태그→메모칸 코칭
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
      polish: { band: B.POLISH_BAND[grade], credits: shortHumanizeCredit(len) },
      blog: { band: B.BLOG_BAND[grade], credits: shortHumanizeCredit(len) },
      restructure: {
        band: B.RESTRUCTURE_BAND,
        credits: restructureCredit(len, false),
        creditsEvidence: restructureCredit(len, true)
      }
    }
  });
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

  // (1) App Check — 콘솔·프런트 준비 후 APPCHECK_ENFORCE=1로 켜면 정상 앱 외 호출 차단.
  if (process.env.APPCHECK_ENFORCE === '1') {
    const ok = await verifyAppCheck(req.headers['x-firebase-appcheck']);
    if (!ok) return res.status(401).json({ ok: false, error: '비정상 접근입니다.' });
  }

  // (2) IP별 시간당 캡 — 봇 반복호출로 인한 LLM 비용·동시성 소진 차단.
  const ip = clientIp(req);
  const hour = coachHour();
  const rec = coachIp.get(ip);
  const count = rec && rec.hour === hour ? rec.count : 0;
  if (ip && count >= COACH_IP_HOURLY_CAP) {
    logger.warn('coach_suggest.ip_capped', { ip, count });
    return res.status(429).json({ ok: true, stances: [], experiences: [], capped: true });
  }

  // (3) 텍스트 해시 캐시 — 동일 입력 재호출은 LLM 없이 즉시 응답(중복 클릭·재시도 비용 제거).
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
