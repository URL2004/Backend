// [tools/_test-structure-preserve.js] 구조 보존 회귀(2026-06-17, #100·#16·#92·#34·#90):
//   tidyParagraphs가 헤딩·번호·불릿·표·조항 줄바꿈은 보존하고, LLM 잡 \n(문장-wrap)·연도 줄은 공백 합침.
const { tidyParagraphs } = require('../engine/genretransfer');

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ❌ ' + m); } else console.log('  ✅ ' + m); };

console.log('=== 구조 줄 보존 ===');
ok(tidyParagraphs('Ⅱ. 본론\n첫 문장이다. 둘째 문장이다.') === 'Ⅱ. 본론\n첫 문장이다. 둘째 문장이다.', '로마숫자 헤딩 줄바꿈 보존 + 본문 합침');
ok(tidyParagraphs('개요\n- 항목 하나\n- 항목 둘').split('\n').length === 3, '불릿 3줄 보존');
ok(tidyParagraphs('계약 내용\n제3조 (대금)\n제4조 (납기)').split('\n').length === 3, '제N조 조항 보존');
ok(tidyParagraphs('정리\n1. 첫째 항목\n2. 둘째 항목').split('\n').length === 3, '번호 리스트 보존');
ok(tidyParagraphs('데이터\n| 항목 | 값 |\n| 가 | 1 |').split('\n').length === 3, '표 행(파이프) 보존');

console.log('\n=== 잡 줄바꿈은 공백 합침(현행 유지) ===');
ok(tidyParagraphs('첫 문장이다.\n둘째 문장이다.\n셋째 문장이다.').indexOf('\n') === -1, '문장-wrap 공백 합침');
ok(tidyParagraphs('매출이 늘었다.\n2023년에는 더 늘었다.').indexOf('\n') === -1, '연도 줄(2023.)을 1.리스트로 오인 안 함');
ok(tidyParagraphs('제목 — 부제\n첫 블록 테스트').includes('제목 — 부제'), '첫 블록 제목 예외 유지');

console.log('\n' + (fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`));
process.exit(fail === 0 ? 0 : 1);
