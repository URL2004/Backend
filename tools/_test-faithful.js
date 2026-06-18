'use strict';
// [tools/_test-faithful.js] 보존형(faithful) 경로가 데이터 글의 숫자를 보존하며 탐지를 낮추는지 검증.
//   실행: LLM_BACKEND=api node tools/_test-faithful.js [파일]
require('dotenv').config({ path: '.env' });
process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'api';
const fs = require('fs');
const analyze = require('../routes/analyze');
const proxy = require('../engine/copykiller-proxy');

(async () => {
  const file = process.argv[2] || 'samples/ev-excerpt.txt';
  const text = fs.readFileSync(file, 'utf8').trim();
  const chars = s => String(s || '').replace(/\s/g, '').length;
  console.log('원문', chars(text), '자, 프록시', proxy.predict(text).composite_risk.toFixed(3));
  console.log('보존형(assignment) 변환 중...');
  const out = await analyze.runHumanizeChunked({
    text, mode: 'assignment', lang: 'ko', signal: AbortSignal.timeout(150000),
    floorV2: true, optIn: false, judge: true, grounding: true, userNotes: '',
  });
  const result = (out && out.result && out.result.outputText) || '';
  if (!result) { console.log('결과 없음:', JSON.stringify(out && out.floorReport && out.floorReport.criticals || out).slice(0, 300)); process.exit(1); }
  console.log('변환', chars(result), '자, 프록시', proxy.predict(result).composite_risk.toFixed(3));
  console.log('=== 숫자 생존 ===');
  for (const n of ['2,000만', '2,300만', '4분의 1', '15.7%', '96.9GWh', '수백만']) console.log((result.includes(n) ? '✅' : '❌') + ' ' + n);
  fs.writeFileSync('../문서/03_원문-결과-분석/전기차-보존형-2026-06-18.md', '# 전기차 보존형(faithful) 변환\n\n프록시 ' + proxy.predict(result).composite_risk.toFixed(3) + '\n\n---\n\n' + result + '\n', 'utf8');
  console.log('MD 저장');
})().catch(e => { console.error('실패:', e.stack || e.message); process.exit(1); });
