// [_anchor-routine2.js] routine v2 = 앵커 + 승인 evidence 10건 + 분량 구조 수정(원문 문단 직접 재료) 임시 드라이버
// 사전 예측: v1(앵커 단독) 59% → evidence로 40%대 진입 검증. 분량 49%→70%+ 목표.
try { require('dotenv').config(); } catch { /* 무시 */ }
process.env.LLM_BACKEND = 'api';
const fs = require('fs');
const gt = require('./engine/genretransfer');

const text = fs.readFileSync('samples/routine.txt', 'utf8').trim();
const evidence = fs.readFileSync('samples/routine-evidence.txt', 'utf8');

const t0 = Date.now();
gt.genreTransferV2(text, { skeleton: 'debate_explainer', evidence }).then(r => {
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  const judgeStr = r.judge?.error ? 'ERR ' + r.judge.error
    : r.judge?.pass ? 'pass'
    : (r.judge?.violations || []).map(v => v.type).join(',');
  console.log(`⏱ ${Math.floor(sec / 60)}분 ${sec % 60}초`);
  console.log('genreRisk', r.risk.score, '| 분량', Math.round(r.lenRatio * 100) + '%',
    '| novelty', r.novelty.count, '| lost', r.lostFacts.count,
    '| 짝위반', r.pairing.length, '| judge', judgeStr);
  if (r.lostFacts.count) console.log('빠진 사실:', r.lostFacts.items.slice(0, 12).join(', '));
  for (const v of (r.judge?.violations || [])) console.log(`judge ${v.type}: "${(v.span || '').slice(0, 80)}" — ${(v.detail || '').slice(0, 100)}`);
  const leak = /갭투자|전세|보증금|임대인|다주택|집값|월세|슬럼화|직주근접/.test(r.text);
  const meta = /(메모\s*:|밝힙니다|지시에\s*따라|삽입하지\s*않)/.test(r.text);
  const wink = /(표현|단어|문장|어투)[^.”"]{0,12}(쓰지\s*말|말라고\s*했|금지)/.test(r.text);
  console.log('앵커번짐:', leak ? '⚠️' : '0 ✅', '| 메타:', meta ? '⚠️' : '0 ✅', '| 윙크:', wink ? '⚠️' : '0 ✅');
  fs.writeFileSync('results/routine-목소리앵커-v4.md',
    `# 생활루틴 — 목소리 앵커 v4(이어쓰기 3회·기준 0.95 — 분량 65%→75%+ 목표) · 카피킬러 측정용\n\n`
    + `> novelty ${r.novelty.count} · lostFacts ${r.lostFacts.count} · 짝위반 ${r.pairing.length} · judge ${r.judge?.pass ? 'pass' : '확인'} · 분량 ${Math.round(r.lenRatio * 100)}%\n\n---\n\n${r.text}\n`, 'utf8');
  console.log('저장: results/routine-목소리앵커-v4.md');
}).catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });


