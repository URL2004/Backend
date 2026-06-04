// [eval/runEval.js] FLOOR 가드 결정론 평가 하네스 (LLM 없음 — 비용 0, CI 가능)
// ────────────────────────────────────────────────────────────────
// 라벨된 케이스(guard-cases.js)에 가드를 돌려 기대 판정과 대조.
// recall(잡아야 할 위반을 잡았나) + FP(안 잡아야 할 걸 잡았나=오탐) 리포트.
// 보고서 §8.9(guard 정밀도 1급 요구) · §11/§12 CI hard gate(deterministic guard pass).
//
// 실행:  node eval/runEval.js   (또는 npm run eval)
// 종료코드: 불일치 1건이라도 있으면 1 (CI 실패).

const floor = require('../engine/floor');
const cases = require('./guard-cases');

let pass = 0, fail = 0;
const fails = [];

function check(name, ok, detail) {
  if (ok) { pass++; }
  else { fail++; fails.push(`${name} — ${detail}`); }
}

for (const c of cases) {
  const povSeed = floor.computePovSeed(c.input);
  const e = c.expect || {};

  // novelty
  if (e.noveltyHas || e.noveltyCount0) {
    const nov = floor.measureNovelty(c.input, c.output);
    if (e.noveltyHas) {
      const missing = e.noveltyHas.filter(t => !nov.items.some(it => it.includes(t) || t.includes(it)));
      check(c.name, missing.length === 0, `novelty 누락(recall): ${missing.join(', ')} | 검출=${JSON.stringify(nov.items)}`);
    }
    if (e.noveltyCount0) {
      check(c.name, nov.count === 0, `novelty 오탐(FP): ${JSON.stringify(nov.items)}`);
    }
  }

  // pov drift
  if (typeof e.povDrift === 'boolean') {
    const d = floor.measurePovDrift(c.input, c.output, povSeed);
    check(c.name, d.introducedFirstPerson === e.povDrift,
      `pov 기대=${e.povDrift} 실제=${d.introducedFirstPerson} (in=${d.input_fp_singular} out=${d.output_fp_singular})`);
  }

  // fake internal refs (thesis)
  if (e.fakeRefHas || e.fakeRefCount0) {
    const fake = floor.measureFakeInternalRefs(c.input, c.output);
    if (e.fakeRefHas) {
      const missing = e.fakeRefHas.filter(t => !fake.fabricated.some(it => it.includes(t) || t.includes(it)));
      check(c.name, missing.length === 0, `fakeRef 누락(recall): ${missing.join(', ')} | 검출=${JSON.stringify(fake.fabricated)}`);
    }
    if (e.fakeRefCount0) {
      check(c.name, fake.count === 0, `fakeRef 오탐(FP): ${JSON.stringify(fake.fabricated)}`);
    }
  }

  // length status
  if (e.lengthStatus) {
    const len = floor.measureLength(c.input, c.output, c.mode);
    check(c.name, len.status === e.lengthStatus, `length 기대=${e.lengthStatus} 실제=${len.status} (ratio=${len.ratio})`);
  }
}

console.log('\n════════ FLOOR 가드 결정론 EVAL ════════');
console.log(`케이스 ${cases.length}개 · 검사 ${pass + fail}건 · 통과 ${pass} · 실패 ${fail}`);
if (fails.length) {
  console.log('\n[실패]');
  fails.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  console.log('');
  process.exit(1);
} else {
  console.log('✅ 전부 통과 (recall + FP 무결)\n');
}
