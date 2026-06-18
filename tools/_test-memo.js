'use strict';
// [tools/_test-memo.js] 분석글 + 사용자 입장 메모(코칭) → 간접화법·탐지 감소 검증.
//   genreTransferV2를 userNotes(메모)와 함께 호출. 메모는 허용세계라 날조 아님 — 판단을 주입해 비인칭을 깬다.
require('dotenv').config({ path: '.env' });
process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'api';
const gt = require('../engine/genretransfer');
const proxy = require('../engine/copykiller-proxy');
const fs = require('fs');
(async () => {
  const text = fs.readFileSync('samples/ev-excerpt.txt', 'utf8').trim();
  const memo = process.argv[2] ||
    '나는 한국 배터리 3사가 LFP 전환에 너무 늦었다고 본다. 삼원계 고성능만 고집한 게 결국 발목을 잡았다.\n보조금에 기대 키운 성장은 처음부터 위태로웠다고 생각한다. 정책이 만든 수요는 정책이 빠지면 그대로 무너진다.';
  const out = await gt.genreTransferV2(text, { skeleton: 'debate_explainer', userNotes: memo, lang: 'ko', signal: AbortSignal.timeout(170000) });
  const raw = out.text || '';
  const pr = proxy.predict(raw);
  console.log('프록시 composite:', pr.composite_risk.toFixed(3), '| 간접화법:', (pr['tag:간접 화법, 비인칭 서술'] || 0).toFixed(3));
  console.log('숫자:');
  for (const n of ['2,000만', '2,300만', '4분의 1', '15.7%', '96.9GWh']) console.log('  ' + (raw.includes(n) ? 'OK' : 'X') + ' ' + n);
  console.log('사실손실:', out.lostFacts && out.lostFacts.count);
  console.log('메모 입장 녹음(LFP/늦/위태/발목/무너):', /LFP|늦|위태|발목|무너/.test(raw));
  fs.writeFileSync('results/ev-memo-debug.txt', raw, 'utf8');
  fs.writeFileSync('../문서/03_원문-결과-분석/전기차-재구성+입장메모-2026-06-18.md',
    '# 전기차 — 재구성 + 사용자 입장 메모(코칭) (측정용 / 2026-06-18)\n\n[넣은 메모(사용자 의견 — 날조 아님)]\n' + memo.split('\n').map(l => '· ' + l).join('\n') + '\n\n구조변경+숫자보존+입장주입. 앞 버전(메모없음) 63% → 이건?\n\n---\n\n## ① 원문(발췌)\n\n' + text + '\n\n---\n\n## ② 변환\n\n' + raw + '\n', 'utf8');
  console.log('MD 작성');
})().then(() => process.exit(0), e => { console.error(e.message); process.exit(1); });
