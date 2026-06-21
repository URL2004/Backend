'use strict';
// [tools/_test-fidelity-guard.js] 무날조 가드 회귀 테스트.
//   실물: samples/housing-future-essay.txt(원문) vs results/reranker-winner.txt(통계청·2.4배 날조 포함)
//   실행: node tools/_test-fidelity-guard.js
const fs = require('fs');
const { checkFabrication } = require('../engine/experimental/fidelity-guard');

let pass = true;
function chk(name, cond, extra) {
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? '  ' + extra : ''));
  if (!cond) pass = false;
}

const orig = fs.readFileSync('samples/housing-future-essay.txt', 'utf8');

// 1) 원문↔원문: 새로 생긴 게 없어야 함(오탐 0)
chk('원문↔원문: 날조 없음(ok)', checkFabrication(orig, orig).ok);

// 2) 실물 raw winner: 통계청·2.4배·에 따르면 적발
if (fs.existsSync('results/reranker-winner.txt')) {
  const raw = fs.readFileSync('results/reranker-winner.txt', 'utf8');
  const r = checkFabrication(orig, raw);
  chk('raw winner: 날조 적발(ok=false)', !r.ok);
  chk("raw winner: '통계청' 신규출처 적발", r.addedSources.includes('통계청'));
  chk("raw winner: '2.4배' 신규수치 적발(소절 2.4. 마스킹 극복)", r.addedNumbers.some(n => n.includes('2.4')));
  chk("raw winner: '에 따르면' 귀속 적발", r.attributions.length > 0);
  console.log('   detail:', JSON.stringify({ nums: r.addedNumbers, src: r.addedSources, attr: r.attributions, cite: r.addedCitations }));
} else {
  console.log('   (results/reranker-winner.txt 없음 — 실물 테스트 건너뜀)');
}

// 3) 보존 수치 오탐 없음(15시간·30분은 원문에 있음 가정)
const a = '맞벌이 부부는 주당 15시간을 가사에 쓴다. 출퇴근은 30분이다.';
const b = '맞벌이 부부는 주당 15시간을 가사 노동에 쓰고, 출퇴근에 하루 30분을 쓴다.';
chk('보존수치(15,30) 오탐 없음', checkFabrication(a, b).ok);

// 4) 신규 수치 적발
const c = b + ' 전문직 딩크족은 최근 10년 사이 2.4배 늘었다.';
const r4 = checkFabrication(a, c);
chk('신규수치(2.4배) 적발', r4.addedNumbers.some(n => n.includes('2.4')));

// 5) 신규 귀속(국토교통부에 따르면) 적발
const d = a + ' 국토교통부에 따르면 교통약자가 전체의 30%다.';
const r5 = checkFabrication(a, d);
chk("신규 귀속('국토교통부에 따르면') 적발", r5.attributions.length > 0 || r5.addedSources.includes('국토교통부'));

// 6) 신규 (저자, 2023) 인용 적발
chk('신규 인용(저자,2023) 적발', !checkFabrication('주장이 있다.', '주장이 있다 (Kim, 2023).').ok);

console.log(pass ? '\n전체 통과 ✅' : '\n실패 ❌ — 위 항목 확인');
process.exitCode = pass ? 0 : 1;
