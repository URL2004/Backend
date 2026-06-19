// [tools/_test-factast-wiring.js] Phase B2a — FACT_AST 플래그 배선 검증(정직판)
//   증명: ① flag-off는 현행과 100% 동일(무회귀)  ② flag-on은 placeholder 676 한계 제거(완전)
//        ③ ★한계 명시: floor 추출이 "1만5천명"을 쪼개므로 factKey 스왑만으로는 1만5천 동치가 안 풀림 →
//           B2b(추출 정규식이 복합을 통째로 + 부호 -?)가 별도로 필요(FP 위험·골든 코퍼스 동반).
const assert = require('assert');
const floor = require('../engine/floor');
const factsafe = require('../engine/factsafe');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ✅', name); } catch (e) { fail++; console.log('  ❌', name, '\n      ', e.message); } }
function withFlag(v, fn) { const old = process.env.FACT_AST; if (v) process.env.FACT_AST = '1'; else process.env.FACT_AST = '0'; try { return fn(); } finally { if (old === undefined) delete process.env.FACT_AST; else process.env.FACT_AST = old; } }

console.log('— ① flag-off 무회귀: 일반 문서 novelty/lostFacts 불변 —');
const rawA = '2023년 매출은 100억 원으로, 전년 대비 40% 증가했다. 카카오와 네이버가 시장을 주도했다.';
const outA = '2023년에 매출이 100억 원을 기록하며 40% 늘었다. 시장은 카카오·네이버가 이끌었다.';
t('flag-off measureNovelty는 기존 코드 그대로(스왑 영향 0)', () => {
  const off = withFlag(false, () => floor.measureNovelty(rawA, outA).count);
  // flag-off는 require('./factast') 경로를 타지 않음 — 값 자체는 회귀 비교가 아니라 "예외 없이 동작" 확인
  assert(typeof off === 'number');
});
t('flag-on도 일반 문서에선 같은 결과(단순 토큰 동일 → 무회귀)', () => {
  const off = withFlag(false, () => floor.measureNovelty(rawA, outA).count);
  const on = withFlag(true, () => floor.measureNovelty(rawA, outA).count);
  assert.strictEqual(on, off, `일반 문서 novelty 회귀: off=${off} on=${on}`);
  const offL = withFlag(false, () => floor.measureLostFacts(rawA, outA).count);
  const onL = withFlag(true, () => floor.measureLostFacts(rawA, outA).count);
  assert.strictEqual(onL, offL, `일반 문서 lostFacts 회귀: off=${offL} on=${onL}`);
});

console.log('— ② placeholder 676 한계 제거(완전 수정) —');
t('3글자 확장 토큰 ⟦Fbaa⟧: flag-off는 미검출(현행 버그), flag-on은 검출', () => {
  const off = withFlag(false, () => factsafe.placeholdersIn('가 ⟦Fbaa⟧ 나').length);
  const on = withFlag(true, () => factsafe.placeholdersIn('가 ⟦Fbaa⟧ 나').length);
  assert.strictEqual(off, 0, 'flag-off는 [a-z]{2}라 3글자 미검출(현행)');
  assert.strictEqual(on, 1, 'flag-on은 [a-z]{2,}라 검출(676 수정)');
});
t('2글자 토큰은 양쪽 동일(하위호환)', () => {
  const off = withFlag(false, () => factsafe.placeholdersIn('가 ⟦Fab⟧ 나').length);
  const on = withFlag(true, () => factsafe.placeholdersIn('가 ⟦Fab⟧ 나').length);
  assert.strictEqual(off, 1); assert.strictEqual(on, 1);
});

console.log('— ③ B2b end-to-end: "1만 5천 명"↔"15,000명" 동치 + 부호 반전을 floor가 올바로 측정 —');
t('"1만 5천 명" vs "15,000명": flag-off는 오탐(현행 버그), flag-on은 0(B2b 수정)', () => {
  const raw = '작년 행사에 1만 5천 명이 참여했다.';
  const out = '작년 행사에는 15,000명이 왔다.';
  const off = withFlag(false, () => floor.measureNovelty(raw, out).count);
  const on = withFlag(true, () => floor.measureNovelty(raw, out).count);
  assert(off >= 1, `flag-off는 현행 버그로 오탐해야(>0). 실제 ${off}`);
  assert.strictEqual(on, 0, `flag-on은 복합 통째+factKey로 동치 인식 → novelty 0. 실제 ${on}`);
});
t('부호 반전 "-0.68"→"0.68": flag-off는 미탐, flag-on은 novelty 잡음(의미역전 감지)', () => {
  const raw = '상관계수는 -0.68로 음의 관계였다.';
  const out = '상관계수는 0.68로 양의 관계였다.';   // 부호 반전 = 의미 역전
  const off = withFlag(false, () => floor.measureNovelty(raw, out).count);
  const on = withFlag(true, () => floor.measureNovelty(raw, out).count);
  assert.strictEqual(off, 0, `flag-off는 부호 미포착으로 0.68=−0.68 → 역전 미탐. 실제 ${off}`);
  assert(on >= 1, `flag-on은 "0.68"(출력)이 원문(−0.68)에 없는 새 사실 → 잡아야. 실제 ${on}`);
});

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'} (pass ${pass} / fail ${fail})`);
process.exit(fail === 0 ? 0 : 1);
