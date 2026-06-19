// [tools/_test-airate-parity.js] ai%-정렬 모델 JS 런타임이 Python 학습값과 일치하는지 회귀 가드.
//   값은 _export_airate.py 직후 측정한 Python 점수(동일 4 텍스트). 모델 재학습 시 이 기대값도 갱신할 것.
const fs = require('fs');
const path = require('path');
const p = require('../engine/copykiller-proxy');

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ❌ ' + m); } else console.log('  ✅ ' + m); };

ok(p.airateAvailable(), 'airate 모델 로드됨');

const tx = JSON.parse(fs.readFileSync(path.join(__dirname, '../../오늘-원문-휴머나이징-2026-06-19.json'), 'utf8'));
const cases = [
  [tx[0]['원문'], 0.7554],
  [tx[0]['휴머나이징된글'], 0.7450],
  [tx[5]['원문'], 0.7859],
  [tx[20]['휴머나이징된글'], 0.7099],
];
for (let i = 0; i < cases.length; i++) {
  const [t, expect] = cases[i];
  const got = p.predictAiRate(t);
  ok(Math.abs(got - expect) < 0.001, `case#${i} JS=${got.toFixed(4)} ≈ PY=${expect}`);
}

console.log('\n' + (fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`));
process.exit(fail === 0 ? 0 : 1);
