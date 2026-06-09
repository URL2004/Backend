// [engine/burstiness.js] 문장 길이 버스티니스(들쭉날쭉) 패스 — '기계적 정확성·균일성' 공략
// ────────────────────────────────────────────────────────────────
// 진단(도시론 61% 라벨): 순수추상 C등급 출고문은 문장길이 CV≈0.40·짧은문장≈1%
//   (사람 산문 0.6~0.9·15~30%). riskScore↔CV 상관 -0.35 → 균일성이 잔여 '기계적 균일성'의 실제 주범.
// 해법(무날조·on-FLOOR): 내용·사실·말투·분량 보존하고 문장 "길이"만 비균질화
//   (짧은 펀치 문장 주입 + 긴 문장 유지). 기존 문장을 쪼개거나 합치는 방식으로만.
//   결정론 "검출"(저CV 문단) → 국소 LLM repair(Haiku) → FLOOR(novelty=0)·길이중립·CV개선 재검 → 악화 시 원본 유지(무해).
// ⚠ Goodhart 주의: riskScore가 아니라 '버스티니스(사람 글의 실제 속성)'를 직접 올린다. 1회 실측으로 검증.

const sg = require('./surfaceguard');
const { llmText, HAIKU } = require('./judge');

const SHORT_CHARS = 12;   // 이하 = 짧은(펀치) 문장
const TARGET_CV = 0.6;    // 사람 산문 목표 변동계수
const LOW_CV = 0.45;      // 이 미만 문단을 수리 대상으로
const MIN_SENTS = 3;      // 문장 3개 미만 문단은 손대지 않음

function sentLens(text) {
  return sg.splitSentences(text).map(s => s.replace(/\s+/g, '').length).filter(l => l > 0);
}
function cvOf(lens) {
  if (lens.length < 2) return 0;
  const m = lens.reduce((a, b) => a + b, 0) / lens.length;
  if (!m) return 0;
  const sd = Math.sqrt(lens.map(l => (l - m) ** 2).reduce((a, b) => a + b, 0) / lens.length);
  return sd / m;
}
function measureBurstiness(text) {
  const lens = sentLens(text);
  const cv = cvOf(lens);
  const shortRatio = lens.length ? lens.filter(l => l <= SHORT_CHARS).length / lens.length : 0;
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  return { cv, shortRatio, mean, n: lens.length };
}

function buildPrompt(para, lang, aggressive = false) {
  const intensity = aggressive
    ? `이 문단의 호흡을 극단적으로 바꿔라. 아주 짧은 문장(한 호흡, 5~9자: "쉽지 않다." "현실은 다르다." "그게 핵심이다." "막을 수 없었다.")과 아주 긴 문장(40자 이상, 여러 절을 쉼표로 길게 이어 붙인)을 번갈아 배치해 길이 낙차를 최대한 키워라. 문장 두세 개마다 하나는 반드시 짧게 끊고, 비슷한 중간 길이 문장이 세 개 이상 연달아 나오지 않게 하라.`
    : `아주 짧은 문장(예: "쉽지 않다." "현실은 다르다.")과 긴 문장을 섞어, 한 문단 안에서 호흡을 크게 바꿔라.`;
  const system = lang === 'en'
    ? `Rewrite the paragraph so sentence LENGTHS are more varied (bursty): mix very short punchy sentences (2-5 words) with longer ones, changing the breathing within the paragraph. Keep ALL facts, numbers, meaning, tone, and total length the same. Add no new information, opinions, or examples. Only split or merge existing sentences to change rhythm. Every sentence must be grammatically complete (no dangling fragments). Output only the rewritten paragraph.`
    : `다음 문단을 문장 "길이"가 더 들쭉날쭉하도록 다시 써라. ${intensity}
규칙:
· 사실·수치·고유명사·의미·말투(해요체/한다체)·전체 분량은 그대로 둔다.
· 원문에 없는 새 정보·견해·예시는 절대 넣지 마라.
· 기존 문장을 쪼개거나 합치는 방식으로만 리듬을 바꿔라(내용 추가 금지).
· ★ 모든 문장은 그 자체로 문법적으로 완전해야 한다. 어순을 비틀지 말고, 주어나 서술어가 없는 파편("중요하다." 처럼 무엇이 중요한지 없는 문장)을 만들지 마라.
· ★ 쪼갤 때는 반드시 자연스러운 절 경계(그리고/하지만/~면/~는데 등)에서만 끊어라. 억지로 짧게 만들어 어색해지면 차라리 원문을 유지하라.
· 본문만 출력(설명·머리말·따옴표 금지).`;
  return { system, user: `[문단]\n${para}` };
}

// 국소 버스티니스 패스: 저CV(균일) 문단만 재작성. FLOOR로 날조 차단, 길이중립, CV 실제 개선만 채택.
async function burstinessPass(text, { lang = 'ko', signal, floor, rawText = '', allowedExtra = '', lowCV = LOW_CV, aggressive = false } = {}) {
  const paras = text.split(/\n\n+/);
  const out = paras.slice();
  let repaired = 0, attempted = 0;
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    const lens = sentLens(p);
    if (lens.length < MIN_SENTS) continue;
    const cv = cvOf(lens);
    if (cv >= lowCV) continue;                 // 이미 충분히 들쭉날쭉
    attempted++;
    const { system, user } = buildPrompt(p, lang, aggressive);
    let cand = '';
    try { cand = (await llmText({ system, user, signal, maxTokens: 1300, model: HAIKU }) || '').trim(); } catch { continue; }
    if (!cand) continue;
    const pc = p.replace(/\s+/g, '').length, cc = cand.replace(/\s+/g, '').length;
    if (cc < pc * 0.85 || cc > pc * 1.12) continue;            // 길이중립(±)
    if (floor?.looksLikeRefusal?.(cand)) continue;
    if (floor?.measureNovelty) {
      const nov = floor.measureNovelty(rawText || p, cand, allowedExtra || '');
      if (nov.count >= 1) continue;                            // 새 사실 → 폐기(무해)
    }
    if (sg.measurePersonalExperienceNovelty) {                 // 경험 날조도 per-segment 차단
      const ex = sg.measurePersonalExperienceNovelty(rawText || p, cand, allowedExtra || '');
      if (ex.count >= 1) continue;
    }
    if (cvOf(sentLens(cand)) <= cv + 0.03) continue;           // 버스티니스 실제 개선만 채택
    out[i] = cand; repaired++;
  }
  return { text: out.join('\n\n'), repaired, attempted };
}

module.exports = { measureBurstiness, burstinessPass, cvOf, sentLens, LOW_CV };
