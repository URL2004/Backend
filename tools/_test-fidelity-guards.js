// [tools/_test-fidelity-guards.js] 2026-06-19 외부감사 충실도 결함 R-02/R-03/R-04 회귀 테스트
//   R-02 chunk.splitLongChunk: 강제컷(공백 없는 런)에 팬텀 공백 주입 금지(왕복 보존)
//   R-03 dedupe fuzzy: 숫자(연도·수치) 다르면 '다른 사실' → 삭제 금지
//   R-04 dedupe _isShortSynEcho: 부정 극성 다르면 '반대뜻' → 삭제 금지
//   기존 동작 회귀: 잼 수정(문장경계 공백 보강)·진짜 중복 삭제·진짜 동의어 에코 삭제는 유지
const assert = require('assert');
const { dedupeSentences } = require('../engine/dedupe');
const chunk = require('../engine/chunk');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ✅', name); } catch (e) { fail++; console.log('  ❌', name, '\n      ', e.message); } }

console.log('— R-03: fuzzy dedupe가 연도·수치 다른 문장을 지우지 않음 —');
t('"2023…100억"·"2024…200억" 둘 다 보존(다른 사실)', () => {
  const src = '2023년 매출은 100억 원으로 증가했다. 2024년 매출은 200억 원으로 증가했다.';
  const r = dedupeSentences(src);
  assert.strictEqual(r.removed, 0, `removed=${r.removed} (사실 손실)`);
  assert(r.text.includes('200억'), '200억 문장이 삭제됨');
  assert(r.text.includes('100억'), '100억 문장이 삭제됨');
});
t('진짜 중복(숫자 동일)은 여전히 삭제', () => {
  const src = '2024년 매출은 200억 원으로 증가했다. 2024년 매출은 200억 원으로 증가했다.';
  const r = dedupeSentences(src);
  assert(r.removed >= 1, `진짜 중복 미삭제 removed=${r.removed}`);
});
t('숫자 없는 근접중복(어미만 다름)은 여전히 삭제', () => {
  const src = '이 정책은 사회 전반의 신뢰를 회복하는 데 결정적인 역할을 한다. 이 정책은 사회 전반의 신뢰를 회복하는 데 결정적인 역할을 합니다.';
  const r = dedupeSentences(src);
  assert(r.removed >= 1, `근접중복 미삭제 removed=${r.removed}`);
});

console.log('— R-04: 짧은 동의어 에코가 부정 극성 다르면 보존 —');
t('"어렵지 않다."·"불가능하다." 둘 다 보존(반대뜻)', () => {
  const src = '이 과제는 결코 어렵지 않다. 불가능하다.';
  const r = dedupeSentences(src);
  assert(r.text.includes('불가능하다'), '불가능하다가 삭제됨(반대뜻 오삭제)');
});
t('"어렵다."·"불가능하다." 동의어 에코는 여전히 삭제(원래 #2 케이스)', () => {
  const src = '이 과제는 정말 어렵다. 불가능하다.';
  const r = dedupeSentences(src);
  assert(!r.text.includes('불가능하다'), `동의어 에코 미삭제: ${r.text}`);
});

console.log('— R-04확장: 긴 fuzzy 문장의 부정/양태 반전은 보존(의미 역전 방지) —');
t('"효과가 있다고 평가된다" vs "효과가 없다고 평가된다" 둘 다 보존(부정 극성)', () => {
  const src = '이 정책은 사회 전반에 효과가 있다고 평가된다. 이 정책은 사회 전반에 효과가 없다고 평가된다.';
  const r = dedupeSentences(src);
  assert(r.text.includes('없다고'), `부정 반전이 fuzzy로 삭제됨: ${r.text}`);
});
t('"효과가 있다고 본다" vs "효과가 있을 수 있다고 본다" 둘 다 보존(양태)', () => {
  const src = '연구진은 그 방법이 효과가 있다고 본다. 연구진은 그 방법이 효과가 있을 수 있다고 본다.';
  const r = dedupeSentences(src);
  assert(r.text.includes('있을 수 있다고'), `양태 차이가 fuzzy로 삭제됨: ${r.text}`);
});
t('같은 부정 극성·같은 양태의 진짜 근접중복은 여전히 삭제', () => {
  const src = '이 정책은 사회 전반에 효과가 없다고 평가된다. 이 정책은 사회 전반에서 효과가 없다고 평가됩니다.';
  const r = dedupeSentences(src);
  assert(r.removed >= 1, `진짜 근접중복(같은 stance) 미삭제 removed=${r.removed}`);
});

console.log('— R-02: 강제컷이 공백 없는 런에 팬텀 공백 주입 안 함 (왕복 불변식 merge(split)===원문) —');
t('공백·구두점 없는 긴 런(URL·SMILES·코드 벽)이 왕복 보존', () => {
  const wall = 'A'.repeat(6000);   // 6000자, 공백·구두점 0 → splitLongChunk 강제컷 발생
  const merged = chunk.mergeChunks(chunk.splitChunks(wall));   // outputText 미설정 → 원본 text로 재조립
  const diff = [...merged].findIndex((ch, i) => ch !== wall[i]);
  assert.strictEqual(merged, wall, `왕복 깨짐: len ${merged.length} vs ${wall.length}, 첫 차이 idx ${diff}`);
  assert(!merged.includes(' '), '강제컷에 팬텀 공백 주입됨');
});
t('공백 없는 코드/URL 혼합 벽도 왕복 보존', () => {
  const wall = ('https://example.com/path?a=1&b=2#frag').repeat(200);   // 공백 0, 길이 7400
  const merged = chunk.mergeChunks(chunk.splitChunks(wall));
  assert.strictEqual(merged, wall, '코드/URL 벽 왕복 깨짐');
});
t('문장경계가 있는 일반 장문은 왕복 보존(잼 보강이 중복공백 안 만듦)', () => {
  const text = ('이것은 충분히 긴 한국어 문장입니다. ').repeat(300);   // 문장경계 다수, 공백 포함
  const merged = chunk.mergeChunks(chunk.splitChunks(text));
  assert.strictEqual(merged, text, '일반 장문 왕복 깨짐');
});

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'}  (pass ${pass} / fail ${fail})`);
process.exit(fail === 0 ? 0 : 1);
