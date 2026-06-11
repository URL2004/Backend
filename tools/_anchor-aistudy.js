// [_anchor-aistudy.js] 일반화 검증 3호 — 연구보고서 골격 과제(서론/본론/결론, 최악 장르 원형) 임시 드라이버
// 36~43% 레시피(앵커 + 승인 근거) 그대로. evidence = ai-learning 17건 재사용(동주제, 기승인).
// 참고문헌 목록은 입력에서 제외(칼럼 본문 변환 대상 아님 — 저자명 토큰이 위빙 왜곡).
try { require('dotenv').config(); } catch { /* 무시 */ }
process.env.LLM_BACKEND = 'api';
const fs = require('fs');
const gt = require('./engine/genretransfer');

const text = fs.readFileSync('samples/ai-study-report.txt', 'utf8').trim();
const evidence = fs.readFileSync('samples/ai-learning-evidence.txt', 'utf8');

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
  fs.writeFileSync('results/ai-study-목소리앵커-v1.md',
    `# AI학습보고서(서론본론결론 골격) — 목소리 앵커 v1(앵커 + 승인 근거 17건 재사용) · 카피킬러 측정용\n\n`
    + `> novelty ${r.novelty.count} · lostFacts ${r.lostFacts.count} · 짝위반 ${r.pairing.length} · judge ${r.judge?.pass ? 'pass' : '확인'} · 분량 ${Math.round(r.lenRatio * 100)}%\n\n---\n\n${r.text}\n`, 'utf8');
  console.log('저장: results/ai-study-목소리앵커-v1.md');
}).catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
