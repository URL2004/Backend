'use strict';
// [tools/_test-meta-strip.js] 소절번호 메타 누수 strip 테스트.
//   실행: node tools/_test-meta-strip.js
const { stripSectionMeta } = require('../engine/experimental/meta-strip');

let pass = true;
function chk(name, cond, got) {
  console.log((cond ? '✅' : '❌') + ' ' + name + (got !== undefined ? '  → "' + got + '"' : ''));
  if (!cond) pass = false;
}

// 1) "소절 N.N.이 ~" → "앞서 ~", '소절' 사라짐
let r = stripSectionMeta('소절 1.1.이 짚은 극심한 피로는 그대로 살아난다.');
chk('소절+조사(이) → 앞서', !/소절/.test(r) && r.startsWith('앞서 짚은'), r);

// 2) "소절 N.N.의 ~" → "앞서의 ~"
r = stripSectionMeta('소절 1.2.의 현실이 집에 이월된다.');
chk('소절+조사(의) → 앞서의', r.startsWith('앞서의 현실이'), r);

// 3) 괄호 삽입구 제거
r = stripSectionMeta('책임연구원이라는 조건(소절 1.1.의 표현을 그대로 빌리자면)은 가장 높다.');
chk('괄호 소절 참조 제거', !/소절/.test(r) && !/빌리자면/.test(r), r);

// 4) 이중 참조 "2.2.와 2.3.은" → "이 둘은"
r = stripSectionMeta('알파룸과 함께 묶이는 2.2.와 2.3.은 사실 한 묶음이다.');
chk('이중 소절참조 → 이 둘은', /이 둘은 사실 한 묶음/.test(r) && !/2\.2\./.test(r), r);

// 5) 통계 수치 "2.4배"는 절대 건드리지 않음(이중참조 패턴 아님)
r = stripSectionMeta('딩크족은 2.4배 늘었다.');
chk('통계수치 2.4배 보존', /2\.4배/.test(r), r);

// 6) 정상 단일 헤딩 "2.1. 제목"은 보존(누수 아님)
r = stripSectionMeta('2.1. 가사 노동을 제로화하는 컨시어지 서비스');
chk('단일 헤딩 2.1. 보존', /2\.1\./.test(r), r);

// 7) 메타 없는 일반 문장 불변
const plain = '집은 단순한 휴식 공간을 넘어 업무 공간으로 확대되고 있다.';
chk('일반 문장 불변', stripSectionMeta(plain) === plain);

console.log(pass ? '\n전체 통과 ✅' : '\n실패 ❌');
process.exitCode = pass ? 0 : 1;
