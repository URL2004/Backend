// [tools/_test-freezeblocks.js] 학술 동결 블록(참고문헌·목차) 분리/재조립 회귀(2026-06-19 #43: 청크-충실이
//   참고문헌 저자명 "신춘성, 이영호, 윤효석"→"신춘성부터 윤효석까지" 의역=학술부정). 참고문헌·목차는 verbatim 보존.
const { splitAcademicBlocks, reassembleAcademic } = require('../engine/freezeblocks');

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ❌ ' + m); } else console.log('  ✅ ' + m); };

// ── 목차 + 본문 + (heading 없는) 꼬리 참고문헌 리스트
const doc = `기술 발전과 인간 진화

한남대학교 컴퓨터공학과 지혜미

목차
1. 서론
2. 본론
3. 결론

1. 서론
인류의 역사는 기술 발전과 궤를 같이하며 진화해왔다. 도구는 인간의 인지 능력을 확장시켰고, 이는 생물학적 진화를 넘어선 새로운 진화의 형태를 만들어냈다. 본 글은 이러한 공진화의 양상을 살펴본다.

2. 본론
기술은 단순한 도구를 넘어 인간 존재의 일부가 되었다. 인간 향상 기술의 등장은 인간과 비인간의 경계를 흐리게 만든다. 이러한 변화는 윤리적 쟁점을 동반한다.

3. 결론
기술과 인간의 진화는 분리될 수 없다. 우리는 이 공진화를 새로운 인본주의로 이해해야 한다.

신춘성, 이영호, 윤효석. (2020). 확장현실 기반 휴먼 디지털 증강 기술 동향과 발전방향. 한국산업정보학회논문지, 25, 1-12.
고흥정. (2021). 포스트휴먼 시대의 인간 진화에 대한 연구. 커뮤니케이션디자인학연구, 74, 17-27.
홍진철. (2023). 포스트휴먼과 기독교 교양교육. 신학과 복음, 51, 159-190.`;

console.log('=== 목차+참고문헌 동결 ===');
const fb = splitAcademicBlocks(doc);
ok(fb.hasFrozen === true, 'hasFrozen=true');
ok(fb.toc.includes('1. 서론') && fb.toc.includes('3. 결론'), '목차 분리됨');
ok(fb.refs.includes('신춘성, 이영호, 윤효석') && fb.refs.includes('홍진철'), '참고문헌 리스트 분리됨');
ok(!fb.body.includes('신춘성, 이영호, 윤효석. (2020)'), '본문엔 참고문헌 리스트 없음');
ok(fb.body.includes('인류의 역사는'), '본문은 보존');

console.log('\n=== 재조립: 본문만 우회(여기선 그대로) → 동결블록 verbatim ===');
const fakeHumanized = fb.body.replace('인류의 역사는', '인류의 역사라는 건');   // 본문만 바뀐 것 흉내
const out = reassembleAcademic(fb, fakeHumanized);
ok(out.includes('신춘성, 이영호, 윤효석. (2020). 확장현실 기반 휴먼 디지털 증강 기술 동향과 발전방향. 한국산업정보학회논문지, 25, 1-12.'), '★참고문헌 저자명 한 글자도 안 바뀜(verbatim)');
ok(out.includes('인류의 역사라는 건'), '본문 변경은 반영됨');
ok(out.indexOf('목차') < out.indexOf('1. 서론\n인류') && out.lastIndexOf('홍진철') > out.indexOf('3. 결론'), '순서 보존(목차 위 / 참고문헌 아래)');

console.log('\n=== 일반 에세이(동결 블록 없음) → 통째 우회 ===');
const essay = '정부 부동산 대책은 공급 확대에 방점을 찍었다. 결국 시장이 묻는 것은 입지다. '.repeat(8);
const fb2 = splitAcademicBlocks(essay);
ok(fb2.hasFrozen === false, '일반 에세이 hasFrozen=false');
ok(fb2.body === essay.trim(), '본문 = 전체(동결 없음)');

console.log('\n=== "참고문헌" heading 있는 경우 ===');
const doc3 = '이것은 충분히 긴 본문 문장입니다. 동결 가드(본문 200자 미만이면 취소)를 넘기기 위한 분량입니다. '.repeat(8) + '\n\n참고문헌\n홍길동. (2020). 제목. 저널, 1, 1-10.\n김철수. (2021). 제목2. 저널2, 2, 11-20.\n이영희. (2022). 제목3. 저널3, 3, 21-30.';
const fb3 = splitAcademicBlocks(doc3);
ok(fb3.refs.includes('홍길동') && fb3.refs.includes('이영희'), 'heading 기반 참고문헌 분리');
ok(!fb3.body.includes('홍길동. (2020)'), '본문에 참고문헌 없음');

console.log('\n' + (fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`));
process.exit(fail === 0 ? 0 : 1);
