// [engine/floor.js] FLOOR v2 — 화자 보존 게이트 (부록 C: C5/C17/C22/C23 무장해제 + C27 pov 가드)
// ────────────────────────────────────────────────────────────────
// 핵심: 원문에 1인칭 단수(저/제가/나)가 없고 사용자가 opt-in 하지 않았으면,
//   엔진이 새 1인칭 화자·개인 일화를 "지어내지" 못하게 막는다(§6.3.1 일화 게이트).
//   - prompt 측: 모드 프롬프트 최상단에 FLOOR 지시 prepend(모드의 일화 주입 지시 override).
//   - gate 측: refine이 "1인칭 일화를 새로 만들라"고 강제하던 위반 항목 제거.
//   - guard 측: 출력에 1인칭이 새로 등장하면 화자 드리프트(FLOOR 위반)로 측정.

// rawText에서 화자 시드 측정(결정론). fp_singular가 일화 게이트의 기준값.
function computePovSeed(rawText) {
  const t = rawText || '';
  // ★ 1인칭 단수 — 명확한 마커만(앞 한글 음절 붙으면 다른 단어로 보고 제외).
  //   저/제 계열 + 내가/내게/나에게/나의 + 소유격 "내 X". '나는/나도/나를/난'은 동사 '나다'
  //   (냄새 나는·소리 나는·불이 난)와 충돌이 잦아 제외 — 캐주얼 누수는 '내/제가', 일화는 anecdote 가드가 커버.
  const fpRe = /(?<![가-힣])(저는|저의|저도|저를|저에게|저로서|저랑|저와|저한테|제가|제 생각|제 경험|제 친구|제 룸메|내가|내게|나에게|나의|내(?=\s))/g;
  const fpPluralRe = /(?<![가-힣])(우리는|우리가|우리의|우리도|저희는|저희가|저희의)/g;
  const orgVoiceRe = /(본\s*보고서|본\s*연구|본\s*글|이\s*글은|이\s*보고서|본고|본\s*논문)/g;
  // 영어 1인칭: 개인(I/me/my/mine) vs 조직(we/us/our/ours) 분리. "I"는 대문자 단독, 나머지는 소문자 단어경계.
  const enSingRe = /\bI\b|\b(?:me|my|mine|myself)\b/g;
  const enPlurRe = /\b(?:we|us|our|ours|ourselves)\b/gi;
  const ko_fp_singular = (t.match(fpRe) || []).length;
  const ko_fp_plural = (t.match(fpPluralRe) || []).length;
  const en_fp_singular = (t.match(enSingRe) || []).length;
  const en_fp_plural = (t.match(enPlurRe) || []).length;
  return {
    ko_fp_singular, ko_fp_plural, en_fp_singular, en_fp_plural,
    fp_singular: ko_fp_singular + en_fp_singular,   // 개인 화자(I/저/제가) 총합
    fp_plural: ko_fp_plural + en_fp_plural,         // 조직/복수 화자(we/우리) 총합
    org_voice_likely: (t.match(orgVoiceRe) || []).length > 0 || en_fp_plural >= 2
  };
}

// 화자 게이트가 닫혀야 하는가? (원문 1인칭 단수 0 && opt-in 아님)
function isSpeakerGateClosed(povSeed, optIn) {
  return !optIn && (povSeed?.fp_singular || 0) === 0;
}

// 모드 프롬프트 위에 붙일 FLOOR 지시. floorV2에서 항상 공통 블록(신규사실 금지 + 분량 보존),
// 원문 1인칭 0 && !optIn이면 화자 보존 블록 추가.
function buildFloorDirective(povSeed, optIn) {
  const blocks = [];
  blocks.push([
    '[GLOBAL FLOOR — 사실성·보존 · 최우선 · 아래 모든 모드 규칙보다 우선]',
    '1) 신규 사실 금지: 원문에 없는 통계·연도·기관명·고유명사·수치, 그리고 논문 내부참조(Table/Eq/그림/§)·인용((저자, 연도))·p값을 새로 지어내지 마라. 또한 원문에 없는 평가·전망·인과관계·진단을 새 주장으로 덧붙이지 마라(원문이 말한 것만 다른 문장으로 옮겨라 — "그럴듯한 추론"을 사실처럼 확장 금지).',
    '2) 분량 보존: 원문과 비슷한 길이로 다시 써라(원문의 0.85~1.2배 유지). 없는 디테일·예시·배경설명·"기술적 상식"으로 분량을 늘리지 말고, 동시에 원문의 핵심 내용·항목·문단을 빠뜨려 과도하게 압축하지도 마라(문단 통째 삭제 금지). 구체화는 원문에 이미 있는 내용을 풀어서만 한다.',
    '※ 이 지시는 아래 모드 규칙의 "디테일 보강 / 분량 늘리기 / 빠진 내용 채우기 / 70% 구체성 / 내부참조 삽입" 지시보다 우선한다.'
  ].join('\n'));
  if (isSpeakerGateClosed(povSeed, optIn)) {
    // ★ 과제 자연체(FORMAL_HUMAN): 개인 일화는 계속 금지하되, 필자 1인칭 *판단*은 허용(speakerPolicy 분리).
    if (process.env.FORMAL_HUMAN === '1' || process.env.ASSIGNMENT_B7 === '1') {
      blocks.push([
        '[화자 보존 — 필자 판단 허용]',
        '원문에 1인칭 화자가 없다. "제가 작년에 ~했다" 같은 개인 경험·일화·감정은 절대 만들지 마라(없는 경험 날조 금지). 단, 글 전체 논지에 대한 *필자의 판단*은 1인칭으로 드러내도 된다("나는/저는 ~라고 본다 / 내가 더 중요하게 보는 부분은 ~"). 즉 개인 일화는 금지, 필자 판단은 허용이다.'
      ].join('\n'));
    } else {
      blocks.push([
        '[화자 보존]',
        '원문에 1인칭 화자(저/제가/나/내가)가 전혀 없다. 새 1인칭 화자나 "제가 작년 학기에 ~한 적이 있다" 같은 개인 경험·일화를 만들지 마라. 원문의 비인칭·일반 서술 시점을 그대로 유지한다. 이 지시는 모드 규칙의 "1인칭 일화 추가/교체"보다 우선한다.'
      ].join('\n'));
    }
  }
  return blocks.join('\n\n') + '\n';
}

// 화자 게이트가 닫혔을 때, "1인칭 일화를 새로 만들라"고 강제하는 refine 위반 항목 제거(안티-FLOOR 무장해제).
const INJECTION_FAIL_MARKERS = ['1인칭 구체 일화', '1인칭 anchor', '추상 진술 비율', '일반론 문단', '판단 회피 1인칭'];
function gateFailedFields(failed, povSeed, optIn) {
  if (!isSpeakerGateClosed(povSeed, optIn)) return failed;
  return (failed || []).filter(f => !INJECTION_FAIL_MARKERS.some(m => f.includes(m)));
}

// 화자 드리프트 가드(C27): 원문 1인칭 단수 0인데 출력에 1인칭 단수가 등장 = FLOOR 위반.
function measurePovDrift(rawText, outputText, povSeed) {
  const seed = povSeed || computePovSeed(rawText);
  const outSeed = computePovSeed(outputText || '');
  return {
    input_fp_singular: seed.fp_singular,
    output_fp_singular: outSeed.fp_singular,
    introducedFirstPerson: seed.fp_singular === 0 && outSeed.fp_singular > 0,  // 비인칭→개인(FLOOR 위반)
    droppedFirstPerson: seed.fp_singular > 0 && outSeed.fp_singular === 0      // 개인→비인칭(화자 손실, 보고용)
  };
}

// ── 신규 사실 주입 가드 (C26: Hard Ledger 전신, 전 모드) ──────────
// verifyCheckFields의 차집합은 assignment 전용이라, floor는 자체 측정으로 전 모드 커버.
function extractYears(s) { return (s || '').match(/(?:19|20)\d{2}/g) || []; }
function extractPercents(s) {
  // 표기 정규화: "60퍼센트"·"60 ％"·"60%" → "60%" (set-diff 오탐 방지).
  return ((s || '').match(/\d+(?:\.\d+)?\s*(?:%|％|퍼센트)/g) || []).map(p => p.replace(/\s+/g, '').replace(/퍼센트|％/g, '%'));
}
const ORG_RE = /[가-힣]{2,}(?:상공회의소|연구원|공사|협회|재단|위원회|기구|연구소|본부|센터|기관|대학교|학회)/g;
// 숫자+단위. "96회", "300분", "12명", "1,200원" 등.
// ★ 쪽/페이지(페이지 참조)는 문서 구조 메타라 내용 사실이 아님 — "3쪽" 한 토큰이 9.4K 글을 통째 차단하던 lostFacts FP(2026-06-15) 제거.
// ★ 정수만(소수 제외) + 앞에 "숫자." 없을 때만(2026-06-15): 목차번호 "2.1 시장"의 .1을 "1 시"로, "2.1 개요"를
//   "1 개"로 먹던 lostFacts FP 차단. 실데이터 소수+단위(2.1배·3.5시간)는 DECIMAL_RE가 숫자를 잡는다.
const NUM_UNIT_RE = /(?<![\d.])\d[\d,]*\s*(?:회|분|시간|초|명|개|건|곳|배|위|점|원|달러|엔|위안|유로|일|주|개월|차|등|등급|km|kg|개국|시|살|세|줄|문항)/g;
// 한국어 금액/수량 단위 (천/만/억/조). "5천원", "3만", "2억원", "4천~5천원", "5천 자", "30만 자".
// ★ (?<!제): "제2조·제6조·제16조~제32조"(조문 번호=條)를 "2조"(兆, 트릴리언)로 오인하던 lostFacts FP 차단(2026-06-15).
//   조문 번호는 문서 구조 참조라 내용 사실이 아님. 돈/수량 "2조 원"은 제 없이 그대로 잡힌다.
const KR_AMOUNT_RE = /(?<!제\d*)\d[\d,]*\s*(?:천|만|억|조)\s*(?:원|명|개|건|배|자|장|권|회|곳|군데|화)?/g;
// 한글 수사 + 단위 ("세 배", "열 명"). '한'은 관형사 충돌로 제외.
const NATIVE_NUM_RE = /(?<![가-힣])(?:두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|스물|서른|마흔|쉰|예순)\s*(?:개|명|번|배|살|마리|권|잔|그루|채|대|장|건|곳|달|해|시간|줄)/g;
// 단위 없는 소수 (0.42). 연도·% 와 별개.
// ★ 목차/개요 번호("2.1 시장 규모", "3.2 ...") 오탐 제외(2026-06-15 실측 lostFacts FP): 소수 뒤가 공백이면
//   문서 구조 번호일 확률이 높다 → 데이터 소수는 보통 단위·조사가 붙음(0.42였다·2.1배·1.44℃). 공백 동반 소수는 사실에서 제외.
const DECIMAL_RE = /(?<![\d.])\d+\.\d+(?![\d%％\s])/g;
// URL / 이메일 / DOI.
const URL_RE = /(?:https?:\/\/[^\s)]+|www\.[^\s)]+|\b10\.\d{4,}\/\S+|[\w.+-]+@[\w-]+\.[\w.-]+)/gi;
// 라틴 약어 + 대문자 영단어.
const LATIN_ACRONYM_RE = /\b[A-Z]{2,}\b/g;
const LATIN_CAPWORD_RE = /\b[A-Z][a-z]{1,}\b/g;
const LATIN_ALLOW = new Set(['AI', 'SNS', 'IT', 'PC', 'TV', 'OK', 'PDF', 'URL', 'CEO', 'GPT', 'LLM', 'API', 'OS', 'CPU', 'GPU']);
// Title Case 영어 일반어 오탐 방지. 한국어 글에 모델이 "The Question" 같은 영어식 소제목을
// 흘리면 기존 LATIN_CAPWORD_RE가 이를 새 고유명사로 잘못 잡아 차단했다.
const LATIN_COMMON = new Set([
  'A', 'AN', 'THE', 'THIS', 'THAT', 'THESE', 'THOSE',
  'AND', 'OR', 'BUT', 'SO', 'IF', 'THEN', 'BECAUSE', 'ALTHOUGH',
  'IN', 'ON', 'AT', 'TO', 'FROM', 'FOR', 'WITH', 'WITHOUT', 'OF', 'BY', 'AS',
  'IS', 'ARE', 'WAS', 'WERE', 'BE', 'BEEN', 'BEING', 'DO', 'DOES', 'DID',
  'NOT', 'NO', 'YES', 'CAN', 'COULD', 'MAY', 'MIGHT', 'MUST', 'SHOULD', 'WOULD', 'WILL',
  'WHAT', 'WHY', 'HOW', 'WHEN', 'WHERE', 'WHO', 'WHICH',
  'QUESTION', 'ANSWER', 'PROBLEM', 'ISSUE', 'POINT', 'CASE', 'EXAMPLE',
  'INTRODUCTION', 'CONCLUSION', 'SUMMARY', 'TITLE', 'TEXT', 'SOURCE', 'REWRITE',
  'FIRST', 'SECOND', 'THIRD', 'MAIN', 'KEY', 'IMPORTANT', 'REAL', 'TRUE', 'FALSE',
  'NEW', 'OLD', 'GOOD', 'BAD', 'MORE', 'LESS', 'JUST'
]);
// 접미사 없는 주요 브랜드/서비스 — 허용리스트로 명시 검출(인명은 NER 영역이라 제외, judge가 의미로 보완).
// ★ 단독 '현대'는 '현대 사회·현대인·현대 미술'(=modern) 오탐이 압도적이라 브랜드에서 제외(2026-06-15 실측 lostFacts FP).
//   현대자동차/현대차만 브랜드로 추적(기업 의미일 때만).
const BRANDS = ['카카오', '네이버', '쿠팡', '배달의민족', '배민', '토스', '당근마켓', '당근', '구글', '유튜브', '인스타그램', '페이스북', '트위터', '삼성', '엘지', '현대자동차', '현대차', '기아', '애플', '아마존', '넷플릭스', '챗지피티', '오픈에이아이', '마이크로소프트',
  'Kakao', 'Naver', 'Coupang', 'Toss', 'Google', 'YouTube', 'Instagram', 'Facebook', 'Twitter', 'Apple', 'Amazon', 'Netflix', 'OpenAI', 'ChatGPT', 'Microsoft'];
const normTok = (s) => s.replace(/\s+/g, '').toLowerCase();
// 숫자 정규화 포함 비교 키: "5천"↔"5000", "1만 자"↔"10,000자"↔"10000자".
// ★ factast.factKey로 위임(부호 보존 + "1만5천"=15000 누적 교정). 단순케이스는 차등 테스트로 기존과 동일
//   출력 증명(_test-factast.js). 기본 on(2026-06-19 활성화, 88쌍 게이트변화0·50문서 FP0 검증). FACT_AST=0이면 기존 경로.
function factKey(s) {
  if (process.env.FACT_AST !== '0') return require('./factast').factKey(s);
  let k = String(s).replace(/\s+/g, '');
  k = k.replace(/(\d[\d,]*)억/g, (_, n) => String(Number(n.replace(/,/g, '')) * 100000000))
       .replace(/(\d[\d,]*)만/g, (_, n) => String(Number(n.replace(/,/g, '')) * 10000))
       .replace(/(\d[\d,]*)천/g, (_, n) => String(Number(n.replace(/,/g, '')) * 1000));
  return k.replace(/,/g, '').toLowerCase();
}

// 영어 Title-Case 고유명사(2단어+ 또는 문장 중간 단일어). 문장 첫 단어 단독은 제외(Most/But/Finding 오탐 방지).
function extractEnEntities(text) {
  const t = text || '';
  const re = /[A-Z][a-zA-Z]+(?:[ -][A-Z][a-zA-Z]+)*/g;
  const ents = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const before = t.slice(0, m.index);
    const atSentenceStart = /(^|[.!?\n]\s*|["'(]\s*)$/.test(before);
    let phrase = m[0];
    const words = phrase.split(/[ -]/);
    if (atSentenceStart) {
      if (words.length >= 2) phrase = words.slice(1).join(' ');  // 문장 첫 단어만 떼고 나머지 엔티티 유지
      else continue;                                              // 단일 문장-첫 Title어 → 스킵
    }
    if (phrase && /^[A-Z]/.test(phrase)) ents.push(phrase);
  }
  return ents;
}

// ── B2b: 한국식 복합수량 통째 캡처 + 부호 포착(기본 on. FACT_AST=0이면 아래 기존 경로) ──────
//   복합: "1만5천명"·"2억3천만 원"을 한 토큰으로(기존은 "1만"+"5천명"으로 쪼개 동치 비교 불가). (?<!제\d*) 가드 유지.
//   ★단위는 천/만/억/조만(원본 KR_AMOUNT_RE와 동일) — 백/십은 "VGG16 백본"·"백신"·"십자" 등 단어 일부 FP라 제외.
const KR_AMOUNT_COMPOUND_RE = /(?<!제\d*)\d[\d,]*\s*[조억만천](?:\s*\d[\d,]*)?(?:\s*[조억만천](?:\s*\d[\d,]*)?)*\s*(?:원|명|개|건|배|자|장|권|회|곳|군데|화)?/g;
//   부호: 이미 추출된 수치 앞에 '-'가 있고, 그 '-' 앞이 '시작/공백/여는괄호/比約약'일 때만 음수로(=코로나-19·GPT-4·
//   2024-01-15·전화번호처럼 단어/숫자에 붙은 하이픈은 제외). 추출 안 된 숫자엔 영향 없음 → FP 가드 자동 보존.
function _signedMatches(t, re, normalize) {
  const out = []; re.lastIndex = 0; let m;
  while ((m = re.exec(t)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    let tok = normalize ? normalize(m[0]) : m[0];
    const i = m.index;
    if (t[i - 1] === '-' && (i - 2 < 0 || /[\s(\[<"'比約약]/.test(t[i - 2]))) tok = '-' + tok;
    out.push(tok);
  }
  return out;
}
const _PCT_RE = /\d+(?:\.\d+)?\s*(?:%|％|퍼센트)/g;
const _normPct = (s) => s.replace(/\s+/g, '').replace(/퍼센트|％/g, '%');

// 텍스트의 모든 hard fact 토큰 추출(전 모드 Hard Ledger §7.3). hasHangul로 라틴 처리 분기.
function extractFacts(text, hasHangul) {
  const t = text || '';
  const facts = [];
  const factAst = process.env.FACT_AST !== '0';   // 기본 on(2026-06-19). FACT_AST=0으로만 끔(롤백용).
  for (const y of extractYears(t)) facts.push(y);
  for (const p of (factAst ? _signedMatches(t, _PCT_RE, _normPct) : extractPercents(t))) facts.push(p);
  for (const o of (t.match(ORG_RE) || [])) facts.push(o);
  for (const m of (factAst ? _signedMatches(t, KR_AMOUNT_COMPOUND_RE, s => s.replace(/\s+/g, '')) : (t.match(KR_AMOUNT_RE) || []).map(s => s.replace(/\s+/g, '')))) facts.push(m);
  for (const m of (factAst ? _signedMatches(t, NUM_UNIT_RE, s => s.trim()) : (t.match(NUM_UNIT_RE) || []).map(s => s.trim()))) facts.push(m);
  for (const m of (t.match(NATIVE_NUM_RE) || [])) facts.push(m.replace(/\s+/g, ' ').trim());
  for (const m of (factAst ? _signedMatches(t, DECIMAL_RE, null) : (t.match(DECIMAL_RE) || []))) facts.push(m);
  for (const m of (t.match(URL_RE) || [])) facts.push(m);
  for (const b of BRANDS) if (t.includes(b)) facts.push(b);
  // 라틴 엔티티: 약어(ACRONYM) + Title-Case 고유명사.
  //   ★ 영어 본문(영어 단어 우세)은 extractEnEntities(문장 첫 대문자 단어 단독 제외)로 "The/Today/Question/Chatbots"
  //     오탐 차단. 한국어 본문(영어는 드문 외래 인명·브랜드)은 raw CAPWORD로 전수 추적 — 문장첫·괄호인용이라도
  //     "Twenge"(인명) 같은 진짜 엔티티를 놓치지 않는다(2026-06-15, 영어 요약글 novelty FP ↔ 논문 인명 recall 양립).
  const koCount = (t.match(/[가-힣]/g) || []).length;
  const enWordCount = (t.match(/[A-Za-z]{2,}/g) || []).length;
  const enDominant = enWordCount >= 10 && enWordCount * 4 > koCount;   // 영어 본문 판정(영어 단어가 한글의 1/4 이상 & 10단어+)
  const latin = enDominant
    ? [...(t.match(LATIN_ACRONYM_RE) || []), ...extractEnEntities(t)]
    : [...(t.match(LATIN_ACRONYM_RE) || []), ...(t.match(LATIN_CAPWORD_RE) || [])];
  for (const m of latin) {
    const up = m.toUpperCase();
    if (!LATIN_ALLOW.has(up) && !LATIN_COMMON.has(up)) facts.push(m);
  }
  return facts;
}

// 신규 사실 주입(출력에 있으나 입력엔 없음) — 전 모드.
// allowedExtra: 사용자 경험 메모(userNotes). 제공 시 "허용 세계 = 원문 ∪ 메모" — 메모에 적힌 사실은
//   날조가 아니다(사용자 동의·제공). 메모에도 원문에도 없는 사실만 novelty로 잡는다.
function measureNovelty(rawText, outputText, allowedExtra) {
  const hasHangul = /[가-힣]/.test(rawText || ''); // 소스 언어 기준(출력 언어 섞임 시 CAPWORD 오탐 방지)
  const allowedFacts = extractFacts(rawText, hasHangul);
  if (allowedExtra) allowedFacts.push(...extractFacts(allowedExtra, hasHangul));
  const inKeys = new Set(allowedFacts.map(factKey));
  const seen = new Set(), items = [];
  for (const f of extractFacts(outputText, hasHangul)) {
    const k = factKey(f);
    if (!inKeys.has(k) && !seen.has(k)) { seen.add(k); items.push(f); }
  }
  return { items, count: items.length };
}

// ── 분량 과확장 가드 (C18: lengthOverrun — 모드별 정책) ──────────
// thesis는 과확장+허위 디테일 위험이 커 상한이 가장 빡빡. conclusion은 호출부에서 더 조일 수 있음.
const LENGTH_POLICY = {
  thesis:     { min: 0.85, max: 1.20, hardMax: 1.30 },
  assignment: { min: 0.85, max: 1.20, hardMax: 1.30 },
  // blog(짧은 다듬기·기본 피하기)은 자연히 압축되는 장르라 하한을 완화(0.85→0.72, env BLOG_LEN_MIN).
  //   ★증축 상한 env 튜너블(2026-06-20 #51·#62·#66 기본 피하기 x1.22~1.34 증축): 기본값 불변(회귀 0).
  //   증축이 문제되면 BLOG_LEN_HARDMAX(예 1.35)·BLOG_LEN_MAX로 무배포 조정. 짧은 글 완화(rawLen<250→2.2)는 measureLength에서 유지.
  blog:       { min: Number(process.env.BLOG_LEN_MIN) || 0.72, max: Number(process.env.BLOG_LEN_MAX) || 1.35, hardMax: Number(process.env.BLOG_LEN_HARDMAX) || 1.55 },
  resume:     { min: 0.90, max: 1.25, hardMax: 1.40 }
};
function measureLength(rawText, outputText, mode) {
  const pol0 = LENGTH_POLICY[mode] || LENGTH_POLICY.assignment;
  const rawLen = (rawText || '').replace(/\s+/g, '').length;
  const outLen = (outputText || '').replace(/\s+/g, '').length;
  const ratio = rawLen > 0 ? outLen / rawLen : 1;
  // ★ 짧은 글 비율 상한 완화(2026-06-19 실측 #8: 140자 글로벌시민교육 성찰이 blog 1.561배로 length_overrun 차단).
  //   짧은 글은 한 문장만 풀어 써도 비율이 크게 튄다(절대 +수십 자는 사소). 무날조는 novelty/judge가 따로 잡으므로
  //   여기선 '길이'만 본다 → rawLen<250(공백제외)이면 hardMax를 넉넉히(최소 2.2배) 완화. 긴 글 과확장 차단은 불변.
  const pol = rawLen < 250 ? Object.assign({}, pol0, { hardMax: Math.max(pol0.hardMax, 2.2) }) : pol0;
  let status = 'ok';
  if (ratio > pol.hardMax) status = 'overHard';      // FLOOR 위반 → shrink repair
  else if (ratio > pol.max) status = 'overSoft';     // 경고만(report)
  else if (ratio < pol.min) status = 'short';        // 부족(원문 정보만 복원)
  return { ratio: Number(ratio.toFixed(3)), status, policy: pol, rawLen, outLen };
}

// ── 손실 가드 (§3.1 "숫자 증발") — 입력의 hard fact가 출력에서 사라짐 ──
// novelty가 "추가"를 잡는다면, 이건 "소실"을 잡는다(set-diff 반대 방향).
function measureLostFacts(rawText, outputText) {
  const hasHangul = /[가-힣]/.test(rawText || ''); // 소스 언어 기준(출력 언어 섞임 시 CAPWORD 오탐 방지)
  const outKeys = new Set(extractFacts(outputText, hasHangul).map(factKey));
  const seen = new Set(), items = [];
  for (const f of extractFacts(rawText, hasHangul)) {
    const k = factKey(f);
    if (!outKeys.has(k) && !seen.has(k)) { seen.add(k); items.push(f); }
  }
  return { items, count: items.length };
}

// ── thesis 허위 내부참조/인용 가드 (C2~C4: Table/Eq/§/연도인용 신규 생성 금지) ──
function extractInternalRefs(s) {
  const t = s || '';
  const refs = new Set();
  const patterns = [
    /(?:Table|표)\s*\d+/gi,
    /(?:Eq\.?|식)\s*\d+/gi,
    /(?:Fig\.?|Figure|그림)\s*\d+/gi,
    /(?:Section|Sec\.?|§)\s*\d+(?:\.\d+)*/gi,
    /\([^)]*\d{4}[^)]*\)/g,        // (Smith et al., 2023) 류 연도 포함 괄호 인용
    /\bp\s*[<≤=]\s*0?\.\d+/gi      // p < .05
  ];
  for (const re of patterns) for (const m of (t.match(re) || [])) refs.add(m.replace(/\s+/g, ' ').trim().toLowerCase());
  return refs;
}
function measureFakeInternalRefs(rawText, outputText) {
  const inRefs = extractInternalRefs(rawText);
  const fabricated = [...extractInternalRefs(outputText)].filter(r => !inRefs.has(r));
  return { fabricated, count: fabricated.length };
}

// ── 반복 가드 (§3.1 결론/CTA 반복 — 청크 경계에서 같은 결론이 두 번 나오는 문제) ──
// 병합된 전체에서 (1)동일(정규화) 문장 2회+ = exact, (2)어미·일부 단어만 다른 근접중복 = fuzzy.
// 청크 단위 재작성은 같은 결론을 어미만 바꿔 두 번 쓰는 일이 잦아 fuzzy까지 잡아야 한다.
function normSent(s) {
  return (s || '').replace(/\s+/g, '').toLowerCase().replace(/[.!?。,，、'"“”‘’()[\]]/g, '');
}
function bigrams(s) {
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
const FUZZY_SIM = 0.6;       // char-bigram Jaccard 임계(저-FP: 어미·소수 단어만 다른 근접중복만)
const FUZZY_MIN_LEN = 16;    // 정규화 길이 하한(짧은 상투구 오탐 방지)
function measureRepetition(text) {
  const sents = (text || '').split(/(?<=[.!?。])\s+|\n+/).map(s => s.trim())
    .filter(s => s.replace(/\s+/g, '').length >= 15);
  // (1) exact — 정규화 동일 문장 2회+
  const seen = new Map();
  for (const s of sents) {
    const key = normSent(s);
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const repeated = [];
  for (const [, n] of seen) if (n >= 2) repeated.push(n);
  // (2) fuzzy — 서로 다른(정규화) 문장이지만 bigram 유사도 높음(근접중복)
  const keys = [...seen.keys()].filter(k => k.length >= FUZZY_MIN_LEN);
  const grams = keys.map(bigrams);
  let fuzzyCount = 0; const fuzzyPairs = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const sim = jaccard(grams[i], grams[j]);
      if (sim >= FUZZY_SIM) { fuzzyCount++; fuzzyPairs.push(Number(sim.toFixed(2))); }
    }
  }
  // (3) 짧은 조각 반복 — 길이 임계값(15자) 아래라 (1)(2)가 놓치는 인상적 체언종결·도치
  //     조각("투명성이 방패다", "닿지 않는다")이 글 전체에 3회+ 등장하면 카피킬러가 반복으로 잡는다.
  const shortSeen = new Map();
  for (const s of (text || '').split(/(?<=[.!?。])\s+|\n+/).map(x => normSent(x.trim()))) {
    if (s.length >= 4 && s.length < 15) shortSeen.set(s, (shortSeen.get(s) || 0) + 1);
  }
  const shortRepeated = [];
  for (const [, n] of shortSeen) if (n >= 4) shortRepeated.push(n); // 4회+ (전환구 3회 오차단 방지; 카피킬러 과도반복은 4+)
  return {
    count: repeated.length,                                   // exact 그룹 수(하위호환)
    maxRepeat: repeated.length ? Math.max(...repeated) : 1,
    fuzzyCount, fuzzyPairs,
    shortFragCount: shortRepeated.length,
    total: repeated.length + fuzzyCount + shortRepeated.length // 노출 판정용 합산
  };
}

// 1차 결과에서 FLOOR critical 위반만 추출 (surface는 제외 — regression report로 §11).
// ── LLM 산출물 누출 가드(genretransfer에서 이식, 2026-06-11) ──────────
// 메타 메모 누출(실측: "미삽입 항목 처리 메모…밝힙니다"가 본문 끝에 붙어 측정됨)
// ★ 판정 스캐폴딩 누출 추가(2026-06-15 실측): 수리/판정 LLM이 "교정 본문" 대신 판정 마크다운
//   ("# 판정: added_claim 확인됨 … ## 수정 문장: …")을 통째로 반환해 본문에 박히는 사고.
//   added_claim·distortion은 내부 위반 타입명이라 사용자 본문엔 사실상 안 나오는 고정밀 토큰.
//   '판정/근거'는 마크다운 헤더(#) 동반일 때만 매칭해 일반 산문 오탐을 피한다('법적 근거' 등은 정상 본문).
//   ★ 지시어 보강(2026-06-16): 정상 에세이엔 절대 안 나오는 모델 지시어(본문만/머리말 없이/위 규칙·룰·
//     프롬프트/재작성한 칼럼…)만 추가. '판정 근거'를 plain으로 넣으면 오탐이라 제외(헤더 동반만 유지).
// ★ '밝힙니다' 좁힘(2026-06-16): 단독 '밝힙니다'는 "…라고 밝힙니다" 정상 보고문을 오탐(검열 보고서 등).
//   본문/출력/원문대로/지시대로/메모/재작성 같은 메타 단서가 같은 절에 동반될 때만 누출로 판정.
const META_NOTE_RE = /(메모\s*:|(?:본문만?|출력|원문대로|지시대로|메모|재작성[한된])[^.”"]{0,10}밝힙니다|지시에\s*따라|삽입하지\s*않|본문만|머리말\s*(?:없이|금지)|설명\s*없이\s*(?:출력|작성)|위\s*(?:지침|규칙|룰|프롬프트)|요청하신|재작성한?\s*(?:칼럼|글|문단|텍스트)\s*(?:만|을|를|입니다|:)|원장[은는이가]\s|승인(?:된|받은)?\s*근거|added_claim|distortion|claim\s*ledger|\bREWRITE\b|수정\s*문장\s*[:：]|#{1,6}\s*판정|#{1,6}\s*근거|이\s*문장은\s*[^.”"\n]{0,12}근거\s*없|(?:뒷받침|명확한)[^.”"\n]{0,10}출처가?\s*(?:필요|없)|원문이나\s*승인|그\s*질문에\s*답(?:할|하기)?\s*수\s*없|답변(?:을|를)?\s*(?:드릴|할|제공할)\s*수\s*없)/i;
// 지시문 윙크 누출(루틴 v1 실측: "…는 데 있다(아, 이 표현 쓰지 말라고 했지)" — 금지목록을 어기고 프롬프트에
// 사과하는 메타 발화를 필자의 사족 괄호로 위장).
// ★ 좁힘(2026-06-16): 검열·언어정책·글쓰기 조언처럼 "표현 금지/쓰지 말라"가 정상 본문인 글에서 대량 오탐
//   (북한 정보통제 글 → blog가 매번 raw 폴백·무변환 차감). 진짜 윙크만 잡도록 ①지시 대상을 가리키는
//   지시어(이/그/위) + 표현어 + ②"말라고 했지/잖아/네/어"식 1인칭 자기-인정 종결을 모두 요구. 3인칭 보고체
//   ("…쓰지 말라고 교육한다")와 일반 "표현 금지"는 통과.
const WINK_RE = /(?:이런?|그런?|위(?:의)?)\s*(?:표현|단어|문장|말투|어투)[^.”"\n]{0,14}(?:쓰지\s*)?(?:말라고|말랬)\s*했?(?:지|잖아?|네|어)/;
// ★ 메인 엔진은 임의 원문을 받으므로 "원문∪허용재료에 없는 경우만" 누출로 판정(원문이 원래 "밝힙니다"를
//   쓰는 격식문·메타 글쓰기 에세이 오탐 방지 — genretransfer의 무조건 폐기와 다른 점).
function findMetaLeaks(text, allowedWorld) {
  const world = (allowedWorld || '').replace(/\s+/g, '');
  const bad = [];
  for (const re of [META_NOTE_RE, WINK_RE]) {
    for (const m of (text || '').matchAll(new RegExp(re.source, 'g'))) {
      if (!world.includes(m[0].replace(/\s+/g, ''))) bad.push(m[0]);
    }
  }
  return [...new Set(bad)];
}
// 용어귀속 날조 가드(루틴 v1 실측: "심리학 쪽에서는 '정-반 효과'라고 부르기도 한다" — 실재하지 않는 용어를
// 학문에 귀속). novelty는 기관·수치 패턴만 보므로 일반명사 합성 용어는 통과, judge도 확률적으로 놓침(1회 실측).
// 결정론 규칙: 따옴표 용어 + "~라고 부른다" 귀속문이면 그 용어가 원문∪허용재료에 실재해야 한다.
function findCoinedTerms(text, allowedWorld) {
  const bare = (allowedWorld || '').replace(/\s+/g, '');
  const bad = [];
  for (const m of (text || '').matchAll(/['‘"「]([^'’"」\n]{2,20})['’"」]\s*(?:이?라고?|이?라)\s*부르/g)) {
    if (!bare.includes(m[1].replace(/\s+/g, ''))) bad.push(m[1]);
  }
  return bad;
}

function collectFloorViolations({ result, rawText, povSeed, optIn, mode, position = 'whole', chunkLevel = false, allowedExtra = '', anchors = false }) {
  const out = result?.outputText || '';
  const v = [];

  const nov = measureNovelty(rawText, out, allowedExtra);
  if (nov.count >= 1) {
    v.push({ type: 'novelty', detail: nov.items.join(', '),
      fix: `입력 글에 없는 통계·연도(YYYY)·기관명·% 수치를 모두 제거하고 원문에 있던 표현으로 되돌려라: ${nov.items.join(', ')}` });
  }

  const drift = measurePovDrift(rawText, out, povSeed);
  // 개인 화자(I/저/제가) 신규 주입 = 위반(조직 we 문서에 I 추가도 포함). opt-in이면 허용.
  // ★ 과제 자연체(FORMAL_HUMAN, 격식 모드): 필자 1인칭 *판단* 허용 → pov 위반에서 제외. 단 개인 일화(experience_novelty)는 아래에서 계속 strict 차단.
  const formalHuman = (process.env.FORMAL_HUMAN === '1' || process.env.ASSIGNMENT_B7 === '1') && (mode === 'assignment' || mode === 'thesis');
  if (!optIn && !formalHuman && drift.introducedFirstPerson) {
    v.push({ type: 'pov', detail: `출력 개인 1인칭 ${drift.output_fp_singular}건`,
      fix: '출력에 새로 등장한 개인 1인칭(I/my/저/제가/나/내가)과 개인 일화를 제거하라. 원문이 조직(we/우리) 화자면 그 시점을 유지하고, 비인칭이면 비인칭을 유지하라. 원문엔 개인 1인칭이 없었다.' });
  }

  if (mode === 'thesis') {
    const fake = measureFakeInternalRefs(rawText, out);
    if (fake.count >= 1) {
      v.push({ type: 'fake_ref', detail: fake.fabricated.join(', '),
        fix: `원문에 없는 내부참조·인용(Table/Eq/그림/§/(저자, 연도)/p값)을 모두 삭제하라. 논문 구조를 지어내지 마라: ${fake.fabricated.join(', ')}` });
    }
  }

  // 과확장(hardMax 초과) = FLOOR 위반 → shrink repair(늘리기 아닌 절삭).
  const len = measureLength(rawText, out, mode);
  if (len.status === 'overHard') {
    v.push({ type: 'length_overrun', detail: `${(len.ratio * 100).toFixed(0)}% (상한 ${Math.round(len.policy.hardMax * 100)}%)`,
      fix: `출력이 원문 대비 ${(len.ratio * 100).toFixed(0)}%로 과확장됐다. 원문에 없는 부연·예시·감정·수치·내부참조·반복 설명을 삭제해 전체 길이를 원문 대비 ${Math.round(len.policy.max * 100)}% 이하로 줄여라. 원문의 핵심 주장·숫자·고유명사·인용은 보존. 새 정보 추가·결론 새로 쓰기 금지(절삭만).` });
  }
  // 과압축(min 미만) = 정보 손실 → 복원 repair(새 내용 금지, 원문에 실제 있던 것만).
  // ★ 청크 레벨에선 length_short를 잡지 않음(§리뷰#18): 개별 청크 분량은 자연히 출렁이고,
  //   진짜 정보손실은 병합 전체(whole) 검사에서 잡는다. 청크마다 short를 올리면 불필요한 repair·raw폴백 유발.
  if (len.status === 'short' && !chunkLevel) {
    v.push({ type: 'length_short', detail: `${(len.ratio * 100).toFixed(0)}% (하한 ${Math.round(len.policy.min * 100)}%)`,
      fix: `출력이 원문 대비 ${(len.ratio * 100).toFixed(0)}%로 너무 짧아 핵심 정보가 누락됐다. 원문에 실제로 존재하는 누락 claim·문단만 복원하라. 원문에 없는 예시·경험·감정·미래전망·수치·기관명은 절대 추가하지 마라.` });
  }
  // 사실 증발 (숫자 증발 §3.1)
  const lost = measureLostFacts(rawText, out);
  if (lost.count >= 1) {
    v.push({ type: 'lost_facts', detail: lost.items.join(', '),
      fix: `원문에 있던 사실이 출력에서 사라졌다: ${lost.items.join(', ')}. 원문대로 복원하라(새 사실 추가 금지).` });
  }
  // ★ 개인 경험 날조 (§v4): 원문·메모에 없는 1인칭 일화를 지어냈다 — hard novelty가 못 잡는 경험 날조.
  const expNov = require('./surfaceguard').measurePersonalExperienceNovelty(rawText, out, allowedExtra);
  if (expNov.count >= 1) {
    v.push({ type: 'experience_novelty', detail: expNov.items.join(' | '),
      fix: `원문에도 사용자 경험 메모에도 없는 개인 일화를 지어냈다: ${expNov.items.join(' | ')}. 그 일화를 삭제하고, 원문이나 메모에 실제로 있는 내용만 써라(없는 경험 생성 금지).` });
  }
  // 메모 재사용 (§v4): 같은 경험 메모를 여러 곳에 반복 위빙
  if (allowedExtra) {
    const reuse = require('./surfaceguard').measureMemoReuse(out, allowedExtra, rawText);
    if (reuse.count >= 1) {
      v.push({ type: 'memo_reuse', detail: reuse.items.map(r => `${r.memo}×${r.count}`).join(', '),
        fix: `같은 경험 메모가 여러 문단에 반복됐다. 각 경험은 가장 잘 맞는 한 문단에만 한 번 쓰고 나머지는 제거하라.` });
    }
  }
  // 결론/CTA 반복 (exact + 근접중복)
  const rep = measureRepetition(out);
  if (rep.total >= 1) {
    v.push({ type: 'repetition', detail: `완전중복 ${rep.count}건·근접중복 ${rep.fuzzyCount}건·짧은조각 ${rep.shortFragCount || 0}건`,
      fix: `같은 결론·문장이 (어미·표현만 바꿔) 반복된다. 의미가 겹치는 문장을 하나로 합치고, 같은 짧은 조각·체언종결("…방패다" 등)을 여러 번 재사용하지 말고 한 번만 써라.` });
  }
  // ★ LLM 산출물 누출 3종(genretransfer 이식): 메타 메모·지시문 윙크 / 용어귀속 날조 / 앵커 소재 번짐.
  //   기존 refine→재검증→raw폴백 기계에 그대로 태운다(fix 지시문 포함).
  const allowedWorld = allowedExtra ? rawText + '\n' + allowedExtra : rawText;
  const metaLeaks = findMetaLeaks(out, allowedWorld);
  if (metaLeaks.length) {
    v.push({ type: 'meta_leak', detail: metaLeaks.join(' | '),
      fix: `지시문에 대한 메타 발화·작업 메모가 본문에 누출됐다: ${metaLeaks.join(' | ')}. 해당 문장·괄호를 삭제하라(본문 내용만 남길 것).` });
  }
  const coined = findCoinedTerms(out, allowedWorld);
  if (coined.length) {
    v.push({ type: 'coined_term', detail: coined.join(', '),
      fix: `원문에 없는 용어를 만들어 학문·분야에 귀속시켰다: ${coined.join(', ')}. 그 용어와 귀속문("~라고 부른다")을 삭제하고 원문 표현으로 되돌려라.` });
  }
  if (anchors) {
    const anchorLeaks = require('./prompt').findAnchorLeaks(out, allowedWorld);
    if (anchorLeaks.length) {
      v.push({ type: 'anchor_leak', detail: anchorLeaks.join(', '),
        fix: `원문에 없는 부동산·도시 소재 어휘가 비유로 끼어들었다: ${anchorLeaks.join(', ')}. 해당 비유·문장을 삭제하고 글의 실제 소재로만 써라.` });
    }
  }
  // ※ 결론부 drift는 여기서 하드 위반으로 잡지 않는다(§우회): 열린·여운 마무리는 우회 기법이라 허용.
  //   결정론 conclusion_drift는 judge 트리거로만 쓰고(analyze.js), 진짜 "결론 의도 역전"은 semanticJudge가 차단.
  return v;
}

// floorReport 조립 — 측정값을 criticals/warnings로 분류하고 status 결정(노출 게이트의 단일 판정, §E.3).
function buildFloorReport({ result, rawText, mode, povSeed, optIn, allowedExtra = '', anchors = false }) {
  const out = result?.outputText || '';
  const criticals = [], warnings = [];
  const nov = result.floorNovelty || measureNovelty(rawText, out, allowedExtra);
  const lost = result.lostFacts || measureLostFacts(rawText, out);
  const len = result.floorLength || measureLength(rawText, out, mode);
  const rep = result.repetition || measureRepetition(out);
  const drift = result.povDrift || measurePovDrift(rawText, out, povSeed);
  const concl = require('./softguard').measureConclusionDrift(rawText, out);
  // ★ 영어 입력 FLOOR 세이프(2026-06-16): 한국어용 novelty/experience 추출기가 영어 Title-Case 다단어 런
  //   ("Company Primary Leaders Leadership Style Core Mechanism" 같은 표 헤더 등)을 재배열 후 못 맞춰 대량 오탐
  //   → 영어 글이 다듬기/blog에서 매번 차단(실측 차단 10건 중 6건). 영어는 한국어 게이트로 내용검증이 불가하므로
  //   novelty·experience를 '경고'로 내리고 전달한다. ※영어 humanize는 TONE_EN으로 정상 동작 — 게이트만 오탐.
  //   한국어 글의 날조 차단(novelty 하드)은 그대로 유지된다.
  const _rawHangul = (rawText.match(/[가-힣]/g) || []).length;
  const _rawLetters = (rawText.match(/[A-Za-z가-힣]/g) || []).length || 1;
  const englishInput = _rawLetters >= 200 && _rawHangul / _rawLetters < 0.15;

  if (nov.count) (englishInput ? warnings : criticals).push({ gate: 'novelty', detail: nov.items.join(', ') });
  // ★ lostFacts 소프트화(2026-06-16): 재구성(formal)은 이미 "누락=경고+전달"인데 청크 경로(blog/다듬기)만 하드라
  //   26K 논문이 숫자 1건("1,235만") 누락에 차단되던 불일치를 제거. 누락은 경고로 노출하고 전달한다(청크별 폴백이
  //   사실을 이미 최대 보존). 날조(novelty)는 하드 차단 유지 — 없는 사실을 지어내는 건 절대 금지.
  if (lost.count) warnings.push({ gate: 'lostFacts', detail: lost.items.join(', ') });
  const expNov = require('./surfaceguard').measurePersonalExperienceNovelty(rawText, out, allowedExtra);
  if (expNov.count) (englishInput ? warnings : criticals).push({ gate: 'experience_novelty', detail: expNov.items.join(' | ') });
  if (allowedExtra) { const reuse = require('./surfaceguard').measureMemoReuse(out, allowedExtra, rawText); if (reuse.count) criticals.push({ gate: 'memo_reuse', detail: reuse.items.map(r => `${r.memo}×${r.count}`).join(', ') }); }
  // length_short 단독(사실 손실 없음)은 차단하지 않고 경고로만 노출 — 진짜 정보손실은 lostFacts가 잡는다.
  //   "결과가 줄어들면서 막힘"이 환불 민원이 되던 케이스를 완화(요약처럼 짧아져도 사실 보존이면 전달).
  // length_short는 lostFacts가 소프트가 됐으므로 항상 경고(사실 보존 우선 — 짧아져도 전달, 누락은 lostFacts 경고로 노출).
  if (len.status === 'short') warnings.push({ gate: 'length_short', detail: len.ratio });
  if (len.status === 'overHard') criticals.push({ gate: 'length_overrun', detail: len.ratio });
  // ★ 과제 자연체(FORMAL_HUMAN, 격식): 필자 1인칭 판단 허용 → pov_inject 제외(experience_novelty=일화는 위에서 계속 critical).
  const _fhReport = (process.env.FORMAL_HUMAN === '1' || process.env.ASSIGNMENT_B7 === '1') && (mode === 'assignment' || mode === 'thesis');
  if (!optIn && !_fhReport && drift.introducedFirstPerson) criticals.push({ gate: 'pov_inject', detail: drift.output_fp_singular });
  // ★ 반복 소프트화(2026-06-16): 단일 정확중복(exact≤1·fuzzy≤2)은 26K 장문에서 사소하다 → 경고. 기계적 반복(다수)만
  //   하드 차단(AI 신호). 26K 논문이 exact 1건에 차단되던 케이스(#6) 완화.
  if (rep.total) {
    if (rep.count >= 2 || rep.fuzzyCount >= 3) criticals.push({ gate: 'repetition', detail: `exact ${rep.count}·fuzzy ${rep.fuzzyCount}` });
    else warnings.push({ gate: 'repetition', detail: `exact ${rep.count}·fuzzy ${rep.fuzzyCount}` });
  }
  // 결론부 drift는 critical 아님(§우회: 열린 마무리 허용) — 경고로만 노출하고, 의도 역전은 semanticJudge가 차단.
  if (concl.flagged) warnings.push({ gate: 'conclusion_drift', detail: concl.markers.join(', ') });
  if (mode === 'thesis') { const fake = measureFakeInternalRefs(rawText, out); if (fake.count) criticals.push({ gate: 'fake_ref', detail: fake.fabricated.join(', ') }); }
  if (result.judge && result.judge.ran && result.judge.pass === false) criticals.push({ gate: 'semanticJudge', detail: (result.judge.violations || []).length + '건' });
  // ★ LLM 산출물 누출 3종(이식): 조용한 누출 → 차단(노출 게이트 원칙).
  {
    const allowedWorld = allowedExtra ? rawText + '\n' + allowedExtra : rawText;
    const metaLeaks = findMetaLeaks(out, allowedWorld);
    if (metaLeaks.length) criticals.push({ gate: 'meta_leak', detail: metaLeaks.join(' | ') });
    const coined = findCoinedTerms(out, allowedWorld);
    if (coined.length) criticals.push({ gate: 'coined_term', detail: coined.join(', ') });
    if (anchors) {
      const anchorLeaks = require('./prompt').findAnchorLeaks(out, allowedWorld);
      if (anchorLeaks.length) criticals.push({ gate: 'anchor_leak', detail: anchorLeaks.join(', ') });
    }
  }

  if (len.status === 'overSoft') warnings.push({ gate: 'length_overSoft', detail: len.ratio });
  if (drift.droppedFirstPerson) warnings.push({ gate: 'pov_dropped', detail: `${drift.input_fp_singular}→0` });
  // judge가 돌았지만 원장이 약해(LEDGER_TOO_WEAK) 의미판정 신뢰도 낮음 → 경고로 노출(§리뷰#6).
  if (result.judge && result.judge.ran && result.judge.ledgerHealth && !result.judge.ledgerHealth.healthy) {
    warnings.push({ gate: 'judge_weak_ledger', detail: result.judge.ledgerHealth.reason });
  }

  // ★ P1-2(2026-06-18 감사): 사실 누락이 많으면 'clean'으로 내보내지 않는다. 과제/논문에서 사실 누락은 품질
  //   실패라, 차단까진 아니어도 clean과 구분해 'needs_review'로 라벨한다(UI·관리자 로그에서 "일부 사실 빠짐"
  //   노출용). downstream은 'blocked'만 차단 체크하므로 needs_review는 결과 전달엔 영향 없음(라벨만).
  let status = criticals.length ? 'blocked' : 'clean';
  if (status === 'clean' && (mode === 'assignment' || mode === 'thesis') && lost.count >= 3) {
    status = 'needs_review';
  }
  return {
    status, criticals, warnings,
    metrics: { lengthRatio: len.ratio, novelty: nov.count, lostFacts: lost.count, repetition: rep.total,
      povInject: !!(drift.introducedFirstPerson && isSpeakerGateClosed(povSeed, optIn)), conclusionDrift: concl.flagged,
      judge: result.judge ? (result.judge.ran ? (result.judge.pass ? 'pass' : 'fail') : 'skip') : null }
  };
}

function floorFixText(v, lang = 'ko') {
  if (lang !== 'en') return v.fix || '';
  const detail = v.detail ? ` Detail: ${v.detail}` : '';
  const common = 'Change only the violating part. Keep the rest of the previous output unchanged.';
  const map = {
    novelty: `Remove every statistic, year, organization, proper noun, or factual detail that is not present in the source.${detail}`,
    pov: `Remove any newly introduced first-person speaker, personal anecdote, or feeling. Preserve the source viewpoint.${detail}`,
    fake_ref: `Delete any citation, table, figure, equation, section reference, author-year reference, or p-value that is not in the source.${detail}`,
    length_overrun: `The output is too long. Cut only unsupported padding, examples, feelings, repeated explanation, or invented context while preserving source facts and claims.${detail}`,
    length_short: `The output is too short. Restore missing claims, details, and examples from the source only. Do not copy whole source sentences verbatim and do not add new information.${detail}`,
    lost_facts: `Restore the source facts that disappeared from the output. Do not add facts beyond the source.${detail}`,
    experience_novelty: `Remove personal experience or anecdote not present in the source or allowed notes.${detail}`,
    memo_reuse: `Reduce repeated use of the same user-provided note. Use each allowed experience only where it naturally fits.${detail}`,
    repetition: `Remove exact or near repetition without deleting source information.${detail}`,
    meta_leak: `Remove meta text, prompt labels, bracketed instructions, or commentary about rewriting.${detail}`,
    coined_term: `Remove or rephrase any coined term attributed to a field/group unless the term appears in the source.${detail}`,
    anchor_leak: `Remove any leaked style-anchor subject matter that is not present in the source.${detail}`
  };
  return `${map[v.type] || `Fix the ${v.type} violation using only source information.${detail}`} ${common}`;
}

function buildFloorRefineUser(humanizeText, prevOutput, violations, lang = 'ko') {
  const lines = violations.map((x, i) => `${i + 1}. [${x.type}] ${floorFixText(x, lang)}`).join('\n');
  if (lang === 'en') {
    return `[SOURCE TEXT]\n${humanizeText}\n\n[PREVIOUS OUTPUT]\n${prevOutput}\n\n[FLOOR VIOLATIONS — fix these only; keep all other sentences unchanged]\n${lines}\n\nFix only the listed FLOOR violations. Do not invent facts, first-person voice, anecdotes, citations, paper structure, statistics, years, organizations, or proper nouns. Use only information that exists in the source. Output the full revised body text only.`;
  }
  return `[원본 텍스트]\n${humanizeText}\n\n[이전 출력]\n${prevOutput}\n\n[FLOOR 위반 — 반드시 수정, 그 외 문장은 그대로 유지]\n${lines}\n\n위 FLOOR 위반만 고쳐라. 새 사실·새 1인칭·새 일화·새 논문구조를 만들지 마라. 원문에 있는 내용만으로 다시 써라.`;
}

// 표면 시그널(Optimization Target) — refine 게이트가 아니라 regression report로만 노출(§11).
function collectSurfaceReport(result) {
  const r = result || {};
  return {
    listOfThree: r.listOfThreeCount,
    questions: r.questionSentenceCount,
    commaClauseRatio: r.commaClauseRatio,
    passiveRatio: r.passiveVoiceRatio,
    longSentenceRatio: r.longSentenceRatio,
    abstractRatio: r.abstractStatementRatio,
    interSentenceConnector: r.interSentenceConnectorRatio,
    sameEndingRun: r.sameEndingRun,
    hedgeRatio: r.hedgeRatio,
    topNounMax: r.topNounCounts ? Math.max(0, ...Object.values(r.topNounCounts)) : 0
  };
}

// ── 모델 거부 탐지 (★ 안전망) ──────────────────────────────
// 모델이 청크 재작성을 거부하면("도와드릴 수 없는 요청…", "탐지기 우회는 지원 안 함") 그 거부 문구가
// 출력에 박혀 글을 망친다(실제 카피킬러 결과에서 제목이 거부문으로 대체된 사고). 정상 에세이 본문엔
// 거의 안 나오는 *메타 거부* 표현만 고정밀로 잡아 호출부에서 실패 처리(재시도→raw 폴백)한다.
const REFUSAL_RE = /도와드릴 수 없|도와드리기?\s*(어렵|힘들|곤란)|도와줄 수 없|제공(해\s*드릴|할)\s*수\s*없는\s*요청|할 수 없는 요청|요청을?\s*(수행|처리|도와)\S*\s*수\s*없|탐지\s*기?\s*(우회|회피)|우회\s*(작업|를?\s*도|을?\s*도|는?\s*지원)|지원하지\s*않는\s*(작업|요청|서비스|기능)|(?:죄송하지만|미안하지만)[^.]{0,30}(없|어렵|않|곤란)|\bI'?m sorry\b|\bI can'?t (help|assist|do)|\bI (cannot|can ?not) (help|assist|comply)|\bI'?m unable to|\bI won'?t be able/i;
// 메타 혼란 응답(재작성이 아니라 프롬프트 구조·입력에 대해 불평) — 정상 글엔 안 나오는 표현.
const META_RE = /\[(원본|이전|재작성|원문|입력)[^\]]{0,10}\]|(원문|입력|원본)\s*(텍스트|내용|글)?\s*(가|이)?\s*(빠져\s*있|비어\s*있|누락|보이지\s*않|없(어요|습니다|네요|고|는데))|항목에\s*(실제\s*)?내용이\s*없|제공(되지\s*않았|이\s*안\s*(되었|됐))/;
function looksLikeRefusal(text) {
  const head = (text || '').slice(0, 400); // 거부·메타 혼란은 보통 응답 맨 앞
  return REFUSAL_RE.test(head) || META_RE.test(head);
}

// ★ 절단 생성 감지(2026-06-22 #209·#217): LLM이 stop_reason=max_tokens 없이도 문장 중간에 멈추는 경우가 있다.
//   텍스트가 종결부호·닫음·URL·숫자·한국어 종결어미로 끝나지 '않으면' 미완(절단)으로 본다. 보수적 — 완결 신호가
//   하나라도 있으면 false. 청크 단위로 "입력 완결 ∧ 출력 절단"이면 생성이 잘린 것 → 재시도/raw 폴백으로 복구.
function endsTruncated(text) {
  const t = (text || '').trim();
  if (t.length < 15) return false;                                  // 너무 짧으면 판정 보류
  if (/[.!?…。！？”’"'》〉」』\)\]]\s*$/.test(t)) return false;       // 종결부호·닫는 따옴표/괄호
  if (/https?:\/\/\S+$/.test(t)) return false;                      // URL로 끝(참고문헌)
  if (/[\d%）)\]]\s*$/.test(t)) return false;                        // 숫자·퍼센트·닫음
  if (/[A-Za-z][.!?]\s*$/.test(t)) return false;                    // 영문 문장 종결
  if (/(니다|습니다|세요|에요|예요|다|요|죠|까|네|함|됨|임|음|오|소|세|군|구나|라|자)\s*$/.test(t)) return false;   // 한국어 종결어미(마침표 생략 흔함)
  return true;                                                       // 완결 신호 전무 = 미완(절단) 가능성
}

// ★ 미완 꼬리 트림(2026-06-22 #209): 문장 중간에 끝난 텍스트를 '마지막 완결 경계'까지 잘라 완결을 보장.
//   끊긴 조각(완전한 정보가 없는 미완 단어들)만 제거. 60% 미만으로 줄면 과손실로 보고 원본 유지(다른 경로가 처리).
//   LLM 무사용·무날조 — 결정론. 절단 아님(endsTruncated=false)이면 그대로 반환.
function trimToLastComplete(text) {
  const t = String(text || '').replace(/\s+$/, '');
  if (!endsTruncated(t)) return text;
  let last = -1, m;
  const re = /[.!?…。](?=\s|$|["”’」』)\]])|(?:니다|습니다|다|요|죠|까|음|함|됨|임)(?=\s|$)/g;
  while ((m = re.exec(t))) last = m.index + m[0].length;
  if (last >= 0 && last >= t.length * 0.6) return t.slice(0, last).replace(/\s+$/, '');
  return text;   // 완결 경계가 너무 앞(과트림 위험) → 원본 유지
}

module.exports = {
  computePovSeed,
  isSpeakerGateClosed,
  buildFloorDirective,
  gateFailedFields,
  looksLikeRefusal,
  endsTruncated,
  trimToLastComplete,
  measurePovDrift,
  measureNovelty,
  measureLostFacts,
  measureFakeInternalRefs,
  measureLength,
  measureRepetition,
  LENGTH_POLICY,
  collectFloorViolations,
  buildFloorReport,
  buildFloorRefineUser,
  collectSurfaceReport,
  META_NOTE_RE,
  WINK_RE,
  findMetaLeaks,
  findCoinedTerms,
  extractFacts,   // B2b 골든 코퍼스 측정용(테스트). 런타임 동작 영향 없음.
  factKey
};
