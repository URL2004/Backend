// [tools/_test-factast.js] Phase B — factast.js: 감사 3버그 수정 + 기존 단순케이스 하위호환 증명
const assert = require('assert');
const { koreanAmountToNumber, factKey, sameFact, tokOf, placeholdersIn } = require('../engine/factast');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ✅', name); } catch (e) { fail++; console.log('  ❌', name, '\n      ', e.message); } }
const eq = (a, b, msg) => assert.strictEqual(a, b, msg);

console.log('— 미리아드 누적 파서 koreanAmountToNumber —');
t('1만5천 = 15000 (감사 동치 오탐의 핵심)', () => eq(koreanAmountToNumber('1만5천'), 15000));
t('1만 5천(공백) = 15000', () => eq(koreanAmountToNumber('1만 5천'), 15000));
t('5천 = 5000', () => eq(koreanAmountToNumber('5천'), 5000));
t('30만 = 300000', () => eq(koreanAmountToNumber('30만'), 300000));
t('255만 = 2,550,000', () => eq(koreanAmountToNumber('255만'), 2550000));
t('2억3천만 = 230,000,000', () => eq(koreanAmountToNumber('2억3천만'), 230000000));
t('1억2천만 = 120,000,000', () => eq(koreanAmountToNumber('1억2천만'), 120000000));
t('3조 = 3e12', () => eq(koreanAmountToNumber('3조'), 3000000000000));

console.log('— (a) 부호 반전 미탐 수정: 부호 다르면 다른 키 —');
t('-0.68 ≠ 0.68', () => { assert(!sameFact('-0.68', '0.68'), '부호반전 미탐'); eq(factKey('-0.68'), '-0.68'); eq(factKey('0.68'), '0.68'); });
t('-12% ≠ 12%', () => { assert(!sameFact('-12%', '12%')); eq(factKey('-12%'), '-12%'); eq(factKey('12%'), '12%'); });
t('U+2212(−)도 부호로 인식', () => assert(!sameFact('−5천', '5천')));

console.log('— (b) 동치 오탐 수정: 같은 값이면 같은 키 —');
t('1만5천 = 15000 = 15,000', () => { eq(factKey('1만5천'), '15000'); eq(factKey('15000'), '15000'); eq(factKey('15,000'), '15000'); assert(sameFact('1만5천', '15,000')); });
t('1만 자 = 10,000자 = 10000자', () => { eq(factKey('1만 자'), '10000자'); eq(factKey('10,000자'), '10000자'); assert(sameFact('1만 자', '10000자')); });
t('5천원 = 5,000원', () => assert(sameFact('5천원', '5,000원')));
t('255만 명 = 2,550,000명', () => assert(sameFact('255만 명', '2,550,000명')));

console.log('— 하위호환: 기존 floor.factKey 단순케이스와 동일 출력 —');
t('2023 → 2023', () => eq(factKey('2023'), '2023'));
t('40% → 40%', () => eq(factKey('40%'), '40%'));
t('5천 → 5000', () => eq(factKey('5천'), '5000'));
t('1만자 → 10000자', () => eq(factKey('1만자'), '10000자'));
t('0.42 → 0.42', () => eq(factKey('0.42'), '0.42'));
t('비수치 브랜드 → 소문자', () => eq(factKey('Kakao'), 'kakao'));

console.log('— (c) 676 placeholder 한계 제거 —');
t('i<676은 기존 ⟦Faa⟧~⟦Fzz⟧와 동일', () => { eq(tokOf(0), '⟦Faa⟧'); eq(tokOf(1), '⟦Fab⟧'); eq(tokOf(25), '⟦Faz⟧'); eq(tokOf(26), '⟦Fba⟧'); eq(tokOf(675), '⟦Fzz⟧'); });
t('i≥676은 3글자 확장, { 없음', () => { const t676 = tokOf(676); eq(t676, '⟦Fbaa⟧'); assert(/^⟦F[a-z]{2,}⟧$/.test(t676), '비문자 포함'); });
t('0..1500 전부 유일 + placeholdersIn으로 검출됨', () => {
  const seen = new Set();
  for (let i = 0; i <= 1500; i++) {
    const tok = tokOf(i);
    assert(/^⟦F[a-z]{2,}⟧$/.test(tok), `비문자 토큰 i=${i}: ${tok}`);
    assert(!seen.has(tok), `충돌 i=${i}: ${tok}`); seen.add(tok);
    eq(placeholdersIn('가나 ' + tok + ' 다라').length, 1, `placeholdersIn 미검출 i=${i}`);
  }
});

console.log('— 차등: 기존 floor.factKey(인라인 복제)와 단순케이스 동일, 복합만 교정 (B2 무회귀 증명) —');
// floor.js 내부 비공개 factKey의 정확한 복제(2026-06-19 시점).
function oldFactKey(s) {
  let k = String(s).replace(/\s+/g, '');
  k = k.replace(/(\d[\d,]*)억/g, (_, n) => String(Number(n.replace(/,/g, '')) * 100000000))
       .replace(/(\d[\d,]*)만/g, (_, n) => String(Number(n.replace(/,/g, '')) * 10000))
       .replace(/(\d[\d,]*)천/g, (_, n) => String(Number(n.replace(/,/g, '')) * 1000));
  return k.replace(/,/g, '').toLowerCase();
}
// extractFacts가 실제로 만드는 단순 토큰들(연도·%·단일단위 금액·숫자단위·소수·브랜드·한글수사) — old===new 여야 함.
const SIMPLE = ['2023', '2020', '40%', '60%', '3.5%', '5천원', '30만', '2억원', '255만명', '5천', '10만자',
  '96회', '300분', '12명', '1,200원', '0.42', '2.1', '1.44', '카카오', 'Kakao', '세 배', '제21065호'];
t('단순 토큰 전부 old===new (배선 시 무회귀)', () => {
  for (const tok of SIMPLE) eq(factKey(tok), oldFactKey(tok), `불일치: "${tok}" old=${oldFactKey(tok)} new=${factKey(tok)}`);
});
t('복합 한국식수량만 교정(old는 틀림)', () => {
  assert.notStrictEqual(oldFactKey('1만5천'), '15000', 'old가 이미 맞으면 교정 의미 없음(전제 확인)');
  eq(factKey('1만5천'), '15000');
  assert.notStrictEqual(factKey('1만5천'), oldFactKey('1만5천'), '복합은 달라야(교정)');
});
// ★ 부호 버그는 factKey가 아니라 '추출'에 있다: old/new 둘 다 부호 토큰을 받으면 구분함. extractFacts가 "-"를
//   떨궈 "0.68"만 넘기는 게 원인 → B2에서 floor 추출 정규식(DECIMAL_RE·%·KR_AMOUNT·NUM_UNIT)에 -? 추가 필요.
t('부호는 추출 단계 문제임을 명시(factKey는 이미 부호 보존)', () => {
  eq(oldFactKey('-0.68'), '-0.68'); eq(factKey('-0.68'), '-0.68');   // 둘 다 부호 보존 — 추출이 부호를 주기만 하면 됨
});

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'} (pass ${pass} / fail ${fail})`);
process.exit(fail === 0 ? 0 : 1);
