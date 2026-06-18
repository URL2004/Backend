'use strict';
require('dotenv').config({ path: '.env' });
process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'api';
const gt = require('../engine/genretransfer');
const fs = require('fs');
(async () => {
  const text = fs.readFileSync('samples/ev-excerpt.txt', 'utf8').trim();
  const r = await gt.genreTransferV2Candidates(text, { lang: 'ko', skeletons: ['debate_explainer'], signal: AbortSignal.timeout(170000) });
  const raw = (r.candidates[0] && r.candidates[0].text) || '';
  console.log('=== 엔진 raw(측정도구 strip 전) 숫자 ===');
  for (const n of ['2,000만', '2,300만', '4분의 1', '15.7%', '96.9GWh', '수백만', '상당한 수준']) console.log((raw.includes(n) ? 'OK ' : 'X  ') + n);
  console.log('사실손실:', r.candidates[0] && r.candidates[0].lostFacts && r.candidates[0].lostFacts.count);
  const proxy = require('../engine/copykiller-proxy');
  const pr = proxy.predict(raw);
  console.log('프록시 composite:', pr.composite_risk.toFixed(3), '| 간접화법:', (pr['tag:간접 화법, 비인칭 서술'] || 0).toFixed(3));
  fs.writeFileSync('results/ev-raw-debug.txt', raw, 'utf8');
})().then(() => process.exit(0), e => { console.error(e.message); process.exit(1); });
