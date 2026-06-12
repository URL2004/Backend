// 61% PDF 이음새 결함 2종 수정 검증 (틱톡 재진술 중복 · "원장" 누출)
const { resolveDupSentences } = require('../engine/genretransfer');
const floor = require('../engine/floor');
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log('FAIL: ' + n)); };

// 1. 포함관계 재진술(같은 문단 인접 — 실사고 그대로)
const s1 = '틱톡이 EU의 중독 유발 설계 조사가 시작되자 자사 보상 프로그램을 자진 철회한 것은, 규제 압력이 실제로 플랫폼 행동을 바꾼다는 방증이다.';
const s2 = '틱톡은 조사가 착수되자 보상 프로그램을 자진 철회했다.';
const textF = '원문이다. ' + s1 + ' ' + s2 + ' 그밖의 내용.';
const doc = '앞 문단이다.\n\n' + s1 + ' ' + s2 + ' 이어지는 설명이다.';
const fixed = resolveDupSentences(doc, textF);
ok('재진술 중복 제거', (fixed.match(/자진 철회/g) || []).length === 1);
ok('본문 보존', fixed.includes('앞 문단이다') && fixed.includes('이어지는 설명이다'));

// 2. 무관 문장 오탐 없음(주제만 같고 내용 다른 두 문장)
const docB = '틱톡은 유럽에서 조사를 받았다.\n\n페이스북은 크리에이터에게 보상 프로그램을 새로 공개했다.';
ok('무관 문장 보존', resolveDupSentences(docB, docB) === docB);

// 3. "원장" 누출 검출(원문에 없을 때만)
ok('원장 누출 검출', floor.findMetaLeaks('원장은 시간 기준 설정, 침대에서 숏폼 안 켜기 등 기준을 제시한다.', '숏폼에 관한 원문').length > 0);
ok('실제 원장(병원장) 허용', floor.findMetaLeaks('원장은 진료 방침을 바꿨다.', '병원 원장은 진료 방침에 대해 말했다.').length === 0);
ok('승인 근거 누출 검출', floor.findMetaLeaks('승인 근거에 따라 본문을 구성했다.', '원문').length > 0);

console.log(`seam fixes: ${pass}통과 / ${fail}실패`);
process.exit(fail ? 1 : 0);
