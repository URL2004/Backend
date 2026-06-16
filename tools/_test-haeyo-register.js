// [tools/_test-haeyo-register.js] B 검증: 해요체 입력 감지 + 합니다체로 드리프트한 출력을 해요체로 정규화.
const { detectRegister } = require('../engine/contract');
const { normalizeRegister } = require('../engine/registernormalize');
const sg = require('../engine/surfaceguard');

// 실측 원문(해요체)
const inHaeyo = `세 번째 한계는 심리적 역기능이에요. AI 트레이너에 오래, 지나치게 기대다 보면 음식을 보는 눈 자체가 달라져요. 숫자가 눈에만 들어와요. 그 시각이 굳어지면 심리적 강박은 자연스럽게 따라와요. 즐거워야 할 식사 자리가 불안의 공간이 돼버리는 거예요.`;
// 실측 결과(합니다체 + 한다체 조각 혼입)
const outDrift = `세 번째 한계는 심리적 역기능입니다. 음식을 바라보는 시각 자체가 달라집니다. 숫자로만 음식을 읽기 시작하는 것입니다. 숫자가 전부가 되어 버린다. 그 시각이 굳어지면 심리적 강박은 자연스럽게 뒤따라옵니다. 일상까지 번진다는 점입니다. 죄책감이 밀려옵니다. 즐거워야 할 식사 자리가 불안의 공간으로 변해버린다. 그것이 가장 큰 문제다. 문제는 더욱 심각해집니다. 역설이 발생하는 셈입니다.`;
// 합니다체 원문(대조)
const inHap = `세 번째 한계는 심리적 역기능입니다. 시각이 달라집니다. 강박이 따라옵니다. 문제가 심각해집니다.`;

let fail = 0;
function check(cond, msg) { if (!cond) { fail++; console.log('  ❌ ' + msg); } else { console.log('  ✅ ' + msg); } }

console.log('=== detectRegister ===');
check(detectRegister(inHaeyo) === 'haeyo', `해요체 원문 → 'haeyo' (got ${detectRegister(inHaeyo)})`);
check(detectRegister(inHap) === 'polite', `합니다체 원문 → 'polite' (got ${detectRegister(inHap)})`);
check(detectRegister('간다. 온다. 본다. 이것이 핵심이다.') === 'plain', `한다체 원문 → 'plain' (got ${detectRegister('간다. 온다. 본다. 이것이 핵심이다.')})`);

console.log('\n=== normalizeRegister(출력, haeyo) ===');
const before = sg.measureRegisterMix(outDrift);
const { text, changed } = normalizeRegister(outDrift, 'haeyo');
const after = sg.measureRegisterMix(text);
console.log(`  변환 전 dominant=${before.dominant} offRatio=${before.offRatio}`);
console.log(`  변환 후 dominant=${after.dominant} offRatio=${after.offRatio} · 치환 ${changed}건`);
check(after.dominant === 'haeyo', `변환 후 해요체 dominant`);
check(/역기능이에요/.test(text), '역기능입니다 → 역기능이에요');
check(/달라져요/.test(text), '달라집니다 → 달라져요');
check(/되어 버려요/.test(text), '되어 버린다 → 되어 버려요');
check(/뒤따라와요/.test(text), '뒤따라옵니다 → 뒤따라와요');
check(/변해버려요/.test(text), '변해버린다 → 변해버려요');
check(/심각해져요/.test(text), '심각해집니다 → 심각해져요');

console.log('\n=== 결과 본문 ===\n' + text);
console.log('\n' + (fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`));
process.exit(fail === 0 ? 0 : 1);
