// [_anchor-v4.js] 목소리앵커 v4 드라이버 — 수리 순서 재구성(짝 교정 수치보존 → 재위빙 → judge 게이트+수리) 검증용 임시 스크립트
try { require('dotenv').config(); } catch { /* 무시 */ }
process.env.LLM_BACKEND = 'api';
const fs = require('fs');
const gt = require('./engine/genretransfer');

const text = fs.readFileSync('samples/ai-learning.txt', 'utf8').trim();
const evidence = fs.readFileSync('samples/ai-learning-evidence.txt', 'utf8');

gt.genreTransferV2(text, { skeleton: 'debate_explainer', evidence }).then(r => {
  const judgeStr = r.judge?.error ? 'ERR ' + r.judge.error
    : r.judge?.pass ? 'pass'
    : (r.judge?.violations || []).map(v => v.type).join(',');
  console.log('genreRisk', r.risk.score, '| 분량', Math.round(r.lenRatio * 100) + '%',
    '| novelty', r.novelty.count, '| lost', r.lostFacts.count,
    '| 짝위반', r.pairing.length, '| judge', judgeStr);
  if (r.lostFacts.count) console.log('빠진 사실:', r.lostFacts.items.join(', '));
  for (const v of (r.judge?.violations || [])) console.log(`judge ${v.type}: "${(v.span || '').slice(0, 80)}" — ${(v.detail || '').slice(0, 100)}`);
  const leak = /갭투자|전세|보증금|임대인|다주택|집값|월세|슬럼화|직주근접/.test(r.text);
  const meta = /(메모\s*:|밝힙니다|지시에\s*따라|삽입하지\s*않)/.test(r.text);
  console.log('앵커번짐:', leak ? '⚠️' : '0 ✅', '| 메타:', meta ? '⚠️' : '0 ✅');
  fs.writeFileSync('results/ai-learning-목소리앵커-v5.md',
    `# AI학습 — 목소리 앵커 v5(슬롯 짝게이트 감점화 + 짝교정 수치보존 + judge 게이트+문장수리) · 카피킬러 측정용\n\n`
    + `> novelty ${r.novelty.count} · lostFacts ${r.lostFacts.count} · 짝위반 ${r.pairing.length} · judge ${r.judge?.pass ? 'pass' : '확인'} · 분량 ${Math.round(r.lenRatio * 100)}%\n\n---\n\n${r.text}\n`, 'utf8');
  console.log('저장: results/ai-learning-목소리앵커-v5.md');
}).catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
