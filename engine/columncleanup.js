// [engine/columncleanup.js] 격식 칼럼 구조 정리 패스 — '짜여진 흐름·구조적 전형성' 공략 (FLOOR-안전)
// ────────────────────────────────────────────────────────────────
// 진단(EV assignment 83% PDF, 사장님): 구체 근거는 충분한데도 높음 → 병목은 evidence가 아니라 '레지스터·구조'.
//   카피킬러가 "짜여진 흐름·구조적 전형성"으로 잡는 두 가지 AI 형식 습관:
//   ① 번호 나열(첫째/둘째/셋째…) = 교과서적 전략 리스트 ② 반복되는 짧은 단정 조각("단순했다."/"현실은 다르다."/"포위당하고 있다.")
//   ★②는 우리 burstiness 패스가 직접 주입한 self-inflicted 신호(프롬프트가 "현실은 다르다" 예시를 명시) → 격식 모드는 양산 중단 + 초과분 병합.
// 해법(무날조·on-FLOOR): 내용·사실·말투·분량 보존. 번호 라벨만 제거해 흐름으로 녹이고, 상투적 punch 조각 초과분만 앞뒤에 병합.
//   결정론 "검출"(번호 마커/punch 밀도) → 국소 LLM repair(Haiku) → FLOOR(novelty=0·experience=0)·길이중립 재검 → 악화 시 원본 유지(무해).

const sg = require('./surfaceguard');
const { llmText, HAIKU } = require('./judge');

const PUNCH_CHARS = 12;          // 이하(무공백) = 짧은 단정 조각
const PUNCH_BUDGET = 6;          // 글 전체 허용 punch 조각 수(초과분만 병합)
const ORDINAL = /(?:^|[\s"'(])(첫째|둘째|셋째|넷째|다섯째|여섯째|일곱째)\s*[,.]/;
const ORDINAL_G = /(첫째|둘째|셋째|넷째|다섯째|여섯째|일곱째)\s*[,.]/g;

function noSp(s) { return s.replace(/\s+/g, '').length; }

// 짧은 단정 조각만 카운트(명사 나열 끝 문장·질문 제외). "단순했다." "현실은 다르다." 류.
function isPunch(sent) {
  const t = sent.trim();
  if (!t || noSp(t) > PUNCH_CHARS) return false;
  if (/[?？]$/.test(t)) return false;               // 의문문은 별개
  return /(다|네|지|까|라|군|군요|죠|어|야)[.!]?$/.test(t) || /[가-힣]\.$/.test(t);
}
function measurePunch(text) {
  return sg.splitSentences(text).filter(isPunch).length;
}
function countOrdinals(text) {
  return (text.match(ORDINAL_G) || []).length;
}

function buildPrompt(para, lang, { delist, mergePunch }) {
  const tasks = [];
  if (delist) tasks.push('1. 번호 나열(첫째/둘째/셋째…)을 없앤다. 항목의 내용·순서·개수는 그대로 두되, "첫째," 같은 라벨만 떼고 자연스러운 흐름으로 잇는다(먼저/그다음/여기서 끝나지 않는다/거기에/나아가/결국 등을 활용). 나열처럼 보이지 않게 문장으로 녹여라.');
  if (mergePunch) tasks.push('2. 너무 짧은 상투적 단정 조각이 반복되면("단순했다." "현실은 다르다." "막을 수 없었다." "포위당하고 있다." "그게 핵심이다." 같은 2~4어절 문장) 일부를 앞이나 뒤 문장에 자연스럽게 합쳐 호흡을 고른다. 짧은 문장을 전부 없애지는 말고, 반복되는 상투적 조각만 줄여라.');
  const system = lang === 'en'
    ? `You edit a Korean industry/op-ed essay. Keep ALL facts, numbers, proper nouns, tone, and length the same. Fix only these AI-looking formatting habits:\n${tasks.join('\n')}\nForbidden: adding new facts/numbers/opinions/examples, changing meaning, growing length much (<=110%). Output only the edited text.`
    : `너는 한국어 산업/시사 칼럼을 다듬는 편집자다. 내용·사실·수치·고유명사·말투(한다체)·전체 분량은 그대로 두고, AI 글처럼 보이는 형식 습관만 고친다.
[고칠 것]
${tasks.join('\n')}
[절대 금지] 새 사실·수치·고유명사·견해·예시 추가 금지. 의미·정서 변경 금지. 분량을 크게 늘리지 마라(원문 110% 이내). 말투(한다체) 유지. 새 1인칭 의견·경험 만들지 마라.
[출력] 고친 본문만(설명·머리말·따옴표 금지).`;
  return { system, user: `[문단]\n${para}` };
}

// 격식 칼럼 구조 정리: 번호 리스트 해체(전부) + 반복 punch 조각 병합(예산 초과분, punch 많은 문단부터). FLOOR로 날조 차단, 길이중립, 개선만 채택.
async function columnCleanupPass(text, { lang = 'ko', signal, floor, rawText = '', allowedExtra = '', punchBudget = PUNCH_BUDGET, maxParas = 24 } = {}) {
  const paras = text.split(/\n\n+/);
  const out = paras.slice();
  let repaired = 0, attempted = 0;
  const globalPunch = measurePunch(text);
  let punchExcess = Math.max(0, globalPunch - punchBudget);   // 전체 예산 초과분만 줄임
  // punch 많은 문단부터 처리(예산 효율) — de-list는 예산과 무관하게 전 문단 적용.
  const order = paras.map((p, i) => ({ i, punch: sg.splitSentences(p).filter(isPunch).length }))
    .sort((a, b) => b.punch - a.punch).map(x => x.i);
  for (const i of order) {
    if (attempted >= maxParas) break;
    const p = paras[i];
    const delist = ORDINAL.test(p);
    const paraPunch = sg.splitSentences(p).filter(isPunch).length;
    const mergePunch = punchExcess > 0 && paraPunch >= 1;     // 예산 초과 시 punch 있는 문단(많은 곳부터) 병합
    if (!delist && !mergePunch) continue;
    attempted++;
    const { system, user } = buildPrompt(p, lang, { delist, mergePunch });
    let cand = '';
    try { cand = (await llmText({ system, user, signal, maxTokens: 1400, model: HAIKU }) || '').trim(); } catch { continue; }
    if (!cand) continue;
    const cc = noSp(cand), pc = noSp(p);
    if (cc < pc * 0.85 || cc > pc * 1.12) continue;            // 길이중립
    if (floor?.looksLikeRefusal?.(cand)) continue;
    if (floor?.measureNovelty) {                               // 새 사실 → 폐기(무해)
      const nov = floor.measureNovelty(rawText || p, cand, allowedExtra || '');
      if (nov.count >= 1) continue;
    }
    if (sg.measurePersonalExperienceNovelty) {                 // 경험 날조 차단
      const ex = sg.measurePersonalExperienceNovelty(rawText || p, cand, allowedExtra || '');
      if (ex.count >= 1) continue;
    }
    // 개선 검증: 번호 라벨이 줄었거나 punch 조각이 줄어든 경우만 채택(둘 다 안 줄면 폐기)
    const ordBefore = countOrdinals(p), ordAfter = countOrdinals(cand);
    const punchAfter = sg.splitSentences(cand).filter(isPunch).length;
    const delistOK = delist && ordAfter < ordBefore;
    const punchOK = mergePunch && punchAfter < paraPunch;
    if (!delistOK && !punchOK) continue;
    if (punchOK) punchExcess -= (paraPunch - punchAfter);
    out[i] = cand; repaired++;
  }
  return { text: out.join('\n\n'), repaired, attempted, globalPunch };
}

module.exports = { columnCleanupPass, measurePunch, countOrdinals, isPunch, PUNCH_BUDGET };
