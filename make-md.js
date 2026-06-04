#!/usr/bin/env node
// [make-md.js] 입력 글을 엔진에 돌려 결과를 .md로 저장.
// 사용: node make-md.js <입력> <mode> <lang> <출력.md>
//   영문은 optIn=true로 화자 게이트(한국어 전용) 오작동 회피. novelty/length 가드는 적용.
const fs = require('fs');
process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claudecode';
const [, , inFile, mode = 'assignment', lang = 'en', outFile = 'result.md'] = process.argv;
const analyze = require('./routes/analyze');
const text = fs.readFileSync(inFile, 'utf8').trim();

(async () => {
  const t0 = Date.now();
  const out = await analyze.runHumanize({ text, mode, lang, floorV2: true, optIn: lang === 'en' });
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  const r = out.result;
  const fl = r.floorLength || {};
  const nov = r.floorNovelty || {};
  const md =
    `# Humanized — ${mode}/${lang}\n\n` +
    `> FLOOR v2 엔진 · LLM_BACKEND=${process.env.LLM_BACKEND} · ${sec}s · refine=${out.refineReason || '-'}\n` +
    `> 가드: novelty ${nov.count ?? '?'}건${nov.count ? ' (' + (nov.items || []).join(', ') + ')' : ''} · ` +
    `length ${fl.ratio ?? '?'}(${fl.status ?? '?'}) · povDrift ${out.povDrift ? out.povDrift.introducedFirstPerson : '?'}\n\n` +
    `---\n\n` + (r.outputText || '(없음)') + '\n';
  fs.writeFileSync(outFile, md, 'utf8');
  console.log(`✅ wrote ${outFile}`);
  console.log(`   novelty=${JSON.stringify(nov.items || [])} length=${fl.ratio}(${fl.status}) refine=${out.refineReason} ${sec}s`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
