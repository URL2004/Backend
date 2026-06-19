// [tools/_eval-factast-pairs.js] FACT_AST 실평가 — 실제 88 원문→휴머나이징 쌍에 flag off vs on 측정 델타.
//   목적: 켰을 때 novelty/lostFacts(차단에 영향) 게이트가 실제로 어떻게 바뀌는지 + 변화가 옳은지 육안 확인.
const fs = require('fs');
const floor = require('../engine/floor');
function withFlag(v, fn) { const o = process.env.FACT_AST; if (v) process.env.FACT_AST = '1'; else process.env.FACT_AST = '0'; try { return fn(); } finally { if (o === undefined) delete process.env.FACT_AST; else process.env.FACT_AST = o; } }
const pairs = JSON.parse(fs.readFileSync(__dirname + '/_eval-pairs.json', 'utf8'));

let novChanged = 0, lostChanged = 0, novDown = 0, novUp = 0, lostDown = 0, lostUp = 0;
const changed = [];
for (const p of pairs) {
  const nOff = withFlag(false, () => floor.measureNovelty(p.raw, p.out));
  const nOn = withFlag(true, () => floor.measureNovelty(p.raw, p.out));
  const lOff = withFlag(false, () => floor.measureLostFacts(p.raw, p.out));
  const lOn = withFlag(true, () => floor.measureLostFacts(p.raw, p.out));
  const dNov = nOn.count - nOff.count, dLost = lOn.count - lOff.count;
  if (dNov !== 0) { novChanged++; if (dNov < 0) novDown++; else novUp++; }
  if (dLost !== 0) { lostChanged++; if (dLost < 0) lostDown++; else lostUp++; }
  if (dNov !== 0 || dLost !== 0) {
    const setItems = (a) => new Set(a.map(x => String(x)));
    const offNov = setItems(nOff.items), onNov = setItems(nOn.items);
    const novGone = [...offNov].filter(x => !onNov.has(x));   // off엔 있었는데 on엔 없는 novelty(거짓 신규 제거)
    const novNew = [...onNov].filter(x => !offNov.has(x));     // on에서 새로 잡힌 novelty(부호역전 등)
    changed.push({ num: p.num, mode: p.mode, dNov, dLost, novGone: novGone.slice(0, 6), novNew: novNew.slice(0, 6) });
  }
}

console.log(`=== 88쌍 실평가: FACT_AST off vs on ===`);
console.log(`novelty 변화: ${novChanged}건 (감소 ${novDown} / 증가 ${novUp})`);
console.log(`lostFacts 변화: ${lostChanged}건 (감소 ${lostDown} / 증가 ${lostUp})`);
console.log(`\n--- 변화 상세 (감소=거짓 신규/누락 제거, 증가=부호역전 등 진짜 감지) ---`);
for (const c of changed) {
  console.log(`#${c.num}[${c.mode}] Δnov=${c.dNov} Δlost=${c.dLost}`
    + (c.novGone.length ? `  거짓novelty제거: ${c.novGone.join(', ')}` : '')
    + (c.novNew.length ? `  새novelty: ${c.novNew.join(', ')}` : ''));
}
if (!changed.length) console.log('(변화 없음 — 이 배치엔 복합수량·부호 사실이 게이트에 영향 준 쌍이 없음)');
