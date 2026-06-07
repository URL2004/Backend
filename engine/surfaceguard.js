// [engine/surfaceguard.js] genericness / specificity / stance / uniformity 측정 (결정론, LLM 없음)
// ────────────────────────────────────────────────────────────────
// softguard.js가 "원문에 없던 감정·미래전망·불확실 추가"(=날조/결론역전)를 잡는다면,
// surfaceguard.js는 카피킬러가 실제로 잡는 "사람이 겪은 글 같지 않은 일반론 구조"를 잡는다:
//   추상적·일반적 내용 / 구체 근거 부족 / 무견해 / 경직 문어체 / 기계적 균일성 / 비인칭.
// ★ 정책: 이 지표가 나쁘다고 "가짜 경험·수치"를 생성하면 FLOOR 위반. 측정·표시·국소수정만 하고,
//   구체화는 (1)원문에 실제로 있는 것 또는 (2)사용자가 제공한 경험 메모 범위 안에서만.

function splitSentences(t) {
  return (t || '').split(/(?<=[.!?。])\s+|\n+/).map(s => s.trim()).filter(Boolean);
}

// ── 1. genericness (추상적·일반적 내용 구성) ──
const GENERIC_SUBJECT_RE = /^(디지털\s*기술|기술|사회|사람들?|인간관계|관계|현대\s*사회|온라인\s*공간|디지털\s*공간|SNS|익명성|소통|변화|문제|중요한\s*것|핵심은|우리는?)/i;
const ABSTRACT_NOUN_RE = /(중요성|필요성|가능성|영향|역할|방식|구조|균형|진정성|공감|신뢰|의미|가치|성격|측면|태도|관점|경향|특성|본질|요소|차원)/;
const GENERIC_ENDING_RE = /(할\s*수\s*있(다|습니다)|필요가\s*있(다|습니다)|중요하(다|합니다)|경우가\s*많(다|습니다)|볼\s*수\s*있(다|습니다)|이어질\s*수\s*있|작용한다|역할을\s*한다|되기도\s*한다|만들기도\s*한다|지니고\s*있)/;
function measureGenericness(text) {
  const s = splitSentences(text);
  if (!s.length) return { ratio: 0, count: 0, total: 0 };
  let g = 0;
  for (const x of s) if (GENERIC_SUBJECT_RE.test(x.trim()) || ABSTRACT_NOUN_RE.test(x) || GENERIC_ENDING_RE.test(x)) g++;
  return { ratio: Number((g / s.length).toFixed(3)), count: g, total: s.length };
}

// ── 2. realAnchorDensity (구체 근거: 시간·장소·인물·행동) ──
const TIME_RE = /(어제|오늘|내일|지난\s*(학기|주|달|해|명절|방학)|작년|재작년|며칠\s*전|밤\s*\d+시|\d+시|아침|점심|저녁|새벽|출근길|퇴근길|그날|그때|요즘)/;
const PLACE_RE = /(버스|지하철|기숙사|강의실|학교|회사|카페|식탁|방|침대|단톡방|단체\s*대화방|채팅방|집|도서관|교실|복도)/;
const PERSON_RE = /(친구|가족|부모님|엄마|아빠|동생|형|누나|언니|오빠|동기|선배|후배|룸메이트|교수님?|동료|연인|상대방)/;
const ACTION_RE = /(봤다|보냈다|기다렸|통화했|꺼\s*[뒀둔]|열었다|읽었|답(했|장)|만났|미뤘|들여다\s*(봤|보)|말했|느꼈|울렸|참았|걸었다|적었|나눴|놓쳤|굳어)/;
function measureRealAnchorDensity(text) {
  const s = splitSentences(text);
  if (!s.length) return { ratio: 0, count: 0, total: 0 };
  let a = 0;
  for (const x of s) {
    const h = Number(TIME_RE.test(x)) + Number(PLACE_RE.test(x)) + Number(PERSON_RE.test(x)) + Number(ACTION_RE.test(x));
    if (h >= 2) a++;
  }
  return { ratio: Number((a / s.length).toFixed(3)), count: a, total: s.length };
}

// ── 3. stanceDensity (글쓴이 관점·판단·사견) ──
const STANCE_RE = /(저는|제가|개인적으로|내\s*생각|제\s*생각|라고\s*본다|라고\s*봅니다|라고\s*느꼈|아쉽|문제라고\s*생각|걱정(된다|스럽)|동의하기\s*(어렵|힘들)|가볍게\s*볼\s*수\s*없|확신한다|분명하다|틀림없|싶었다|싶습니다)/;
function measureStance(text) {
  const s = splitSentences(text);
  if (!s.length) return { ratio: 0, count: 0, total: 0 };
  let c = 0;
  for (const x of s) if (STANCE_RE.test(x)) c++;
  return { ratio: Number((c / s.length).toFixed(3)), count: c, total: s.length };
}

// ── 4. uniformity (기계적 균일성: 문장 길이·종결·문단 모양) ──
// 종결어미를 마지막 한글 4자로 묶는다(습니다/됩니다/있습니다/봅니다 구분) → 동일 종결어미 연속(단조) 측정.
function endingGroup(s) {
  if (/[?？]\s*$/.test(s)) return 'q';
  const h = (s.replace(/[^가-힣]+$/, '').match(/[가-힣]+$/) || [''])[0];
  return h.slice(-4) || 'other';
}
function maxRun(arr) {
  let m = 0, c = 0, p = null;
  for (const x of arr) { if (x === p) c++; else { c = 1; p = x; } if (c > m) m = c; }
  return m;
}
function cv(nums) {
  if (!nums.length) return 0;
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (!avg) return 0;
  const v = nums.reduce((a, b) => a + (b - avg) ** 2, 0) / nums.length;
  return Math.sqrt(v) / avg;
}
function measureUniformity(text) {
  const s = splitSentences(text);
  const lens = s.map(x => x.replace(/\s+/g, '').length);
  const paraSentCounts = (text || '').split(/\n{2,}/).map(p => splitSentences(p).length).filter(n => n > 0);
  return {
    avgLength: Number((lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length)).toFixed(1)),
    lengthCV: Number(cv(lens).toFixed(3)),            // 낮을수록 균일(AI스러움)
    maxEndingRun: maxRun(s.map(endingGroup)),         // 같은 종결 연속(높으면 단조)
    paragraphCountCV: Number(cv(paraSentCounts).toFixed(3))
  };
}

function lv(ratio, lo, hi) { return ratio >= hi ? 'high' : ratio <= lo ? 'low' : 'mid'; }

// "실제 겪은 장면"(lived scene): 1인칭/과거시점 맥락 + 과거시제 행동. 단순 명사 언급(친구·SNS)은 제외.
//   카피킬러가 '낮음'으로 통과시키는 건 바로 이런 1인칭 과거 경험 문장이다.
const PERSONAL_CTX_RE = /(저는|저도|제가|제\s|내가|나는|우리\s|지난\s*(학기|주|달|해|명절|방학)|그날|그때|작년|재작년|며칠\s*전|예전에)/;
const PAST_ACTION_RE = /(했|봤|느꼈|보냈|울렸|놓쳤|참았|들었|걸었|적었|나눴|만났|기다렸|뒀|들여다\s*봤|모였|받았|겪었|깨달았|실감했|굳어|돌아왔|지냈|살았)(다|는데|었|고|으며|지만|어요|네요)?/;
function isLivedScene(s) { return PERSONAL_CTX_RE.test(s) && PAST_ACTION_RE.test(s); }

// "구체 사실"(specificity): 연도·숫자+단위·한자·인용어구 등. 일반적 약어(SNS/AI)는 제외(너무 흔해 신호 아님).
//   purpose 에세이처럼 1인칭 일화가 아니라 고유명사·수치로 구체적인 글이 카피킬러를 통과하는 경로.
const SPECIFIC_RE = /(19|20)\d{2}|\d+\s*(명|개|건|배|원|시간|분|초|개월|주|일|차례|번|미터|m|km|kg|살|세|층|위|등)|[一-鿿]|"[^"]{2,}"|“[^”]{2,}”|'[^']{3,}'|‘[^’]{3,}’/;
function isSpecific(s) { return SPECIFIC_RE.test(s); }

// ── 문단 단위 분석 (★ 카피킬러는 문단별로 본다 — 문서 평균은 일화 문단이 추상 문단을 희석해 신호를 가린다) ──
// 문단이 "구체(낮음)"이려면 실제 겪은 장면(lived scene)이 1개 이상 있어야 한다.
// 그게 없고 일반론 위주면 "추상-위험 문단"(카피킬러가 잡는 그 구간).
function analyzeParagraphs(text) {
  const paras = (text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  let abstractRisk = 0, concrete = 0, neutral = 0;
  const detail = [];
  for (const p of paras) {
    const sents = splitSentences(p);
    if (!sents.length) continue;
    const lived = sents.filter(isLivedScene).length;
    const specific = sents.filter(isSpecific).length;
    const stanced = sents.filter(s => STANCE_RE.test(s)).length;
    const generic = sents.filter(s => GENERIC_SUBJECT_RE.test(s.trim()) || ABSTRACT_NOUN_RE.test(s) || GENERIC_ENDING_RE.test(s)).length;
    let kind;
    if (lived >= 1 || specific >= 1) { concrete++; kind = 'concrete'; }     // 실제 장면 또는 구체 사실 → 안전
    else { abstractRisk++; kind = (generic / sents.length) >= 0.34 ? 'abstract_risk' : 'thin'; } // 구체 grounding 없음
    detail.push({ lived, specific, stanced, generic, sents: sents.length, kind });
  }
  const total = paras.length || 1;
  // 위험비율 = 구체 grounding(장면·사실)이 없는 문단 비율 ≈ 카피킬러 AI 의심 구간 비율.
  return { total, abstractRisk, concrete, neutral, abstractRiskRatio: Number((abstractRisk / total).toFixed(3)), detail };
}

// 종합 리포트 + 추천(needs_user_anchor): 추상-위험 문단 비율이 높으면 경험 메모 없이는 강한 휴먼화 불가.
function buildSurfaceReport(text) {
  const genericness = measureGenericness(text);
  const realAnchorDensity = measureRealAnchorDensity(text);
  const stanceDensity = measureStance(text);
  const uniformity = measureUniformity(text);
  const paragraphs = analyzeParagraphs(text);
  // 추상-위험 문단이 절반 이상이면 사용자 경험 메모가 필요(카피킬러 ≈ 추상-위험 문단 비율).
  const recommendation = paragraphs.abstractRiskRatio >= 0.5 ? 'needs_user_anchor' : 'ok';
  return {
    genericness: { ...genericness, level: lv(genericness.ratio, 0.30, 0.45) },
    realAnchorDensity: { ...realAnchorDensity, level: lv(realAnchorDensity.ratio, 0.12, 0.25) },
    stanceDensity: { ...stanceDensity, level: lv(stanceDensity.ratio, 0.05, 0.15) },
    uniformity,
    paragraphs: { total: paragraphs.total, abstractRisk: paragraphs.abstractRisk, concrete: paragraphs.concrete, abstractRiskRatio: paragraphs.abstractRiskRatio },
    recommendation
  };
}

// 입력(원문) 위험 분류: 추상-위험 문단이 과반이면 경험 메모 없이 자연화해도 AI 의심이 남는다.
function classifyInputRisk(rawText) {
  const para = analyzeParagraphs(rawText);
  if (para.abstractRiskRatio >= 0.5) {
    return {
      risk: 'generic_abstract_source', needsUserAnchor: true,
      abstractRiskRatio: para.abstractRiskRatio, abstractRisk: para.abstractRisk, total: para.total,
      message: '원문에 추상 일반론 문단이 많아(실제 경험·장면이 부족), 그대로 자연화하면 AI 의심이 남을 수 있습니다. 실제 겪은 상황·인물·시간·장소를 1~2개 알려주시면 그 범위에서 자연스럽게 녹여 드립니다(없는 경험은 지어내지 않습니다).'
    };
  }
  return { risk: 'normal', needsUserAnchor: false, abstractRiskRatio: para.abstractRiskRatio, abstractRisk: para.abstractRisk, total: para.total };
}

module.exports = {
  splitSentences, measureGenericness, measureRealAnchorDensity, measureStance,
  measureUniformity, analyzeParagraphs, buildSurfaceReport, classifyInputRisk
};
