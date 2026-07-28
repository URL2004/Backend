// [engine/b7polish.js] B7 학부생 보고서형 마감 패스 — 합니다체 강제 + 1인칭 anchor 예산 캡 (생성·패스가 흐트러뜨린 걸 결정론적으로 교정)
// ────────────────────────────────────────────────────────────────
// 문제(EV B7 실측): 생성은 합니다체를 시도하나 grounding 등 패스가 한다체로 되돌려 50/50 혼합(B7 politeRegister 실패),
//   모델이 "저는 ~봅니다" anchor를 25회 남발(예산 2~4 초과 → 반복 템플릿 = 92% 실패 재현). 서버가 강제해야 함.
// 처치(무날조): 문단별 LLM(Haiku)로 ① 전 문장 ~합니다/~입니다 존댓말 통일 ② 1인칭 anchor를 문단당 ≤1로 축소(나머지는 비개인 문장으로)
//   ③ 새 사실·경험 추가 금지·내용/길이 보존. FLOOR(novelty=0·experience=0) 재검, 개선(합니다↑ 또는 anchor↓)만 채택.

const sg = require('./surfaceguard');
const { llmText, HAIKU } = require('./judge');

const noSp = s => s.replace(/\s+/g, '').length;
const ANCHOR_RE = /(저는|제\s*생각|저로서는|제가\s*보기|제가\s*더|제가\s*가장)/g;
function anchorCount(t) { return (t.match(ANCHOR_RE) || []).length; }
function hapShare(t) {
  const s = sg.splitSentences(t); if (!s.length) return 0;
  let h = 0; s.forEach(x => { if (sg.sentRegister(x) === 'hap') h++; }); return h / s.length;
}

function buildPrompt(para, lang) {
  const manyAnchor = anchorCount(para) >= 3;
  const system = lang === 'en'
    ? 'Rewrite to a consistent polite Korean report register; keep facts/length/hedges; output only text.'
    : `이 문단을 학부생 보고서형 존댓말로 다듬어라. 내용·사실·수치·논지·길이는 그대로 둔다.
[고칠 것 — 말투 통일이 최우선]
· 모든 문장을 ~합니다/~입니다/~했습니다 존댓말로 통일하라. 평어 종결(~다/~이다/~한다/~했다/~없다/~아니다)을 단 하나도 남기지 마라. 블로그체(~요/~죠/~거든요/~잖아요)도 쓰지 마라.
· ★hedge 표현("~인 것 같습니다/~지 않을까요?/~기도 합니다/~로 보입니다")과 필자 판단("저는 ~/제 생각에는 ~")은 *그대로 보존*하라 — 제거하지 마라(존댓말로만 바꾼다).${manyAnchor ? '\n· 단 이 문단에 "저는/제 생각에는" anchor가 3개 이상이라 과하다 — 가장 자연스러운 1~2개만 남기고 나머지는 같은 뜻의 비개인 문장으로 바꿔라.' : ''}
[절대 금지] 새 사실·수치·기관·사례·개인경험 추가. 의미 변경. 길이 크게 늘리기(원문 115% 이내).
[출력] 고친 문단 본문만(설명·머리말·따옴표 금지).`;
  return { system, user: `[문단]\n${para}` };
}

async function b7PolishPass(text, rawText, { lang = 'ko', signal, floor, allowedExtra = '' } = {}) {
  const paras = text.split(/\n\n+/);
  const out = paras.slice();
  let repaired = 0, attempted = 0;
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    if (sg.splitSentences(p).length < 1) continue;
    const needHap = hapShare(p) < 0.95;        // 합니다체 아닌 문장이 남아 있음
    const needCap = anchorCount(p) >= 3;        // 한 문단에 anchor 3개+ (과함 → 1~2로). 1~2개는 보존.
    if (!needHap && !needCap) continue;
    attempted++;
    const { system, user } = buildPrompt(p, lang);
    let cand = '';
    try { cand = (await llmText({ system, user, signal, maxTokens: 1300, model: HAIKU }) || '').trim(); } catch { continue; }
    if (!cand) continue;
    const cc = noSp(cand), pc = noSp(p);
    if (cc < pc * 0.8 || cc > pc * 1.18) continue;
    if (floor?.looksLikeRefusal?.(cand)) continue;
    if (floor?.measureNovelty) { const nv = floor.measureNovelty(rawText, cand, allowedExtra || ''); if (nv.count >= 1) continue; }
    if (sg.measurePersonalExperienceNovelty(rawText, cand, allowedExtra || '').count >= 1) continue;
    // 개선 검증: 합니다체 비율이 올랐거나 anchor가 줄어든 경우만 채택
    const improved = (hapShare(cand) > hapShare(p) + 0.05) || (anchorCount(cand) < anchorCount(p));
    if (!improved) continue;
    out[i] = cand; repaired++;
  }
  return { text: out.join('\n\n'), repaired, attempted };
}

module.exports = { b7PolishPass, hapShare, anchorCount };
