// [tools/_test-proxy-parity.js] copykiller-proxy.js 런타임 예측기 회귀 가드.
//   JS 예측 로직(char_wb+word TF-IDF, LogReg, composite_risk)이 깨지지 않았는지 검증.
//   골든값은 Python(joblib)과 diff 0.000000 일치 확인된 모델에서 캡처한 값.
//   ※ 모델 재학습(copykiller_proxy.joblib 갱신) 시:
//     1) python tools/export_proxy.py 로 copykiller_proxy_model.json 재생성
//     2) 아래 GOLDEN 값을 새 모델 출력으로 갱신(이 스크립트가 출력하는 actual 값을 붙여넣기)
//     3) Python predict와 재대조(diff < 1e-6 이어야 함)
//   실행: node tools/_test-proxy-parity.js
const ck = require('../engine/copykiller-proxy');

const TOL = 1e-6;
// 고정 텍스트(절대 수정 금지 — 골든값과 1:1)
const CASES = [
  {
    name: 'abstract(추상·일반론 — 위험)',
    text: '현대 사회에서 인공지능 기술은 다양한 분야에 걸쳐 광범위하게 활용되고 있으며, 이는 우리의 삶에 지대한 영향을 미치고 있다고 할 수 있다. 이러한 변화는 앞으로도 지속될 것으로 전망된다.',
    composite_risk: 0.57615392,
    tag_gunge: 0.69905098, // tag:구체적 근거 부족
  },
  {
    name: 'concrete(경험·수치 — 안전)',
    text: '지난 3월 12일 화요일, 나는 강남역 스타벅스에서 친구 민수를 만나 2시간 동안 창업 아이템을 논의했다. 초기 자본금은 500만원으로 잡았고, 첫 달 매출은 320만원이 나왔다.',
    composite_risk: 0.30184373,
    tag_gunge: 0.20657055,
  },
];

function fail(msg) { console.error('❌ ' + msg); process.exitCode = 1; }

if (!ck.available()) {
  fail('copykiller_proxy_model.json 없음 — 모델 미배치. (export_proxy.py 실행 필요)');
  process.exit(1);
}

let allOk = true;
for (const c of CASES) {
  const p = ck.predict(c.text);
  if (!p) { fail(`${c.name}: predict()가 null`); allOk = false; continue; }
  // 1) 구조 sanity — 모든 head 확률 [0,1]
  for (const k in p) {
    if (k === 'composite_risk') continue;
    if (!(p[k] >= 0 && p[k] <= 1)) { fail(`${c.name}: ${k}=${p[k]} 범위밖`); allOk = false; }
  }
  // 2) 골든 회귀 — composite_risk / 구체근거부족
  const dCr = Math.abs(p.composite_risk - c.composite_risk);
  const dTg = Math.abs((p['tag:구체적 근거 부족'] || 0) - c.tag_gunge);
  const okCr = dCr < TOL, okTg = dTg < TOL;
  if (!okCr || !okTg) allOk = false;
  console.log(
    `${okCr && okTg ? '✅' : '❌'} ${c.name}\n` +
    `   composite_risk actual=${p.composite_risk.toFixed(8)} golden=${c.composite_risk.toFixed(8)} Δ=${dCr.toExponential(2)}\n` +
    `   구체근거부족   actual=${(p['tag:구체적 근거 부족'] || 0).toFixed(8)} golden=${c.tag_gunge.toFixed(8)} Δ=${dTg.toExponential(2)}`
  );
}
// 3) 대비 검증 — 추상이 구체보다 위험해야 코칭이 의미가 있음
const ra = ck.predict(CASES[0].text).composite_risk;
const rc = ck.predict(CASES[1].text).composite_risk;
if (ra > rc) console.log(`✅ 대비: 추상(${ra.toFixed(3)}) > 구체(${rc.toFixed(3)}) — 코칭 방향 정상`);
else { fail(`대비 역전: 추상(${ra.toFixed(3)}) <= 구체(${rc.toFixed(3)})`); allOk = false; }

console.log(allOk ? '\n전체 통과 ✅' : '\n실패 — 위 항목 확인 (모델 재학습했다면 GOLDEN 갱신 필요)');
