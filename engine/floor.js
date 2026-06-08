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
    '1) 신규 사실 금지: 원문에 없는 통계·연도·기관명·고유명사·수치, 그리고 논문 내부참조(Table/Eq/그림/§)·인용((저자, 연도))·p값을 새로 지어내지 마라.',
    '2) 분량 보존: 원문과 비슷한 길이로 다시 써라(원문의 0.85~1.2배 유지). 없는 디테일·예시·배경설명·"기술적 상식"으로 분량을 늘리지 말고, 동시에 원문의 핵심 내용·항목·문단을 빠뜨려 과도하게 압축하지도 마라(문단 통째 삭제 금지). 구체화는 원문에 이미 있는 내용을 풀어서만 한다.',
    '※ 이 지시는 아래 모드 규칙의 "디테일 보강 / 분량 늘리기 / 빠진 내용 채우기 / 70% 구체성 / 내부참조 삽입" 지시보다 우선한다.'
  ].join('\n'));
  if (isSpeakerGateClosed(povSeed, optIn)) {
    blocks.push([
      '[화자 보존]',
      '원문에 1인칭 화자(저/제가/나/내가)가 전혀 없다. 새 1인칭 화자나 "제가 작년 학기에 ~한 적이 있다" 같은 개인 경험·일화를 만들지 마라. 원문의 비인칭·일반 서술 시점을 그대로 유지한다. 이 지시는 모드 규칙의 "1인칭 일화 추가/교체"보다 우선한다.'
    ].join('\n'));
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
const NUM_UNIT_RE = /\d[\d,]*(?:\.\d+)?\s*(?:회|분|시간|초|명|개|건|곳|배|위|점|원|달러|엔|위안|유로|일|주|개월|차|등|등급|km|kg|개국|시|살|세|줄|쪽|페이지|문항)/g;
// 한국어 금액/수량 단위 (천/만/억/조). "5천원", "3만", "2억원", "4천~5천원", "5천 자", "30만 자".
const KR_AMOUNT_RE = /\d[\d,]*\s*(?:천|만|억|조)\s*(?:원|명|개|건|배|자|장|권|회|곳|군데|화)?/g;
// 한글 수사 + 단위 ("세 배", "열 명"). '한'은 관형사 충돌로 제외.
const NATIVE_NUM_RE = /(?<![가-힣])(?:두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|스물|서른|마흔|쉰|예순)\s*(?:개|명|번|배|살|마리|권|잔|그루|채|대|장|건|곳|달|해|시간|줄|쪽)/g;
// 단위 없는 소수 (0.42). 연도·% 와 별개.
const DECIMAL_RE = /(?<![\d.])\d+\.\d+(?![\d%％])/g;
// URL / 이메일 / DOI.
const URL_RE = /(?:https?:\/\/[^\s)]+|www\.[^\s)]+|\b10\.\d{4,}\/\S+|[\w.+-]+@[\w-]+\.[\w.-]+)/gi;
// 라틴 약어 + 대문자 영단어.
const LATIN_ACRONYM_RE = /\b[A-Z]{2,}\b/g;
const LATIN_CAPWORD_RE = /\b[A-Z][a-z]{1,}\b/g;
const LATIN_ALLOW = new Set(['AI', 'SNS', 'IT', 'PC', 'TV', 'OK', 'PDF', 'URL', 'CEO', 'GPT', 'LLM', 'API', 'OS', 'CPU', 'GPU']);
// 접미사 없는 주요 브랜드/서비스 — 허용리스트로 명시 검출(인명은 NER 영역이라 제외, judge가 의미로 보완).
const BRANDS = ['카카오', '네이버', '쿠팡', '배달의민족', '배민', '토스', '당근마켓', '당근', '구글', '유튜브', '인스타그램', '페이스북', '트위터', '삼성', '엘지', '현대자동차', '현대', '기아', '애플', '아마존', '넷플릭스', '챗지피티', '오픈에이아이', '마이크로소프트'];
const normTok = (s) => s.replace(/\s+/g, '').toLowerCase();
// 숫자 정규화 포함 비교 키: "5천"↔"5000", "1만 자"↔"10,000자"↔"10000자".
function factKey(s) {
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

// 텍스트의 모든 hard fact 토큰 추출(전 모드 Hard Ledger §7.3). hasHangul로 라틴 처리 분기.
function extractFacts(text, hasHangul) {
  const t = text || '';
  const facts = [];
  for (const y of extractYears(t)) facts.push(y);
  for (const p of extractPercents(t)) facts.push(p);
  for (const o of (t.match(ORG_RE) || [])) facts.push(o);
  for (const m of (t.match(KR_AMOUNT_RE) || [])) facts.push(m.replace(/\s+/g, ''));
  for (const m of (t.match(NUM_UNIT_RE) || [])) facts.push(m.trim());
  for (const m of (t.match(NATIVE_NUM_RE) || [])) facts.push(m.replace(/\s+/g, ' ').trim());
  for (const m of (t.match(DECIMAL_RE) || [])) facts.push(m);
  for (const m of (t.match(URL_RE) || [])) facts.push(m);
  for (const b of BRANDS) if (t.includes(b)) facts.push(b);
  const latin = hasHangul
    ? [...(t.match(LATIN_ACRONYM_RE) || []), ...(t.match(LATIN_CAPWORD_RE) || [])]  // 한국어: 외래 단일어도
    : [...(t.match(LATIN_ACRONYM_RE) || []), ...extractEnEntities(t)];              // 영어: 약어 + Title-Case 엔티티(문장첫 필터)
  for (const m of latin) if (!LATIN_ALLOW.has(m.toUpperCase())) facts.push(m);
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
  blog:       { min: 0.85, max: 1.35, hardMax: 1.55 },
  resume:     { min: 0.90, max: 1.25, hardMax: 1.40 }
};
function measureLength(rawText, outputText, mode) {
  const pol = LENGTH_POLICY[mode] || LENGTH_POLICY.assignment;
  const rawLen = (rawText || '').replace(/\s+/g, '').length;
  const outLen = (outputText || '').replace(/\s+/g, '').length;
  const ratio = rawLen > 0 ? outLen / rawLen : 1;
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
function collectFloorViolations({ result, rawText, povSeed, optIn, mode, position = 'whole', chunkLevel = false, allowedExtra = '' }) {
  const out = result?.outputText || '';
  const v = [];

  const nov = measureNovelty(rawText, out, allowedExtra);
  if (nov.count >= 1) {
    v.push({ type: 'novelty', detail: nov.items.join(', '),
      fix: `입력 글에 없는 통계·연도(YYYY)·기관명·% 수치를 모두 제거하고 원문에 있던 표현으로 되돌려라: ${nov.items.join(', ')}` });
  }

  const drift = measurePovDrift(rawText, out, povSeed);
  // 개인 화자(I/저/제가) 신규 주입 = 위반(조직 we 문서에 I 추가도 포함). opt-in이면 허용.
  if (!optIn && drift.introducedFirstPerson) {
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
    const reuse = require('./surfaceguard').measureMemoReuse(out, allowedExtra);
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
  // ※ 결론부 drift는 여기서 하드 위반으로 잡지 않는다(§우회): 열린·여운 마무리는 우회 기법이라 허용.
  //   결정론 conclusion_drift는 judge 트리거로만 쓰고(analyze.js), 진짜 "결론 의도 역전"은 semanticJudge가 차단.
  return v;
}

// floorReport 조립 — 측정값을 criticals/warnings로 분류하고 status 결정(노출 게이트의 단일 판정, §E.3).
function buildFloorReport({ result, rawText, mode, povSeed, optIn, allowedExtra = '' }) {
  const out = result?.outputText || '';
  const criticals = [], warnings = [];
  const nov = result.floorNovelty || measureNovelty(rawText, out, allowedExtra);
  const lost = result.lostFacts || measureLostFacts(rawText, out);
  const len = result.floorLength || measureLength(rawText, out, mode);
  const rep = result.repetition || measureRepetition(out);
  const drift = result.povDrift || measurePovDrift(rawText, out, povSeed);
  const concl = require('./softguard').measureConclusionDrift(rawText, out);

  if (nov.count) criticals.push({ gate: 'novelty', detail: nov.items.join(', ') });
  if (lost.count) criticals.push({ gate: 'lostFacts', detail: lost.items.join(', ') });
  const expNov = require('./surfaceguard').measurePersonalExperienceNovelty(rawText, out, allowedExtra);
  if (expNov.count) criticals.push({ gate: 'experience_novelty', detail: expNov.items.join(' | ') });
  if (allowedExtra) { const reuse = require('./surfaceguard').measureMemoReuse(out, allowedExtra); if (reuse.count) criticals.push({ gate: 'memo_reuse', detail: reuse.items.map(r => `${r.memo}×${r.count}`).join(', ') }); }
  if (len.status === 'short') criticals.push({ gate: 'length_short', detail: len.ratio });
  if (len.status === 'overHard') criticals.push({ gate: 'length_overrun', detail: len.ratio });
  if (!optIn && drift.introducedFirstPerson) criticals.push({ gate: 'pov_inject', detail: drift.output_fp_singular });
  if (rep.total) criticals.push({ gate: 'repetition', detail: `exact ${rep.count}·fuzzy ${rep.fuzzyCount}` });
  // 결론부 drift는 critical 아님(§우회: 열린 마무리 허용) — 경고로만 노출하고, 의도 역전은 semanticJudge가 차단.
  if (concl.flagged) warnings.push({ gate: 'conclusion_drift', detail: concl.markers.join(', ') });
  if (mode === 'thesis') { const fake = measureFakeInternalRefs(rawText, out); if (fake.count) criticals.push({ gate: 'fake_ref', detail: fake.fabricated.join(', ') }); }
  if (result.judge && result.judge.ran && result.judge.pass === false) criticals.push({ gate: 'semanticJudge', detail: (result.judge.violations || []).length + '건' });

  if (len.status === 'overSoft') warnings.push({ gate: 'length_overSoft', detail: len.ratio });
  if (drift.droppedFirstPerson) warnings.push({ gate: 'pov_dropped', detail: `${drift.input_fp_singular}→0` });
  // judge가 돌았지만 원장이 약해(LEDGER_TOO_WEAK) 의미판정 신뢰도 낮음 → 경고로 노출(§리뷰#6).
  if (result.judge && result.judge.ran && result.judge.ledgerHealth && !result.judge.ledgerHealth.healthy) {
    warnings.push({ gate: 'judge_weak_ledger', detail: result.judge.ledgerHealth.reason });
  }

  const status = criticals.length ? 'blocked' : 'clean';
  return {
    status, criticals, warnings,
    metrics: { lengthRatio: len.ratio, novelty: nov.count, lostFacts: lost.count, repetition: rep.total,
      povInject: !!(drift.introducedFirstPerson && isSpeakerGateClosed(povSeed, optIn)), conclusionDrift: concl.flagged,
      judge: result.judge ? (result.judge.ran ? (result.judge.pass ? 'pass' : 'fail') : 'skip') : null }
  };
}

function buildFloorRefineUser(humanizeText, prevOutput, violations) {
  const lines = violations.map((x, i) => `${i + 1}. [${x.type}] ${x.fix}`).join('\n');
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

module.exports = {
  computePovSeed,
  isSpeakerGateClosed,
  buildFloorDirective,
  gateFailedFields,
  looksLikeRefusal,
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
  collectSurfaceReport
};
