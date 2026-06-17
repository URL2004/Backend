'use strict';
// [engine/copykiller/fidelity-guard.js] 무날조 가드 (P0).
//   출력에 "원문에 없는" 수치·출처·기관·인용·'○○에 따르면' 귀속이 새로 생겼는지 탐지.
//   ※ 차단이 아니라 "탐지"다. 파이프라인이 해당 절만 strip/repair 하도록(stripFabricatedCitations와 동형 철학).
//   재랭커 데모가 실증한 구멍("통계청 생활시간조사에 따르면 … 2.4배")을 막는 게 1차 목표.

// 숫자+단위 토큰 추출. 단위를 함께 묶어 "2.4"(소절 번호)와 "2.4배"(통계)를 구별한다.
//   소절 번호가 통계 수치를 마스킹하던 함정 방지(원문에 "2.4. 사례" 있어도 "2.4배"는 신규로 잡음).
const NUM_RE = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(%|퍼센트|배|명|원|만원|억원|조원|만|억|조|건|개|위|점|년|개월|주|시간|분|초|일|월|차|회|㎡|평|km|cm|kg|도)?/g;
function numberTokens(text) {
  const set = new Set();
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(String(text || '')))) set.add(m[1].replace(/,/g, '') + (m[2] || ''));
  return set;
}
// 하위호환: 단위 무시한 코어 집합
function numberCores(text) {
  const set = new Set();
  for (const t of numberTokens(text)) set.add(t.replace(/[^\d.]/g, ''));
  return set;
}

// "○○ + (에 따르면|발표|자료|조사 결과)" 귀속 표현 — 출처를 끌어다 쓰는 패턴.
// 앞쪽 기관/자료성 명사(청·원·회·연구소·보고서·자료·조사·통계 …)를 캡처.
const ATTR_RE = /([가-힣A-Za-z][가-힣A-Za-z·\d\s]{0,20}?(?:청|원|회|소|단|센터|연구소|연구원|대학교|대학|위원회|학회|보고서|백서|자료|조사|통계|지표|보도))\s*(?:에 따르면|에 의하면|이 발표한|에서 발표한|의 자료에 따르면|조사 결과)/g;

// 흔한 매체/기관 토큰(원문에 없는데 출력에 있으면 신규 출처로 간주)
const ORG_TOKENS = [
  'BBC', 'CNN', 'YTN', 'KBS', 'MBC', 'SBS', '연합뉴스', '로이터', 'Reuters', 'AP통신',
  'WHO', 'WIPO', 'OECD', 'IMF', 'UNESCO', 'UN ', '유엔',
  '통계청', '국토교통부', '보건복지부', '교육부', '기획재정부', '고용노동부', '한국은행',
  '국세청', '대법원', '헌법재판소', '한국개발연구원', 'KDI', 'Stanford', 'MIT', 'Harvard',
];

// (저자, 2023) 형태 인용
const CITE_RE = /\([^()]*?(?:19|20)\d{2}[^()]*?\)/g;

function uniq(a) { return [...new Set(a)]; }

// src(원문) 대비 out(출력)에서 새로 생긴 날조 신호를 반환.
function checkFabrication(src, out) {
  src = String(src || ''); out = String(out || '');
  const srcNums = numberTokens(src);
  const addedNumbers = uniq([...numberTokens(out)].filter(n => !srcNums.has(n) && /[%배명원만억조건개위점년]|시간|개월/.test(n)));

  const attributions = [];
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(out))) {
    const ent = m[1].trim();
    if (ent && !src.includes(ent)) attributions.push(m[0].trim());
  }

  const addedSources = ORG_TOKENS
    .map(t => t.trim())
    .filter(t => out.includes(t) && !src.includes(t));

  const srcCites = new Set(src.match(CITE_RE) || []);
  const addedCitations = uniq((out.match(CITE_RE) || []).filter(c => !srcCites.has(c)));

  const ok = !addedNumbers.length && !attributions.length && !addedSources.length && !addedCitations.length;
  return { ok, addedNumbers, addedSources, attributions, addedCitations };
}

module.exports = { checkFabrication, numberCores };
