// [tools/_test-codetoken.js] 코드성 토큰 점뒤 공백 깨짐 복원 회귀(2026-06-19 #감사: CONTACT.MB_MB→"CONTACT. MB_MB").
const { restoreCodeTokens } = require('../engine/spacing');
let fail = 0; const ok = (c, m) => { if (!c) { fail++; console.log('  ❌ ' + m); } else console.log('  ✅ ' + m); };
ok(restoreCodeTokens('CONTACT. MB_MB 호출', '원문 CONTACT.MB_MB').text.includes('CONTACT.MB_MB'), 'CONTACT.MB_MB 복원');
ok(restoreCodeTokens('FUNCTION. XY 와 LOAD. SYSTEM_ACC', 'FUNCTION.XY LOAD.SYSTEM_ACC').text === 'FUNCTION.XY 와 LOAD.SYSTEM_ACC', '복수 토큰 복원');
ok(restoreCodeTokens('버전 v1. 2', 'v1.2 버전').text.includes('v1.2'), '버전 v1.2 복원');
ok(restoreCodeTokens('문장이 끝났다. 다음 문장.', '문장이 끝났다. 다음 문장.').fixed === 0, '한글 문장 무변경(오탐 0)');
ok(restoreCodeTokens('원문에 없는 CODE. TOKEN', '관련 없는 원문').fixed === 0, '원문에 없는 토큰은 안 건드림');
ok(restoreCodeTokens('A는 T하고만, G는 C하고만', 'A-T, G-C').fixed === 0, '일반 텍스트 무변경');
console.log('\n' + (fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`));
process.exit(fail === 0 ? 0 : 1);
