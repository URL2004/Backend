// [tools/_test-floor-english.js] 영어 FLOOR 세이프 검증: 영어 입력은 novelty/experience를 경고로(전달),
//   한국어 입력은 그대로 하드 차단(날조 보호 유지).
const floor = require('../engine/floor');
const enRaw = 'Final Report: Cultural Psychology and Organizational Transformation. Albert Bandura Socio-Cognitive Theory and Self-Efficacy. Steve Jobs Transformational Leadership at Apple. Larry Page and Sergey Brin Collaborative Open Systems at Google. Samsung Lee Kun-hee New Management.';
const koRaw = '반두라의 사회인지이론은 자기효능감을 핵심으로 한다. 삼성 이건희 회장의 신경영은 품질 경영을 강조했다. 애플 스티브 잡스는 변혁적 리더십을 보였다.';

function run(rawText, over) {
  const r = floor.buildFloorReport({ result: { outputText: 'rewritten output text here for testing purposes.', floorLength: { status: 'ok', ratio: 1 }, povDrift: {}, ...over }, rawText, mode: 'assignment', povSeed: {}, optIn: false });
  return { status: r.status, criticals: r.criticals.map(c => c.gate), warnings: r.warnings.map(w => w.gate) };
}
const novLost = { floorNovelty: { count: 3, items: ['Company Primary Leaders', 'Centralized High Standards', 'Open Leadership'] }, lostFacts: { count: 2, items: ['Self-Efficacy', 'Korea'] }, repetition: { count: 0, fuzzyCount: 0, total: 0 } };

let fail = 0;
function check(c, m) { if (!c) { fail++; console.log('  ❌ ' + m); } else console.log('  ✅ ' + m); }

console.log('=== 영어 입력: novelty/lostFacts → 경고(전달) ===');
const en = run(enRaw, novLost);
console.log(`  status=${en.status} crit=[${en.criticals}] warn=[${en.warnings}]`);
check(en.status !== 'blocked', '영어 글 차단 안 됨(전달)');
check(en.warnings.includes('novelty') && en.warnings.includes('lostFacts'), 'novelty·lostFacts가 경고에');

console.log('\n=== 한국어 입력: novelty → 하드 차단(날조 보호 유지) ===');
const ko = run(koRaw, { floorNovelty: { count: 1, items: ['가짜기관'] }, lostFacts: { count: 0, items: [] }, repetition: { count: 0, fuzzyCount: 0, total: 0 } });
console.log(`  status=${ko.status} crit=[${ko.criticals}] warn=[${ko.warnings}]`);
check(ko.status === 'blocked' && ko.criticals.includes('novelty'), '한국어 날조 → 차단 유지');

console.log('\n' + (fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`));
process.exit(fail === 0 ? 0 : 1);
