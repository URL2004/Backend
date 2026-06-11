// [_evidence-aistudy.js] ai-study 2차 evidence 검색(임시) — 맨몸(무근거) 문단 주제 겨냥, segment 6개
try { require('dotenv').config(); } catch { /* 무시 */ }
const fs = require('fs');
const { suggestEvidence } = require('./engine/evidence');

const text = fs.readFileSync('samples/ai-study-report.txt', 'utf8').trim();

const t0 = Date.now();
suggestEvidence(text, { lang: 'ko', maxSegments: 6 }).then(r => {
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`⏱ ${Math.floor(sec / 60)}분 ${sec % 60}초`);
  let n = 0;
  for (const c of (r.candidates || [])) {
    n++;
    console.log(`[${n}] ${c.fact}`);
    console.log(`    출처: ${c.sourceTitle || ''} ${c.sourceUrl || ''}`);
    console.log(`    segment: "${(c.segmentHead || '').replace(/\s+/g, ' ').slice(0, 60)}…"`);
  }
  console.log(`\n총 후보 ${n}건(환각 게이트 통과분)`);
  fs.writeFileSync('results/_aistudy-evidence-candidates.json', JSON.stringify(r, null, 2), 'utf8');
  console.log('원본 저장: results/_aistudy-evidence-candidates.json');
}).catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
