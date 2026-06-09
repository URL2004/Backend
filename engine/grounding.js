// [engine/grounding.js] source-internal grounding repair (메모 없이 카피킬러 영역↓)
// ────────────────────────────────────────────────────────────────
// 설계: 설계-source-grounding.md. 경계: 원문이 이미 말한 것 재구성=허용 / 새 구체·관계=금지(FLOOR).
//   흐름: 출력 → segment 분할 → 추상 segment 타겟 → 원문 anchor 배정 →
//         grounding 프롬프트로 추상 문장 "교체" → ①measureNovelty ②semanticJudge 게이트 →
//         통과 시 채택, 실패 시 1회 재시도, 그래도 실패면 원본 segment 유지(=무해).
// ※ repair는 출력 품질이 아니라 "추상→구체"가 목적. 새 사실 0 (FLOOR가 강제).

const sg = require('./surfaceguard');
const floor = require('./floor');
const { llmText, buildSoftClaimLedger, semanticJudge } = require('./judge');

// ── 강한 구체(면제 기준) — 이게 있으면 카피킬러가 영역을 놓아주므로 repair 불필요 ──
const G_FIRST_PERSON = /(저는|저도|제가|내가|나는|우리가|우리는)/;
const G_PAST = /(았|었|였|했|갔|왔|봤|뒀|났|렸|췄|쳤)(다|다는|는데|던|고|으며|지만|어요|네요|거든요|습니다|죠)/;
const G_SPECIFIC = /(19|20)\d{2}|\d+\s*(명|개|건|배|원|시간|분|초|개월|차례|미터|km|kg|살|세|층|위|％|%|억|조)|[一-鿿]{2,}/;
const G_ACR = new Set(['AI', 'ESG', 'SNS', 'IT', 'MVP', 'CEO', 'KPI', 'ROI', 'DX']);
const G_EXAMPLE = /(예를\s*들|예컨대|가령|이를테면|예로\s*들)/;
function hasStrongConcrete(s) {
  if (G_FIRST_PERSON.test(s) && G_PAST.test(s)) return true;
  if (G_SPECIFIC.test(s)) return true;
  const eng = (s.match(/[A-Za-z]{3,}/g) || []).filter(w => !G_ACR.has(w.toUpperCase()));
  if (eng.length) return true;
  return false;
}
// segment가 repair 타겟인가: 강한 구체도, 원문 사례 프레임도 없으면(=순수 추상) 타겟.
function isRepairTarget(segText) {
  const sents = sg.splitSentences(segText);
  if (sents.some(hasStrongConcrete)) return false;   // 실제 수치·고유명사·1인칭 장면 → 카피킬러 escape
  if (sents.some(s => G_EXAMPLE.test(s))) return false; // 원문 사례 프레임 → escape
  return true;
}

// ── 이 segment에 배정할 원문 anchor(원문에 이미 있는 구체 재료) ──
// 관련성: segment와 내용어가 겹치는 원문 사례·대조·한계 문장 + 등장 도메인 용어.
const A_STOP = new Set(['그리고', '하지만', '그런데', '그러나', '때문', '경우', '정도', '우리', '기업', '조직', '경영', '사람', '문제', '방식', '상황', '결국', '지금', '있다', '없다', '되는', '하는']);
function tokens(s) {
  return [...new Set((s || '').match(/[가-힣]{2,}|[A-Za-z]{2,}/g) || [])].filter(t => !A_STOP.has(t));
}
function overlap(a, b) {
  const A = new Set(tokens(a)); if (!A.size) return 0;
  let h = 0; for (const t of tokens(b)) if (A.has(t)) h++;
  return h / A.size;
}
function assignAnchors(segText, anchorPool, rawText) {
  // 1) segment 주제와 겹치는 원문 사례/대조/한계 문장(원문 그대로 — 새 사실 아님). 가장 가치 높은 재료.
  const frames = [...(anchorPool.examples || []), ...(anchorPool.contrasts || []), ...(anchorPool.caveats || [])];
  const relFrames = frames
    .map(f => ({ f, sim: overlap(segText, f) }))
    .filter(x => x.sim >= 0.15)
    .sort((a, b) => b.sim - a.sim).slice(0, 2).map(x => x.f);
  // 2) 깨끗한 구체 개념만 — 약어(ESG/IT)·specifics(연도·수치·인용). generic 명사추출은 노이즈라 제외.
  const concepts = [...(anchorPool.specifics || []), ...(anchorPool.acronyms || [])]
    .filter(t => t.length >= 2 && segText.includes(t)).slice(0, 6);
  return { frames: relFrames, terms: concepts };
}

// ── grounding 프롬프트(§3 경계 제약) ──
function buildGroundingPrompt(segText, anchors, lang = 'ko') {
  const frameLines = anchors.frames.length ? `\n[원문에 이미 있는 사례/대조 — 이것을 끌어와 구체화에 써라]\n- ${anchors.frames.join('\n- ')}` : '';
  const termLine = anchors.terms.length ? `\n[이 문단에 이미 있는 핵심어 — 막연한 문장 대신 이것을 구체적으로 풀어라]\n${anchors.terms.join(', ')}` : '';
  const system = `너는 한국어 글에서 "무견해·막연한 일반론 문장"을 "선명한 판단 문장"으로 바꾸는 편집자다. 내용·사실·분량은 그대로 두고 표현의 날을 세운다.

[핵심 작업 — 이것을 최우선으로]
· 막연한 서술("~이 중요하다", "~할 수 있다", "~가 필요하다", "~도 하나의 요소다")을 **판단문**으로 바꿔라:
  "문제는 A가 아니라 B", "핵심은 A보다 B", "위험은 A에서 온다", "A가 아니라 B가 갈랐다" 같은 구조.
· 단, A·B는 반드시 **그 문단 안에 이미 있는 내용**이어야 한다. 문단의 대조·조건·한계를 더 또렷하게 드러낼 뿐, 새 내용을 넣지 마라.
· ★★말투(문체)를 문단 원래대로 똑같이 유지하라 — 문단이 해요체면 판단문도 반드시 해요체("문제는 A가 아니라 B예요"), 한다체면 한다체. ★특히 해요체 문단에 한다체(~다/~이다)·체언 종결(명사로 끊기)을 한 문장도 넣지 마라(문체혼합=카피킬러 신호). 문단 안에서 말투를 섞지 마라.

[절대 규칙 — 어기면 실패]
· 새 회사·연도·수치·통계·고유명사를 만들지 마라(원문에 있는 것만).
· 원문이 "나열"만 한 것(예: 'ESG' 같은 단어)에 구체 설명·인과·결과를 새로 붙이지 마라.
· "나는 ~라고 본다" 같은 새 1인칭 의견을 만들지 마라(판단문은 비개인적으로).
· 추가하지 말고 교체하라. 분량을 늘리지 마라(원문 110% 이내).

[출력] 고친 문단 본문만. 설명·머리말·따옴표 금지.`;
  const user = `[고칠 문단]\n${segText}${frameLines}${termLine}`;
  return { system, user };
}

// ── 한 segment grounding (LLM + 2단 게이트) ──
async function groundSegment(segText, rawText, anchorPool, { lang = 'ko', signal, ledger } = {}) {
  if (!isRepairTarget(segText)) return { text: segText, changed: false, reason: 'not-target' };
  const anchors = assignAnchors(segText, anchorPool, rawText);
  const { system, user } = buildGroundingPrompt(segText, anchors, lang);

  for (let attempt = 0; attempt < 2; attempt++) {
    let cand = await llmText({ system, user, signal, maxTokens: 1200 });
    cand = (cand || '').trim();
    if (!cand || cand.length < segText.length * 0.5) continue;        // 빈/과소 응답 → 재시도
    if (floor.looksLikeRefusal(cand)) continue;                      // ★ 거부문 → 폐기(원본 유지)
    // 분량 상한(교체이지 추가 아님)
    if (cand.replace(/\s+/g, '').length > segText.replace(/\s+/g, '').length * 1.15) continue;
    // ① 결정론 hard-novelty 게이트 (allowed world = 원문 전체. 원문에 있는 구체는 허용, 날조만 차단)
    const nov = floor.measureNovelty(rawText, cand, '');
    if (nov.count >= 1) continue;                                     // 새 수치·연도·기관 → 폐기, 재시도
    // ② semanticJudge 게이트 (닫힌세계 = 원문 segment)
    if (ledger) {
      const v = await semanticJudge(rawText, cand, ledger, { lang, signal });
      if (!v.pass) continue;                                          // added_claim/distortion → 폐기, 재시도
    }
    return { text: cand, changed: true, anchors };
  }
  return { text: segText, changed: false, reason: 'gate-failed' };    // 게이트 통과 못함 → 원본 유지(무해)
}

// ── 전체 grounding 패스 ──
async function groundingPass(outputText, rawText, { lang = 'ko', signal, targetChars = 350, maxTargets } = {}) {
  const anchorPool = sg.buildSourceAnchorPool(rawText);
  const segs = sg.buildSegments(outputText, targetChars);
  const before = sg.buildSegmentReport(outputText, rawText, targetChars);

  // ★ 선택 적용(#1): 추상 segment 전부가 아니라 "가장 추상적인 상위 N개"만 grounding.
  //   grounding은 호출을 거의 2배로 만들므로(ledger + segment별 judge) 비용을 N으로 상한.
  //   가장 generic(추상)한 segment부터 골라 효과 큰 곳에 예산을 쓴다.
  const MAX = Number(maxTargets) || Number(process.env.GROUNDING_MAX_TARGETS) || 18; // 우회 우선: 더 많은 추상영역 정리(비용↑ 감수)
  const ranked = segs
    .map((s, i) => ({ i, gen: sg.measureSegmentRisk(s, anchorPool).genericRatio, target: isRepairTarget(s) }))
    .filter(x => x.target)
    .sort((a, b) => b.gen - a.gen);
  const pick = new Set(ranked.slice(0, MAX).map(x => x.i));

  const out = segs.slice();   // 미선택 segment는 원본 그대로
  let repaired = 0;
  // 타겟 0개면 ledger 호출도 건너뜀(비용 0).
  if (pick.size) {
    let ledger = null;
    try { ledger = await buildSoftClaimLedger(rawText, { lang, signal }); } catch { /* 게이트 ②는 best-effort */ }
    const concurrency = Number(process.env.CHUNK_CONCURRENCY) ||
      (process.env.LLM_BACKEND === 'claudecode' ? 1 : 6);
    const idxs = [...pick];
    let next = 0;
    const worker = async () => {
      while (next < idxs.length) {
        const i = idxs[next++];
        const r = await groundSegment(segs[i], rawText, anchorPool, { lang, signal, ledger });
        if (r.changed) repaired++;
        out[i] = r.text;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, idxs.length) }, worker));
  }
  const result = out.join('\n\n');
  const after = sg.buildSegmentReport(result, rawText, targetChars);
  return {
    text: result,
    repaired,
    targets: ranked.length,     // 전체 추상 타겟 수
    grounded: pick.size,        // 실제 grounding 시도 수(상한 적용)
    cappedAt: MAX,
    before: { segments: before.segments, suspect: before.suspectSegments, ratio: before.suspectRatio },
    after: { segments: after.segments, suspect: after.suspectSegments, ratio: after.suspectRatio }
  };
}

module.exports = { groundingPass, groundSegment, isRepairTarget, assignAnchors, buildGroundingPrompt, hasStrongConcrete };
