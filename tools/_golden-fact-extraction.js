// [tools/_golden-fact-extraction.js] B2b 골든 코퍼스 — 사실 추출 FP 가드 + 의도 수정 스펙
// ────────────────────────────────────────────────────────────────
// 목적: floor 추출 정규식(KR_AMOUNT_RE·NUM_UNIT_RE·DECIMAL_RE·%·years)을 복합 통째/부호 포착으로
//   바꾸기 전, 깨지면 안 되는 FP 가드와 고쳐야 할 의도 케이스를 고정한다.
//   ★ FP 가드는 '지금도 통과·앞으로도 통과'(hard). 의도 수정은 '지금 FAIL → B2b 후 PASS'(현재는 리포트).
//   실행: FACT_AST 플래그 무관하게 floor.extractFacts(현행 추출)을 측정. (factKey 비교는 별도)
const floor = require('../engine/floor');
const assert = require('assert');
const factKey = floor.factKey;
function withFlag(v, fn) { const old = process.env.FACT_AST; if (v) process.env.FACT_AST = '1'; else delete process.env.FACT_AST; try { return fn(); } finally { if (old === undefined) delete process.env.FACT_AST; else process.env.FACT_AST = old; } }
const xf = (t) => floor.extractFacts(t, /[가-힣]/.test(t));
const keys = (t) => xf(t).map(factKey);

let hardPass = 0, hardFail = 0, intentPass = 0, intentFail = 0;
// FP 가드는 flag-off·flag-on 양쪽에서 통과해야(새 추출 경로가 가드를 깨면 안 됨).
function hard(name, fn) {
  try { withFlag(false, fn); withFlag(true, fn); hardPass++; console.log('  ✅[가드 off+on]', name); }
  catch (e) { hardFail++; console.log('  ❌[가드]', name, '\n        ', e.message); }
}
// 의도 수정은 flag-on에서 통과해야(B2b 구현 후).
function intent(name, fn) {
  try { withFlag(true, fn); intentPass++; console.log('  ✅[의도 on]', name); }
  catch (e) { intentFail++; console.log('  🟡[의도·미구현]', name, '\n        ', e.message); }
}
const has = (t, needle) => xf(t).some(f => f.replace(/\s+/g, '').includes(needle.replace(/\s+/g, '')));
const keyHas = (t, k) => keys(t).includes(k);

console.log('━━━ FP 가드 (flag off+on 양쪽 통과 필수) ━━━');
hard('제2조·제16조 → 조문번호를 兆 금액으로 오추출 안 함', () => {
  assert(!has('이 사건은 제2조와 제16조에 따른다.', '2조'), '"2조" 오추출');
  assert(!has('근로기준법 제32조를 위반했다.', '32조'), '"32조" 오추출');
});
hard('코로나-19 → "-19"/"19" 부호수치 오추출 안 함', () => {
  const ks = keys('코로나-19 사태 이후 경제가 변했다.');
  assert(!ks.includes('-19') && !ks.includes('19'), `오추출: ${ks.join(',')}`);
});
hard('GPT-4 → "-4"/"4" 오추출 안 함', () => {
  const ks = keys('우리는 GPT-4 모델을 썼다.');
  assert(!ks.includes('-4') && !ks.includes('4'), `오추출: ${ks.join(',')}`);
});
hard('목차 "2.1 시장 규모" → "2.1" 소수 오추출 안 함(공백 동반)', () => {
  assert(!has('2.1 시장 규모는 크다.', '2.1'), '"2.1" 오추출');
});
hard('페이지 "3쪽" → 오추출 안 함(쪽은 단위 아님)', () => {
  assert(!has('자세한 내용은 3쪽 참조.', '3쪽'), '"3쪽" 오추출');
});
hard('날짜 "2024-01-15" → 연도만, "-01"/"-15" 부호수치 오추출 안 함', () => {
  const ks = keys('행사일은 2024-01-15이다.');
  assert(!ks.includes('-01') && !ks.includes('-15') && !ks.includes('-1'), `날짜 부호 오추출: ${ks.join(',')}`);
});
hard('전화 "010-1234-5678" → 부호수치 오추출 안 함', () => {
  const ks = keys('문의는 010-1234-5678로.');
  assert(!ks.some(k => /^-/.test(k)), `전화 부호 오추출: ${ks.join(',')}`);
});
hard('연도범위 "2020~2022년" → 연도는 잡되 兆/이상한 토큰 안 만듦', () => {
  const ks = keys('사업은 2020~2022년에 진행됐다.');
  assert(ks.includes('2020') && ks.includes('2022'), `연도 누락: ${ks.join(',')}`);
});

console.log('\n━━━ 의도 수정 (현재 FAIL 예상 · B2b 목표) ━━━');
intent('복합 "1만 5천 명" ↔ "15,000명" 동치(같은 키)', () => {
  const a = keys('작년에 1만 5천 명이 참여했다.');
  const b = keys('작년에 15,000명이 참여했다.');
  // 목표: 양쪽이 동일 사실 1건(15000명)으로 표현돼 교집합이 생긴다.
  assert(a.some(k => b.includes(k)), `동치 키 없음 — a=[${a}] b=[${b}]`);
});
intent('복합 "2억3천만 원" → 단일 키 230000000원', () => {
  assert(keyHas('예산은 2억3천만 원이다.', '230000000원'), `키: ${keys('예산은 2억3천만 원이다.').join(',')}`);
});
intent('부호 "-0.68" ↔ "0.68" 구분(부호 포착)', () => {
  assert(keyHas('상관계수는 -0.68이었다.', '-0.68'), `부호 미포착: ${keys('상관계수는 -0.68이었다.').join(',')}`);
});
intent('부호 "-12%" ↔ "12%" 구분', () => {
  assert(keyHas('전년比 -12% 하락했다.', '-12%'), `부호 미포착: ${keys('전년比 -12% 하락했다.').join(',')}`);
});

console.log(`\n[가드 off+on] pass ${hardPass} / fail ${hardFail}   [의도 on] pass ${intentPass} / fail ${intentFail}`);
// B2b 구현 후: FP 가드 + 의도 수정 모두 통과해야 성공.
process.exit(hardFail === 0 && intentFail === 0 ? 0 : 1);
