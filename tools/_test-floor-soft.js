// [tools/_test-floor-soft.js] C 검증: 청크 경로 FLOOR에서 lostFacts·소반복은 소프트(전달), novelty·다수반복은 하드(차단).
const floor = require('../engine/floor');
const base = { outputText: '오늘 항공 시장은 빠르게 변하고 있다. 가격 경쟁이 심화된다.', floorLength: { status: 'ok', ratio: 1 }, povDrift: {} };
function run(over) {
  const r = floor.buildFloorReport({ result: { ...base, ...over }, rawText: '항공 시장은 빠르게 변한다. 가격 경쟁이 심하다.', mode: 'assignment', povSeed: {}, optIn: false });
  return { status: r.status, criticals: r.criticals.map(c => c.gate), warnings: r.warnings.map(w => w.gate) };
}
const cases = [
  { name: 'lostFacts 1 + 반복 exact1 (둘 다 소프트→전달)', over: { floorNovelty: { count: 0, items: [] }, lostFacts: { count: 1, items: ['1,235만'] }, repetition: { count: 1, fuzzyCount: 0, total: 1 } }, expectBlocked: false, mustWarn: ['lostFacts', 'repetition'] },
  { name: 'novelty 1 (날조 → 하드 차단)', over: { floorNovelty: { count: 1, items: ['가짜기관'] }, lostFacts: { count: 0, items: [] }, repetition: { count: 0, fuzzyCount: 0, total: 0 } }, expectBlocked: true, mustCrit: ['novelty'] },
  { name: '반복 exact 3 (다수 반복 → 하드 차단)', over: { floorNovelty: { count: 0, items: [] }, lostFacts: { count: 0, items: [] }, repetition: { count: 3, fuzzyCount: 0, total: 3 } }, expectBlocked: true, mustCrit: ['repetition'] },
];
let fail = 0;
for (const c of cases) {
  const r = run(c.over);
  const blocked = r.status === 'blocked';
  let ok = blocked === c.expectBlocked;
  if (c.mustWarn) ok = ok && c.mustWarn.every(g => r.warnings.includes(g));
  if (c.mustCrit) ok = ok && c.mustCrit.every(g => r.criticals.includes(g));
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'} ${c.name} → status=${r.status} crit=[${r.criticals}] warn=[${r.warnings}]`);
}
console.log(fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`);
process.exit(fail === 0 ? 0 : 1);
