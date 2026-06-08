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

// ── 개인 경험 날조 가드(§v4): hard novelty(숫자·고유명사)가 못 잡는 "지어낸 일화" 차단 ──
// 출력의 1인칭 과거 경험 문장(lived scene)은 원문(rawText) 또는 사용자 메모에 근거해야 한다.
// 둘 다에 없는 경험은 날조 → critical. (내용어 겹침으로 근거 판정 — 의역 허용, 완전 신규만 차단.)
const PEN_STOP = new Set(['저는', '저도', '제가', '나는', '내가', '그날', '그때', '있었', '있습니다', '같습니다', '같다', '봤다', '느꼈', '됩니다', '합니다', '하는', '있는', '되는', '같은', '그리고', '하지만', '그런데', '정도', '경우', '때문', '이런', '그런']);
function contentTokens(s) {
  return [...new Set((s || '').match(/[가-힣]{2,}|[A-Za-z]{2,}|\d+/g) || [])].filter(t => !PEN_STOP.has(t));
}
function groundedIn(sentence, sourceText) {
  const toks = contentTokens(sentence);
  if (toks.length < 3) return true;               // 너무 짧으면 판단 보류(근거 있다고 간주)
  const R = sourceText || '';
  const hit = toks.filter(t => R.includes(t)).length;
  return hit / toks.length >= 0.5;                 // 내용어 절반+가 원문/메모에 있으면 근거 있음
}
function measurePersonalExperienceNovelty(rawText, outputText, memo = '') {
  const allowed = (rawText || '') + '\n' + (memo || '');
  const fabricated = [];
  for (const s of splitSentences(outputText)) {
    if (isLivedScene(s) && !groundedIn(s, allowed)) fabricated.push(s.trim().slice(0, 50));
  }
  return { items: fabricated, count: fabricated.length };
}
// 메모 재사용 가드: 같은 경험 메모가 출력에 2회+ 등장(중복 위빙)하면 반복 신호.
function measureMemoReuse(outputText, memo = '') {
  const lines = (memo || '').split('\n').map(l => l.trim()).filter(Boolean);
  const scenes = splitSentences(outputText).filter(isLivedScene);
  const reused = [];
  for (const ln of lines) {
    const cnt = scenes.filter(s => groundedIn(s, ln) && groundedIn(ln, s)).length;  // 양방향 겹침 = 같은 경험
    if (cnt >= 2) reused.push({ memo: ln.slice(0, 30), count: cnt });
  }
  return { items: reused, count: reused.length };
}

function lv(ratio, lo, hi) { return ratio >= hi ? 'high' : ratio <= lo ? 'low' : 'mid'; }

// ════════════════════════════════════════════════════════════════
// ★ source-internal grounding 슬라이스 (메모 없이) — 측정만 (repair는 다음 단계)
//   카피킬러는 문서 평균이 아니라 "영역(≈700~1000자 묶음)"마다 AI 의심을 표시한다.
//   따라서 점수↓ = 의심 영역 수↓. 여기서는 (1) 원문 내부 anchor pool 추출,
//   (2) 카피킬러 영역 크기로 segment 분할, (3) segment별 위험 측정만 한다.
//   ※ 이 측정이 실제 카피킬러 영역 플래그와 맞는지(프록시 검증)가 repair보다 먼저다.
// ════════════════════════════════════════════════════════════════

// ── (A) source anchor pool: 원문에 "이미 있는" 구체 재료. 새 사실 생성 아님(FLOOR-safe). ──
const DOMAIN_STOP = new Set(['그리고','하지만','그런데','그러나','때문','경우','정도','우리','기업','조직','경영','사람','문제','방식','상황','결국','지금','과거','현재','미래','이것','그것','수가','수도','중요','필요','가능','대한','위한','통해','대해','한다','된다','이다']);
function buildSourceAnchorPool(rawText) {
  const R = rawText || '';
  // 1) 강한 구체(specific): 연도·수치+단위·한자·따옴표 인용 → 가장 강한 anchor
  const specifics = [...new Set((R.match(SPECIFIC_RE_G) || []).map(s => s.trim()))].filter(Boolean);
  // 2) 약어/영문 개념(AI, ESG, SNS, IT, MVP, ...)
  const acronyms = [...new Set((R.match(/[A-Za-z]{2,}/g) || []))];
  // 3) 반복 등장하는 도메인 명사(2~6자, 2회+) — buzzword급이지만 추상문장 grounding엔 유효
  const nounFreq = {};
  for (const m of (R.match(/[가-힣]{2,6}/g) || [])) {
    if (DOMAIN_STOP.has(m)) continue;
    if (/[다라은는이가을를의도게한들며고지요나서]$/.test(m)) continue;  // 조사·어미 종결 = 명사 아님
    nounFreq[m] = (nounFreq[m] || 0) + 1;
  }
  const terms = Object.entries(nounFreq).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([t]) => t);
  // 4) 사례/대조/한계 프레임 문장(원문 논리를 날카롭게 할 재료)
  const sents = splitSentences(R);
  const examples = sents.filter(s => /(예를\s*들|예컨대|가령|이를테면|같은\s*경우|처럼)/.test(s)).map(s => s.slice(0, 60));
  const contrasts = sents.filter(s => /(아니라|보다|반면|대신|오히려|와\s*달리|에\s*비해|만으로(는|도)?\s*부족|뿐(만)?\s*아니)/.test(s)).map(s => s.slice(0, 60));
  const caveats = sents.filter(s => /(하지만|그러나|다만|단,|함정|위험|놓치|간과|착각|역풍|되진\s*않|나오진\s*않)/.test(s)).map(s => s.slice(0, 60));
  return {
    specifics, acronyms, terms,
    examples: examples.slice(0, 12), contrasts: contrasts.slice(0, 12), caveats: caveats.slice(0, 12),
    anchorTerms: [...new Set([...specifics, ...acronyms, ...terms])]   // segment anchor 카운트용 통합 풀
  };
}

// ── (B) 카피킬러 영역 크기로 segment 분할(연속 문단을 ~targetChars까지 묶음) ──
function buildSegments(text, targetChars = 900) {
  const paras = (text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const segs = [];
  let cur = [];
  let len = 0;
  for (const p of paras) {
    cur.push(p);
    len += p.replace(/\s+/g, '').length;
    if (len >= targetChars) { segs.push(cur.join('\n\n')); cur = []; len = 0; }
  }
  if (cur.length) {
    // 마지막 자투리는 직전 segment에 합침(너무 짧은 꼬리 영역 방지)
    if (segs.length && len < targetChars * 0.4) segs[segs.length - 1] += '\n\n' + cur.join('\n\n');
    else segs.push(cur.join('\n\n'));
  }
  return segs;
}

// ── segment 전용 strict 구체 판정 (eval이 쓰는 isLivedScene/isSpecific은 건드리지 않음) ──
//   카피킬러 3개 실측(65%/85%/100%)로 보정: 영역이 "안 잡히려면" 진짜 구체가 1개는 있어야 한다.
//   진짜 구체 = ①진성 1인칭 과거 장면 ②연도·수치+단위·한자2+ ③고유 영문 ④사례 프레임 ⑤실제 대화 인용.
//   제외(카피킬러가 안 속는 것): 일반 과거("그때 있었"), buzzword 나열(AI·ESG), 수사적 진술 인용.
const SEG_ACRONYM = new Set(['AI', 'ESG', 'SNS', 'IT', 'MVP', 'CEO', 'KPI', 'ROI', 'DX']);
const SEG_FIRST_PERSON = /(저는|저도|제가|내가|나는|우리가|우리는)/;
const SEG_PAST = /(았|었|였|했|갔|왔|봤|뒀|났|렸|췄|쳤)(다|다는|는데|던|고|으며|지만|어요|네요|거든요|습니다|죠)/;
const SEG_SPECIFIC = /(19|20)\d{2}|\d+\s*(명|개|건|배|원|시간|분|초|개월|차례|미터|km|kg|살|세|층|위|％|%|억|조)|[一-鿿]{2,}/;
const SEG_EXAMPLE = /(예를\s*들|예컨대|가령|이를테면)/;
const SEG_DIALOG = /["“”][^"“”]*[?？!][^"“”]*["“”]|["“”][^"“”]{0,20}(야|냐|니|어|지|해|줘|봐)[?？!]?["“”]/;
function isSegmentConcrete(s) {
  if (SEG_FIRST_PERSON.test(s) && SEG_PAST.test(s)) return true;     // 진성 1인칭 과거 장면
  if (SEG_SPECIFIC.test(s)) return true;                            // 연도·수치+단위·한자
  const eng = (s.match(/[A-Za-z]{3,}/g) || []).filter(w => !SEG_ACRONYM.has(w.toUpperCase()));
  if (eng.length) return true;                                      // 고유 영문(흔한 약어 제외)
  if (SEG_EXAMPLE.test(s)) return true;                             // 사례 프레임
  if (SEG_DIALOG.test(s)) return true;                             // 실제 대화 인용
  return false;
}

// ── 서브스코어(카피킬러 사유 taxonomy 대응) ──────────────────────
// "간접 화법·비인칭 서술" — 비인칭·수동·정형 종결
const IMPERSONAL_END_RE = /(된다|되곤\s*한다|되기도\s*한다|여겨진다|여겨진다는|이루어진다|요구된다|요구받는다|간주된다|평가된다|마련이다|법이다|뿐이다|셈이다|것이다|기도\s*한다)\.?$/;
const IMPERSONAL_ANY_RE = /(볼\s*수\s*있|알\s*수\s*있|느낄\s*수\s*있|할\s*수\s*있다|필요가\s*있|라는\s*(얘기|뜻|의미)이?(다|에요|예요)|이라고\s*할\s*수)/;
function measureImpersonal(text) {
  const s = splitSentences(text);
  if (!s.length) return 0;
  const imp = s.filter(x => { const t = x.trim(); return IMPERSONAL_END_RE.test(t) || IMPERSONAL_ANY_RE.test(t); }).length;
  return imp / s.length;
}
// "지나친 요약·압축" — 한 문장에 정보 과밀(요약문)
const COMP_ABSTRACT_RE = /(중요성|필요성|가능성|영향|역할|방식|구조|균형|의미|가치|측면|태도|관점|경향|특성|본질|요소|차원|결과|과정|능력|문제|관리|습관|방향|기준|책임)/g;
const COMP_CAUSAL_RE = /(그래서|때문|따라서|결국|그러므로|덕분|탓에|로\s*인해|결과적으로)/;
function isCompressedSentence(s) {
  const t = (s || '').trim();
  const len = t.replace(/\s+/g, '').length;
  const commas = (t.match(/[,·]/g) || []).length;
  const abst = (t.match(COMP_ABSTRACT_RE) || []).length;
  const causal = COMP_CAUSAL_RE.test(t) ? 1 : 0;
  if (commas >= 3 && abst >= 3) return true;
  if (len >= 60 && abst >= 3 && causal) return true;
  if (len >= 55 && commas >= 2 && abst >= 4) return true;
  return false;
}
function measureCompression(text) {
  const s = splitSentences(text);
  if (!s.length) return 0;
  return s.filter(isCompressedSentence).length / s.length;
}
// 구어체 틱(반복 시 "기계적 균일성") — segment 내 등장 종류 수
const CONV_TICS = ['근데', '거든요', '더라고요', '잖아요', '문제는', '핵심은', '결국', '슬쩍', '툭'];
function measureTicDensity(text) {
  const sents = splitSentences(text).length || 1;
  let hits = 0;
  for (const tic of CONV_TICS) { let i = 0; while ((i = text.indexOf(tic, i)) !== -1) { hits++; i += tic.length; } }
  return hits / sents;
}

// ── (C) segment별 위험 측정 + 서브스코어 + 합성 riskScore ──
//   핵심 가설(실측 보정 MAE≈0.14): 영역 안에 strict 구체가 하나도 없으면 잡힌다.
//   riskScore: 카피킬러 사유별 서브스코어 가중합(0~1 clamp). 가중치는 PDF 라벨로 보정 예정(Phase 1-2).
function measureSegmentRisk(segText, anchorPool) {
  const sents = splitSentences(segText);
  const n = sents.length || 1;
  const concreteSents = sents.filter(isSegmentConcrete);
  const stanced = sents.filter(s => STANCE_RE.test(s)).length;
  const generic = sents.filter(s => GENERIC_SUBJECT_RE.test(s.trim()) || ABSTRACT_NOUN_RE.test(s) || GENERIC_ENDING_RE.test(s)).length;
  const anchorHits = anchorPool ? anchorPool.anchorTerms.filter(t => t.length >= 2 && segText.includes(t)).length : 0;
  const u = measureUniformity(segText);
  const concrete = concreteSents.length;
  const genericRatio = generic / n;
  const impersonalRatio = measureImpersonal(segText);
  const compressionRatio = measureCompression(segText);
  const ticDensity = measureTicDensity(segText);
  const stanceRatio = stanced / n;
  const concreteRatio = concrete / n;
  // 균일성: 종결 단조(maxEndingRun) + 길이 균일(lengthCV 낮음)
  const uniformity = Math.min(1, (u.maxEndingRun >= 4 ? 0.6 : u.maxEndingRun >= 3 ? 0.35 : 0) + (u.lengthCV < 0.35 ? 0.4 : u.lengthCV < 0.5 ? 0.2 : 0));
  // 합성 risk(잠정 가중치 — Phase 1-2에서 PDF로 보정). 0~1 clamp.
  let risk = genericRatio * 0.9 + uniformity * 0.7 + impersonalRatio * 0.7 + compressionRatio * 0.7 + Math.min(1, ticDensity) * 0.4
           - concreteRatio * 1.1 - stanceRatio * 0.5 - Math.min(1, anchorHits / 3) * 0.3;
  risk = Math.max(0, Math.min(1, risk + 0.15));   // bias로 0근처 보정
  return {
    chars: segText.replace(/\s+/g, '').length, sents: n,
    concrete, stanced, generic, anchorHits,
    genericRatio: Number(genericRatio.toFixed(2)),
    impersonalRatio: Number(impersonalRatio.toFixed(2)),
    compressionRatio: Number(compressionRatio.toFixed(2)),
    ticDensity: Number(ticDensity.toFixed(2)),
    uniformity: Number(uniformity.toFixed(2)),
    lengthCV: u.lengthCV, maxEndingRun: u.maxEndingRun,
    riskScore: Number(risk.toFixed(3)),
    suspect: concrete === 0   // (레거시 binary) — Phase 1-2 검증 후 riskScore 임계로 교체 예정
  };
}

// ── (D) 문서 전체 segment 리포트: 의심 영역 비율 ≈ 카피킬러 AI% (프록시) ──
function buildSegmentReport(text, rawText = '', targetChars = 350) {
  const anchorPool = buildSourceAnchorPool(rawText || text);
  const segs = buildSegments(text, targetChars);
  const rows = segs.map((s, i) => ({ idx: i + 1, ...measureSegmentRisk(s, anchorPool), head: s.replace(/\s+/g, ' ').slice(0, 40) }));
  const suspect = rows.filter(r => r.suspect).length;
  return {
    targetChars,
    segments: rows.length,
    suspectSegments: suspect,
    suspectRatio: Number((suspect / (rows.length || 1)).toFixed(3)),  // ≈ 예측 카피킬러 AI%
    anchorPool: {
      specifics: anchorPool.specifics, acronyms: anchorPool.acronyms, terms: anchorPool.terms,
      examples: anchorPool.examples.length, contrasts: anchorPool.contrasts.length, caveats: anchorPool.caveats.length
    },
    rows
  };
}

// "실제 겪은 장면"(lived scene): 1인칭/과거시점 맥락 + 과거시제 행동. 단순 명사 언급(친구·SNS)은 제외.
//   카피킬러가 '낮음'으로 통과시키는 건 바로 이런 1인칭 과거 경험 문장이다.
const PERSONAL_CTX_RE = /(저는|저도|제가|제\s|내가|나는|우리\s|지난\s*(학기|주|달|해|명절|방학)|그날|그때|작년|재작년|며칠\s*전|예전에|한때|어릴\s*때|고등학교\s*때|중학교\s*때|대학\s*때)/;
// 과거시제 형태소(일반화): ~았/었/였/갔/왔/봤/했... + 종결/연결어미. 특정 동사 나열 대신 과거형 자체를 잡는다.
const PAST_ACTION_RE = /(았|었|였|했|갔|왔|봤|뒀|났|렸|췄|쳤|다툰)(다|다는|는데|던|던\s|고|으며|지만|음|어요|네요|거든요|습니다|기도)/;
// 경험 표지: "~적이 있다", "~던 적", "~곤 했다" 자체가 구체적 과거 경험 진술.
const EXPERIENCE_RE = /(적이\s*있|던\s*적|곤\s*했|적\s*있)/;
function isLivedScene(s) {
  if (EXPERIENCE_RE.test(s) && PAST_ACTION_RE.test(s)) return true;          // ~한 적이 있다 류
  if (PERSONAL_CTX_RE.test(s) && PAST_ACTION_RE.test(s)) return true;        // 1인칭/특정시점 + 과거행동
  return false;
}

// "구체 사실"(specificity): 연도·숫자+단위·한자·인용어구 등. 일반적 약어(SNS/AI)는 제외(너무 흔해 신호 아님).
//   purpose 에세이처럼 1인칭 일화가 아니라 고유명사·수치로 구체적인 글이 카피킬러를 통과하는 경로.
const SPECIFIC_RE = /(19|20)\d{2}|\d+\s*(명|개|건|배|원|시간|분|초|개월|주|일|차례|번|미터|m|km|kg|살|세|층|위|등)|[一-鿿]|"[^"]{2,}"|“[^”]{2,}”|'[^']{3,}'|‘[^’]{3,}’/;
const SPECIFIC_RE_G = /(19|20)\d{2}|\d+\s*(명|개|건|배|원|시간|분|초|개월|주|일|차례|번|미터|m|km|kg|살|세|층|위|등)|[一-鿿]{1,}|"[^"]{2,}"|“[^”]{2,}”/g;
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
  measureUniformity, analyzeParagraphs, buildSurfaceReport, classifyInputRisk,
  measurePersonalExperienceNovelty, measureMemoReuse, isLivedScene,
  buildSourceAnchorPool, buildSegments, measureSegmentRisk, buildSegmentReport,
  measureImpersonal, measureCompression, isCompressedSentence, measureTicDensity
};
