// [engine/registernormalize.js] 결정론 말투(존댓말/한다체) 일관성 정규화 — 무LLM·무날조(종결어미만 변환)
// ────────────────────────────────────────────────────────────────
// 왜: 휴머나이즈 패스들(burstiness 펀치 주입·청크 재작성 등)이 글의 말투를 무시하고 한다체 단정("그게 핵심이다.")을
//   존댓말 글에 섞어 넣어 말투가 깨진다(실측 2026-06-16: 존댓말 성찰문 → 존댓말+한다체 혼입, "저"가 "나"로 추락).
//   measureRegisterMix는 혼입을 '감지'만 할 뿐 강제하는 게이트가 없었다. 여기서 출력을 원문 말투로 통일한다.
// 안전: 종결어미(문장 끝)와 1인칭 대명사만 결정론으로 치환 — 새 사실·내용·분량은 건드리지 않는다. 확신 못 하는
//   어미는 그대로 둔다(부분 정규화 > 오변환). 변환 가능한 고빈도·명확 어미만 다룬다.

// 문장 끝(종결어미)만 — 뒤가 문장 종결부호/줄끝일 때만 치환(중간의 "하다고/한다고"는 보호).
const END = '(?=[.!?…」』”’\\)\\]]*(?:[.!?…\\n]|$))';

// 한다체 → 존댓말(hap) 종결 변환 (고빈도·명확 어미만)
const HANDA_TO_HAP = [
  ['했다', '했습니다'], ['됐다', '됐습니다'], ['였다', '였습니다'], ['았다', '았습니다'], ['었다', '었습니다'],
  ['이다', '입니다'], ['아니다', '아닙니다'],
  ['한다', '합니다'], ['된다', '됩니다'], ['진다', '집니다'], ['난다', '납니다'], ['본다', '봅니다'], ['든다', '듭니다'],
  ['있다', '있습니다'], ['없다', '없습니다'], ['같다', '같습니다'], ['싶다', '싶습니다'], ['겠다', '겠습니다'],
  ['모른다', '모릅니다'], ['만든다', '만듭니다'],
  ['하다', '합니다'],   // 중요하다→중요합니다, 필요하다→필요합니다 ('한다'·'모른다'를 먼저 처리해 충돌 회피)
];
// 존댓말 → 한다체(반대 방향) — '합니다'는 하다/한다 양쪽 기원이라 모호해 제외(오변환 방지). 명확 어미만.
const HAP_TO_HANDA = [
  ['했습니다', '했다'], ['됐습니다', '됐다'], ['였습니다', '였다'], ['았습니다', '았다'], ['었습니다', '었다'],
  ['입니다', '이다'], ['아닙니다', '아니다'],
  ['있습니다', '있다'], ['없습니다', '없다'], ['같습니다', '같다'], ['싶습니다', '싶다'], ['겠습니다', '겠다'],
];
// 존댓말 글의 1인칭: 나/내 → 저/제 (앞이 한글이면 '하나는' 같은 단어 내부라 보호: 음의 lookbehind)
const PRONOUN_TO_HAP = [
  ['내가', '제가'], ['나는', '저는'], ['나도', '저도'], ['나의', '저의'], ['나를', '저를'], ['나에게', '저에게'], ['내게', '제게'],
];

function applyEndings(text, pairs) {
  let out = text, changed = 0;
  for (const [from, to] of pairs) {
    const re = new RegExp(from + END, 'g');
    out = out.replace(re, () => { changed++; return to; });
  }
  return { out, changed };
}
function applyPronouns(text, pairs) {
  let out = text, changed = 0;
  for (const [from, to] of pairs) {
    const re = new RegExp('(?<![가-힣])' + from, 'g');   // 단어 내부(하나는/그나마…) 보호
    out = out.replace(re, () => { changed++; return to; });
  }
  return { out, changed };
}

// target: 'hap'(존댓말) | 'handa'(한다체). 출력을 target 말투로 종결어미 통일.
function normalizeRegister(text, target) {
  if (target !== 'hap' && target !== 'handa') return { text, changed: 0 };
  let out = text, changed = 0;
  const e = applyEndings(out, target === 'hap' ? HANDA_TO_HAP : HAP_TO_HANDA);
  out = e.out; changed += e.changed;
  if (target === 'hap') { const p = applyPronouns(out, PRONOUN_TO_HAP); out = p.out; changed += p.changed; }
  return { text: out, changed };
}

module.exports = { normalizeRegister, HANDA_TO_HAP, HAP_TO_HANDA };
