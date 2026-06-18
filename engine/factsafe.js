// [engine/factsafe.js] 사실 자리표시자(placeholder) 보호 — 설계 D 구현(2026-06-15)
// ────────────────────────────────────────────────────────────────
// 재구성(자유 칼럼화)이 7K+ 격식논문의 흩어진 연도·수치를 떨구거나(2023 누락) 바꾸는(2023→2022) 걸 원천 차단.
//   생성 전:  원문의 hard fact(연도·연도범위·%·금액·법령번호·숫자+단위)를 ⟦F0⟧… 토큰으로 가린다(값은 map에 보관).
//             LLM은 토큰의 값을 바꿀 수 없고(=distortion 불가), 토큰은 일반 숫자보다 더 잘 보존된다(=lostFacts↓).
//   생성 후:  토큰을 원래 값으로 복원 → 값 정확성 100% 보장. 떨궈진 토큰=누락(lostFacts가 잡고 weaveLost가 복구).
// 슬롯 생성 재료(srcText·claim·evidence)에만 적용하고, 병합 직후 복원해 judge·게이트는 실제 값으로 본다.

// 보호 대상 패턴(긴 것 우선 — 연도범위가 단일 연도보다 먼저 잡혀야 함).
const FACT_PATTERNS = [
  /제\s?\d[\d,]*\s?호/g,                                       // 법령/조 번호: 제21065호
  /(?:19|20)\d{2}\s*[~\-–—]\s*(?:(?:19|20)\d{2}|\d{2})\s*년?/g, // 연도 범위: 2020~2022년
  /(?<!제\d*)\d[\d,]*\s*(?:천|만|억|조)\s*(?:원|명|개|건|배|자|장|권|회)?/g,  // 만/억 금액·수량: 255만 명, 5천원 (제16조~제32조 등 조문번호 제외)
  /\d[\d,]*(?:\.\d+)?\s*(?:%|％|퍼센트)/g,                      // 퍼센트: 40%
  /(?:19|20)\d{2}/g,                                           // 연도: 2023
  /\d[\d,]*(?:\.\d+)?\s*(?:회|분|시간|초|명|개|건|곳|배|점|원|달러|일|개월|km|kg|세|살)/g, // 숫자+단위
];

// 원문에서 hard fact를 추출해 "값→토큰" 맵을 만든다. 같은 값은 같은 토큰(복원 일관).
function buildFactMap(rawText) {
  const t = rawText || '';
  const spans = [];
  for (const re of FACT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) { if (m[0] && m[0].trim()) spans.push({ s: m.index, e: m.index + m[0].length, t: m[0].trim() }); }
  }
  spans.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));   // 시작 오름차순, 길이 내림차순
  const chosen = [];
  let lastEnd = -1;
  for (const sp of spans) { if (sp.s >= lastEnd) { chosen.push(sp); lastEnd = sp.e; } }   // 겹침 제거(긴 것 우선)
  const map = {};       // 토큰 → 원래 값
  const valToTok = {};  // 값 → 토큰
  let n = 0;
  // ★ 토큰은 글자 기반(⟦Faa⟧·⟦Fab⟧) — 숫자를 넣으면 _numToks·수치 정규식이 토큰 내부 숫자를 사실로 오인한다.
  const tokOf = (i) => '⟦F' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)) + '⟧';
  for (const sp of chosen) {
    if (!(sp.t in valToTok)) { const tok = tokOf(n++); valToTok[sp.t] = tok; map[tok] = sp.t; }
  }
  return { map, count: Object.keys(map).length };
}

// 주어진 텍스트에서 map의 값들을 토큰으로 치환(긴 값부터 — 부분겹침 방지).
function mask(text, factMap) {
  if (!factMap || !factMap.count) return text || '';
  const vals = Object.entries(factMap.map).sort((a, b) => b[1].length - a[1].length);
  let out = String(text || '');
  for (const [tok, val] of vals) out = out.split(val).join(tok);
  return out;
}

// 토큰을 원래 값으로 복원.
function restore(text, factMap) {
  if (!factMap || !factMap.count) return text || '';
  let out = String(text || '');
  // ★복원 견고화(2026-06-18): LLM이 토큰에 공백·대문자를 섞어(⟦ Fab ⟧, ⟦FAB⟧) 정확 매칭이 깨지면
  //   숫자가 그대로 삭제되던 버그(15.7%→삭제) 방지 — 토큰을 정규형(⟦Fxx⟧)으로 먼저 정규화.
  out = out.replace(/⟦\s*F\s*([A-Za-z])\s*([A-Za-z])\s*⟧/g, (_m, a, b) => '⟦F' + a.toLowerCase() + b.toLowerCase() + '⟧');
  for (const [tok, val] of Object.entries(factMap.map)) out = out.split(tok).join(val);
  return out;
}

// 출력에 남아있는/빠진 토큰 분석(누락 검출용).
function placeholdersIn(text) { return (String(text || '').match(/⟦F[a-z]{2}⟧/g) || []); }

module.exports = { buildFactMap, mask, restore, placeholdersIn };
