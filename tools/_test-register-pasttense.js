// [tools/_test-register-pasttense.js] 과거형 일괄 변환 + blog 해요체 통일 회귀(2026-06-17):
//   해요체 글에 섞인 한다체 과거형(졌다·냈다…)·동사(준다)·형용사(않다)를 해요체로 통일하되,
//   중간 어미(했는데/진다는/하다고)와 비과거는 건드리지 않는다(어미만·무날조).
const rn = require('../engine/registernormalize');
const sg = require('../engine/surfaceguard');

let fail = 0;
const eq = (input, expect, msg) => {
  const o = rn.normalizeRegister(input, 'haeyo').text;
  const ok = o === expect;
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'} ${msg}: "${o}"${ok ? '' : ` (기대 "${expect}")`}`);
};

console.log('=== 과거형 ㅆ다 → ㅆ어요 (고정목록이 놓치던 것) ===');
eq('연구가 이어졌다.', '연구가 이어졌어요.', '이어졌다');
eq('사실을 짚어냈다.', '사실을 짚어냈어요.', '짚어냈다');
eq('변화를 추적했다.', '변화를 추적했어요.', '추적했다');

console.log('\n=== 동사·형용사 종결 보강 ===');
eq('점을 보여준다.', '점을 보여줘요.', '보여준다');
eq('연구는 많지 않다.', '연구는 많지 않아요.', '많지 않다');

console.log('\n=== 중간 어미·비과거 보호(오변환 금지) ===');
eq('분석했는데 결과가 나왔다.', '분석했는데 결과가 나왔어요.', '했는데 보호 + 나왔다 변환');
eq('달라진다는 점을 보여준다.', '달라진다는 점을 보여줘요.', '진다는 보호 + 준다 변환');
eq('중요하다고 했다.', '중요하다고 했어요.', '하다고 보호 + 했다 변환');

console.log('\n=== 혼합 단락 전체 통일 → offRatio 0 ===');
const mixed = '연구가 이어졌다. 사실을 짚어냈다. 생각보다 넓다. 변화를 보여준다.\n앞에선 추적했어요. 결과가 나왔거든요.';
const out = rn.normalizeRegister(mixed, 'haeyo').text;
const mix = sg.measureRegisterMix(out);
const unified = mix.offRatio === 0;
if (!unified) fail++;
console.log(`${unified ? '✅' : '❌'} 혼합 → 해요체 통일(offRatio=${mix.offRatio})`);

console.log('\n' + (fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`));
process.exit(fail === 0 ? 0 : 1);
