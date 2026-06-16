// [tools/_test-meta-leak-fp.js] meta_leak 오탐 회귀 가드(2026-06-16):
//   검열·언어정책처럼 "표현 금지/쓰지 말라"가 정상 본문인 글, "…라고 밝힙니다" 보고문이
//   WINK_RE/META_NOTE_RE에 윙크·메타로 오탐돼 blog가 raw 폴백(무변환+차감)하던 사고 방지.
//   동시에 진짜 프롬프트 윙크·메타 누출은 계속 잡아야 한다.
const floor = require('../engine/floor');

// 검열 보고서 성격의 원문(allowedWorld). 표현·금지가 정상적으로 본문에 등장.
const raw = '북한은 남한식 표현을 단속한다. 길거리에서 애정 표현을 금지하고, 남친 같은 표현도 바꾸도록 교육한다. 통일연구원은 이를 보고했다.';

let fail = 0;
const ok = (cond, m) => { if (!cond) { fail++; console.log('  ❌ ' + m); } else console.log('  ✅ ' + m); };
const noLeak = (t) => floor.findMetaLeaks(t, raw).length === 0;
const hasLeak = (t) => floor.findMetaLeaks(t, '원문은 따로 있다 본문 내용 길게').length > 0;

console.log('=== 정상 본문(검열·보고) → 오탐 없어야 ===');
ok(noLeak('그런 표현은 아예 못 쓰게 금지했고'), '표현 금지(3인칭 보고)');
ok(noLeak('남친이나 쪽팔린다 같은 표현도 쓰지 말라고 교육한다'), '쓰지 말라고 교육한다(3인칭)');
ok(noLeak('이런 말투와 표현을 쓰지 못하도록 금지하고 있다'), '쓰지 못하도록 금지');
ok(noLeak('거리에서의 애정 표현조차 금지 대상이 된다'), '애정 표현 금지');
ok(noLeak('통일연구원은 이런 법들이 제정됐다고 밝힙니다'), '…라고 밝힙니다(보고문)');
ok(noLeak('정부는 분명한 입장을 밝힙니다'), '입장을 밝힙니다');

console.log('=== 진짜 윙크·메타 누출 → 계속 잡아야 ===');
ok(hasLeak('정보 통제의 핵심은 여기 있다(아, 이 표현 쓰지 말라고 했지)'), '이 표현 쓰지 말라고 했지(윙크)');
ok(hasLeak('그런 말투 쓰지 말랬잖아'), '그런 말투 쓰지 말랬잖아(윙크)');
ok(hasLeak('원문대로 작성했음을 밝힙니다'), '원문대로 작성…밝힙니다(메타)');
ok(hasLeak('본문만 출력했다'), '본문만(메타)');
ok(hasLeak('위 지침에 따라 작성했다'), '위 지침에 따라(메타)');

console.log('\n' + (fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`));
process.exit(fail === 0 ? 0 : 1);
