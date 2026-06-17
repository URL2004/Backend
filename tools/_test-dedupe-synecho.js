// [tools/_test-dedupe-synecho.js] 짧은 동의어 에코 제거 회귀(2026-06-17, #2 "…어렵다. 불가능하다."):
//   직전 단정을 짧은 동의어로 되풀이하면 제거하되, 반대뜻(가능/불가능)·일반 단문은 과삭제하지 않는다.
const { dedupeSentences } = require('../engine/dedupe');

let fail = 0;
const ok = (cond, m) => { if (!cond) { fail++; console.log('  ❌ ' + m); } else console.log('  ✅ ' + m); };

console.log('=== 동의어 에코 제거 ===');
ok(dedupeSentences('우수 교수 수급과 연구 팀 구성도 현실적으로 어렵다. 불가능하다.').removed >= 1, '어렵다 → 불가능하다(동의어) 제거');
ok(dedupeSentences('이 작업은 정말 중요하다. 핵심이다.').removed >= 1, '중요하다 → 핵심이다 제거');

console.log('\n=== 과삭제 방지(안전) ===');
ok(dedupeSentences('이 일은 가능하다. 불가능하다.').removed === 0, '반대뜻(가능/불가능)은 유지 — substring 함정 방지');
ok(dedupeSentences('비가 내렸다. 거세게 내렸다.').removed === 0, '동의어 그룹 아님 → 유지');
ok(dedupeSentences('이 일은 어렵다. 그러나 우리는 끝까지 해낼 수 있다고 믿는다.').removed === 0, '긴 반론 문장(>12자)은 유지');
ok(dedupeSentences('성과를 냈다.').removed === 0, '단일 문장 → 변화 없음');

console.log('\n' + (fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`));
process.exit(fail === 0 ? 0 : 1);
