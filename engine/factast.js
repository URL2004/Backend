// [engine/factast.js] 타입 사실 정규화 — 부호·한국식 복합수량·단위를 단일 진실 소스로 (Phase B, 2026-06-19 감사)
// ────────────────────────────────────────────────────────────────
// 기존 사실 비교가 여러 모듈의 서로 다른 정규화 규칙에 흩어져
// 부호·한국식수량을 다르게(혹은 틀리게) 다루던 문제를 통합한다. 감사 실재현 3종:
//   (a) 부호 반전 미탐: "-0.68"·"0.68"이 같은 키 → 의미 역전을 novelty/lostFacts가 못 잡음.
//   (b) 동치 오탐: floor.factKey가 "1만5천"을 누적 못 해(만 치환→"100005천"→천 치환→"100005000") "15,000"과 다른 키.
//   (c) 676 placeholder 깨짐: factsafe.tokOf(i)가 i≥676에서 ⟦F{a⟧(char 123='{')를 만들어 복원 정규식 ⟦F[a-z]{2}⟧ 불일치.
// 이 모듈은 셋을 한 곳에서 고친다. ★의존성 0(Chevrotain·Decimal 불필요 — 핵심 정규화는 정수/문자열로 충분).
// ★ 격리 단계(B1): 어느 곳도 아직 import하지 않는다 — 회귀 위험 0. 배선(B2)은 플래그(FACT_AST) 뒤 골든 A/B 후.
// ★ 하위호환: 기존 단순 케이스("5천"→"5000","1만 자"→"10000자","40%"→"40%","2023"→"2023")는 floor.factKey와
//   같은 출력 → B2 배선 시 단순 케이스 무회귀, 복합·부호만 교정.

// ── 한국식 복합수량 → 정수 (미리아드 누적) ─────────────────────────
//   조(10^12)·억(10^8)·만(10^4)은 '큰 단위'(섹션 경계), 천/백/십은 '작은 단위'(섹션 내부 누적).
//   "1만5천"=1·10^4+5·10^3=15000, "2억3천만"=2·10^8+3000·10^4=230,000,000, "1억2천만"=120,000,000.
const _BIG = { '조': 1e12, '억': 1e8, '만': 1e4 };
const _SMALL = { '천': 1000, '백': 100, '십': 10 };
function koreanAmountToNumber(str) {
  const s = String(str == null ? '' : str).replace(/[,\s]/g, '');
  let total = 0, section = 0, buf = '';
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') { buf += ch; continue; }
    if (_SMALL[ch] != null) { const n = buf ? parseInt(buf, 10) : 1; section += n * _SMALL[ch]; buf = ''; }
    else if (_BIG[ch] != null) { const n = buf ? parseInt(buf, 10) : 0; section += n; total += section * _BIG[ch]; section = 0; buf = ''; }
    else { buf = ''; }   // 단위 아닌 글자(원·명·자 등)는 수량 파싱에서 무시(키 단계에서 별도 보존)
  }
  if (buf) section += parseInt(buf, 10);
  return total + section;
}

// ── 사실 토큰 정규화 키 (floor.factKey 개선 드롭인) ────────────────
//   부호 보존 + 한국식 누적 + 단위 분리. 같은 사실이면 같은 키, 부호/값 다르면 다른 키.
function factKey(s) {
  let str = String(s == null ? '' : s).trim();
  if (!str) return '';
  // 1) 선행 부호 분리(하이픈-마이너스·U+2212·en-dash 단독)
  let sign = '';
  const sm = str.match(/^[-−–]\s*(?=\d)/);   // 부호 뒤가 숫자일 때만(범위 "2020~2022"는 별개)
  if (sm) { sign = '-'; str = str.slice(sm[0].length); }
  str = str.replace(/\s+/g, '');
  // 2) 퍼센트
  const pm = str.match(/^([\d,]+(?:\.\d+)?)(?:%|％|퍼센트)$/);
  if (pm) return sign + pm[1].replace(/,/g, '') + '%';
  // 3) 한국식 복합수량(+선택 단위): 숫자와 조/억/만/천/백/십이 섞인 토큰
  const km = str.match(/^([\d,]*(?:[조억만천백십][\d,]*)+)(.*)$/);
  if (km && /\d/.test(km[1])) {
    return sign + String(koreanAmountToNumber(km[1])) + km[2].toLowerCase();
  }
  // 4) 일반 숫자(+선택 단위): 콤마 제거 정규화 ("10,000자"→"10000자")
  const nm = str.match(/^([\d,]+(?:\.\d+)?)(.*)$/);
  if (nm && /\d/.test(nm[1])) return sign + nm[1].replace(/,/g, '') + nm[2].toLowerCase();
  // 5) 비수치(브랜드·기관·엔티티): 콤마 제거 + 소문자(기존 normTok 호환)
  return sign + str.replace(/,/g, '').toLowerCase();
}

// 두 사실 토큰이 같은 사실인가(부호·동치 인식).
function sameFact(a, b) { return factKey(a) === factKey(b); }

// ── 무제한 placeholder 토큰 (factsafe.tokOf 676 한계 제거) ─────────
//   base-26 소문자, 최소 2글자(정규식 ⟦F[a-z]{2,}⟧ 매칭 보장). i<676은 기존 ⟦Faa⟧~⟦Fzz⟧와 100% 동일,
//   i≥676은 3글자(⟦Fbaa⟧…)로 확장 — '{' 같은 비문자 안 생김.
function tokOf(i) {
  let n = Math.max(0, i | 0), s = '';
  do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } while (n > 0);
  while (s.length < 2) s = 'a' + s;
  return '⟦F' + s + '⟧';   // ⟦F…⟧
}
function placeholdersIn(text) { return (String(text == null ? '' : text).match(/⟦F[a-z]{2,}⟧/g) || []); }

module.exports = { koreanAmountToNumber, factKey, sameFact, tokOf, placeholdersIn };
