// [tools/_diff-extract-factast.js] B2b 실문서 스냅샷 차등 — FACT_AST off vs on 추출 변화 점검.
//   기대: on에만 = 복합 병합본/부호 추가본. off에만 = 병합돼 사라진 조각. 그 외 변화 = FP 의심(수동 점검).
const fs = require('fs');
const floor = require('../engine/floor');
function withFlag(v, fn) { const o = process.env.FACT_AST; if (v) process.env.FACT_AST = '1'; else process.env.FACT_AST = '0'; try { return fn(); } finally { if (o === undefined) delete process.env.FACT_AST; else process.env.FACT_AST = o; } }
let totalOnlyOff = 0, totalOnlyOn = 0;
for (const f of process.argv.slice(2)) {
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch { console.log('skip', f); continue; }
  t = t.slice(0, 20000);
  const off = new Set(withFlag(false, () => floor.extractFacts(t, true)));
  const on = new Set(withFlag(true, () => floor.extractFacts(t, true)));
  const onlyOff = [...off].filter(x => !on.has(x));
  const onlyOn = [...on].filter(x => !off.has(x));
  totalOnlyOff += onlyOff.length; totalOnlyOn += onlyOn.length;
  console.log('\n##', f.split(/[\\/]/).pop(), '(off=' + off.size, 'on=' + on.size + ')');
  console.log('  off에만(병합돼 사라진 조각):', onlyOff.slice(0, 50).join(' | ') || '(없음)');
  console.log('  on에만(복합병합/부호추가):', onlyOn.slice(0, 50).join(' | ') || '(없음)');
}
console.log('\n=== 합계 onlyOff=' + totalOnlyOff, 'onlyOn=' + totalOnlyOn, '===');
