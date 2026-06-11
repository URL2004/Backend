#!/usr/bin/env node
// [genre-test.js] Genre Profile Transfer 로컬 러너 (MVP 실험용)
// 사용법: node genre-test.js <입력파일> [genre] — genre: news_explainer(기본) | policy_column | data_report
//   EVIDENCE=파일 → 승인 근거 사용. LLM_BACKEND=api 권장(Sonnet 생성 다수).
try { require('dotenv').config(); } catch { /* 무시 */ }
const fs = require('fs');
const path = require('path');
if (!process.env.LLM_BACKEND) process.env.LLM_BACKEND = 'api';

const [, , fileArg, genreArg = 'news_explainer'] = process.argv;
if (!fileArg) { console.error('사용법: node genre-test.js <입력파일> [genre]'); process.exit(1); }
const text = fs.readFileSync(path.resolve(fileArg), 'utf8').trim();
let evidence = process.env.EVIDENCE_TEXT || '';
if (!evidence && process.env.EVIDENCE && fs.existsSync(process.env.EVIDENCE)) evidence = fs.readFileSync(process.env.EVIDENCE, 'utf8');

const gt = require('./engine/genretransfer');
const gf = require('./engine/genreframes');

// V2 후보 모드: node genre-test.js <파일> v2 — skeleton 3종 생성 → genreRiskScore 최저 선택
if (genreArg === 'v2') {
  (async () => {
    const t0 = Date.now();
    console.log(`🚀 GenreTransfer V2 (후보 3종)  입력 ${text.length}자  evidence ${evidence ? evidence.split('\n').filter(Boolean).length + '건' : '없음'}`);
    const r = await gt.genreTransferV2Candidates(text, { evidence });
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('\n=== 후보별 결과 ===');
    for (const c of r.candidates) {
      if (c.error) { console.log(`· ${c.skeleton}: ❌ ${c.error}`); continue; }
      const d = c.risk.detail;
      console.log(`· ${c.skeleton}: risk ${c.risk.score} (사람 1.3~2.8 / v1출력 14.75) | 분량 ${Math.round(c.lenRatio * 100)}% | novelty ${c.novelty.count} | lost ${c.lostFacts.count} | judge ${c.judge?.pass ? 'pass' : c.judge?.error ? 'ERR' : '위반' + (c.judge?.violations?.length ?? '?')} | 프레임 R${d.research.length}/H${d.explainerHeadings.length}/S${d.explainerSentences.length} | CV ${d.paragraphLenCV} 교훈 ${d.formulaEndingRatio} 괄호다양 ${d.openerDiversity}`);
    }
    if (!r.winner) { console.error('❌ 출고 가능 후보 없음'); process.exit(1); }
    const w = r.winner;
    console.log(`\n🏆 선택: ${w.skeleton} (risk ${w.risk.score})`);
    console.log(`⏱ ${sec}s\n`);
    console.log(w.text.slice(0, 1200) + '\n…(전문은 파일)');
    const outName = path.basename(fileArg).replace(/\.[^.]+$/, '') + '-genreV2.md';
    fs.writeFileSync(path.join('results', outName),
      `# ${path.basename(fileArg)} — GenreTransfer V2(${w.skeleton}) · 카피킬러 측정용\n\n> skeleton slot-filling·후보3종 중 risk 최저. risk ${w.risk.score}(사람 1.3~2.8) · novelty ${w.novelty.count} · lostFacts ${w.lostFacts.count} · judge ${w.judge?.pass ? 'pass' : '확인'} · 분량 ${Math.round(w.lenRatio * 100)}%\n\n---\n\n${w.text}\n`, 'utf8');
    console.log(`\n저장: results/${outName}`);
  })().catch(e => { console.error('❌', e.message); process.exit(1); });
  return;
}

(async () => {
  const t0 = Date.now();
  console.log(`🚀 GenreTransfer  genre=${genreArg}  입력 ${text.length}자  evidence ${evidence ? evidence.split('\n').filter(Boolean).length + '건' : '없음'}`);
  const inProfile = gt.extractDocProfile(text);
  console.log(`입력 진단: badFrame=${inProfile.badFrame.hits.length ? '⚠️ [' + inProfile.badFrame.hits.join(' | ') + ']' : '없음'}`);

  const r = await gt.genreTransfer(text, { genre: genreArg, evidence });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\n[출력]\n');
  console.log(r.text);
  console.log('\n' + '─'.repeat(64));
  console.log(`⏱ ${sec}s | 분량비(vs 원문∪근거) ${Math.round(r.lenRatio * 100)}% | ledger claims ${r.claims}`);
  console.log(`📐 plan: "${r.plan.title}" — ${r.plan.sections.map(s => s.role).join(' → ')}`);
  const a = r.artifacts;
  console.log(`🧬 artifacts: badFrame ${a.badFrameCount} | 괄호/1000자 ${a.parenPer1000}(목표 ${a.target.parenPer1000}) | 의문문 ${a.questionPer1000}(${a.target.questionPer1000}) | 숫자 ${a.numberPer1000}(${a.target.numberPer1000}) | 문단CV ${a.paragraphLenCV} | 교훈마무리 ${a.formulaEndingRatio}`);
  console.log(`🛡 FLOOR: novelty ${r.novelty.count}${r.novelty.count ? ' ⚠️ [' + r.novelty.items.join(', ') + ']' : ' ✅'} | lostFacts ${r.lostFacts.count}${r.lostFacts.count ? ' ⚠️ [' + r.lostFacts.items.slice(0, 8).join(', ') + ']' : ' ✅'}`);
  console.log(`⚖ judge: ${r.judge?.error ? 'ERROR ' + r.judge.error : r.judge.pass ? 'pass ✅' : '⚠️ 위반 ' + r.judge.violations.length + '건: ' + r.judge.violations.map(v => v.type).join(', ')}`);

  const outName = path.basename(fileArg).replace(/\.[^.]+$/, '') + '-genre-' + genreArg + '.md';
  fs.writeFileSync(path.join('results', outName),
    `# ${path.basename(fileArg)} — 장르전환(${genreArg}) · 카피킬러 측정용\n\n> 연구보고서 골격 → ${genreArg}. novelty ${r.novelty.count} · lostFacts ${r.lostFacts.count} · judge ${r.judge?.pass ? 'pass' : '확인'} · 분량 ${Math.round(r.lenRatio * 100)}%\n\n---\n\n${r.text}\n`, 'utf8');
  console.log(`\n저장: results/${outName}`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
