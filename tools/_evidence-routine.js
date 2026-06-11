// [_evidence-routine.js] routine 글 evidence Phase1 검색(임시) — 추상 segment에 붙일 실재 사실 후보 수집
// 환각 게이트(collectResultUrls) 통과 후보만 출력. 승인(사용자) 전에는 절대 본문에 위빙하지 않는다.
try { require('dotenv').config(); } catch { /* 무시 */ }
const fs = require('fs');
const { suggestEvidence } = require('./engine/evidence');

const text = fs.readFileSync('samples/routine.txt', 'utf8').trim();

suggestEvidence(text, { lang: 'ko', maxSegments: 5 }).then(r => {
  const segs = r.segments || r.candidates || r;
  let n = 0;
  const lines = [];
  for (const seg of (Array.isArray(segs) ? segs : [])) {
    const cands = seg.candidates || [];
    if (!cands.length) continue;
    lines.push(`\n■ segment: "${(seg.segText || seg.text || '').replace(/\s+/g, ' ').slice(0, 80)}…"`);
    for (const c of cands) {
      n++;
      lines.push(`  [${n}] ${c.fact || c.text || JSON.stringify(c).slice(0, 150)}`);
      lines.push(`      출처: ${c.sourceTitle || ''} ${c.sourceUrl || c.url || ''}`);
    }
  }
  console.log(lines.join('\n') || JSON.stringify(r, null, 2).slice(0, 3000));
  console.log(`\n총 후보 ${n}건(환각 게이트 통과분)`);
  fs.writeFileSync('results/_routine-evidence-candidates.json', JSON.stringify(r, null, 2), 'utf8');
  console.log('원본 저장: results/_routine-evidence-candidates.json');
}).catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
