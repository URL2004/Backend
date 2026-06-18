'use strict';
// [tools/_run-faithful-batch.js] 실사용 글들을 "보존형 강한 스타일"(runHumanizeChunked + FORMAL_HUMAN+앵커)로
//   일괄 변환·채점. 재구성(칼럼톤) 결과와 head-to-head 비교용. 숫자 보존 + 프록시.
//   실행: FORMAL_HUMAN=1 STYLE_ANCHOR=1 LLM_BACKEND=api node tools/_run-faithful-batch.js
require('dotenv').config({ path: '.env' });
process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'api';
process.env.FORMAL_HUMAN = process.env.FORMAL_HUMAN || '1';
process.env.STYLE_ANCHOR = process.env.STYLE_ANCHOR || '1';
const fs = require('fs');
const analyze = require('../routes/analyze');
const proxy = require('../engine/copykiller-proxy');

const chars = s => String(s || '').replace(/\s/g, '').length;
const OUTDIR = '../문서/03_원문-결과-분석';

// 재구성(칼럼톤) 실측치 — 비교 기준
const SOURCES = [
  { file: 'samples/ev.txt', label: '전기차(데이터)', slug: '전기차', restruct: '100%' },
  { file: 'samples/privacy.txt', label: '개인정보(추상)', slug: '개인정보', restruct: '69%' },
  { file: 'samples/space.txt', label: '우주(추상)', slug: '우주', restruct: '65%' },
  { file: 'samples/birth.txt', label: '저출산(논증)', slug: '저출산', restruct: '25%' },
];

function excerpt(text, maxChars = 1800) {
  const paras = text.split(/\n{2,}/); let out = [], n = 0;
  for (const p of paras) { const c = chars(p); if (n + c > maxChars && out.length) break; out.push(p.trim()); n += c; if (n >= maxChars) break; }
  return out.join('\n\n');
}

(async () => {
  const rows = [];
  for (const src of SOURCES) {
    const text = excerpt(fs.readFileSync(src.file, 'utf8').trim());
    const o0 = proxy.predict(text).composite_risk;
    process.stdout.write(`■ ${src.label} (발췌 ${chars(text)}자, 프록시 ${o0.toFixed(3)}) 보존형강... `);
    let result = '';
    try {
      const out = await analyze.runHumanizeChunked({
        text, mode: 'assignment', lang: 'ko', signal: AbortSignal.timeout(170000),
        floorV2: true, optIn: false, judge: true, grounding: true, userNotes: '',
      });
      result = (out && out.result && out.result.outputText) || '';
    } catch (e) { console.log('실패:', e.message); continue; }
    if (!result) { console.log('결과없음'); continue; }
    const r = proxy.predict(result).composite_risk;
    console.log(`프록시 ${r.toFixed(3)} | ${chars(result)}자 (재구성 ${src.restruct})`);
    rows.push({ label: src.label, o0, r, restruct: src.restruct });
    const md = `# 보존형 강한스타일 — ${src.label} (측정용 / 2026-06-18)\n프록시 원문 ${o0.toFixed(3)} → 변환 ${r.toFixed(3)} (재구성 칼럼톤 실측 ${src.restruct})\n\n---\n\n## ① 원문(발췌)\n\n${text}\n\n---\n\n## ② 보존형 강한스타일 변환\n\n${result}\n`;
    fs.writeFileSync(`${OUTDIR}/보존형강-${src.slug}-2026-06-18.md`, md, 'utf8');
  }
  let s = '# 보존형 강한스타일 vs 재구성 — 프록시 비교 (2026-06-18)\n\n| 문서 | 원문 | 보존형강(프록시) | 재구성(실측) |\n|---|---|---|---|\n';
  for (const r of rows) s += `| ${r.label} | ${r.o0.toFixed(3)} | ${r.r.toFixed(3)} | ${r.restruct} |\n`;
  s += '\n(보존형강은 프록시 추정 — 카피킬러 실측 필요. 보존형은 숫자·사실 전부 보존)\n';
  fs.writeFileSync(`${OUTDIR}/보존형강-요약-2026-06-18.md`, s, 'utf8');
  console.log('\n' + s);
})().catch(e => { console.error('실패:', e.stack || e.message); process.exit(1); });
