// injectOwnerMarkers 검증 — 실사고 재현(47↛MBC 보도)
const { checkEvidencePairing, injectOwnerMarkers } = require('../engine/evidenceguard');
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log('FAIL: ' + n)); };

const ev = ['MBC 보도(2024)에 따르면, 국내 숏폼 앱 월간 사용시간이 2019년 대비 47% 증가했다.'];
// 위반: 수치 47이 출처 앵커 없이 떠돎(±2문장 내 MBC·숏폼앱 등 소유 앵커 부재)
const doc = '사람들이 영상을 보는 시간은 해마다 늘었다. 짧은 영상 시청은 5년 사이 47% 늘었다는 통계도 있다. 누구나 체감하는 변화다.\n\n다음 문단은 무관한 이야기다.';
const before = checkEvidencePairing(doc, ev);
ok('위반 사전 검출', before.length === 1 && before[0].num === '47');

const fixed = injectOwnerMarkers(doc, before, ev);
ok('출처 표지 삽입', /47%?\(MBC 기준\)/.test(fixed));
const after = checkEvidencePairing(fixed, ev);
ok('위반 해소', after.length === 0);
ok('본문 보존', fixed.includes('누구나 체감하는 변화다') && fixed.includes('무관한 이야기다'));

// 위반 없는 문서는 불변
const cleanDoc = 'MBC 보도에 따르면 숏폼 사용시간이 47% 늘었다. 큰 변화다.';
ok('정상 문서 불변', injectOwnerMarkers(cleanDoc, checkEvidencePairing(cleanDoc, ev), ev) === cleanDoc);

console.log(`inject-owner: ${pass}통과 / ${fail}실패`);
process.exit(fail ? 1 : 0);
