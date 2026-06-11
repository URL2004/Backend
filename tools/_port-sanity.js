// 이식 결정론 sanity (1회용 드라이버 — 검증 후 삭제)
const P = require('./engine/prompt');
const F = require('./engine/floor');
const E = require('./engine/evidenceguard');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : (fail++, console.log('  ❌ ' + name)); };

// ① 앵커: assignment+ko+anchorIdx → 앵커 포함, 회전, 토글, polite 단서, blog/EN 제외
const s0 = P.buildSystemPrompt('assignment', 'ko', { anchorIdx: 0 });
const s1 = P.buildSystemPrompt('assignment', 'ko', { anchorIdx: 1 });
ok('앵커 포함(idx0)', s0.includes('목소리 앵커') && s0.includes('갭투자'));
ok('회전(idx0≠idx1)', s0 !== s1 && s1.includes('운영유지관리비용'));
ok('앵커 헤더 디프레이밍', !P.ANCHOR_HEADER.includes('카피킬러') && !P.ANCHOR_HEADER.includes('탐지') && !P.ANCHOR_HEADER.includes('0~2%'));
const sP = P.buildSystemPrompt('assignment', 'ko', { anchorIdx: 0, register: 'polite' });
ok('polite 단서', sP.includes('앵커의 평어체를 베끼지 마라'));
ok('anchorIdx 없으면 미포함', !P.buildSystemPrompt('assignment', 'ko', {}).includes('목소리 앵커'));
ok('blog 미포함', !P.buildSystemPrompt('blog', 'ko', { anchorIdx: 0 }).includes('목소리 앵커'));
process.env.STYLE_ANCHOR = '0';
ok('STYLE_ANCHOR=0 해제', !P.buildSystemPrompt('assignment', 'ko', { anchorIdx: 0 }).includes('목소리 앵커'));
delete process.env.STYLE_ANCHOR;

// ② 앵커 누출: 원문에 없는 부동산 어휘만 위반
ok('누출 적중', P.findAnchorLeaks('마치 갭투자로 집을 넓혀가듯 학습도 그렇다.', '학습 효율에 대한 글').includes('갭투자'));
ok('원문 실재 시 허용', P.findAnchorLeaks('전세 시장이 흔들린다.', '전세 제도의 위기에 대한 원문').length === 0);

// ③ 메타·윙크·용어귀속(floor)
ok('메타 메모 적중', F.findMetaLeaks('본문이다.\n\n미삽입 항목 처리 메모: 일부는 삽입하지 않았음을 밝힙니다.', '원문').length > 0);
ok('윙크 적중', F.findMetaLeaks('문제는 거기에 있다(아, 이 표현 쓰지 말라고 했지).', '원문').length > 0);
ok('원문 실재 메타 허용', F.findMetaLeaks('지원 동기를 밝힙니다.', '저의 지원 동기를 밝힙니다.').length === 0);
ok('용어귀속 적중', F.findCoinedTerms("심리학에서는 '정-반 효과'라고 부르기도 한다.", '루틴에 관한 원문').length === 1);
ok('원문 실재 용어 허용', F.findCoinedTerms("이를 '습관 고리'라고 부른다.", "원문에 습관 고리 개념이 있다").length === 0);

// ④ collectFloorViolations 통합(anchors 플래그)
const mk = (out, raw, anchors) => F.collectFloorViolations({ result: { outputText: out }, rawText: raw, povSeed: F.computePovSeed(raw), optIn: false, mode: 'assignment', chunkLevel: true, anchors });
ok('cFV anchor_leak(플래그 on)', mk('갭투자처럼 공부한다. 본문 내용 길게 이어진다.', '공부 방법에 대한 본문 내용 길게 이어진다.', true).some(v => v.type === 'anchor_leak'));
ok('cFV anchor_leak(플래그 off 미검사)', !mk('갭투자처럼 공부한다. 본문 내용 길게 이어진다.', '공부 방법에 대한 본문 내용 길게 이어진다.', false).some(v => v.type === 'anchor_leak'));
ok('cFV meta_leak', mk('내용이다. 위 지침에 따라 본문만 출력했다.', '내용이다.', false).some(v => v.type === 'meta_leak'));

// ⑤ 짝 검증(evidenceguard 이동 후 동작 보존)
const ev = ['오픈서베이 2025 조사에서 대학생 45.9%가 AI 활용능력에 자신이 없다고 답했다.', '스위스 연구진은 666명을 대상으로 비판적 사고를 조사했다.'];
const badFusion = '1차 조사에 참여한 666명 중 45.9%가 자신이 없다고 했다. 이 결과는 의미심장하다.';
ok('재조합 융합 검출', E.checkEvidencePairing(badFusion, ev).length > 0);
const good = '오픈서베이 조사에서 대학생 45.9%가 활용능력에 자신이 없다고 답했다.';
ok('정상 인용 통과', E.checkEvidencePairing(good, ev).length === 0);
// 재인용 dedupe
const doc = '오픈서베이 조사에서 45.9%가 자신 없다고 답했다.\n\n다른 문단이다. 앞서 본 대로 45.9%가 자신 없다고 답했다.';
const dd = E.dedupeFactRecitations(doc, ev, '원문\n' + ev.join('\n'));
ok('재인용 제거', (dd.match(/45\.9/g) || []).length === 1);

// ⑥ judge augmented ledger(네트워크 없이 구조만)
const src = require('fs').readFileSync('./engine/judge.js', 'utf8');
ok('judge approvedFacts 시그니처', src.includes('approvedFacts') && src.includes('augmented'));

console.log(`\n이식 sanity: ${pass}통과 / ${fail}실패`);
process.exit(fail ? 1 : 0);
