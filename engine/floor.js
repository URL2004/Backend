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
  // ★ 앞에 한글 음절이 붙으면 다른 단어의 일부(하"나를", 문"제가", 언"제가", 만"나는")이므로 제외 — lookbehind로 단어 경계 강제.
  const fpSingularRe = /(?<![가-힣])(저는|저의|저도|저를|저에게|저로서|저랑|저와|저한테|제가|제 생각|제 경험|제 친구|제 룸메|내가|나는|나의|나를|내게|나도|나에게)/g;
  const fpPluralRe = /(?<![가-힣])(우리는|우리가|우리의|우리도|저희는|저희가|저희의)/g;
  const orgVoiceRe = /(본\s*보고서|본\s*연구|본\s*글|이\s*글은|이\s*보고서|본고|본\s*논문)/g;
  return {
    fp_singular: (t.match(fpSingularRe) || []).length,
    fp_plural: (t.match(fpPluralRe) || []).length,
    org_voice_likely: (t.match(orgVoiceRe) || []).length > 0
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
    '2) 분량 보존: 원문과 비슷한 길이로 다시 써라(원문의 1.2배를 넘기지 말 것). 없는 디테일·예시·배경설명·"기술적 상식"으로 분량을 늘리지 마라. 구체화는 원문에 이미 있는 내용을 풀어서만 한다.',
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
    introducedFirstPerson: seed.fp_singular === 0 && outSeed.fp_singular > 0
  };
}

// ── 신규 사실 주입 가드 (C26: Hard Ledger 전신, 전 모드) ──────────
// verifyCheckFields의 차집합은 assignment 전용이라, floor는 자체 측정으로 전 모드 커버.
function extractYears(s) { return new Set((s || '').match(/(?:19|20)\d{2}/g) || []); }
function extractPercents(s) {
  return new Set(((s || '').match(/\d+(?:\.\d+)?\s*(?:%|％|퍼센트)/g) || []).map(p => p.replace(/\s+/g, '')));
}
const ORG_RE = /[가-힣]{2,}(?:상공회의소|연구원|공사|협회|재단|위원회|기구|연구소|본부|센터|기관|대학교|학회)/g;
// 숫자+단위 (연도·% 제외 — 위에서 별도 처리). "96회", "300분", "12명", "1,200원" 등.
const NUM_UNIT_RE = /\d[\d,]*(?:\.\d+)?\s*(?:회|분|시간|초|명|개|건|곳|배|위|점|원|달러|엔|위안|유로|일|주|개월|차|등|등급|km|kg|개국|가지|시|살|세|줄|쪽|페이지|문항)/g;
// 라틴 약어(ESM, CUDA, SNS) + 대문자 시작 영단어(Twenge, Cognitive, Method, Test).
const LATIN_ACRONYM_RE = /\b[A-Z]{2,}\b/g;       // ESM, CUDA, SEC — ALLCAPS 약어(영/한 공통, 문장 첫 대문자와 무관)
const LATIN_CAPWORD_RE = /\b[A-Z][a-z]{1,}\b/g;  // 한국어 텍스트의 외래 고유명사(Twenge)용 — 영어엔 미적용(문장 첫 대문자 오탐)
const LATIN_ALLOW = new Set(['AI', 'SNS', 'IT', 'PC', 'TV', 'OK', 'PDF', 'URL', 'CEO', 'GPT', 'LLM', 'API', 'OS', 'CPU', 'GPU']);
const normTok = (s) => s.replace(/\s+/g, '').toLowerCase();

function measureNovelty(rawText, outputText) {
  const inT = rawText || '', outT = outputText || '';
  const items = [];
  const push = (x) => items.push(x);

  // 연도
  const inY = extractYears(inT), outY = extractYears(outT);
  for (const y of outY) if (!inY.has(y)) push(y);
  // %
  const inP = extractPercents(inT), outP = extractPercents(outT);
  for (const p of outP) if (!inP.has(p)) push(p);
  // 한국어 기관·기업 접미사
  const inO = new Set(inT.match(ORG_RE) || []), outO = new Set(outT.match(ORG_RE) || []);
  for (const o of outO) if (!inO.has(o)) push(o);
  // 숫자+단위
  const inN = new Set((inT.match(NUM_UNIT_RE) || []).map(normTok));
  for (const m of (outT.match(NUM_UNIT_RE) || [])) if (!inN.has(normTok(m))) push(m.trim());
  // 라틴 약어/고유명사 — 언어 인지.
  //   한국어 텍스트: 단일 라틴 대문자어도 외래 고유명사로 간주(주입 검출).
  //   영어 텍스트: 문장 첫 대문자(This/So/Finding)가 전부라 단일어는 오탐 → ALLCAPS + 다단어 고유명사 시퀀스만.
  const hasHangul = /[가-힣]/.test(inT + outT);
  const latinOf = (s) => hasHangul
    ? [...(s.match(LATIN_ACRONYM_RE) || []), ...(s.match(LATIN_CAPWORD_RE) || [])]  // 한국어: 외래 고유명사 단일어도 검출
    : [...(s.match(LATIN_ACRONYM_RE) || [])];                                        // 영어: ALLCAPS 약어만(문장 첫 대문자 오탐 회피)
  const inL = new Set(latinOf(inT).map(x => x.toLowerCase()));
  for (const m of latinOf(outT)) {
    if (LATIN_ALLOW.has(m.toUpperCase())) continue;
    if (!inL.has(m.toLowerCase())) push(m);
  }

  const uniq = [...new Set(items)];
  return { items: uniq, count: uniq.length };
}

// ── 분량 과확장 가드 (C18: lengthOverrun — 모드별 정책) ──────────
// thesis는 과확장+허위 디테일 위험이 커 상한이 가장 빡빡. conclusion은 호출부에서 더 조일 수 있음.
const LENGTH_POLICY = {
  thesis:     { min: 0.85, max: 1.20, hardMax: 1.30 },
  assignment: { min: 0.85, max: 1.20, hardMax: 1.30 },
  blog:       { min: 0.85, max: 1.30, hardMax: 1.50 },
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
// 병합된 전체 텍스트에서 동일(정규화) 문장이 2회 이상이면 반복으로 카운트.
function measureRepetition(text) {
  const sents = (text || '').split(/(?<=[.!?。])\s+|\n+/).map(s => s.trim())
    .filter(s => s.replace(/\s+/g, '').length >= 15);
  const seen = new Map();
  for (const s of sents) {
    const key = s.replace(/\s+/g, '').toLowerCase();
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const repeated = [];
  for (const [, n] of seen) if (n >= 2) repeated.push(n);
  return { count: repeated.length, maxRepeat: repeated.length ? Math.max(...repeated) : 1 };
}

// 1차 결과에서 FLOOR critical 위반만 추출 (surface는 제외 — regression report로 §11).
function collectFloorViolations({ result, rawText, povSeed, optIn, mode }) {
  const out = result?.outputText || '';
  const v = [];

  const nov = measureNovelty(rawText, out);
  if (nov.count >= 1) {
    v.push({ type: 'novelty', detail: nov.items.join(', '),
      fix: `입력 글에 없는 통계·연도(YYYY)·기관명·% 수치를 모두 제거하고 원문에 있던 표현으로 되돌려라: ${nov.items.join(', ')}` });
  }

  const drift = measurePovDrift(rawText, out, povSeed);
  if (isSpeakerGateClosed(povSeed, optIn) && drift.introducedFirstPerson) {
    v.push({ type: 'pov', detail: `출력 1인칭 ${drift.output_fp_singular}건`,
      fix: '출력에 새로 등장한 1인칭(저/제가/나/내가)과 개인 일화를 모두 제거하고, 원문의 비인칭·일반 서술 시점으로 되돌려라. 원문에는 1인칭이 전혀 없었다.' });
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
  return v;
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

module.exports = {
  computePovSeed,
  isSpeakerGateClosed,
  buildFloorDirective,
  gateFailedFields,
  measurePovDrift,
  measureNovelty,
  measureFakeInternalRefs,
  measureLength,
  measureRepetition,
  collectFloorViolations,
  buildFloorRefineUser,
  collectSurfaceReport
};
