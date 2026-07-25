// [engine/inputrouting.js] 입력 글이 '재구성(재생성)'에 부적합한지 결정론으로 판정(무LLM·무과금).
// ────────────────────────────────────────────────────────────────
// 왜: 부적합한 글(자소서·생기부·탐구문, 짧고 추상적인 글)을 고급(재구성)에 넣으면 LLM이 원문에 없는
//   사실·평가·전망을 지어내(added_claim) 거의 확정적으로 차단된다. 그 사이 ledger·plan·슬롯×시도·weave·
//   judge·수리로 수십 번의 생성 호출이 통째로 낭비된다(실측: 재구성 1건 차단 = 수백 크레딧 상당 API).
//   → /diagnose(무LLM)와 /transform 시작점에서 결정론으로 걸러 보존형(다듬기)으로 유도, API 낭비를 0으로.

// 자소서·생기부·탐구 유형 감지. '저/제' 1인칭이 드물어도(존댓말 자기서술) 강한 신호어가 있으면 자소서류로 본다.
//   기존엔 1인칭 밀도 + '지원/면접/역량' 어휘를 동시에 요구해, "주제를 선정했습니다"식 생기부·탐구문(1인칭
//   대명사·취업 어휘 없음)이 안 걸려 재구성까지 가 added_claim 폭발(실측 junnny1004 2026-06-16).
function looksLikeResume(text) {
  const t = text || '';
  const bare = t.replace(/\s+/g, '').length || 1;
  const fp = (t.match(/저는|저의|저를|저도|제가|제 강점|제 경험|본인은|본인의/g) || []).length;
  const fpPer1k = fp / (bare / 1000);                 // 1000자당 1인칭 자기지칭
  const vocab = (t.match(/지원|합격|자격증|면접|입사|자기소개|지원동기|강점|역량|기여하겠|되겠습니다|성장하|채용|포부/g) || []).length;
  // ① 강한 자소서·생기부 골격어(단독 성립, 인용 유무와 무관): 세특·생기부·자소서·진로·동아리·지원동기 — 시사·논증 글엔 안 나옴.
  if (/세부\s*능력\s*및?\s*특기|세특|생활기록부|생기부|진로\s*(?:활동|희망|탐색)|동아리\s*활동|지원\s*동기|자기소개서/.test(t)) return true;
  // ② 주제 선정/선택: 탐구·생기부에 흔하지만 일반 보고서에도 나온다("이 주제를 선택한 이유는…"). 그래서 단독 성립이되,
  //   ★인용 기반 논증 보고서 예외(2026-06-16 실측 dayoung3360 '북한 정보통제' 보고서: 인용 6개인데 "주제로 선택한 이유"에
  //   걸려 자소서로 오분류→보존형 오라우팅). (이름, 2023)식 학술 인용이 2개+면 재구성이 지어낼 게 없는 사실기반 논증 글
  //   (=시사·논증=재구성 적합)이므로 이 신호로는 라우팅하지 않는다. (gy6326 탐구문은 이런 인용이 없어 그대로 잡힘.)
  const citations = (t.match(/\([가-힣A-Za-z·]+\s*,?\s*(?:19|20)\d{2}\)/g) || []).length;
  // ★과학·기술 연구 보고서 예외(2026-06-18 실측 EGFR 분자도킹 보고서 4회 연속 오차단): "비소세포폐암을 관심 질병으로
  //   선정하였다"의 '선정하였다'가 이 패턴에 걸리고, 인용이 (저자,2023) 아닌 (GeneCards)·(PubChem) DB명이라 인용 예외도
  //   못 타 자소서로 오판됐다. SMILES·PDB·돌연변이 등 기술 마커가 3개+면 연구 보고서이므로 이 휴리스틱에서 제외한다
  //   (강신호 ①·명시 주제선정은 그대로). 이런 보고서는 isStructuredReport가 받아 구조보존 청크 우회로 라우팅.
  if (citations < 2 && sciReportMarkers(t) < 3 && /주제\s*(?:를|로)?\s*(?:선정|선택)|(?:선정|선택)하(?:게|였|았|고자|기로|는\s*과정)|(?:이|해당)\s*주제를?\s*(?:선정|선택)/.test(t)) return true;
  // ★탐구·세특 보고서 골격어(2026-06-16): 단일 출현은 정상 글에도 있을 수 있어 2개 이상 동시 출현 시에만 성립(오탐 방지).
  //   "주제를 선정/선택" 명시구가 없는 탐구문(예: gy6326)도 이 조합으로 잡아 보존형으로 유도한다.
  const inquiry = (t.match(/탐구\s*(?:주제|활동|보고서|내용|과정|동기|결과)|탐구(?:를|해)?\s*(?:통해|보고\s*싶|해\s*보고\s*싶)|후속\s*활동|이번\s*탐구|느낀\s*점|더\s*깊이\s*탐구|탐구해\s*보고\s*싶/g) || []).length;
  if (inquiry >= 2) return true;
  // ★자소서·지원서 신호어(2026-06-16): 합니다체 자소서는 명시적 1인칭("저는")이 드물어 fpPer1k 기준을 빠져나간다
  //   (실측 LG CNS 자소서 fpPer1k 2.2 → 미탐지 → 재구성이 자소서를 '지원자 비평 칼럼'으로 바꿔 배출). "지원했/입사 후/
  //   성장하겠/인재가 되고 싶" 같은 지원·포부 표현이 2개 이상이면 자소서로 본다(정상 시사·논증 글엔 이 조합이 거의 없음).
  const apply = (t.match(/지원했|지원하게\s*된|지원하(?:고|게)\s*싶|지원\s*동기|지원\s*이유|입사\s*후|입사하(?:면|게|여)|인재가?\s*되|기여하(?:겠|고\s*싶)|성장하(?:겠|고\s*싶)|되고\s*싶습니다|뽑아\s*주|합격하/g) || []).length;
  if (apply >= 2) return true;
  return (fpPer1k >= 3 && vocab >= 2);
}

// 사실 밀도(연도·%·인용·통계 가중합 / 천자). 빼곡하면 재구성 시 사실 누락·연도 오기 위험 → 보존형 권장.
function factDensity(text) {
  const t = text || '';
  const years = (t.match(/(?:19|20)\d{2}/g) || []).length;
  const pcts = (t.match(/\d+(?:\.\d+)?\s*(?:%|％|퍼센트)/g) || []).length;
  const cites = (t.match(/\([^)]*(?:19|20)\d{2}[^)]*\)|[가-힣]{2,}(?:연구원|협회|재단|위원회|학회|대학교|공사|기구|청|부)/g) || []).length;
  const nums = (t.match(/\d[\d,]*(?:\.\d+)?\s*(?:명|개|건|원|달러|배|점|회|개월|조|억|만)/g) || []).length;
  const bare = t.replace(/\s+/g, '').length || 1;
  return (years * 2 + pcts * 2 + cites + nums) / Math.max(1, bare / 1000);
}
const FACT_DENSE_THRESHOLD = Number(process.env.FACT_DENSE_THRESHOLD) || 5;

// ★ 과학·공학 연구 보고서 식별자 카운트(2026-06-18 실측 EGFR 분자도킹 보고서 4회 연속 오차단): SMILES 코드·PDB ID·
//   유전자 돌연변이·DB명·실험설계 같은 마커는 factDensity(연도·%·통계)가 전혀 못 세는데, 이런 글은 사실·식별자가
//   빼곡한 '기술 연구 보고서'다. 자소서·생기부·탐구반성문엔 거의 안 나온다. ≥3이면 기술 연구 보고서로 본다.
//   용도: ① looksLikeResume의 '선정하였다' 휴리스틱에서 제외(자소서 오판 방지) ② isStructuredReport의 밀집 신호 보강.
function sciReportMarkers(text) {
  return ((text || '').match(/SMILES|PubChem|\bPDB\b|GeneCards|\bNCBI\b|\bCID\b|\bRTK\b|분자\s*도킹|시뮬레이션|키나아제|돌연변이|염기\s*서열|단백질|화합물|시약|시료|실험군|대조군|유의\s*수준|회귀\s*분석|배양|항체|효소|수용체/gi) || []).length;
}

// 장문 구조화 논문 감지(2026-06-16 실측 zoz040224: 26,934자 논문 재구성→결과 29%·8%로 접힘=length_collapse 차단,
//   연도·수치 대량 누락). 초장문을 단일 호출로 처리하면 모델이 '요약'으로 오해해 접힐 수 있다.
//   현재 엔진은 이런 논문을 구조 보존 청크와 섹션 회복 경로로 처리한다.
//   조건: 매우 긴 글(공백제외 14,000자+) AND 논문 구조 신호(로마숫자 대제목 목차 또는 학술 섹션 표지).
//   ※ 사실밀집(factDense)만으론 막지 않는다(사장님 결정) — 구조 신호가 있는 초장문 논문만 라우팅.
function isLongStructuredThesis(text) {
  const t = text || '';
  const noSp = t.replace(/\s+/g, '').length;
  if (noSp < 14000) return false;
  const hasRoman = /[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*\./.test(t);                       // Ⅰ. 서론 … Ⅵ. 결론
  const hasToc = /(논문의\s*구성|선행\s*연구|이론적\s*배경|참고\s*문헌|연구\s*(?:방법|배경|목적|문제)|초록|Abstract)/.test(t);
  return hasRoman || hasToc;
}

// 학술 논문(학위논문·학회지 인용 기반) 감지(2026-06-16 실측 #9 항공논문 섹션): 단일 재작성에서 국토부 논의·
//   저자명·정책 전망이 추가된 사고를 막기 위해, 사실·인용 밀도가 높은 문서는 청크 기반 격식 경로로 보낸다.
//   시사 칼럼(뉴스 인용 "(이름, 2023)")과 구분: 학위논문·학회지·『저널명』 같은 학술 1차출처 표기 2개+.
function isAcademicCited(text) {
  const t = text || '';
  const refs = (t.match(/학위\s*논문|석사\s*학위|박사\s*학위|학회지|학술지|『[^』\n]{2,}』/g) || []).length;
  return refs >= 2;
}

// 독후감·서평·감상문(개인 성찰문) 감지(2026-06-16 실측 yune0604 '수치심' 독후감: 재구성이 없는 장 번호("10장이
//   경고하는 대목")·평가를 날조해 차단). 책 내용에 대한 개인 감상이라 새 외부 사실이 없어 재구성이 빈자리를 지어낸다
//   → 보존형(다듬기)으로 유도. 강한 정형 구조(【줄거리】/【시사점】·독후감/서평)는 단독, 그 외엔 책 언급+1인칭 성찰 다수.
function looksLikeReflection(text) {
  const t = text || '';
  if (/【\s*줄거리\s*】|【\s*시사점\s*】|독후감|서평|감상문/.test(t)) return true;
  const book = (t.match(/이\s*책(은|이|을|에서|의|을\s*통해|을\s*읽)|저자는|글쓴이는|작가는|책을\s*읽/g) || []).length;
  const reflect = (t.match(/나는|내가|느꼈|깨달았|깨닫게|생각이\s*들|마음에\s*남|위안이\s*되|돌아보게/g) || []).length;
  return book >= 1 && reflect >= 3;   // 책 언급 + 1인칭 성찰 3개+ = 독후감/감상문(정상 시사·논증 글엔 이 조합 드묾)
}

// ★ 영어(비한국어) 위주 입력 판정(2026-06-16). 회피(기본 blog·고급 재구성) 엔진은 "한국 시사 칼럼 필자"로
//   하드코딩된 한국어 전용이라, 영어를 넣으면 한국어로 번역·축약해 원문을 망친다(영어 28,891자 → 한국어
//   4,081자, 14% 손상). hangul/letters<0.15 = 영어 위주(프런트 evDetectLang과 동일 기준). 다듬기(polish)는
//   영어를 영어 그대로 다듬으므로 이 판정으로 막지 않는다.
function isEnglishInput(text) {
  const t = text || '';
  const hangul = (t.match(/[가-힣]/g) || []).length;
  const letters = (t.match(/[A-Za-z가-힣]/g) || []).length || 1;
  // ★임계값 200→50(2026-06-17 실측 버그): 영어 연설/발표문(영문자 126~152자)이 통과해 피하기로 처리→매끈한
  //   원어민 영어로 다듬어져 카피킬러 0→100% 참사(#영어). 50자+영문 우위(한글<15%)면 영어로 본다.
  //   한글 섞인 기술용어 글은 비율 가드로 보호.
  return letters >= 50 && hangul / letters < 0.15;
}
// ★메시지 정정(2026-06-17): "다듬기로 하세요"는 잘못된 안내였다 — 영어를 다듬을수록 AI 패턴이 강해져 카피킬러가
//   더 잘 잡는다(실측 0→100%). 회피 불가를 솔직히 알리고 원문 유지를 권장.
const ENGLISH_UNFIT_REASON = '영어 글은 AI 검사 회피(피하기)를 지원하지 않아요. 피하기는 한국어 전용이라 영어를 넣으면 번역·변형돼 원문이 손상되고, 영어를 매끄럽게 다듬을수록 오히려 AI 패턴이 강해져 검사에서 더 잘 잡혀요. 영어는 원문 그대로 두시길 권장합니다.';

// ★ 격식 문서 감지(2026-06-17, CSV 감사 #21·#83·#90·#72): 보고서·계약서·실험·논문을 기본 피하기(blog)에 넣으면
//   해요체 구어체로 변질된다(가벼운 말투가 그 형식에 안 맞음). 가중 점수 ≥2면 격식문서로 보고 고급 피하기로 안내.
//   강신호(계약 조항·계약서)는 +2로 단독 통과. 캐주얼 블로그 오탐을 줄이려 '서론/본론/결론' 같은 흔한 말은 제외.
function isFormalDocument(text) {
  const t = text || '';
  let score = 0;
  if (/제\s?\d{1,3}\s?조(?:\s*\(|\s|$)/.test(t)) score += 2;                                   // 제N조(계약·법령)
  if (/계약(?:서|자)|합의서|협약서|갑\s*(?:과|은|는)\s*을/.test(t)) score += 2;                    // 계약 강신호
  if (/[ⅠⅡⅢⅣⅤ]\s*[.、)].*[ⅠⅡⅢⅣⅤ]\s*[.、)]|^\s*목\s*차\s*$/ms.test(t)) score += 1;             // 로마숫자 목차(2개+)
  if (/가설|대조군|유의\s*수준|실험\s*방법|시료|측정\s*결과/.test(t)) score += 1;                   // 실험보고서
  if (/참고\s*문헌|초록|Abstract|선행\s*연구|이론적\s*배경/.test(t)) score += 1;                    // 학술
  if (/(?:<|\[|\(|【)?\s*표\s*\d+/.test(t)) score += 1;                                          // 표N
  if (((t.match(/\([가-힣A-Za-z·]+,?\s*(?:19|20)\d{2}\)/g) || []).length) >= 2) score += 1;       // 인용 2개+
  return score >= 2;
}
const FORMAL_GUIDANCE_REASON = '이 글은 보고서·계약서·논문 같은 격식 문서 형식이에요. 가벼운 말투의 「기본 피하기」로 돌리면 구어체로 바뀌어 형식이 깨져요. 원문 구조와 격식을 살리는 「고급 피하기(재구성)」로 진행해 주세요.';

// ★ 각주(¹⁾ ²⁾ …) 인용이 많은 논증·학술 글: 단일 재작성의 평가·메타주장 합성을 막기 위해,
//   위첨자 각주 표지가 3개 이상이면 처음부터 문단별 충실 재작성으로 직행한다.
function isFootnoteCited(text) {
  const sup = ((text || '').match(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+\s*⁾/g) || []).length;   // ¹⁾ ²⁾ … ¹⁴⁾
  return sup >= 3;
}

// ★ 구조화 통계 보고서 감지(2026-06-18 실측 사이버불링 보고서): 원문 48%였는데 단일 재구성이
//   목차·섹션 구조를 부수고 줄글로 만들어 "간접화법·비인칭"이 글 전체를 덮음 → 93%·100%로 *악화*. 구조(목차·번호
//   섹션)와 빼곡한 통계가 원문의 점수를 지켜주던 글인데, 구조를 깨는 단일 재구성이 그 방패를 부순 것. 이런 글은
//   isLongStructuredThesis(14k+)와 똑같이 청크 기반 구조보존 우회(runLongThesisChunked: 목차·문단 보존 + 문단별
//   burstiness·register 우회)로 보내야 한다. 그 단문판(길이 무관) — 14k 미만 보고서가 단일 재구성으로 새던 사각지대.
//   ★ NARROW 설계: 시사·논증 칼럼(재구성이 효과적인 본업)을 절대 건드리지 않게, 보고서 고유 표지(제출자·학번 표지 /
//   목차 / 줄머리 번호섹션)로 score≥2 AND 통계 밀집(factDense)을 둘 다 요구한다. 구조만·통계만으론 발동 안 함.
function isStructuredReport(text) {
  const t = text || '';
  const noSp = t.replace(/\s+/g, '').length;
  if (noSp < 700) return false;                                  // 짧은 글은 thin 게이트 소관(여긴 보고서급만)
  let score = 0;
  if (/제\s*출\s*자\s*[:：]|학\s*번\s*[:：]|학부\s*\/\s*\d{5,}|\/\s*\d{6,8}\s*\//.test(t)) score += 2;   // 제출자·학번 표지(보고서 표지)
  if (/<\s*목\s*차\s*>|(?:^|\n)\s*목\s*차\s*(?:\n|$)|(?:^|\n)\s*차\s*례\s*(?:\n|$)/.test(t)) score += 2;  // 목차/차례
  const topSec = (t.match(/(?:^|\n)[ \t]*\d{1,2}(?!\d)[.)]\s*[가-힣]{2,}/g) || []).length;             // 줄머리 "1. 서론"(연도 2024. 가드: \d{1,2}(?!\d))
  if (topSec >= 3) score += 2;   // 줄머리 번호섹션 3개+ = 강한 보고서 구조(시사칼럼엔 없음). EGFR 보고서(1.질병~4.억제제)도 단독 통과
  const subSec = (t.match(/\d{1,2}(?!\d)\s*[-－]\s*\d{1,2}(?!\d)\s*[.)]?\s*[가-힣]/g) || []).length;     // "2-1. 발생 실태"
  if (subSec >= 2) score += 1;
  // 밀집 신호: 통계(factDensity) OR 기술 식별자(SMILES·PDB·유전자 등 — factDensity가 못 세는 과학 보고서). 둘 중 하나면 보고서다움.
  const dense = factDensity(t) >= FACT_DENSE_THRESHOLD || sciReportMarkers(t) >= 3;
  // 구조 신호 충분(≥2) AND 밀집 — 둘 다라야 발동(시사칼럼·구조만 있는 감상문 오탐 방지).
  return score >= 2 && dense;
}

// 과제 보고서형 섹션 구조 감지: 통계가 많지 않아도 Ⅰ.서론/Ⅱ.본론/Ⅲ.결론 같은 골격은 보존해야 한다.
// 단일 재구성(칼럼 스켈레톤)에 넣으면 보고서가 칼럼 문체로 바뀌므로, 문단별 구조보존 고급 경로로 보낸다.
function isSectionedAssignmentReport(text) {
  const t = text || '';
  const noSp = t.replace(/\s+/g, '').length;
  if (noSp < 300) return false;
  const romanHead = '(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|[IVX]{1,5})';
  const romanSectionRe = new RegExp('(?:^|\\n)\\s*' + romanHead + '\\s*[.、)]\\s*(?:서론|본론|결론|논의|분석|조사|연구|이론적\\s*배경)', 'g');
  const romanSections = (t.match(romanSectionRe) || []).length;
  const hasRomanIntro = new RegExp('(?:^|\\n)\\s*' + romanHead + '\\s*[.、)]\\s*서론').test(t);
  const hasRomanConclusion = new RegExp('(?:^|\\n)\\s*' + romanHead + '\\s*[.、)]\\s*결론').test(t);
  if (romanSections >= 2 && hasRomanIntro && hasRomanConclusion) return true;
  if (noSp < 700) return false;

  const numberedSections = (t.match(/(?:^|\n)[ \t]*\d{1,2}(?!\d)[.)]\s*[가-힣][^\n]{2,60}/g) || []).length;
  const hasReportWords = /본\s*(?:글|보고서|과제)|조사\s*결과|분석하고자|근거\s*자료|비즈니스\s*전략|발생하는\s*문제|활용되는\s*정보기술/.test(t);
  const hasIntroConclusion = /(?:^|\n)\s*(?:서론|결론)\s*$/m.test(t)
    || (/(?:^|\n)\s*[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩIVX]+\s*[.、)]\s*서론/.test(t) && /(?:^|\n)\s*[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩIVX]+\s*[.、)]\s*결론/.test(t));
  return numberedSections >= 3 && hasReportWords && hasIntroConclusion;
}

// ★ 회피 난이도 사전 안내(2026-06-18~19 실측, 소프트 — 차단 아님, 사용자는 진행 가능): 일부 장르는 무날조 회피가
//   구조적으로 어렵다. 시작 전 솔직히 고지해 크레딧·환불 사고를 막는다(/diagnose로 노출).
//   ① STEM 실험·방법론·스펙 보고서(SMILES·PDB·돌연변이 등): 객관 기술 서술이 장르 본질 → 코칭·재구성 다 무효
//      (EGFR 분자도킹 보고서: 코칭없음·약한코칭·강한1인칭 3번 다 카피킬러 100% 실측).
//   ② 구조화 데이터 보고서(목차·통계): 원문이 이미 낮은 경우가 많아 휴머나이징이 오히려 올릴 수 있음
//      (사이버불링 보고서 원문 48% → 구조보존 우회 76% 실측).
const ADVISORY_STEM = '이 글은 실험·방법론·연구 보고서예요. SMILES·화학식·PDB·메커니즘 같은 객관적 기술 서술은 AI 검출을 낮추기 매우 어렵습니다(사람이 써도 높게 나와요). 진행은 가능하지만 효과가 제한적일 수 있어요.';
const ADVISORY_STRUCTURED = '이 글은 목차·통계가 있는 구조화 보고서예요. 이런 글은 원문 자체가 이미 낮게 나오는 경우가 많아, 휴머나이징이 오히려 탐지율을 올릴 수도 있어요. 원문을 먼저 검사해 보시고 높게 나올 때만 진행하시길 권해요.';
function genreAdvisory(text) {
  if (sciReportMarkers(text) >= 3) return { kind: 'stem_spec', reason: ADVISORY_STEM };
  if (isStructuredReport(text)) return { kind: 'structured', reason: ADVISORY_STRUCTURED };
  return null;
}

// 재구성 부적합 판정 + 사용자에게 그대로 보여줄 '명확한 사유'. ir = surfaceguard.classifyInputRisk(text).
//   factDense(사실 빼곡)는 '권장'(소프트)이라 여기서 막지 않는다 — 사장님 결정으로 사실밀집 글도 고급을
//   돌릴 수 있어야 함(B). 막다른 길로 만드는 두 부류만 사전 차단한다: ① 자소서·생기부·탐구 ② 짧고 추상적.
function restructureUnfit(text, ir = {}) {
  const t = text || '';
  const bare = t.replace(/\s+/g, '').length || 1;
  // 영어 위주 글 → 「그대로 다듬기」로 유도(POST 진입부에서 1차 차단하지만 직접 호출 대비 방어).
  if (isEnglishInput(t)) {
    return { unfit: true, kind: 'english', reason: ENGLISH_UNFIT_REASON };
  }
  if (looksLikeResume(t)) {
    return {
      unfit: true, kind: 'resume',
      reason: '이 글은 자소서·생활기록부·탐구활동처럼 1인칭으로 자기 경험·동기를 적은 글이에요. 고급(재구성)은 시사·논증 칼럼으로 새로 써내는 방식이라, 이런 글을 넣으면 AI가 원문에 없는 지원 동기·평가·일화를 지어내 차단돼요. 「그대로 다듬기」나 「기본 피하기」로 진행해 주세요.'
    };
  }
  if (looksLikeReflection(t)) {
    return {
      unfit: true, kind: 'reflection',
      reason: '이 글은 책에 대한 개인 감상(독후감·서평)이에요. 고급(재구성)은 시사·논증 칼럼으로 새로 써내는 방식이라, 책 내용에 없는 장 번호·평가·해석을 지어내 차단돼요. 「그대로 다듬기」나 「기본 피하기」로 진행해 주세요.'
    };
  }
  // ※ 초장문 구조화 논문(isLongStructuredThesis)은 여기서 unfit으로 막지 않는다 — 보존형(그대로 다듬기)으로 보내면
  //   '피하기(우회)' 기능이 빠지기 때문. 대신 transform.runJob이 단일패스 재구성(collapse) 대신 '청크 기반 격식 회피'
  //   (runHumanizeChunked mode=assignment·tonePolish=false = 우회 유지 + 문단별이라 접힘 없음)로 라우팅한다.
  // 짧고 추상적이라 풀어낼 사실이 거의 없는 글: 재구성이 빈 자리를 지어내 채운다.
  const abstract = (ir.grade === 'C') || (Number(ir.abstractRiskRatio) >= 0.5);
  if (bare < 600 && abstract && factDensity(t) < 1.0) {
    return {
      unfit: true, kind: 'thin',
      reason: '글이 짧고 추상적이라(구체적인 수치·사례·이름이 거의 없어요) 고급(재구성)이 빈 내용을 지어내 채우다 차단되기 쉬워요. 구체적 경험·수치를 더 보태거나 「그대로 다듬기」로 진행해 주세요.'
    };
  }
  return { unfit: false, kind: null, reason: '' };
}

// 입력에 같은 내용이 통째로 반복됐는지 결정론 감지(무LLM·무과금). 실측(2026-06-16): 사용자가 약사 리포트를
//   실수로 두 번 붙여넣어 ~2만 자(blog 412크레딧)로 제출 → 중복 분량만큼 과금되고, 긴 입력이 judge 수리에서
//   잘려 결과까지 절반 소실. 차감 전에 막아 비용·혼선을 없앤다(차단 시 무차감 — 중복 빼고 재시도 유도).
//   판정: 문단(공백 무시 30자+)을 앞 80자 키로 묶어, 2회+ 나온 문단의 분량이 전체 본문의 35%+면 중복 입력.
// ★ 인용 날조 감지(2026-06-17, CSV 100건 감사 #56·#47): 근거가 빈약한 학술 글의 재작성 과정에서
//   원문에 없던 논문·학회지·저자(연도)·출처·통계 인용을 지어낸다(실측 lenRatio 207%, novelty·semanticJudge가
//   모두 통과시킴 — 게이트 사각지대). 출력에 있고 원문(공백무시)엔 없는 학술인용 표지 종류 수를 센다. ≥2면
//   날조로 보고 청크 회피(충실 재작성)로 재수정(차단 아님). 전체 100건 임계값 ≥2 오탐 0 실측.
function countFabricatedCitations(src, out) {
  const norm = s => (s || '').replace(/\s+/g, '');
  const S = norm(src);
  const re = /『[^』\n]{1,40}』|학회지|학위\s*논문|등재\s*(?:논문|연구)|출처\s*[:：]|[가-힣]{2,4}·[가-힣]{2,4}\s*\(?\s*20\d{2}|[가-힣]{2,4},\s*「|KISTI|KCI|WIPO|USPTO|pp?\.?\s*\d|\d+\s*권\s*\d*\s*호|보고서\s*\(?\s*20\d{2}/g;
  const hits = new Set();
  for (const m of (out || '').matchAll(re)) { const tok = m[0]; if (!S.includes(norm(tok))) hits.add(tok); }
  return hits.size;
}

// ★ 날조 인용 결정론 제거(2026-06-17, #99): 블로그처럼 더 깨끗한 재라우팅 경로가 없는 곳에서, 원문에 없는
//   '괄호형' 인용/출처만 안전하게 떼어낸다(문장 안 깨짐 — 괄호는 통째 제거 가능). 본문에 녹아든 인라인 인용은
//   건드리지 않는다(그건 isFormalDocument 라우팅으로 고급에 보내 재수정). stripSubmitterMeta와 동형.
function stripFabricatedCitations(src, out) {
  const norm = s => (s || '').replace(/\s+/g, '');
  const S = norm(src);
  let t = out || '', removed = 0;
  const drop = m => { if (!S.includes(norm(m))) { removed++; return ''; } return m; };
  t = t.replace(/[(（]\s*출처\s*[:：][^)）\n]*[)）]/g, drop);                                              // (출처: …)
  t = t.replace(/[(（]\s*[가-힣A-Za-z·]+(?:\s*[·,]\s*[가-힣A-Za-z·]+)*\s*,?\s*(?:19|20)\d{2}\s*[)）]/g, drop);  // (저자, 2023)
  if (removed) t = t.replace(/ {2,}/g, ' ').replace(/\s+([.,，。])/g, '$1');
  return { text: t, removed };
}

// ★ 고유명사 과반복 감지(2026-06-17, CSV 감사 #86): 재작성 모델이 매 문단을 원문의 distinctive 명사구에
//   재-앵커링하면서 같은 인용 제목·수상 이력("제17회 롄허보 문학상")을 8회씩 연결어처럼 반복(novelty·repetition
//   게이트 둘 다 0). 출력의 명사구(상·학회지·제N회 등)가 원문 대비 4배+·5회+ 반복되면 그 횟수를 돌려준다(≥5면
//   날조와 같은 청크 회피로 재수정). split 카운트라 정규식 이스케이프 불필요. 전체 100건 이 신호 오탐 0 실측.
function maxNamedRepeat(src, out) {
  const cands = [...new Set(((out || '').match(/[가-힣]{2,10}(?:문학상|대상|학회지|보고서|선언문?|협약|참사|사건|판결)|제\s?\d{1,3}\s?[회권호]/g) || []))];
  let best = 0;
  for (const c of cands) {
    if (c.length < 3) continue;
    const oc = out.split(c).length - 1;
    const sc = (src || '').split(c).length - 1;
    if (oc >= 5 && oc > sc * 2 && oc > best) best = oc;
  }
  return best;
}

// ★ 제출자 메타데이터 제거(2026-06-17, CSV 감사 #97): 입력 머리말의 "제출자: OO학부 20260423 변정빈"을
//   재생성 엔진이 인용 저자처럼 본문에 엮어("변정빈(20260423)이 설계한…") 학생 본인 이름이 가짜 인용이 됐다.
//   돌리기 전에 학부·학번·이름/라벨형 메타데이터를 결정론으로 떼어낸다(본문 내용은 안 건드림). 학번은 6자리+
//   연속 숫자라 4자리 연도와 구분된다.
function stripSubmitterMeta(text) {
  let t = text || '', changed = 0;
  const patterns = [
    /제\s*출\s*자\s*[:：]?\s*[가-힣]{0,20}(?:학부|학과|전공|대학원)?\s*\d{6,10}\s*[가-힣]{2,4}/g,
    /[가-힣]{2,12}(?:학부|학과|전공|대학원)\s+\d{6,10}\s+[가-힣]{2,4}/g,
    /(?:학\s*번|성\s*명|이\s*름|제\s*출\s*일|담당\s*교수|과목\s*명)\s*[:：]\s*[^\n,]{1,20}/g,
  ];
  for (const re of patterns) t = t.replace(re, () => { changed++; return ''; });
  return { text: t, changed };
}

// ★ 글자분리(PDF 추출 깨짐) 복원(2026-06-19 실측 #57·#58: "법 원 의 필 요 성" 처럼 모든 글자가 공백으로
//   분해된 10510자 입력 — 단일글자 토큰 100%). 이런 입력은 ①과금이 부풀고(공백까지 글자수로 계산)
//   ②URL이 "https://www. scourt. go. kr"로 깨지고 ③다운스트림 품질이 망가진다. 돌리기 '전에' 결정론으로 재결합.
//   판정: 공백 분리 토큰 중 단일문자 비율이 임계 이상이면 깨진 것 → 단일문자 토큰 사이 공백을 제거해 재결합.
//   무LLM·무날조(공백만 조정). 정상 글(단일글자 비율 낮음)은 건드리지 않는다. 끄려면 호출부 env.
function rejoinSplitChars(text, threshold = 0.45) {
  const t = text || '';
  // 토큰화는 공백류만 기준(개행 포함) — 분리율 측정.
  const toks = t.split(/\s+/).filter(Boolean);
  if (toks.length < 50) return { text: t, changed: false, ratio: 0 };
  const single = toks.filter(x => x.length === 1).length;
  const ratio = single / toks.length;
  if (ratio < threshold) return { text: t, changed: false, ratio: Math.round(ratio * 100) / 100 };
  // 재결합: 줄 단위로 처리해 문단(개행) 구조는 보존. 각 줄에서 "단일문자 + 공백" 연쇄를 붙인다.
  //   규칙: 한 글자(한글/영문/숫자/문장부호) 뒤의 단일 공백이, 그 공백 다음도 곧 단일문자로 이어지는 흐름이면 제거.
  //   안전화: 이미 두 글자 이상으로 뭉친 토큰 사이의 공백은 정상 띄어쓰기로 보고 유지.
  const lines = t.split('\n');
  const fixedLines = lines.map(line => {
    const parts = line.split(/(\s+)/);   // 토큰과 공백을 함께 보존
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (/^\s+$/.test(p)) {
        // 공백 처리: ★단일 공백이고 양옆이 모두 단일문자면 글자분리 아티팩트 → 제거("법 원"→"법원",
        //   "w w w . s c o u r t"→"www.scourt"). 2칸 이상 간격은 PDF에서 흔히 '진짜 단어 경계'라 한 칸으로
        //   보존(구조 일부 회복). 탭·기타 공백류는 한 칸으로.
        const prev = parts[i - 1] || '';
        const next = parts[i + 1] || '';
        const prevSingle = prev.length === 1;
        const nextSingle = next.length === 1;
        if (p === ' ' && prevSingle && nextSingle) continue;
        out += ' ';
      } else {
        out += p;
      }
    }
    return out;
  });
  let rejoined = fixedLines.join('\n').replace(/[^\S\n]{2,}/g, ' ');
  return { text: rejoined, changed: rejoined !== t, ratio: Math.round(ratio * 100) / 100 };
}

function detectInputDuplication(text) {
  const t = text || '';
  const norm = (s) => (s || '').replace(/\s+/g, '');
  // ① 문단/줄 단위 반복. ★ 분할을 \n{2,}→\n+ 로 넓힌다(2026-06-16 실측: 환경교육 보고서가 빈 줄 없이
  //   단일 개행으로 두 번 이어붙어 \n{2,}로는 1블록 → 미감지였다). 키(앞 80자) 반복은 내용이 실제로
  //   겹칠 때만 발생하므로 줄 단위로 잘게 나눠도 정상 글 오탐은 없다.
  const blocks = t.split(/\n+/).map(norm).filter(b => b.length >= 30);
  if (blocks.length >= 3) {
    const seen = new Set();
    let dup = 0, total = 0;
    for (const b of blocks) {
      total += b.length;
      const key = b.slice(0, 80);   // 문단 앞 80자로 근사 동일성 판정(완전 일치 반복을 안정적으로 포착)
      if (seen.has(key)) dup += b.length; else seen.add(key);
    }
    const ratio = total ? dup / total : 0;
    if (ratio >= 0.35) return { duplicated: true, ratio: Math.round(ratio * 100) / 100 };
  }
  // ② 통짜 반복(경계 무시): 앞 절반의 60자 윈도우 다수가 뒤 절반에 그대로 재등장하면 두 번 붙여넣기다.
  //   문단 경계가 재붙여넣기로 달라져 ①이 놓치는 경우(부분 줄바꿈)까지 포착. 60자 정확 일치는 정상 글에서
  //   거의 안 겹쳐 오탐이 낮다.
  const full = norm(t);
  if (full.length >= 400) {
    const h = Math.floor(full.length / 2);
    const a = full.slice(0, h), b = full.slice(h);
    let match = 0, n = 0;
    for (let i = 0; i + 60 <= a.length; i += 60) { n++; if (b.includes(a.slice(i, i + 60))) match++; }
    if (n >= 3 && match / n >= 0.6) return { duplicated: true, ratio: Math.round((match / n) * 100) / 100 };
  }
  return { duplicated: false, ratio: 0 };
}

module.exports = { looksLikeResume, looksLikeReflection, factDensity, isLongStructuredThesis, isAcademicCited, isFootnoteCited, isStructuredReport, isSectionedAssignmentReport, sciReportMarkers, genreAdvisory, isEnglishInput, ENGLISH_UNFIT_REASON, restructureUnfit, detectInputDuplication, rejoinSplitChars, stripSubmitterMeta, countFabricatedCitations, stripFabricatedCitations, maxNamedRepeat, isFormalDocument, FORMAL_GUIDANCE_REASON, FACT_DENSE_THRESHOLD };
