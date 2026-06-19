// [engine/spacing.js] 결정론 띄어쓰기 품질 게이트 (Phase 0)
// ────────────────────────────────────────────────────────────────
// 목적: 출력의 "기계 후처리" 느낌을 주는 띄어쓰기 오류를 안전하게 교정.
//   원칙(사장님 지침): 안전한 항목만 자동 치환, 애매한 복합명사는 경고만.
//   탐지점수가 아니라 "제품 품질" 게이트 — 사실·의미 불변(공백만 조정).
//   안전성 우선: clever regex 대신 오탐 0에 가까운 명시 항목만. 함정("-ㄹ수록")은 제외.

// ── (1) 의존명사 "수": [동사ㄹ어간]+수 → 띄움. "수록"(어미)·"수밖에"는 별도 처리. ──
//   단음절 어간은 다른 명사와 충돌 없는 것만(밀수/살수대첩/물수건 등 회피).
const SU_STEM = /(할|볼|될|줄|들|갈|올|알|풀|쓸|낼|열|걸|둘|쉴|깰|빠질|만들|지킬|느낄|찾을|얻을|막을|챙길|바꿀|이어질|견딜|키울|잃을|잊을|받을|먹을|잡을|넘을|늘릴|다닐|멈출|기댈|버틸|지낼|돌볼|해낼|살아갈|만나)수(?!록)/g;
const SU_AUX = /수(있|없)/g;   // 수있/수없 — 한국어에 이런 결합명사 없음 → 안전

// ── (2,3) 의존명사 "것/게"·수사+단위 등 명시 교정(오탐 0) ──
const LITERAL = [
  // 것 (관형형+것; 그것/이것/저것 지시대명사는 목록에 없음 → 안전)
  [/것같/g, '것 같'],
  [/하는것/g, '하는 것'], [/되는것/g, '되는 것'], [/먹는것/g, '먹는 것'], [/보는것/g, '보는 것'],
  [/있는것/g, '있는 것'], [/없는것/g, '없는 것'], [/사는것/g, '사는 것'], [/가는것/g, '가는 것'],
  [/같은것/g, '같은 것'], [/좋은것/g, '좋은 것'], [/쉬운것/g, '쉬운 것'], [/인것/g, '인 것'],
  // 게 (=것이; 그게/이게/저게/크게/쉽게/하게 등 부사·지시는 목록에 없음 → 안전)
  [/하는게/g, '하는 게'], [/되는게/g, '되는 게'], [/먹는게/g, '먹는 게'], [/보는게/g, '보는 게'],
  [/사는게/g, '사는 게'], [/가는게/g, '가는 게'], [/오는게/g, '오는 게'],
  [/있는게/g, '있는 게'], [/없는게/g, '없는 게'], [/같은게/g, '같은 게'], [/좋은게/g, '좋은 게'],
  [/나은게/g, '나은 게'], [/쉬운게/g, '쉬운 게'], [/어려운게/g, '어려운 게'],
  [/중요한게/g, '중요한 게'], [/필요한게/g, '필요한 게'], [/싫은게/g, '싫은 게'],
  // 수밖에(붙임 유지하되 앞 공백 확보)
  [/할수밖에/g, '할 수밖에'], [/될수밖에/g, '될 수밖에'], [/줄수밖에/g, '줄 수밖에'],
  // 부사+용언
  [/잘먹/g, '잘 먹'], [/잘자/g, '잘 자'], [/잘안/g, '잘 안'],
  // 수사+단위 / 관형사+명사
  [/전세계/g, '전 세계'],
  [/몇년/g, '몇 년'], [/몇번/g, '몇 번'], [/몇개/g, '몇 개'], [/몇시간/g, '몇 시간'], [/몇가지/g, '몇 가지'],
  [/한가지/g, '한 가지'], [/두가지/g, '두 가지'], [/세가지/g, '세 가지'], [/네가지/g, '네 가지'],
  [/한순간/g, '한 순간'], [/이순간/g, '이 순간'], [/그순간/g, '그 순간'],
];

// ── 애매(자동치환 안 함, 경고만) — 붙여도/띄어도 맞을 수 있는 복합명사 ──
const AMBIGUOUS = [
  '건강관리', '기업경영', '경쟁우위', '핵심가치', '자기계발', '시험기간',
  '생활습관', '식습관', '수면시간', '근력운동', '맨몸운동', '건강검진',
  '재택근무', '온라인강의', '학습플랫폼', '의사결정', '데이터기반',
];

// 텍스트 띄어쓰기 교정. 반환: { text, fixes, warnings }
function fixSpacing(text) {
  if (!text) return { text: text || '', fixes: 0, warnings: [] };
  let out = text;
  let fixes = 0;
  const count = (re) => { const m = out.match(re); return m ? m.length : 0; };

  fixes += count(SU_STEM); out = out.replace(SU_STEM, '$1 수');
  fixes += count(SU_AUX);  out = out.replace(SU_AUX, '수 $1');
  for (const [re, rep] of LITERAL) { fixes += count(re); out = out.replace(re, rep); }

  // 이중 공백 정리(치환 부작용 방지) — 줄바꿈은 보존.
  out = out.replace(/[^\S\n]{2,}/g, ' ');

  const warnings = [];
  for (const w of AMBIGUOUS) if (out.includes(w)) warnings.push(w);
  return { text: out, fixes, warnings };
}

// ── 코드성 토큰 점뒤 공백 깨짐 복원(2026-06-19 88건 감사: LLM이 "CONTACT.MB_MB" → "CONTACT. MB_MB",
//   "FUNCTION.XY" → "FUNCTION. XY"로 점을 문장 끝으로 오인해 공백 삽입 = 기술 표기 손상). 원문에 '공백 없는'
//   코드성 토큰(영문·숫자·언더스코어 . 영문…, 대문자/언더스코어/숫자 포함)이 있고 출력에 그 토큰의 '점뒤 공백'
//   형태가 있으면 원형으로 되돌린다. ★원문 대조라 안전(원문에 있던 토큰만, 무날조·무LLM).
function restoreCodeTokens(out, rawText) {
  if (!out || !rawText) return { text: out || '', fixed: 0 };
  const tokenRe = /[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/g;
  const toks = [...new Set((rawText.match(tokenRe) || []))]
    .filter(t => /[A-Z_0-9]/.test(t.replace(/^[A-Za-z]+/, '')) || /[A-Z_]/.test(t))   // 코드성(대문자·언더스코어·숫자)만
    .filter(t => t.length >= 4 && /\.[A-Za-z0-9_]/.test(t));
  let text = out, fixed = 0;
  for (const tok of toks) {
    const spaced = tok.replace(/\./g, '. ');   // CONTACT.MB_MB → "CONTACT. MB_MB"
    if (spaced !== tok && text.includes(spaced)) { const before = text; text = text.split(spaced).join(tok); if (text !== before) fixed++; }
  }
  return { text, fixed };
}

module.exports = { fixSpacing, restoreCodeTokens, AMBIGUOUS };
