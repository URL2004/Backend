// [engine/registerrepair.js] Phase2 register 교정 패스 — 격식 모드 '화자 거리감' 공략 (FLOOR 완화: 판단 허용·사실 차단)
// ────────────────────────────────────────────────────────────────
// 진단(사장님): 격식 글의 카피킬러 병목은 구조·evidence가 아니라 비인칭 산업리포트 어투(화자 거리감). 4개 PDF 일관 신호=
//   비인칭·간접화법·주관성배제·구조전형성. 해법: 비인칭 단정문을 *기존 사실만으로* 논증형 필자 판단문으로 구조 변형.
// A(83%)와의 차이: ① 흩뿌리기 아님 — 비인칭 문단만 골라 1~2문장 구조 변형 ② 수사의문문(과연~인가) 금지(AI 전형) ③ 근거 재해석
//   ("자료에 따르면 X. 신호다" → "수치에서 더 주목할 부분은 ~") ④ 요약 결론으로 문단 닫지 않기.
// FLOOR: 새 사실·수치·고유명사·경험 날조는 결정론 게이트(measureNovelty·experience)로 strict 차단. 판단·해석만 semanticJudge(mode=formal)가 허용.
// ★검증: register surrogate(subjectivity↑·risk↓) 개선 + 한다체 유지 + FLOOR clean일 때만 채택. 노이즈 제거 위해 같은 생성문에 켜고/끔 A/B.

const sg = require('./surfaceguard');
const rs = require('./registerscore');
const { llmText, semanticJudge } = require('./judge');   // 기본 모델(Sonnet) — register 구조변형은 품질이 중요(Haiku는 약함)

const noSp = s => s.replace(/\s+/g, '').length;
const HAEYO_RE = /(해요|어요|예요|에요|세요|습니다|합니다|입니다|십시오|할게요|네요)/;   // 격식 한다체 깨짐(존댓말/구어) 감지

function buildPrompt(para, lang) {
  const system = lang === 'en'
    ? `Rewrite so the impersonal report tone becomes a visible authorial judgment, using ONLY facts already in the paragraph. Add no new facts/figures/proper nouns. No rhetorical questions. Keep 한다체. Output only the text.`
    : `너는 한국어 산업/시사 글을 다듬는 편집자다. 이 문단은 정보가 부족해서가 아니라 *비인칭 산업리포트 어투*(화자 거리감) 때문에 AI 의심을 받는다. 어투만 고친다.

[고칠 것 — 기존 내용만 사용. 비인칭 리포트체를 "필자가 근거를 읽고 판단하는" 1인칭 격식 에세이체로 바꿔라]
· 이 문단의 비인칭 단정문("~이다/~된다/~할 수 있다/~는 것이다") 중 2~3개를 *1인칭 필자 판단문*으로 구조 변형하라:
  "나는 이 대목에서 ~라고 본다", "내가 더 중요하게 보는 부분은 ~다", "이 글에서 먼저 의심해야 할 전제는 ~다", "내가 보기에 ~".
· 단순히 "필자가 보기에"만 붙이지 말고, *어떤 근거를 어떻게 읽는지*를 드러내라(근거 재해석): "자료에 따르면 X. 신호다" → "그 수치에서 내가 더 눈여겨보는 부분은 순위가 아니라 ~다".
· 비인칭·수동("여겨진다/이루어진다/볼 수 있다/평가된다/전망된다")은 능동 단정으로 바꿔라.
· 문단을 요약 결론("결국 ~다")으로 닫지 말고, 구체나 다음 쟁점으로 마무리하라.
· ★문체는 격식 한다체 유지(존댓말·구어체 "거든요/잖아요" 금지). "과연 ~인가?" 수사의문문 금지.
· ★개인 경험·일화는 절대 금지(제가 ~했을 때/제 친구가). 새 사실·수치·고유명사도 금지. 오직 *기존 논지에 대한 필자의 판단·해석*만 1인칭으로 드러내라.

[절대 규칙 — 어기면 실패]
· 새 사실·수치·연도·고유명사·사례·경험을 만들지 마라(원문 문단에 있는 것만).
· "과연 ~인가?" 같은 수사의문문을 쓰지 마라(AI 전형).
· 말투는 한다체 유지(존댓말·해요체·구어체 금지). 분량은 원문 120% 이내.
· 판단은 *기존 논지를 또렷이 드러내는* 수준 — 원문에 없는 새 입장·전망·감정은 만들지 마라.

[출력] 고친 문단 본문만(설명·머리말·따옴표 금지).`;
  return { system, user: `[문단]\n${para}` };
}

// 격식 register 교정: 비인칭·주관성배제 높은 문단부터 판단문 구조 변형. FLOOR strict + register 개선 검증 후 채택.
async function registerRepairPass(text, rawText, { lang = 'ko', signal, floor, ledger, mode = 'assignment', allowedExtra = '', maxParas = 22 } = {}) {
  const paras = text.split(/\n\n+/);
  const out = paras.slice();
  let repaired = 0, attempted = 0;
  // 비인칭 높고 주관성 낮은 문단부터(가장 register 위험)
  const order = paras.map((p, i) => {
    const s = sg.splitSentences(p);
    if (s.length < 2) return { i, score: -1 };
    const imp = sg.measureImpersonal(p), subj = rs.measureSubjectivity(p);
    return { i, score: imp + (0.3 - Math.min(0.3, subj)) };   // 비인칭↑·주관↓일수록 우선
  }).filter(x => x.score >= 0).sort((a, b) => b.score - a.score).map(x => x.i);

  for (const i of order) {
    if (attempted >= maxParas) break;
    const p = paras[i];
    if (sg.splitSentences(p).length < 2) continue;
    attempted++;
    const { system, user } = buildPrompt(p, lang);
    let cand = '';
    // ★ H-01 수정(2026-06-19): `model: HAIKU`는 미import 식별자라 ReferenceError→catch로 매 문단 무동작이었다
    //   (REGISTER=1로 켜도 silent no-op). 주석 의도대로 기본 모델(Sonnet)을 쓴다 — register 구조변형은 품질 중요.
    try { cand = (await llmText({ system, user, signal, maxTokens: 1400 }) || '').trim(); } catch { continue; }
    if (!cand) continue;
    const cc = noSp(cand), pc = noSp(p);
    if (cc < pc * 0.8 || cc > pc * 1.25) continue;                    // 길이 근중립(판단문 주입으로 다소 증가 허용)
    if (floor?.looksLikeRefusal?.(cand)) continue;
    if (HAEYO_RE.test(cand) && !HAEYO_RE.test(p)) continue;           // 한다체 깨짐(존댓말/구어 유입) → 폐기
    // ★ FLOOR strict: 새 사실·경험 날조 차단(완화와 무관)
    if (floor?.measureNovelty) { const nv = floor.measureNovelty(rawText, cand, allowedExtra || ''); if (nv.count >= 1) continue; }
    const ex = sg.measurePersonalExperienceNovelty(rawText, cand, allowedExtra || ''); if (ex.count >= 1) continue;
    // ★ semanticJudge(mode=formal): 판단·해석은 허용, 새 사실·왜곡은 차단
    if (ledger) { const v = await semanticJudge(rawText, cand, ledger, { lang, signal, mode }); if (!v.pass) continue; }
    // ★ register 개선 검증: 주관성↑(핵심 레버) AND risk가 크게 나빠지지 않을 때 채택(주관성 상승이 목표).
    const subjBefore = rs.measureSubjectivity(p), subjAfter = rs.measureSubjectivity(cand);
    const riskBefore = rs.registerScore(p).risk, riskAfter = rs.registerScore(cand).risk;
    if (!(subjAfter > subjBefore && riskAfter <= riskBefore + 0.02)) continue;
    out[i] = cand; repaired++;
  }
  const finalText = out.join('\n\n');
  return { text: finalText, repaired, attempted, before: rs.registerScore(text), after: rs.registerScore(finalText) };
}

module.exports = { registerRepairPass };
