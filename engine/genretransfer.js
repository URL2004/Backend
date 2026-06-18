// [engine/genretransfer.js] Genre Profile Transfer — 문서 장르 변환기 (사장님 설계 2026-06-10)
// ────────────────────────────────────────────────────────────────
// 가설: 카피킬러는 "사람이 쓴 문장"보다 "사람이 쓴 문서처럼 생긴 구조"를 본다.
//   근거: 한은 보고서(완전 비인칭 격식)=0~2% vs 우리 연구보고서 골격=94~95%(evidence 넣어도).
//   사람 저점수 문서의 구조 통계(실측): 괄호 삽입구 4.7~8.1/1000자(우리 0.4), 의문문 0.9~3.5(우리 0.12),
//   숫자 칼럼 5~13·데이터보고서 61~68, 비정형 소제목, 문단별 역할 다양(사례/반박/자료/의견), 미완결 문단.
// 기존 휴머나이저와 다른 점: 문단 재작성이 아니라 ①장르 라우팅 ②document plan(골격 재구성)
//   ③section role별 재작성 ④artifactGuard(연구보고서 잔재 제거) ⑤FLOOR/judge로 사실 보존.
// ★ 경쟁가설 주의: "카피킬러=LLM 토큰분포" 가설이 맞으면 장르 전환도 80%대 유지 → 이 모듈의 MVP 실측이 판별 실험.

const sg = require('./surfaceguard');
const floor = require('./floor');
const judgeEngine = require('./judge');
const { buildSoftClaimLedger, semanticJudge, MODEL, HAIKU } = judgeEngine;

function llmText(opts = {}) {
  const repairLike = opts.model === HAIKU;
  return judgeEngine.llmText({
    task: repairLike ? 'repair' : 'formal',
    mode: repairLike ? undefined : 'formal',
    riskLevel: repairLike ? 'medium' : 'high',
    ...opts
  });
}

function llmJSON(opts = {}) {
  return judgeEngine.llmJSON({
    task: 'formal',
    mode: 'formal',
    riskLevel: 'high',
    ...opts
  });
}

// ── 장르 프로파일(사람 저점수 문서 실측 기반 목표 통계) ──
const GENRE_PROFILES = {
  news_explainer: {
    label: '뉴스 해설형 과제문',
    lead: '사건·쟁점을 첫 문단에서 직격(배경 설명으로 시작 금지)',
    roles: ['lead', 'fact', 'context', 'contrast', 'interpretation', 'proposal'],
    targetStats: { parenPer1000: 5, questionPer1000: 1.0, numberPer1000: 10 },
    targetAIRange: [50, 70],
  },
  policy_column: {
    label: '정책 칼럼형',
    lead: '주장 또는 반론을 먼저 던짐',
    roles: ['claim', 'counterargument', 'evidence', 'interpretation', 'proposal'],
    targetStats: { parenPer1000: 6, questionPer1000: 1.5, numberPer1000: 8 },
    targetAIRange: [40, 65],
  },
  data_report: {
    label: '데이터 보고서형',
    lead: '핵심 수치 요약으로 시작',
    roles: ['summary', 'indicator', 'comparison', 'cause', 'outlook'],
    targetStats: { parenPer1000: 12, questionPer1000: 0, numberPer1000: 40 },
    targetAIRange: [0, 30],
  },
};

// ── 연구보고서 골격 감지(카피킬러 최악 골격 — AI학습 보고서 94~95% 증거) ──
const BAD_RESEARCH_FRAME = [
  /[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*\.\s*(서론|이론적\s*배경|결론|논의|제언)/,
  /연구의\s*필요성/, /이론적\s*배경/, /본\s*연구[는의]/, /연구\s*문제/, /연구\s*방법/,
  /가상\s*설문/, /구체적인\s*연구\s*목적은/, /시사점[을은]?\s*(제시|도출)/,
  /첫째[,.][\s\S]{0,400}둘째[,.][\s\S]{0,400}셋째[,.]/,
];
function detectBadFrame(text) {
  const hits = [];
  for (const re of BAD_RESEARCH_FRAME) { const m = (text || '').match(re); if (m) hits.push(m[0].replace(/\s+/g, ' ').slice(0, 30)); }
  return { bad: hits.length > 0, hits };
}

// ── 문서 구조 통계(사람 프로파일 대비 진단) ──
function extractDocProfile(text) {
  const chars = ((text || '').match(/[가-힣]/g) || []).length || 1;
  const paras = (text || '').split(/\n{2,}/).map(p => p.trim()).filter(p => p.replace(/\s+/g, '').length > 20);
  const lens = paras.map(p => p.replace(/\s+/g, '').length);
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const cv = lens.length > 1 ? Math.sqrt(lens.map(l => (l - mean) ** 2).reduce((a, b) => a + b, 0) / lens.length) / (mean || 1) : 0;
  // 교훈형/정형 마무리로 닫는 문단 비율
  const formulaEnd = paras.filter(p => /(필요하다|중요하다|해야\s*한다|것이다|셈이다)\s*\.?$/.test(p)).length;
  return {
    hangulChars: chars,
    parenPer1000: Number(((text.match(/\(/g) || []).length / chars * 1000).toFixed(1)),
    questionPer1000: Number(((text.match(/\?/g) || []).length / chars * 1000).toFixed(2)),
    numberPer1000: Number(((text.match(/\d[\d,.]*/g) || []).length / chars * 1000).toFixed(1)),
    paragraphs: paras.length,
    paragraphLenCV: Number(cv.toFixed(2)),
    formulaEndingRatio: Number((paras.length ? formulaEnd / paras.length : 0).toFixed(2)),
    badFrame: detectBadFrame(text),
  };
}

// ── 1) Document Plan: 원문 주장(ledger)+승인근거를 장르 골격의 section role에 배정 ──
async function buildDocumentPlan(rawText, { genre = 'news_explainer', evidenceList = [], ledger, lang = 'ko', signal } = {}) {
  const profile = GENRE_PROFILES[genre];
  const claims = (ledger?.claims || []).map((c, i) => `C${i + 1}. ${c.claim || c.text || ''}`).join('\n');
  const evid = evidenceList.map((e, i) => `E${i + 1}. ${e}`).join('\n');
  const system = `너는 문서 구조 편집자다. 아래 원문(연구보고서 골격)을 "${profile.label}" 장르의 문서로 재구성하는 **계획**을 세운다. 내용·사실은 그대로, 골격만 바꾼다.
규칙:
· 제목: 쟁점을 드러내는 도발적·구체적 제목(질문형 가능). "~에 미치는 영향 연구" 같은 보고서 제목 금지.
· 섹션 역할 풀: ${profile.roles.join(', ')}. lead가 첫 섹션(소제목 없음, ${profile.lead}).
· 섹션 5~7개. 소제목은 짧고 비정형(명사구·질문·단정 섞기). "서론/이론적 배경/결론" 금지.
· 원문 주장(C#)을 전부 섹션에 배정하라 — 하나도 버리지 마라(여러 섹션 배정 가능).
· 승인 근거(E#)는 그 주장을 뒷받침할 섹션에 배정(리드에 1개 이상).
· 같은 역할 섹션이 연달아 오지 않게.
JSON만 출력: {"title":"...","sections":[{"role":"lead","heading":null,"claims":["C1",...],"evidence":["E1",...],"targetChars":600},{"role":"fact","heading":"...","claims":[...],"evidence":[...],"targetChars":900},...]}`;
  const user = `[원문]\n${rawText}\n\n[원문 주장 목록]\n${claims}\n\n[승인 근거 목록]\n${evid || '(없음)'}`;
  const plan = await llmJSON({ system, user, signal, maxTokens: 3000, model: MODEL });
  if (!plan || !Array.isArray(plan.sections) || !plan.sections.length) throw new Error('genre plan 생성 실패');
  // ① 중복 배정 제거: 같은 주장/근거가 여러 섹션에 가면 내용이 두 번 쓰임(1차 실측: 오프로딩·45.9% 중복).
  //   첫 등장 섹션만 유지.
  const seenC = new Set(), seenE = new Set();
  plan.sections.forEach(s => {
    s.claims = (s.claims || []).filter(id => !seenC.has(id) && seenC.add(id));
    s.evidence = (s.evidence || []).filter(id => !seenE.has(id) && seenE.add(id));
  });
  // ② 커버리지 보정: 미배정 주장/근거는 주제 유사도가 가장 높은 섹션에 추가(사실 소실 방지)
  const place = (textOf, id) => {
    const tok = new Set(((textOf || '').match(/[가-힣]{2,}/g) || []));
    let best = Math.min(1, plan.sections.length - 1), bestScore = -1;
    plan.sections.forEach((s, si) => {
      if (si === 0) return; // lead 제외
      const st = ((s.heading || '') + ' ' + (s.role || '')).match(/[가-힣]{2,}/g) || [];
      let hit = 0; for (const t of st) if (tok.has(t)) hit++;
      if (hit > bestScore) { bestScore = hit; best = si; }
    });
    return best;
  };
  (ledger?.claims || []).forEach((c, i) => {
    const id = `C${i + 1}`;
    if (!seenC.has(id)) { const b = place(c.claim, id); (plan.sections[b].claims = plan.sections[b].claims || []).push(id); seenC.add(id); }
  });
  evidenceList.forEach((e, i) => {
    const id = `E${i + 1}`;
    if (!seenE.has(id)) { const b = place(e, id); (plan.sections[b].evidence = plan.sections[b].evidence || []).push(id); seenE.add(id); }
  });
  // ③ 분량 스케일링: 섹션 합계가 원문의 ~85%가 되도록 targetChars 보정(1차 실측: 39%로 과소 — 미제출감).
  const rawHangul = ((rawText.match(/[가-힣]/g) || []).length) || 1;
  const desired = Math.round(rawHangul * 0.95);
  const total = plan.sections.reduce((a, s) => a + (Number(s.targetChars) || 600), 0) || 1;
  plan.sections.forEach(s => { s.targetChars = Math.max(450, Math.round((Number(s.targetChars) || 600) * desired / total)); });
  return plan;
}

// ── 2) Section role별 재작성 ──
const ROLE_GOAL = {
  lead: '쟁점을 곧장 제시한다. 배경 설명·"현대 사회에서"식 도입 금지. 2~3문단.',
  fact: '수치·조사·사례 중심으로 현황을 보여준다. 인용 표지("~조사에 따르면", "~가 발표한")를 자연스럽게.',
  context: '배경과 맥락을 짧게 깔되, 자료·연도·기관을 끼워 넣는다.',
  contrast: '반론·우려·엇갈리는 지점을 선제적으로 다룬다.',
  counterargument: '예상 반박을 먼저 제시하고 원문 논지로 받아친다.',
  claim: '원문의 핵심 주장을 단정적으로 먼저 던진다.',
  evidence: '주장을 받치는 근거·수치를 배치한다.',
  interpretation: '수치·사례가 무엇을 뜻하는지 원문 논지 안에서 해석한다.',
  proposal: '금지·당위 나열 대신 구체적 기준·방안으로 마무리한다.',
  summary: '핵심 수치를 요약한다.', indicator: '지표를 항목별로 짚는다.', comparison: '비교·대조한다.', cause: '원인을 짚는다.', outlook: '전망으로 닫는다.',
};

function buildSectionPrompt(plan, section, claimTexts, evidTexts, genre, lang) {
  const profile = GENRE_PROFILES[genre];
  const system = `너는 "${profile.label}" 글을 쓰는 한국어 필자다. 주어진 재료(원문 주장+승인 근거)만으로 문서의 한 섹션을 쓴다.
[문체 — 과제 해설체]
· 한다체(~다/~이다) 기본. 격식은 유지하되 연구보고서 어법 금지: "본 연구는/연구의 필요성/이론적 배경/첫째,…둘째,…셋째,…" 나열 금지.
· ★괄호 삽입구를 자연스럽게 써라(1000자당 4~8개 수준) — 부연, 연도·기관, 단서, 짧은 예시를 괄호로. 사람 문서의 흔적이다.
· 수사적 의문문은 글 전체에 1~2개만(이 섹션에 꼭 넣으라는 뜻 아님). "과연 ~인가?" 패턴 금지.
· 인용 표지("~에 따르면", "~라고 답했다")로 근거를 문장 흐름 안에 녹여라 — 근거를 나열하지 말고 논점 전개의 재료로.
· 문단 길이를 들쭉날쭉하게(한 문단짜리 단락 허용). ★일부 문단은 결론 없이 다음 쟁점으로 넘어가며 끝내라 — 매 문단을 교훈으로 닫지 마라.
· 같은 수사 구조("문제는 ~가 아니라", "~이 핵심이다")를 반복하지 마라. 이 지시문의 표현을 그대로 베끼지 마라.
[절대 규칙 — FLOOR]
· 아래 재료에 없는 사실·수치·기관·연구·사례를 만들지 마라. 승인 근거의 수치·기관명·연도는 정확히 그대로.
· 1인칭 경험·일화 금지(비인칭 유지). 원문 논지의 방향을 바꾸지 마라.
· 출처 표기는 재료에 실제로 있는 것만.
[이 섹션]
· 역할: ${section.role} — ${ROLE_GOAL[section.role] || '내용을 전개한다.'}
· 분량: 문단 ${Math.max(2, Math.round((section.targetChars || 700) / 320))}개(각 3~6문장), 공백 제외 약 ${section.targetChars || 700}자. ★이보다 눈에 띄게 짧으면 실패다 — 배정된 주장·근거를 충분히 풀어 써라(압축 요약 금지).
· 출력: 본문만. 소제목·머리말·마크다운 금지(소제목은 시스템이 따로 붙인다).`;
  const user = `[문서 제목(참고)]\n${plan.title}\n\n[이 섹션에 배정된 원문 주장]\n${claimTexts.join('\n') || '(없음)'}\n\n[이 섹션에 배정된 승인 근거]\n${evidTexts.join('\n') || '(없음)'}`;
  return { system, user };
}

// ── 3) artifactGuard: 연구보고서 잔재·구조 통계 검사 ──
function measureArtifacts(text, genre = 'news_explainer') {
  const p = extractDocProfile(text);
  const target = GENRE_PROFILES[genre]?.targetStats || {};
  return { ...p, target, badFrameCount: p.badFrame.hits.length };
}

// ── 메인: 장르 변환 ──
async function genreTransfer(rawText, { genre = 'news_explainer', evidence = '', lang = 'ko', signal, concurrency = 3 } = {}) {
  const evidenceList = (evidence || '').split('\n').map(l => l.trim()).filter(Boolean);
  const allowed = evidence || '';
  const textF = evidence ? rawText + '\n\n' + evidence : rawText;

  const ledger = await buildSoftClaimLedger(rawText, { lang, signal });
  const plan = await buildDocumentPlan(rawText, { genre, evidenceList, ledger, lang, signal });

  // 섹션 재작성(동시 3) — 섹션별 novelty 게이트(새 사실 생기면 1회 재시도)
  const out = new Array(plan.sections.length);
  let next = 0;
  const worker = async () => {
    while (next < plan.sections.length) {
      const i = next++;
      const s = plan.sections[i];
      const claimTexts = (s.claims || []).map(id => {
        const c = ledger.claims[parseInt(String(id).replace(/\D/g, ''), 10) - 1];
        return c ? `· ${c.claim || ''}${c.evidence_text ? `\n  (원문 근거: ${c.evidence_text})` : ''}` : null;
      }).filter(Boolean);
      const evidTexts = (s.evidence || []).map(id => {
        const e = evidenceList[parseInt(String(id).replace(/\D/g, ''), 10) - 1];
        return e ? `· ${e}` : null;
      }).filter(Boolean);
      const { system, user } = buildSectionPrompt(plan, s, claimTexts, evidTexts, genre, lang);
      // 이 섹션이 반드시 품어야 할 수치 토큰(배정 근거에서 추출) — 1차 실측에서 근거 5~6건 증발의 재발 방지
      const mustNums = [...new Set(evidTexts.join(' ').match(/\d[\d,.]*%?/g) || [])].filter(t => t.replace(/\D/g, '').length >= 2);
      const minChars = Math.round((s.targetChars || 600) * 0.75);
      let best = { body: '', score: -1 };
      for (let attempt = 0; attempt < 3; attempt++) {
        let body = '';
        const extra = attempt > 0 && mustNums.length ? `\n\n★이전 시도에서 누락됨 — 다음 수치를 본문에 반드시 포함하라: ${mustNums.join(', ')}\n★분량을 지켜라(공백 제외 ${s.targetChars}자 수준).` : '';
        try { body = (await llmText({ system, user: user + extra, signal, maxTokens: 2500, model: MODEL }) || '').trim(); } catch { continue; }
        if (!body || floor.looksLikeRefusal(body)) continue;
        if (floor.measureNovelty(textF, body, allowed).count > 0) continue;   // 날조 → 폐기
        const chars = (body.match(/[가-힣]/g) || []).length;
        const missing = mustNums.filter(n => !body.includes(n)).length;
        const score = (chars >= minChars ? 1 : 0) + (mustNums.length ? (mustNums.length - missing) / mustNums.length : 1);
        if (score > best.score) best = { body, score };
        if (chars >= minChars && missing === 0) break;          // 분량·근거 모두 충족 → 확정
      }
      out[i] = { ...s, body: best.body };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, plan.sections.length) }, worker));

  // 조립: 제목 + (소제목 + 본문)
  let doc = plan.title + '\n\n' + out.map((s, i) => {
    if (!s.body) return '';
    return (i === 0 || !s.heading) ? s.body : s.heading + '\n\n' + s.body;
  }).filter(Boolean).join('\n\n');

  // artifactGuard: 연구보고서 잔재가 남으면 해당 문단 1회 수리
  let artifacts = measureArtifacts(doc, genre);
  if (artifacts.badFrameCount > 0) {
    const paras = doc.split(/\n{2,}/);
    for (let i = 0; i < paras.length; i++) {
      const bf = detectBadFrame(paras[i]);
      if (!bf.bad) continue;
      try {
        const cand = (await llmText({
          system: `다음 문단에서 연구보고서 어법(${bf.hits.join(', ')})을 제거하고 같은 내용을 해설문 어법으로 다시 써라. 사실·수치 그대로, 분량 유지, 본문만 출력.`,
          user: paras[i], signal, maxTokens: 1200, model: MODEL
        }) || '').trim();
        if (cand && !detectBadFrame(cand).bad && floor.measureNovelty(textF, cand, allowed).count === 0) paras[i] = cand;
      } catch { /* 유지 */ }
    }
    doc = paras.join('\n\n');
    artifacts = measureArtifacts(doc, genre);
  }

  // 사실 소실 수리(최대 2라운드): 빠진 수치·고유명사를 가장 맞는 자리에 위빙
  let lost = floor.measureLostFacts(textF, doc);
  for (let round = 0; round < 2 && lost.count > 0; round++) {
    try {
      const cand = (await llmText({
        system: `아래 문서에 빠진 사실들을 가장 자연스러운 자리에 끼워 넣어 전체 문서를 다시 출력하라. 빠진 사실: ${lost.items.join(', ')}. 문서의 구조·문체는 유지하고, 새 사실은 만들지 마라. 본문만 출력.`,
        user: doc, signal, maxTokens: 8000, model: MODEL
      }) || '').trim();
      if (cand && floor.measureNovelty(textF, cand, allowed).count === 0) {
        const lost2 = floor.measureLostFacts(textF, cand);
        if (lost2.count < lost.count) { doc = cand; lost = lost2; }
        else break;
      } else break;
    } catch { break; }
  }

  // 마감: 격식 표현예산(템플릿 반복) → 에코/중복 → 띄어쓰기
  try {
    const fb = await require('./formalbudget').formalBudgetPass(doc, { lang, signal, floor, rawText: textF, allowedExtra: allowed });
    if (fb.text) doc = fb.text;
  } catch { /* 무해 */ }
  doc = require('./dedupe').dedupeSentences(doc).text;
  doc = require('./spacing').fixSpacing(doc).text;

  // 최종 FLOOR 리포트
  const novelty = floor.measureNovelty(textF, doc, allowed);
  lost = floor.measureLostFacts(textF, doc);
  let judge = null;
  try {
    const v = await semanticJudge(rawText, doc, ledger, { lang, signal, allowedExtra: allowed });
    judge = { pass: v.pass, violations: v.violations || [] };
  } catch (e) { judge = { error: e.message }; }
  artifacts = measureArtifacts(doc, genre);
  const lenRatio = ((doc.match(/[가-힣]/g) || []).length) / (((textF.match(/[가-힣]/g) || []).length) || 1);

  return { text: doc, plan, artifacts, novelty, lostFacts: lost, judge, lenRatio: Number(lenRatio.toFixed(2)), claims: ledger.claims.length };
}

// ════════════════════════════════════════════════════════════════
// Genre Transfer V2 (사장님 v2 설계) — skeleton slot-filling
//   v1 실패 진단: 연구보고서 프레임은 제거했으나 "AI 해설문" 템플릿(~란 무엇인가/도움이 되는 순간/해야 할 일)으로
//   갈아탐 → 94%. v2 = 서버가 사람 저점수 문서의 skeleton을 고르고, LLM은 slot에 claim/evidence를 채우기만.
//   소제목 미사용(사람 칼럼: "소제목 있음❌ 문단 역할 다양성✅"), 슬롯 순차 생성(앞 슬롯 꼬리에 이어쓰기),
//   genreframes.genreRiskScore(사람 1.3~2.8 vs v1출력 14.75)로 후보 선택·출고 게이트.
// ════════════════════════════════════════════════════════════════
const gf = require('./genreframes');

const SKELETONS = {
  debate_explainer: {
    label: '찬반 해설형 과제문',
    slots: [
      { role: 'hook_fact', goal: '수치·사실로 곧장 시작하라. "최근 ~환경이 빠르게 변하고 있다"류 도입 상투구 금지.', w: 1.1 },
      { role: 'uncomfortable_question', goal: '논점을 옮기는 불편한 질문 또는 반문을 던져라(사용 여부가 아니라 다른 차원으로). 질문은 1개만.', w: 0.7 },
      { role: 'concept_reframe', goal: '핵심 개념을 교과서식으로 정의하지 말고 통념과 다른 각도로 재해석하라. "~란 무엇인가" 식 전개 금지.', w: 1.0 },
      { role: 'benefit_case', goal: '도움이 되는 조건·사례를 흐름 속에서 보여라. 장점 나열 금지 — 어떤 조건에서 작동하는지로.', w: 1.2 },
      { role: 'risk_case', goal: '위험을 조건문으로 보여라(언제·어떤 사용에서 문제가 되는가). 나열 금지.', w: 1.4 },
      { role: 'institution_response', goal: '기관·제도의 실제 대응 사실을 짚고 그 의미를 따져라.', w: 1.2 },
      { role: 'closing_standard', goal: '교훈 요약으로 닫지 마라. 구체적 기준·판단선을 제시하며 끝내라.', w: 0.9 },
    ],
  },
  policy_column: {
    label: '정책 칼럼형',
    slots: [
      { role: 'claim_first', goal: '주장을 먼저 단정적으로 던져라.', w: 1.0 },
      { role: 'counterclaim', goal: '예상 반론을 먼저 제시하고 받아쳐라.', w: 1.1 },
      { role: 'law_or_policy_fact', goal: '제도·정책·기관의 구체 사실을 배치하라.', w: 1.3 },
      { role: 'field_problem', goal: '현장에서 실제로 생기는 문제를 보여라.', w: 1.3 },
      { role: 'proposal', goal: '구체적 기준·방안을 제안하라.', w: 1.2 },
      { role: 'remaining_limit', goal: '남는 한계·미해결 지점을 인정하며 끝내라(깔끔한 결론 금지).', w: 0.8 },
    ],
  },
  news_article_style: {
    label: '뉴스 기사형',
    slots: [
      { role: 'event_lead', goal: '사건·발표·수치로 리드를 써라(기사 첫 문단처럼).', w: 1.0 },
      { role: 'numbers', goal: '핵심 수치들을 맥락과 함께 전달하라.', w: 1.2 },
      { role: 'voices', goal: '원문에 있는 인용·출처만 인용 표지로 전달하라(원문에 없는 기관·"~에 따르면" 신설 금지).', w: 1.2 },
      { role: 'pros_cons', goal: '찬반·기대와 우려를 교차시켜라.', w: 1.3 },
      { role: 'outlook', goal: '남은 쟁점과 전망으로 닫아라(교훈 금지).', w: 0.9 },
    ],
  },
  // 격식 보고서형 — 비인칭·압축·단정(한은 보고서 스타일 0~2%대). 칼럼 톤 X, 보고서 register 유지하되
  //   탐지를 올리는 "본 연구는/이론적 배경/첫째,둘째 / ~할 수 있다·가능성이 있다·고려할 필요가 있다" 템플릿·헤지를 제거.
  formal_brief: {
    label: '격식 보고서형(비인칭·압축)',
    slots: [
      { role: 'definition_fact', goal: '대상을 도입 상투구 없이 사실 정의로 곧장 제시하라. "최근 ~중요해지고 있다/빠르게 변하고 있다"류 도입 금지.', w: 1.1 },
      { role: 'mechanism', goal: '핵심 메커니즘·인과를 단정 서술로 압축하라. "~할 수 있다/가능성이 있다/볼 수 있다" 대신 조건을 명시한 단정문으로.', w: 1.3 },
      { role: 'conditional_variation', goal: '구간·조건별로 결과가 어떻게 갈리는지 구체 분기하라(일반론·"다양한 요인" 금지).', w: 1.3 },
      { role: 'analysis_basis', goal: '판단의 근거(무엇을 무엇과 대조·비교하는지)를 사실로 명시하라. "본 연구에서는 ~하고자 한다 / 이론적 배경 / 필요성" 선언·나열 금지.', w: 1.1 },
      { role: 'implication_terse', goal: '그래서 무엇이 달라지고 무엇을 봐야 하는지 단정적으로 짚고 끝내라. 교훈 요약·"고려할 필요가 있다"·"중요한 의미를 가진다" 금지.', w: 1.0 },
    ],
  },
};

// 서버 라우팅: 주제 신호로 skeleton 선택(이번 실험은 후보 전부 생성하므로 참고용)
function pickSkeleton(rawText) {
  if (/(법|조례|정책|행정|규제|지침|가이드라인)/.test(rawText) && /(제안|개선|대응)/.test(rawText)) return 'policy_column';
  if (((rawText.match(/\d[\d,.]*%/g) || []).length) > 15) return 'news_article_style';
  return 'debate_explainer';
}

async function buildSlotPlan(rawText, { skeleton, evidenceList = [], ledger, lengthMode = 'keep', signal } = {}) {
  const sk = SKELETONS[skeleton];
  const claims = (ledger?.claims || []).map((c, i) => `C${i + 1}. ${c.claim || ''}`).join('\n');
  const evid = evidenceList.map((e, i) => `E${i + 1}. ${e}`).join('\n');
  const system = `너는 문서 편집자다. 원문의 주장(C#)과 승인 근거(E#)를 "${sk.label}" 골격의 슬롯에 배정한다.
슬롯(순서 고정): ${sk.slots.map((s, i) => `${i + 1}.${s.role}(${s.goal.slice(0, 24)}…)`).join(' / ')}
규칙: 모든 C#를 빠짐없이 한 슬롯에(중복 금지). 모든 E#도 한 슬롯에(중복 금지). 제목은 쟁점을 드러내는 구체적 제목(부제는 꼭 필요할 때만 짧게 — 대시 부제·콜론 남용 금지), "~에 미치는 영향/~란 무엇인가" 식·극적 부제 금지.
JSON만: {"title":"...","subtitle":"...","slots":[{"role":"hook_fact","claims":["C1"],"evidence":["E1"]},...]} (슬롯 순서·개수 고정)`;
  const user = `[원문]\n${rawText}\n\n[주장]\n${claims}\n\n[승인 근거]\n${evid || '(없음)'}`;
  let plan = await llmJSON({ system, user, signal, maxTokens: 2500, model: MODEL });
  // ★작업 생존(2026-06-12 실사고 'slot plan 실패'): 계획 1콜이 흔들려도 전체 작업을 죽이지 않는다.
  //   1차 실패 → 스키마 강조+토큰 여유로 재시도, 2차도 실패 → 결정론 폴백(빈 슬롯 → 아래 커버리지 보정이
  //   모든 C#/E#를 라운드로빈 배정, 제목은 원문 첫 문장 = 허용 세계 내라 novelty-safe).
  if (!plan || !Array.isArray(plan.slots)) {
    console.warn('⚠️ slot plan 1차 실패 — 스키마 강조 재시도');
    plan = await llmJSON({ system: system + '\n★출력은 JSON 객체 하나만 — {"title","subtitle","slots"} 스키마 그대로. JSON 외 텍스트·설명 절대 금지.', user, signal, maxTokens: 3500, model: MODEL });
  }
  if (!plan || !Array.isArray(plan.slots)) {
    console.warn('⚠️ slot plan 2차도 실패 — 결정론 폴백(라운드로빈 배정)');
    plan = { title: (sg.splitSentences(rawText)[0] || '').replace(/\s+/g, ' ').trim().slice(0, 60), subtitle: '', slots: [] };
  }
  // 슬롯 정렬·보정 + 중복 제거 + 커버리지(미배정 → 주제 무관히 본문 슬롯에 순환 배정)
  const slots = sk.slots.map(def => {
    const found = plan.slots.find(s => s.role === def.role) || {};
    return { ...def, claims: found.claims || [], evidence: found.evidence || [] };
  });
  const seenC = new Set(), seenE = new Set();
  slots.forEach(s => {
    s.claims = s.claims.filter(id => !seenC.has(id) && seenC.add(id));
    s.evidence = s.evidence.filter(id => !seenE.has(id) && seenE.add(id));
  });
  let rr = 1;
  (ledger?.claims || []).forEach((c, i) => { const id = `C${i + 1}`; if (!seenC.has(id)) { slots[rr % (slots.length - 1) + 0].claims.push(id); seenC.add(id); rr++; } });
  evidenceList.forEach((e, i) => { const id = `E${i + 1}`; if (!seenE.has(id)) { slots[rr % (slots.length - 1) + 0].evidence.push(id); seenE.add(id); rr++; } });
  // ★ 사실 분산 캡(2026-06-12 실측 61%): 계획 LLM이 통계를 리드 슬롯에 몰빵(한 영역에 8~10개) →
  //   나머지 영역이 맨몸 논증으로 남아 피탐. 실측 원칙(§설계): 문단당 1사실 분산=42% vs 몰림=58%.
  //   슬롯당 캡 = ceil(전체/슬롯수)+1, 초과분은 사실이 적은 슬롯부터 순서대로 재배치(주제 매칭 일부 양보 <
  //   분산 이득 — 영역 단위 면역은 분산이 만든다).
  {
    const totalE = evidenceList.length;
    if (totalE > slots.length) {
      const cap = Math.ceil(totalE / slots.length) + 1;
      const overflow = [];
      slots.forEach(s => { while (s.evidence.length > cap) overflow.push(s.evidence.pop()); });
      for (const id of overflow) {
        const target = slots.slice().sort((a, b) => a.evidence.length - b.evidence.length)[0];
        target.evidence.push(id);
      }
    }
  }
  // 분량 모드(2026-06-15 사장님 "유지 골라도 짧다" — 옵션을 엔진에 연결): keep=원문 95% 목표, compact=60%.
  //   재구성은 원장 요약에서 재생성하므로 100%는 불가(요약 압축) — keep도 실측 상한 ~65~75%. compact는 의도적 축약.
  const lenScale = lengthMode === 'compact' ? 0.6 : 0.95;
  const desired = Math.round((((rawText.match(/[가-힣]/g) || []).length) || 1) * lenScale);
  const wsum = slots.reduce((a, s) => a + s.w, 0);
  // ★길이 규율(2026-06-18): 슬롯 최소 floor를 입력 길이에 비례시킨다. 고정 420 floor는 짧은 글을
  //   슬롯수×420까지 부풀려(966자→2940자 강제) "같은 논점 반복 패딩"을 유발 → 카피킬러 반복 태그로 피탐.
  //   무날조 원칙상 짧은 글은 못 부풀린다(새 사실 금지) → 짧게 나오는 게 정답. floor = min(420, desired/슬롯수).
  const floorPer = Math.min(420, Math.round(desired / Math.max(1, slots.length)));
  slots.forEach(s => { s.targetChars = Math.max(floorPer, Math.round(desired * s.w / wsum)); });
  return { title: plan.title || '', subtitle: plan.subtitle || '', slots };
}

// ★ 목소리 앵커·누출 게이트·승인사실 무결성 가드 — 메인 엔진 이식(2026-06-11)으로 prompt.js/evidenceguard.js/floor.js가
//   단일 진실 소스가 됨. 여기서는 import만(동작 동일). 앵커 헤더는 이식하며 디프레이밍됨(탐지기·점수 언급 제거).
const { LLM_TIC_RULE, pickAnchors, ANCHOR_LEAK_RE } = require('./prompt');
// ★ 수치-출처 짝 검증·수치 토큰·기관 앵커: engine/evidenceguard.js로 이식(메인 엔진 공용) — import만.
const { _numToks, evidenceAnchorMap, checkEvidencePairing, dedupeFactRecitations, injectOwnerMarkers } = require('./evidenceguard');

// ★ 문단 정리(2026-06-12): LLM이 한 문단 안에서 문장마다 줄바꿈(\n)을 넣으면 pre-wrap UI에서 "문장 뜻 단위로
//   두 행" 어색한 줄바꿈이 됨. 문단 구분(\n\n)은 유지하고 문단 내부 단일 \n만 공백으로. 제목 블록(첫 블록에
//   "— 부제" 줄)은 제목/부제 줄바꿈을 보존.
// ★ 문서 구조 줄(헤딩·번호·불릿·표 행·조항)이면 앞 줄바꿈을 보존, 아니면 공백 합침(2026-06-17, 구조 붕괴 #100·#16·
//   #92·#34·#90 수정). LLM이 문장마다 넣는 잡 \n은 그대로 공백 처리(현행 유지) — 다음 줄이 구조 줄일 때만 \n 보존.
//   \d{1,2}(?!\d) 가드: 4자리 연도(2023.)를 1.리스트로 오인 금지.
const STRUCT_LINE_RE = /^\s*(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*[.、)]|\d{1,2}(?!\d)\s*[.)]\s|\d{1,2}\.\d{1,2}|[가-하]\s*[.)]\s|[①②③④⑤⑥⑦⑧⑨⑩]|[-•*▪◦·]\s|\|.*\||제\s?\d{1,3}\s?(?:조|장|절|항))/;
function structJoin(text) {
  const ls = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!ls.length) return '';
  let acc = ls[0];
  for (let k = 1; k < ls.length; k++) {
    // 현재 줄이 구조 줄(리스트·하위헤딩) 또는 직전 줄이 구조 줄(헤딩 다음 본문 분리)이면 줄바꿈 보존.
    const keepNl = STRUCT_LINE_RE.test(ls[k]) || STRUCT_LINE_RE.test(ls[k - 1]);
    acc += (keepNl ? '\n' : ' ') + ls[k];
  }
  return acc;
}
function tidyParagraphs(doc) {
  const blocks = (doc || '').split(/\n{2,}/);
  return blocks.map((b, i) => {
    const t = b.trim();
    if (!t) return '';
    if (i === 0 && /\n\s*—/.test(b)) {                         // 제목\n— 부제 보존
      return t.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
    }
    return structJoin(t);                                       // 문단 내부: 구조 줄만 줄바꿈 보존, 나머지는 공백
  }).filter(Boolean).join('\n\n');
}

// 문단급 near-dup 제거(2026-06-11, 43% PDF에서 발견): weave가 사실 토큰을 끼우며 문단을 변주 복제
// ("진입장벽~오프로딩" 4문장 2본) — 문장級 dedupe는 ③마감에서 weave보다 먼저 돌아 못 잡음. 카피킬러
// '기계적 정확성·균일성' 라벨 2영역이 정확히 이 이음새였음. 순수 삭제 = FLOOR-safe.
// 사실 손실이 늘지 않는 쪽 사본을 지운다(둘 다 늘면 유지 — 악화 금지).
function _paraBigrams(s) { const t = s.replace(/\s+/g, ''); const set = new Set(); for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2)); return set; }
function _paraJaccard(a, b) { const A = _paraBigrams(a), B = _paraBigrams(b); let inter = 0; for (const x of A) if (B.has(x)) inter++; const uni = A.size + B.size - inter; return uni ? inter / uni : 0; }
function dedupeParas(doc, textF) {
  const paras = doc.split(/\n{2,}/);
  const drop = new Set();
  const joined = (skip) => paras.filter((_, x) => !drop.has(x) && x !== skip).join('\n\n');
  for (let i = 0; i < paras.length; i++) {
    if (drop.has(i)) continue;
    for (let j = i + 1; j < paras.length; j++) {
      if (drop.has(j)) continue;
      if (paras[i].replace(/\s+/g, '').length < 80 || paras[j].replace(/\s+/g, '').length < 80) continue;
      if (_paraJaccard(paras[i], paras[j]) < 0.6) continue;
      const base = floor.measureLostFacts(textF, joined(-1)).count;
      if (floor.measureLostFacts(textF, joined(j)).count <= base) { drop.add(j); continue; }
      if (floor.measureLostFacts(textF, joined(i)).count <= base) { drop.add(i); break; }
    }
  }
  return paras.filter((_, x) => !drop.has(x)).join('\n\n');
}

// 사실 재인용 제거(dedupeFactRecitations): engine/evidenceguard.js로 이식 — 위 import 사용.

// 문단 횡단 문장급 dup 해소(사실 인지형) — v5 실측: 사본들이 서로 다른 큰 문단 안에 박혀 문단 jaccard 0.497로
// dedupeParas가 못 잡고, dedupe(문장級)는 "후속 등장 삭제"라 위빙된 사실 토큰("두 번~다섯 번")을 든 사본을 지워
// lost를 재유발(순환). 해법: 뒤 사본 제거가 기본이되, 뒤 사본 제거로 lost가 늘면 앞자리에 뒤 문장을 심고 뒤를 제거.
// 패러프레이즈 포함관계(2026-06-12 실측: "틱톡이 EU의 조사가 시작되자 보상 프로그램을 자진 철회한 것은…" 직후
// "틱톡은 조사가 착수되자 보상 프로그램을 자진 철회했다" 재진술 — 길이가 달라 bigram jaccard 0.62 미달로 생존).
// 짧은 쪽의 내용어가 긴 쪽에 85%+ 포함되면 같은 사실의 재진술로 본다.
function _containedDup(a, b) {
  const toks = (s) => [...new Set((s.match(/[가-힣]{2,}|[A-Za-z]{2,}|\d[\d,.]*/g) || []))];
  const [shorter, longer] = a.replace(/\s+/g, '').length <= b.replace(/\s+/g, '').length ? [a, b] : [b, a];
  const st = toks(shorter);
  if (st.length < 4) return false;
  // 한국어 활용형("철회했다"↔"철회한", "틱톡은"↔"틱톡이") 때문에 토큰 동일성은 빗나간다 — 어간 2자 프리픽스로 매칭.
  const hit = st.filter(t => longer.includes(t.slice(0, 2))).length;
  return hit / st.length >= 0.85;
}
function resolveDupSentences(doc, textF) {
  let guard = 0;
  for (let changed = true; changed && guard < 12; guard++) {
    changed = false;
    const paras = doc.split(/\n{2,}/).map(p => p.split(/(?<=[.!?”"])\s+/));
    const flat = [];
    paras.forEach((sents, pi) => sents.forEach((s, si) => flat.push({ pi, si, s })));
    outer:
    for (let x = 0; x < flat.length; x++) {
      for (let y = x + 1; y < flat.length; y++) {
        const a = flat[x], b = flat[y];
        if (a.s.replace(/\s+/g, '').length < 20 || b.s.replace(/\s+/g, '').length < 20) continue;
        if (a.pi === b.pi && Math.abs(a.si - b.si) <= 1 && !_containedDup(a.s, b.s)) continue;   // 인접은 꼬리에코 담당, 단 포함관계 재진술은 여기서
        if (_paraJaccard(a.s, b.s) < 0.62 && !_containedDup(a.s, b.s)) continue;
        const rebuild = (mut) => {
          const P = paras.map(se => se.slice());
          mut(P);
          return P.map(se => se.filter(Boolean).join(' ')).filter(p => p.replace(/\s+/g, '').length > 0).join('\n\n');
        };
        const dropB = rebuild(P => { P[b.pi][b.si] = ''; });
        const swapAB = rebuild(P => { P[a.pi][a.si] = b.s; P[b.pi][b.si] = ''; });
        doc = floor.measureLostFacts(textF, swapAB).count < floor.measureLostFacts(textF, dropB).count ? swapAB : dropB;
        changed = true;
        break outer;
      }
    }
  }
  return doc;
}

// 메타 메모·지시문 윙크·용어귀속 날조 가드: engine/floor.js로 이식(메인 엔진 공용) — import만.
const { META_NOTE_RE, WINK_RE, findCoinedTerms } = require('./floor');
// ★판정 스캐폴딩 줄 제거(2026-06-16 실측 2건): 판정/수리 LLM이 교정 본문 대신 마크다운 판정을 통째로
//   토해 본문에 박히는 사고 — "# 판정: added_claim", "## 근거 - …", "---", "**문제점:** - …",
//   "## 수정 문장:" 등. 칼럼 산문엔 마크다운 헤더·수평선·판정 라벨이 존재하지 않으므로 줄 단위로 안전하게
//   제거한다(일반어 '근거/판정/문제점'은 "라벨+콜론" 형태일 때만 매칭 — 정상 산문 오탐 회피).
const SCAFFOLD_LINE_RE = /^(?:#{1,6}\s|[-—*_]{3,}\s*$|\*{0,2}\s*(?:판정|근거|문제점|수정\s*문장|위반(?:\s*(?:사항|내용))?|진단|평가\s*결과)\s*\*{0,2}\s*[:：])/;
// ★문장 단위 메타 제거(2026-06-16): 예전엔 문단 단위 + >300자 문단 예외라, 긴 문단 안에 끼인 지시문/판정
//   (인라인 누출, 예: "… 받는다. # 판정: added_claim")이 통째로 통과했다. 이제 ① 줄 단위로 판정 스캐폴딩
//   줄을 빼고 ② 남은 문단을 문장으로 쪼개 META 매칭 문장만 뺀다 → 본문은 보존, 누출만 제거. 순수 메타 문단은
//   모든 줄·문장이 빠져 자동 삭제. META_NOTE_RE·SCAFFOLD_LINE_RE 모두 정상 산문 오탐이 거의 없는 고정밀.
function stripMetaNotes(doc) {
  const out = [];
  for (const para of String(doc || '').split(/\n{2,}/)) {
    const lines = para.split(/\n/).map(l => l.trim()).filter(l => l && !SCAFFOLD_LINE_RE.test(l));
    // ★ 구조 보존(2026-06-17): 줄별로 META 문장만 제거한 뒤 struct-aware 재조합(헤딩·리스트 줄바꿈 유지).
    const keptLines = lines.map(line => {
      const sents = line.split(/(?<=[.!?”"。…])\s+/);
      return sents.filter(s => { const ss = s.trim(); return ss && !META_NOTE_RE.test(ss); }).join(' ').trim();
    }).filter(Boolean);
    if (keptLines.length) out.push(structJoin(keptLines.join('\n')));
  }
  return out.join('\n\n');
}

const V2_BANS = `[금지 — 하나라도 어기면 실패]
· 연구보고서 어법: 본 연구는/연구의 필요성/이론적 배경/연구 목적/첫째,…둘째,…셋째,…
· AI 해설문 틀: "~란 무엇인가", "~의 의미/필요성", "도움이 되는 순간/지점", "위험한 지점", "~가 해야 할 일", "결국 ~에 달려 있다", "이 구조(과정)에서 가장 중요한", "이 사실(결과/수치)은 ~를 보여준다", "같은 맥락을 가리킨다", "문제는 ~라는 데 있다", "~라는 점에서", "달리 말하면 ~", "제목 — 부제 — 또 다른 부제"식 대시 남발
· "필자가 보기에", "과연 ~인가?", 교훈 요약 마무리("~가 중요하다/필요하다"로 문단 닫기 반복)
· 재료(주장·근거)에 없는 사실·수치·기관·사례·1인칭 경험 생성
· 원문에 없는 평가·전망·인과·진단을 새 주장으로 덧붙이기(순응도 저하·부처 충돌·주기 단축처럼 "그럴듯한 추론"을 사실인 양 확장 금지 — 원문이 말한 범위만 옮겨라)
${LLM_TIC_RULE}`;

function buildSlotPrompt(plan, slot, claimTexts, evidTexts, prevTail, usedOpeners, slotIdx = 0, srcText = '', usedNums = [], memoLines = [], skeleton = '') {
  // ★ "수치 캐시"(2026-06-15) — 격식논문 재구성에서 연도·%가 떨어지거나(2023 누락=lostFacts) 바뀌는(2023→2022=distortion)
  //   차단의 예방책: 승인 근거뿐 아니라 "이 슬롯의 원문 문단(srcText)"에 실재하는 수치·연도·법령번호도 "반드시 포함"으로
  //   못 박는다. 원문에 있는 수치만 강제(생성 아님) → retry 채점(누락 시 감점)이 누락·변형을 강하게 억제.
  //   근거 수치를 앞에 둬 우선 보존, 과밀 방지로 14개 상한.
  const evNums = (evidTexts.join(' ').match(/\d[\d,.]*%?/g) || []);
  const srcPH = ((srcText || '').match(/⟦F[a-z]{2}⟧/g) || []);   // factsafe 자리표시자 — 있으면 이게 "반드시 보존" 대상
  const srcNums = srcPH.length ? srcPH : ((srcText || '').match(/\d[\d,.]*%?/g) || []).filter(t => t.replace(/\D/g, '').length >= 2);
  const mustNums = [...new Set([...evNums, ...srcNums])].slice(0, 16);
  const hasPH = srcPH.length > 0;
  const banNums = usedNums.filter(n => !mustNums.includes(n));
  // 사용자 실제 경험·사례(메모): 관련 있는 슬롯에 구체 예시로 녹인다. 메모에 없는 건 생성 금지(허용 세계=원문∪근거∪메모).
  const memoBlock = (memoLines && memoLines.length)
    ? `\n\n[필자(사용자)가 직접 제공한 실제 경험·사례 — 이 슬롯 논점과 관련 있으면 추상 서술을 구체적 장면·예시로 바꿔 녹여라. 메모에 없는 경험·수치·기관·사실은 절대 지어내지 말 것. 한 경험은 글 전체에서 한 번만 쓴다]\n${memoLines.map(m => `· ${m}`).join('\n')}`
    : '';
  const isFormal = skeleton === 'formal_brief';
  const anchors = (isFormal || process.env.STYLE_ANCHOR === '0') ? '' : pickAnchors(slotIdx) + '\n';
  // 페르소나·문체를 스켈레톤별로 — 격식 보고서형은 칼럼 voice가 아니라 비인칭 분석체 + 리듬 변주(균일성 직격)
  const persona = isFormal
    ? '너는 한국어 분석 보고서를 쓰는 필자다. 한 편의 분석 보고서를 슬롯 단위로 이어 쓰고 있다(소제목 없음 — 흐름으로 이어지는 줄글).'
    : '너는 한국 시사 칼럼 필자다. 한 편의 칼럼을 슬롯 단위로 이어 쓰고 있다(소제목 없음 — 흐름으로 이어지는 줄글).';
  // ※ 격식톤은 칼럼톤보다 탐지가 구조적으로 높다(격식 register 어휘가 주관배제·무견해 태그를 올림 — 3회 실측 확정).
  //   균일성/판단주입/리듬 지시로 균일성은 낮출 수 있어도 register penalty는 못 없앤다. register 보존이 목적인 옵션.
  const styleBlock = isFormal
    ? `[문체 — 분석 보고서의 결(비인칭·격식, 단 상투 템플릿/헤지 회피)]
· 한다체·비인칭 격식 유지. 단 "본 연구는/연구의 필요성/이론적 배경/첫째,…둘째,…" 보고서 상투 템플릿과 "~할 수 있다·가능성이 있다·고려할 필요가 있다" 헤지는 금지.
· 문장 길이를 들쭉날쭉하게: 짧은 단정문과 긴 분석문을 섞고, 같은 구조 문장을 3개 이상 연속하지 마라.
· 칼럼식 수사(반문 "과연 ~인가?", 구어 추임새, 1인칭) 금지. 괄호 삽입구는 단서·부연에 한해 절제(1000자당 2~3개).
· 같은 내용·문장을 다른 슬롯에서 반복하지 마라 — 직전 문단 끝을 보고 새 내용으로 전개하라.`
    : `[문체 — 사람 칼럼의 결]
· 한다체. 괄호 삽입구(부연·연도·단서)를 자연스럽게(1000자당 4~8개). 인용 표지("~에 따르면")로 근거를 논점 전개 재료로.
· 문단 길이 들쭉날쭉. 일부 문단은 결론 없이 다음 쟁점으로 넘어가다 만 듯 끝내라. 모든 문단을 같은 단어로 시작하지 말고, user가 주는 금지 시작어를 피하라.
· 한 문단 안에서 근거와 의견이 섞이게(근거 나열 문단 금지 — 근거는 논쟁의 무기다).`;
  // ★ prompt caching(§이식 ⑧): system은 고정부+앵커(5변형)만 — 슬롯별 가변부([이 슬롯]·금지 시작어·수치 목록)는
  //   전부 user로 분리해 같은 앵커 변형의 슬롯·재시도가 system 캐시를 재사용할 수 있게 한다(지시 내용은 동일).
  const system = `${persona}
${anchors}[사실 보존 — 절대 규칙, 문체보다 우선]
· 연도·날짜·기간·인용연도·퍼센트·통계 수치·금액·법령번호는 원문 표기 그대로 옮겨라. 절대 바꾸지 마라(2023을 2022로, 40%를 45%로 쓰면 실패).
· "반드시 포함할 수치"로 준 값은 빠짐없이, 정확히 그대로 본문에 넣어라. 재구성하더라도 이 값들은 손대지 않는다.
· 원문에 없는 연도·수치·출처·기관·인용을 새로 만들지 마라. 또한 원문에 없는 평가·전망·인과관계·진단을 새 주장으로 덧붙이지 마라(예: "~로 순응도가 낮아진다", "부처가 충돌했다", "주기가 짧아진다" 같은 추론·확장 금지 — 원문이 말한 범위만 다른 문장으로 옮겨라).
· ★원문에 등장하는 고유명사(인물·기관·책·제품·기술명)에는 원문이 그 대상에 대해 말한 사실만 옮겨라. 그 대상에 원문에 없는 활동·저작·발언·업적·특성·역할을 새로 붙이지 마라(예: 원문이 "○○의 책을 읽었다"까지만 말했으면, "○○가 ~기법을 체계적으로 다룬다"처럼 그 인물의 행적을 지어내 확장하면 실패).
· ★재료(원문 주장·근거)가 빈약하면 빈약한 대로 짧게 써라. 분량을 채우려고 원문에 없는 기술적 설명·메커니즘·구체 수치·인과·온도/규격을 지어내 채우지 마라 — 분량 미달보다 날조가 훨씬 큰 실패다(짧은 글은 짧게 재구성하는 것이 정답이다).${hasPH ? '\n· ★⟦F##⟧ 형태의 토큰은 원문 사실(연도·수치)의 자리표시자다. 그 자체를 본문에 그대로 옮겨 쓰고(숫자로 바꾸지 말 것), 위치·개수를 유지하라. 토큰을 삭제·변형·생성하면 실패. 예: "⟦Fab⟧년에 제정"은 그대로 "⟦Fab⟧년에 제정"으로.' : ''}
${styleBlock}
${V2_BANS}
· 출력: 본문만(제목·소제목·머리말 금지).`;
  const user = `[이 슬롯]
· 역할: ${slot.role} — ${slot.goal}
· 분량: 문단 ${Math.max(1, Math.round(slot.targetChars / 330))}개, 공백 제외 약 ${slot.targetChars}자. 짧으면 실패.
· 금지 시작어(앞 문단들이 이미 쓴 첫 단어): ${usedOpeners.slice(-8).join(', ') || '없음'}
${mustNums.length ? `· 반드시 포함할 수치: ${mustNums.join(', ')}` : ''}
${banNums.length ? `· ★앞 슬롯에서 이미 인용한 수치·조사 — 재인용 금지(같은 글에서 같은 통계를 두 번 소개하면 실패다): ${banNums.join(', ')}` : ''}
[칼럼 제목(참고)]\n${plan.title} — ${plan.subtitle}\n\n[직전 문단 끝(여기서 자연스럽게 이어가라, 반복 금지)]\n${prevTail || '(글의 시작)'}\n\n[이 슬롯의 재료 — 원문 주장]\n${claimTexts.join('\n') || '(없음)'}\n\n[이 슬롯의 재료 — 승인 근거]\n${evidTexts.join('\n') || '(없음)'}${srcText ? `\n\n[이 슬롯의 원문 문단(디테일 재료 — 요약하지 말고 구체 디테일·예시를 살려서 분량을 채워라. 단 문체는 칼럼의 결로)]\n${srcText}` : ''}${memoBlock}`;
  return { system, user, mustNums };
}

// ★ 수치 변형(distortion) 결정론 복원(2026-06-15): 재생성 중 LLM이 연도·%를 잘못 옮긴 경우(원문 2023→출력 2022)를
//   semanticJudge가 distortion으로 '차단'하던 것을, 차단 대신 '원문 값으로 복원'한다. 출력에만 있는(허용세계에 없는)
//   수치를 — 같은 종류(연도/%)이고 문장 맥락이 매우 유사한(토큰 겹침≥0.6) "원문에서 사라진 수치"로 되돌린다.
//   겹침이 높을 때만 동작해 서로 다른 수치를 잘못 합치는 오교정을 막는다(진짜 날조는 매칭 안 돼 그대로 차단).
function correctDistortedNumbers(doc, rawText, allowedText) {
  const NUM_RE = /(?:19|20)\d{2}년?|\d[\d,]*(?:\.\d+)?\s*%/g;
  const norm = s => s.replace(/\s+/g, '').replace(/년$/, '');
  const isYear = k => /^(?:19|20)\d{2}$/.test(k);
  const srcKeys = new Set(((allowedText || rawText).match(NUM_RE) || []).map(norm));
  const outAll = (doc.match(NUM_RE) || []).map(norm);
  const outKeys = new Set(outAll);
  const novel = [...new Set(outAll)].filter(n => !srcKeys.has(n));
  if (!novel.length) return doc;
  const tok = s => { const set = new Set(); for (const w of s.replace(/[^가-힣A-Za-z0-9]/g, ' ').split(/\s+/)) if (w.length >= 2) set.add(w); return set; };
  const overlap = (a, b) => { const A = tok(a), B = tok(b); if (!A.size) return 0; let h = 0; for (const w of A) if (B.has(w)) h++; return h / A.size; };
  const lost = [];
  for (const s of sg.splitSentences(rawText)) {
    for (const m of (s.match(NUM_RE) || [])) { const k = norm(m); if (!outKeys.has(k)) lost.push({ key: k, sent: s, year: isYear(k) }); }
  }
  if (!lost.length) return doc;
  let out = doc;
  const outSents = sg.splitSentences(doc);
  // ★ 단순 치환만 자동복구(사장님 F안): 출력·원문 대응 문장 모두 같은 종류 수치가 "1개"일 때만. 여러 연도가
  //   섞인 문장(2021·2022·2023 비교)은 단순 치환하면 더 망가지므로 자동복구 금지 → 차단(보존형 재시도로 보냄).
  const cntType = (s, year) => (s.match(NUM_RE) || []).map(norm).filter(k => isYear(k) === year).length;
  for (const nv of novel) {
    const host = outSents.find(s => (s.match(NUM_RE) || []).map(norm).includes(nv));
    if (!host || cntType(host, isYear(nv)) !== 1) continue;
    let best = null, bestOv = 0;
    for (const L of lost) {
      if (L.year !== isYear(nv) || cntType(L.sent, L.year) !== 1) continue;
      const ov = overlap(host, L.sent); if (ov > bestOv) { bestOv = ov; best = L; }
    }
    if (best && bestOv >= 0.6) {
      const re = new RegExp(nv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      out = out.replace(host, host.replace(re, best.key));   // 출력 수치 → 원문 값 복원
      lost.splice(lost.indexOf(best), 1);
    }
  }
  return out;
}

async function genreTransferV2(rawText, { skeleton = 'debate_explainer', evidence = '', userNotes = '', lang = 'ko', lengthMode = 'keep', signal } = {}) {
  const evidenceList = (evidence || '').split('\n').map(l => l.trim()).filter(Boolean);
  // ★ 사용자 실제 경험·사례 메모(2026-06-15): 추상 격식글이 회피에 막히는 근본 원인=구체 부족 → 엔진이
  //   못 지어내는 진짜 구체를 사용자가 제공. 메모는 허용 세계(원문∪근거∪메모)에 들어가 날조가 아니게 되고,
  //   슬롯 생성에 재료로 녹아 추상도를 낮춘다. blog 경로(userNotes)와 동일 원리를 재구성에 확장.
  const memoLines = (userNotes || '').split('\n').map(l => l.trim()).filter(Boolean);
  const allowed = [evidence, userNotes].filter(Boolean).join('\n');
  // 메모는 allowed에만(=날조 아님, 선택 재료) — textF(사실 생존 강제/lostFacts 기준)엔 넣지 않는다.
  //   evidence는 학생이 승인한 사실이라 textF에 포함해 생존을 강제하지만, 메모는 "관련 있으면 녹이는" 선택지라
  //   강제하면 관련 없는 메모 한 줄이 lostFacts로 차단을 유발한다(2026-06-15 설계 결정).
  const textF = evidence ? rawText + '\n\n' + evidence : rawText;
  // ★ 설계 D — 사실 자리표시자 보호(2026-06-15): 슬롯 생성이 흩어진 연도·수치를 떨구거나(2023 누락) 바꾸는(2023→2022)
  //   걸 원천 차단. 원문 hard fact를 ⟦Faa⟧ 토큰으로 가려 생성하고(LLM이 값 못 바꿈·잘 안 떨굼), 슬롯 생성+프레임수리
  //   직후 복원해 값 정확성을 보장한다. 이후 weaveLost·judge·게이트는 실제 값으로 본다. 사실 3개+ 글에만 적용.
  const factsafe = require('./factsafe');
  const factMap = factsafe.buildFactMap(rawText);
  const fsafe = factMap.count >= 3;
  // ※ 원장 마스킹/숫자보존 강제는 backfire(2026-06-18 실측: 사실손실 6→14) — 재구성은 "요약→재생성"이라
  //   구조적으로 데이터 글의 숫자를 보존 못 함. 데이터 풍부 글은 재구성이 아닌 보존형(faithful) 경로로 라우팅해야 함.
  const ledger = await buildSoftClaimLedger(rawText, { lang, signal });
  const plan = await buildSlotPlan(rawText, { skeleton, evidenceList, ledger, lengthMode, signal });

  // 슬롯 순차 생성(앞 슬롯 꼬리에 이어 쓰기 — v1의 병렬 섹션 단절 문제 해소)
  const bodies = [];
  const usedOpeners = [];
  let slotIdx = -1;
  for (const slot of plan.slots) {
    slotIdx++;
    const claimTexts = (slot.claims || []).map(id => {
      const c = ledger.claims[parseInt(String(id).replace(/\D/g, ''), 10) - 1];
      return c ? `· ${c.claim || ''}${c.evidence_text ? ` (원문 근거: ${c.evidence_text})` : ''}` : null;
    }).filter(Boolean);
    const evidTexts = (slot.evidence || []).map(id => {
      const e = evidenceList[parseInt(String(id).replace(/\D/g, ''), 10) - 1];
      return e ? `· ${e}` : null;
    }).filter(Boolean);
    // 분량 49% 고질의 구조 원인 완화(2026-06-11): 재료가 ledger 요약뿐이라 디테일이 깎임 → claim의
    // evidence_text(원문 인용)가 들어 있는 원문 문단을 디테일 재료로 직접 전달(중복 제거, 1400자 캡).
    const rawParas = rawText.split(/\n{2,}/).map(p => p.trim()).filter(p => p.replace(/\s+/g, '').length > 40);
    const srcSet = new Set();
    for (const id of (slot.claims || [])) {
      const c = ledger.claims[parseInt(String(id).replace(/\D/g, ''), 10) - 1];
      if (!c || !c.evidence_text) continue;
      const key = String(c.evidence_text).replace(/\s+/g, '').slice(0, 24);
      const p = rawParas.find(rp => rp.replace(/\s+/g, '').includes(key));
      if (p) srcSet.add(p);
    }
    let srcText = [...srcSet].join('\n').slice(0, 1400);
    // 사실 자리표시자 보호: 슬롯 재료(원문 문단·주장)의 연도·수치를 토큰으로 가린다(병합 후 복원).
    let claimTextsP = claimTexts;
    if (fsafe) { srcText = factsafe.mask(srcText, factMap); claimTextsP = claimTexts.map(c => factsafe.mask(c, factMap)); }
    const prevTail = bodies.length ? bodies[bodies.length - 1].split(/\n{2,}/).pop().slice(-160) : '';
    // 앞 슬롯들이 이미 인용한 수치 — 재인용 금지 목록(ai-study 63% 실측: 슬롯 독립 생성이 같은 통계를 2~4회 재진술)
    const usedNumList = [...new Set(bodies.flatMap(b => _numToks(b)).map(t => t.split('|')[0]))];
    const { system, user, mustNums } = buildSlotPrompt(plan, slot, claimTextsP, evidTexts, prevTail, usedOpeners, slotIdx, srcText, usedNumList, memoLines, skeleton);
    const usedNumSet = new Set(usedNumList);
    const minChars = Math.round(slot.targetChars * 0.8);   // 0.7→0.8(분량 미달이 best-pick으로 통과하던 폭 축소)
    let best = { body: '', score: -1 };
    let bestNovel = { body: '', score: -1, items: [] };   // 날조 토큰 포함 후보 — 클린 슬롯이 0이면 토큰만 빼고 살려 슬롯 붕괴 방지(2026-06-16)
    for (let attempt = 0; attempt < 4; attempt++) {        // 3→4(분량 재시도 여유)
      let body = '';
      const extra = attempt > 0 ? `\n\n★재시도: ${mustNums.length ? `수치(${mustNums.join(', ')}) 누락 금지. ` : ''}분량 미달이다 — 공백 제외 ${slot.targetChars}자 이상을 반드시 채워라(원문 문단의 디테일·예시를 더 살려라). 금지 표현을 쓰지 마라. 앵커의 소재(부동산·도시 등)를 가져오지 마라.` : '';
      try { body = (await llmText({ system, user: user + extra, signal, maxTokens: 2500, model: MODEL }) || '').trim(); } catch { continue; }
      if (!body || floor.looksLikeRefusal(body)) continue;
      if (ANCHOR_LEAK_RE.test(body)) continue;                       // 앵커 소재 번짐 → 폐기(실측 1회 발생)
      if (META_NOTE_RE.test(body)) continue;                          // 메타 메모 → 폐기
      if (WINK_RE.test(body)) continue;                               // 지시문 윙크 → 폐기(루틴 v1 실측)
      if (findCoinedTerms(body, textF).length > 0) continue;          // 용어귀속 날조 → 폐기(수리 불가 — 폐기 유지)
      // 짝 위반은 폐기하지 않고 감점만 — 폐기 시 데이터 슬롯이 통째로 사라짐(v4 실측: lost 18, 분량 38%).
      // 짝 위반은 결정론 검증 가능한 "수리 대상"이라 본문 단계 ①(수치 보존 교정)에 맡긴다.
      const pairBad = checkEvidencePairing(body, evidenceList).length;
      const frames = gf.measureGenreFrames(body);
      const frameHits = frames.research.length + frames.explainerHeadings.length + frames.explainerSentences.length;
      const chars = (body.match(/[가-힣]/g) || []).length;
      const missing = mustNums.filter(n => !body.includes(n)).length;
      // 앞 슬롯 수치 재인용은 감점(이 슬롯 배정분 mustNums는 제외)
      const reCite = [...new Set(_numToks(body).map(t => t.split('|')[0]))].filter(n => usedNumSet.has(n) && !mustNums.includes(n)).length;
      const score = (chars >= minChars ? 1 : chars / minChars) + (mustNums.length ? (mustNums.length - missing) / mustNums.length : 1) - frameHits - pairBad * 2 - reCite;
      // ★날조(novelty) 토큰이 있으면 클린 후보엔 못 넣지만, 슬롯 통째 폐기(붕괴) 대비로 best-novel에 보관한다(아래에서 토큰만 제거).
      const nov = floor.measureNovelty(textF, body, allowed);
      if (nov.count > 0) { if (score > bestNovel.score) bestNovel = { body, score, items: nov.items }; continue; }
      if (score > best.score) best = { body, score };
      // ★속도(2026-06-12): 분량은 재시도 사유에서 제외 — "재시도는 길이를 못 늘림(같은 길이로 다시 씀)" 실측 확정,
      //   미달분은 어차피 아래 이어쓰기 확장이 채운다. 게이트 클린이면 즉시 채택(슬롯당 낭비 호출 최대 3회 제거).
      if (missing === 0 && frameHits === 0 && pairBad === 0) break;
    }
    // 이어쓰기 확장(2026-06-11, 분량 54% 진단): 슬롯 목표 합계는 원문의 92%로 정상인데 Sonnet이 호출당
    // 500~650자에서 멈춰 충족률 ~60%(7,000목표→4,361실측). 재시도는 길이를 못 늘림(같은 길이로 다시 씀) →
    // 미달분은 "끊긴 지점에서 이어쓰기"로 채운다. 패딩이 아니라 아직 안 쓴 원문 디테일 소화를 지시.
    let bodyFinal = best.body;
    // ★붕괴 방지(2026-06-16): 클린 슬롯이 끝내 안 나오면(전 시도가 날조로 폐기) 슬롯을 통째로 버리지 않고,
    //   날조 토큰만 빼고 살린다(B 원칙: 날조는 제거하되 그 슬롯의 정당한 논지·사실·분량까지 버리지 않는다).
    //   초고밀도 격식글에서 슬롯 대부분이 날조로 폐기→분량 10%·사실 수십 건 증발하던 붕괴를 막는다.
    //   제목 수리와 동일 패턴: Haiku로 토큰 빼고 재작성(novelty 재검증) → 실패 시 결정론 토큰 제거.
    if (!bodyFinal && bestNovel.body) {
      try {
        const cand = (await llmText({
          system: `다음 문단에서 원문에 없는 수치·고유명사(${bestNovel.items.slice(0, 12).join(', ')})를 빼고, 같은 논지로 자연스럽게 다시 써라. 원문에 실제로 있는 표현만 사용하고 새 정보를 더하지 마라. 본문만 출력.`,
          user: bestNovel.body, signal, maxTokens: 2500, model: HAIKU
        }) || '').trim();
        if (cand && floor.measureNovelty(textF, cand, allowed).count === 0
            && !META_NOTE_RE.test(cand) && !ANCHOR_LEAK_RE.test(cand) && !WINK_RE.test(cand)
            && findCoinedTerms(cand, textF).length === 0) bodyFinal = cand;
      } catch { /* 폴백: 결정론 제거 */ }
      if (!bodyFinal) {                                              // LLM 수리 실패 → 토큰 직접 제거로라도 살린다(붕괴보단 낫다)
        let r = bestNovel.body;
        for (const it of bestNovel.items) r = r.split(it).join('');
        r = r.replace(/\s{2,}/g, ' ').replace(/\s+([.,)\]])/g, '$1').trim();
        if (r && floor.measureNovelty(textF, r, allowed).count === 0) bodyFinal = r;
      }
    }
    // ★분량 강화(2026-06-15 B 이후): 예전엔 3회·0.95로 올리면 lost 20(승인근거 증발)→lostFacts 하드차단이라 2회·0.9로 묶었다.
    //   이제 lostFacts는 소프트(B) + factsafe가 hard fact를 토큰으로 보존하므로 더 밀어도 차단되지 않는다 → 4회·0.95.
    //   날조(novelty)·짝(pairing) 가드는 아래 루프 안에 그대로 살아 있어 사실 안전성은 유지된다.
    for (let ext = 0; ext < 4 && bodyFinal && ((bodyFinal.match(/[가-힣]/g) || []).length) < slot.targetChars * 0.95; ext++) {
      const need = slot.targetChars - ((bodyFinal.match(/[가-힣]/g) || []).length);
      try {
        const cont = (await llmText({
          system,
          user: user + `\n\n[지금까지 쓴 본문의 끝부분(여기서 이어서 계속)]\n${bodyFinal.slice(-800)}\n\n★위 본문에 자연스럽게 이어 붙일 다음 문단(들)만 출력하라 — 공백 제외 약 ${need}자. 이미 쓴 내용 반복 금지. 재료(원문 문단·주장·근거)에서 아직 소화하지 않은 디테일·예시를 살려라. 본문만.`,
          signal, maxTokens: 3000, model: MODEL
        }) || '').trim();
        if (!cont || floor.looksLikeRefusal(cont)) break;
        if (ANCHOR_LEAK_RE.test(cont) || META_NOTE_RE.test(cont) || WINK_RE.test(cont)) break;
        if (findCoinedTerms(cont, textF).length > 0) break;
        if (floor.measureNovelty(textF, cont, allowed).count > 0) break;
        const merged = bodyFinal + '\n\n' + cont;
        if (checkEvidencePairing(merged, evidenceList).length > checkEvidencePairing(bodyFinal, evidenceList).length) break;
        bodyFinal = merged;
      } catch { break; }
    }
    if (bodyFinal) {
      bodies.push(bodyFinal);
      usedOpeners.push((bodyFinal.split(/\s+/)[0] || '').slice(0, 3));
    }
  }

  // 제목 novelty 게이트(2026-06-11 ai-study 실측): 계획이 만든 제목이 92.4→"92%"로 반올림 = 허용 세계 밖 토큰.
  // 제목은 슬롯 게이트를 안 거치므로 여기서 검사 — 위반 시 전체문서 수리(재위빙 등) 후보가 전부 novelty 기각되는
  // 연쇄 붕괴(lost 7 복구불능 실측)를 일으킨다. 수리 불가면 위반 토큰을 제목에서 제거(결정론).
  let titleLine = plan.subtitle ? `${plan.title}\n— ${plan.subtitle}` : `${plan.title}`;   // 폴백 계획은 부제 없음 — '— ' 꼬리 방지
  {
    const tNov = floor.measureNovelty(textF, titleLine, allowed);
    if (tNov.count > 0) {
      try {
        const cand = (await llmText({
          system: `다음 칼럼 제목에서 원문에 없는 수치·고유명사(${tNov.items.join(', ')})를 빼고, 같은 논지의 제목으로 다시 써라. 원문에 실제로 있는 표현만 사용. 형식 유지(제목\\n— 부제), 그것만 출력.`,
          user: titleLine, signal, maxTokens: 200, model: HAIKU   // 단순 편집 → Haiku(비용↓), novelty 게이트가 결과 검증
        }) || '').trim();
        if (cand && floor.measureNovelty(textF, cand, allowed).count === 0 && !META_NOTE_RE.test(cand)) titleLine = cand;
        else tNov.items.forEach(t => { titleLine = titleLine.split(t).join(''); });
      } catch { tNov.items.forEach(t => { titleLine = titleLine.split(t).join(''); }); }
    }
  }
  let doc = titleLine + '\n\n' + bodies.join('\n\n');

  // 프레임 잔재 수리(문단 단위 1회)
  let frames = gf.measureGenreFrames(doc);
  if (frames.research.length + frames.explainerHeadings.length + frames.explainerSentences.length > 0) {
    const paras = doc.split(/\n{2,}/);
    for (let i = 0; i < paras.length; i++) {
      const pf = gf.measureGenreFrames(paras[i]);
      const hits = [...pf.research, ...pf.explainerHeadings, ...pf.explainerSentences];
      if (!hits.length) continue;
      try {
        const cand = (await llmText({
          system: `다음 문단에서 정형 표현(${hits.join(' | ')})을 제거하고 같은 내용을 다른 구조로 다시 써라. 사실·수치 그대로, 분량 유지, 본문만 출력.`,
          user: paras[i], signal, maxTokens: 1200, model: HAIKU   // 프레임 표현 제거(구조 재배치) → Haiku(비용↓), 프레임·novelty 게이트가 검증
        }) || '').trim();
        const cf = gf.measureGenreFrames(cand || '');
        if (cand && !(cf.research.length + cf.explainerHeadings.length + cf.explainerSentences.length) && floor.measureNovelty(textF, cand, allowed).count === 0) paras[i] = cand;
      } catch { /* 유지 */ }
    }
    doc = paras.join('\n\n');
  }

  // ★ 사실 자리표시자 복원(설계 D): 슬롯 생성+프레임 수리까지 토큰으로 보호한 사실을 원래 값으로 되돌린다.
  //   이후 단계(짝교정·weaveLost·judge·게이트)는 실제 값을 보고 동작한다. 떨궈진 토큰은 복원 후 사라져
  //   lostFacts가 잡고 weaveLost가 재삽입을 시도(차단보다 복구 우선).
  if (fsafe) doc = factsafe.restore(doc, factMap);

  // ── 수리 순서(v3 실측 교훈): 짝 교정(수치 보존) → 사실 재위빙(짝 인지) → 마감 → judge 게이트+수리 → 최종 재위빙.
  //    v3에서 짝 수리가 재위빙 "뒤"에 돌며 수치를 떨궈 lostFacts 4 발생 + judge가 진짜 재조합 3건을 보고만 하고 방치.

  // 문장 단위 교정 헬퍼(문단 보존): 위반 문장을 찾아 재작성, 게이트(메타·novelty·짝) 통과 시만 교체
  // 매칭은 judge의 span 검증과 동일 기준(normWS: 공백붕괴+trim+소문자, 첫 24자) — 다르면 수리가 조용히 스킵된다
  const normKey = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  async function repairSentence(curDoc, sentKey, instruction) {
    const key = normKey(sentKey).slice(0, 24);
    if (!key) return curDoc;
    const paras = curDoc.split(/\n{2,}/);
    for (let pi = 0; pi < paras.length; pi++) {
      const sents = paras[pi].split(/(?<=[.!?”"])\s+/);
      const idx = sents.findIndex(s => normKey(s).includes(key));
      if (idx < 0) continue;
      try {
        const cand = (await llmText({ system: instruction + '\n한 문장만 출력(설명·머리말 금지). ★출력 문장에 "원장"·"승인 근거"·"클레임" 같은 작업 용어를 절대 쓰지 마라 — 독자가 읽는 본문이다(실측: "원장은 시간 기준 설정…을 제시한다" 누출 사고).', user: sents[idx], signal, maxTokens: 350, model: HAIKU }) || '').trim();   // 문장 1개 교정 → Haiku(비용↓), 메타·novelty·짝 게이트가 검증
        if (cand && !META_NOTE_RE.test(cand) && !WINK_RE.test(cand) && findCoinedTerms(cand, textF).length === 0 && floor.measureNovelty(textF, cand, allowed).count === 0 && checkEvidencePairing(cand, evidenceList).length === 0) {
          sents[idx] = cand;
          paras[pi] = sents.join(' ');
          return paras.join('\n\n');
        }
      } catch { /* 유지 */ }
      return curDoc;
    }
    return curDoc;
  }

  // ① 수치-출처 짝 교정(수치 보존형 — "빼라" 폴백이 v3에서 lostFacts 4 유발)
  let pairing = checkEvidencePairing(doc, evidenceList);
  for (const bad of pairing) {
    const owner = evidenceAnchorMap(evidenceList).find(m => m.nums.includes(bad.num) || m.nums.includes('-' + bad.num));
    doc = await repairSentence(doc, bad.sent,
      `다음 문장은 수치(${bad.num})를 출처와 다르게 결합했을 위험이 있다. 수치를 빼지 말고, 아래의 실제 사실에 맞게 문장을 교정하라(출처 표지를 함께 명시). 도저히 안 맞을 때만 수치를 빼라. 실제 사실: ${owner ? owner.line : ''}`);
  }
  pairing = checkEvidencePairing(doc, evidenceList);
  // ★ 결정론 최후 수단(2026-06-12 실사고: 잔여 위반 1건이 30분 작업 전체 차단): LLM 교정이 못 박은 위반은
  //   수치 옆에 소속 출처 표지를 괄호 삽입(무날조 — 승인 사실의 출처 명시)으로 결정론 해소.
  if (pairing.length) {
    doc = injectOwnerMarkers(doc, pairing, evidenceList);
    pairing = checkEvidencePairing(doc, evidenceList);
  }

  // ② 사실 소실 재위빙(3라운드, 짝 인지형) — 수용 조건: lost 감소 + 짝 위반 비증가.
  //    짝 위반이 늘면 끊지 말고 즉석 교정 후 재평가(v4 실측: 여기서 break하면 소실 18건이 복구 불능).
  //    빠진 사실은 맨 토큰이 아니라 원문 맥락 인용과 함께 — v5 실측: "200명, 1차"만 주자 위빙 LLM이
  //    자리를 추측해 남의 조사에 꽂음("성균관대 1차 조사 200명" — 원문은 가상 설문 가정·AI 1차 피드백).
  const srcSentsAll = sg.splitSentences(textF);
  const lostCtx = (it) => {
    const s = srcSentsAll.find(x => x.includes(it));
    return s ? `${it} (원문 맥락: "${s.trim().replace(/\s+/g, ' ').slice(0, 110)}" — 이 맥락 그대로만, 다른 조사·기관·수치와 결합 금지)` : it;
  };
  async function weaveLost(curDoc) {
    let curLost = floor.measureLostFacts(textF, curDoc);
    let stalled = 0;   // ★속도(2026-06-12): 개선 없는 라운드(풀문서 재작성 2~4분짜리)를 같은 프롬프트로 반복하지 않음
    for (let r = 0; r < 3 && curLost.count > 0 && stalled < 1; r++) {
      const before = curLost.count;
      try {
        let cand = stripMetaNotes((await llmText({
          system: `아래 칼럼에 빠진 사실들을 가장 자연스러운 자리에 끼워 넣어 전체를 다시 출력하라. 빠진 사실:\n${curLost.items.map(lostCtx).map(x => '· ' + x).join('\n')}\n★각 수치는 반드시 그 수치의 출처 표지(기관·조사명)와 같은 문장에 두어라.\n★기존 문단을 복제·변주해 늘리지 마라 — 기존 문단 안에 제자리 수정으로 끼워라(43% 실측: 변주 복제가 '기계적 균일성' 피탐).\n★끼워 넣는 문장은 이 칼럼의 결로 써라 — 원문의 보고서 어투(~하였다/본 연구는/설정하였다)를 그대로 옮기지 마라. 가정·가상 사실은 가정임이 드러나게, 단 칼럼 문장으로.\n구조·문체 유지, 새 사실·새 결합 금지, 본문만 출력.`,
          user: curDoc, signal, maxTokens: 8000, model: MODEL
        }) || '').trim());
        if (!cand || WINK_RE.test(cand) || findCoinedTerms(cand, textF).length > 0 || floor.measureNovelty(textF, cand, allowed).count > 0) { stalled++; continue; }
        const basePairs = checkEvidencePairing(curDoc, evidenceList).length;
        if (checkEvidencePairing(cand, evidenceList).length > basePairs) {
          for (const bad of checkEvidencePairing(cand, evidenceList)) {
            const owner = evidenceAnchorMap(evidenceList).find(m => m.nums.includes(bad.num) || m.nums.includes('-' + bad.num));
            cand = await repairSentence(cand, bad.sent,
              `다음 문장은 수치(${bad.num})를 출처와 다르게 결합했을 위험이 있다. 수치를 빼지 말고, 아래의 실제 사실에 맞게 문장을 교정하라(출처 표지를 함께 명시). 실제 사실: ${owner ? owner.line : ''}`);
          }
          if (checkEvidencePairing(cand, evidenceList).length > basePairs) { stalled++; continue; }   // 교정 실패 → 후보 폐기, 정체로 집계
        }
        const l2 = floor.measureLostFacts(textF, cand);
        if (l2.count < curLost.count) { curDoc = cand; curLost = l2; }
        if (curLost.count >= before) stalled++;   // 이 라운드에 개선 0 → 다음 라운드 중단(확률 반복의 기대값 < 비용)
      } catch { break; }
    }
    // weave가 만든 변주 복제·재인용 즉시 제거(②·④ 두 호출처 공통). ★dedupeFactRecitations 포함(2026-06-12 47% PDF):
    // ④ judge 루프의 weave는 ③마감 뒤에 돌아 재인용 dedupe를 안 거침 → "정부 16세 규제" 류 재진술 생존하던 구멍.
    return dedupeFactRecitations(resolveDupSentences(dedupeParas(curDoc, textF), textF), evidenceList, textF);
  }
  doc = await weaveLost(doc);

  // ③ 마감(표현예산·메타·중복·띄어쓰기)
  try {
    const fb = await require('./formalbudget').formalBudgetPass(doc, { lang, signal, floor, rawText: textF, allowedExtra: allowed });
    if (fb.text) doc = fb.text;
  } catch { /* 무해 */ }
  doc = stripMetaNotes(doc);
  doc = require('./dedupe').dedupeSentences(doc).text;
  doc = resolveDupSentences(dedupeParas(doc, textF), textF);   // 슬롯 생성 자체의 문단·문장 중복도 커버
  doc = dedupeFactRecitations(doc, evidenceList, textF);       // 같은 사실 재인용 제거(ai-study 63% 실측)
  doc = require('./spacing').fixSpacing(doc).text;

  // ④ semanticJudge 게이트 + 문장 수리(1라운드) — v3 실측: 짝 가드가 못 보는 "프레임 재조합"(교원 200명 가짜 설문 등)을 judge가 정확히 잡음
  const judgeLedger = { ...ledger, claims: [...ledger.claims, ...evidenceList.map(e => ({ claim: e, evidence_text: e })), ...memoLines.map(m => ({ claim: m, evidence_text: m }))] };
  let judge = null;
  try {
    let v = await semanticJudge(rawText, doc, judgeLedger, { lang, signal, allowedExtra: allowed });
    for (let jr = 0; jr < 2 && !v.pass && (v.violations || []).length; jr++) {   // 2라운드 — v5 실측: 1라운드로는 수치 융합 1건 미수렴
      for (const viol of v.violations.slice(0, 6)) {
        if (!viol.span) continue;
        // detail에 judge가 인용한 원장 사실(교정 근거)이 들어 있다 — 자르면 수리 LLM이 무엇이 맞는지 모른다(100자 절단이 v5 미수렴 원인 추정)
        doc = await repairSentence(doc, viol.span,
          `다음 문장은 원문·승인근거와 다른 주장을 담았다(${viol.type}). 판정 근거: ${(viol.detail || '').slice(0, 300)}\n판정 근거에 인용된 원문·승인 근거의 사실 그대로 따르도록 문장을 고쳐 써라 — 없는 조사·분석·인과·수치 결합을 지어내지 마라(주장 못 받치면 그 부분을 빼라).`);
      }
      doc = await weaveLost(doc);                                   // judge 수리가 사실을 떨궜으면 재위빙
      v = await semanticJudge(rawText, doc, judgeLedger, { lang, signal, allowedExtra: allowed });
    }
    // ★ 최종 회수 패스(2026-06-16): 문장별 수리가 끝내 수렴 못 한 잔여 위반은 차단 직전에 한 번 더 도려낸다.
    //   repairViolations = 원장 기준 일괄 교정(날조 span 삭제/원문값 복원, 새 정보 추가 금지). per-span repairSentence가
    //   정체한 케이스(서로 얽힌 added_claim 다발)를 전체 위반을 한꺼번에 보며 정리해 통과시킬 수 있다.
    //   분량이 절반 미만으로 무너지면(=핵심까지 도려냄) 채택하지 않고 차단 유지(보존형 폴백으로 보냄).
    if (!v.pass && (v.violations || []).length) {
      try {
        const stripped = await judgeEngine.repairViolations(rawText, doc, judgeLedger, v.violations, { lang, signal });
        if (stripped && stripped !== doc) {
          const keptRatio = ((stripped.match(/[가-힣]/g) || []).length) / (((doc.match(/[가-힣]/g) || []).length) || 1);
          if (keptRatio >= 0.5) {
            const sv = await semanticJudge(rawText, stripped, judgeLedger, { lang, signal, allowedExtra: allowed });
            if (sv.pass) { doc = stripped; v = sv; }   // 통과 + 분량 절반 이상 보존 → 회수 채택(차단 회피)
          }
        }
      } catch { /* 회수 실패는 무해 — 아래에서 원래 verdict로 차단 진행 */ }
    }
    judge = { pass: v.pass, violations: v.violations || [] };
  } catch (e) { judge = { error: e.message }; }

  doc = correctDistortedNumbers(doc, rawText, textF);   // 연도·% 변형(2023→2022) 결정론 복원 — 차단 전 마지막 교정
  const novelty = floor.measureNovelty(textF, doc, allowed);
  // ★ 사실 소실 게이트 분리(2026-06-15, 고급+근거 차단 빈발 완화): 원문 사실 소실만 하드 차단(rawText 기준).
  //   승인 근거는 weaveLost가 최선을 다해 녹이되, 끝내 못 녹인 건 차단이 아니라 '미반영'으로 둔다 —
  //   선택 보강이라 한두 건 때문에 30분 작업을 통째로 막지 않는다(실측: 근거 24건 중 일부 미위빙→통째 차단).
  //   evidenceLost는 노트·표시용 소프트 신호(차단 아님).
  const lost = floor.measureLostFacts(rawText, doc);
  const evidenceLost = evidence ? floor.measureLostFacts(evidence, doc) : { count: 0, items: [] };
  pairing = checkEvidencePairing(doc, evidenceList);
  if (pairing.length) {   // judge 수리·재위빙이 끝물에 짝을 깼을 수 있음 — 최후 수단 1회 더
    doc = injectOwnerMarkers(doc, pairing, evidenceList);
    pairing = checkEvidencePairing(doc, evidenceList);
  }
  doc = tidyParagraphs(doc);   // ★ 문단 내부 단일 줄바꿈 정리(2026-06-12: LLM이 문장마다 \n 넣어 "애매한 두 행" 발생)
  doc = stripMetaNotes(doc);   // ★최종 scrub(2026-06-16): judge 수리·재위빙·교정이 끼운 지시문/메타를 return 직전 제거.
  //   기존 scrub은 judge 루프 '이전'(③마감)뿐이라, 그 뒤 repairSentence/weaveLost가 넣은 누출이 그대로 나갔다.
  doc = require('./outputguard').stripPunchTemplates(doc, rawText, { strict: true }).text;   // ★독립형 punch 단정 제거(2026-06-16 품질리포트): "그게 핵심이다"·"정책이 뒤흔들렸다" 등(원문에 있던 건 보존). formalBudgetPass(LLM) 뒤 결정론 안전망.
  const risk = gf.genreRiskScore(doc);
  const lenRatio = ((doc.match(/[가-힣]/g) || []).length) / ((((textF.match(/[가-힣]/g) || []).length)) || 1);
  return { text: doc, skeleton, plan, risk, novelty, lostFacts: lost, evidenceLost, judge, pairing, lenRatio: Number(lenRatio.toFixed(2)) };
}

// 후보 3종 생성 → 하드게이트(novelty·프레임) + genreRiskScore 최저 선택
async function genreTransferV2Candidates(rawText, { evidence = '', lang = 'ko', signal, skeletons = ['debate_explainer', 'policy_column', 'news_article_style'] } = {}) {
  const candidates = [];
  for (const sk of skeletons) {
    try { candidates.push(await genreTransferV2(rawText, { skeleton: sk, evidence, lang, signal })); }
    catch (e) { candidates.push({ skeleton: sk, error: e.message }); }
  }
  const ok = candidates.filter(c => !c.error);
  const hard = ok.filter(c => c.novelty.count === 0 && c.risk.detail.research.length === 0 && c.risk.detail.explainerHeadings.length === 0);
  const pool = hard.length ? hard : ok;
  pool.sort((a, b) => (a.risk.score - b.risk.score) || (a.lostFacts.count - b.lostFacts.count));
  return { winner: pool[0] || null, candidates };
}

module.exports = { GENRE_PROFILES, detectBadFrame, extractDocProfile, measureArtifacts, buildDocumentPlan, genreTransfer, SKELETONS, pickSkeleton, genreTransferV2, genreTransferV2Candidates, checkEvidencePairing, dedupeParas, resolveDupSentences, dedupeFactRecitations, tidyParagraphs };
