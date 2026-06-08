// [engine/phrasebudget.js] 구어체 장치 반복 예산 (Phase 0)
// ────────────────────────────────────────────────────────────────
// 문제: blog 톤이 ~거든요/근데/더라고요/문제는 등을 반복 → "구어체 템플릿" = 기계적 균일성 신호.
// 해법(사장님 지침): 맹목 regex 치환 금지. 결정론 "검출" + 초과 segment만 "국소 LLM repair".
//   1) 전역 카운트 → 예산 초과 표현 식별
//   2) 초과 occurrence가 든 segment만 대상
//   3) 해당 표현 금지하고 segment 재작성 → FLOOR(novelty) 재검 → 악화 시 원본 유지(무해)

const sg = require('./surfaceguard');
const { llmText } = require('./judge');

// 표현별 허용 횟수(문서 전체 기준). 초과분만 국소 수리.
const PHRASE_BUDGET = {
  '근데': 4, '거든요': 5, '더라고요': 3, '잖아요': 5,
  '문제는': 3, '핵심은': 2, '중요한 건': 2, '결국': 4,
  '지금은 달라요': 1, '쉽지 않아요': 1, '슬쩍': 3, '툭': 3, '확': 4,
};

function countOcc(text, phrase) {
  if (!text) return 0;
  let n = 0, i = 0;
  while ((i = text.indexOf(phrase, i)) !== -1) { n++; i += phrase.length; }
  return n;
}

// 전역 사용량 측정 → 초과 표현 목록
function measurePhraseUsage(text, budget = PHRASE_BUDGET) {
  const counts = {};
  const over = [];
  for (const [p, b] of Object.entries(budget)) {
    const c = countOcc(text, p);
    if (c) counts[p] = c;
    if (c > b) over.push({ phrase: p, count: c, budget: b });
  }
  over.sort((a, b) => (b.count - b.budget) - (a.count - a.budget));
  return { counts, over };
}

function buildRepairPrompt(segText, banPhrases, lang) {
  const ban = banPhrases.join(', ');
  const system = lang === 'en'
    ? `Rewrite the paragraph so it does NOT use these overused expressions: ${ban}. Replace them with varied, natural alternatives (different connectives/endings). Keep ALL facts, meaning, tone, and length the same. Add no new information. Output only the rewritten paragraph.`
    : `다음 문단을 다시 쓰되, 과다하게 반복된 표현 "${ban}"을 쓰지 마라. 대신 자연스럽고 다양한 다른 표현·접속·종결로 바꿔라. 사실·의미·말투·분량은 그대로 두고, 새 정보는 절대 넣지 마라. 본문만 출력(설명·따옴표 금지).`;
  return { system, user: `[문단]\n${segText}` };
}

// 국소 repair: 초과 표현이 든 segment만 재작성. floor.measureNovelty로 날조 차단.
async function repairPhraseOveruse(text, { lang = 'ko', signal, floor, rawText = '', allowedExtra = '', targetChars = 350, budget = PHRASE_BUDGET } = {}) {
  const before = measurePhraseUsage(text, budget);
  if (!before.over.length) return { text, repaired: 0, before: before.over, after: before.over };

  const overSet = new Set(before.over.map(o => o.phrase));
  const segs = sg.buildSegments(text, targetChars);

  // 표현별로 "예산 초과 occurrence가 든 segment"를 수리 대상으로. 앞쪽 budget개는 보존.
  const repairIdx = new Set();
  for (const { phrase, budget: b } of before.over) {
    let seen = 0;
    segs.forEach((s, i) => {
      const c = countOcc(s, phrase);
      if (!c) return;
      if (seen >= b) repairIdx.add(i);          // 이미 예산 소진 후 등장 → 수리
      else if (seen + c > b) repairIdx.add(i);   // 이 segment에서 예산 넘김 → 수리
      seen += c;
    });
  }
  if (!repairIdx.size) return { text, repaired: 0, before: before.over, after: before.over };

  const out = segs.slice();
  let repaired = 0;
  for (const i of repairIdx) {
    const ban = before.over.filter(o => countOcc(segs[i], o.phrase)).map(o => o.phrase);
    if (!ban.length) continue;
    const { system, user } = buildRepairPrompt(segs[i], ban, lang);
    let cand = '';
    try { cand = (await llmText({ system, user, signal, maxTokens: 1200 }) || '').trim(); } catch { continue; }
    if (!cand || cand.length < segs[i].length * 0.5) continue;
    if (floor && floor.looksLikeRefusal && floor.looksLikeRefusal(cand)) continue;
    // FLOOR: 새 사실 0 (allowed world = 원문 ∪ 메모)
    if (floor && floor.measureNovelty) {
      const nov = floor.measureNovelty(rawText || segs[i], cand, allowedExtra || '');
      if (nov.count >= 1) continue;
    }
    // 실제로 금지어가 줄었는지 확인(안 줄면 무의미 → 폐기)
    const reduced = ban.some(p => countOcc(cand, p) < countOcc(segs[i], p));
    if (!reduced) continue;
    out[i] = cand; repaired++;
  }
  const result = out.join('\n\n');
  return { text: result, repaired, before: before.over, after: measurePhraseUsage(result, budget).over };
}

module.exports = { PHRASE_BUDGET, measurePhraseUsage, repairPhraseOveruse, countOcc };
