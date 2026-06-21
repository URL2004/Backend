'use strict';
// [tools/_compare-tones.js] 원문 N개 × 톤 2종(칼럼=debate / 격식=formal_brief) A/B 비교.
//   각 변환: meta-strip + 날조문장 제거 + 프록시 채점. 요약표 + 문서별 측정 MD 출력.
//   실행: LLM_BACKEND=api node tools/_compare-tones.js
require('dotenv').config({ path: '.env' });
process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'api';
const fs = require('fs');
const gt = require('../engine/genretransfer');
const proxy = require('../engine/copykiller-proxy');
const { checkFabrication, stripFabricatedSentences } = require('../engine/experimental/fidelity-guard');
const { stripSectionMeta } = require('../engine/experimental/meta-strip');

const chars = s => String(s || '').replace(/\s/g, '').length;
const OUTDIR = '../문서/03_원문-결과-분석';
const TONES = [
  { key: 'debate_explainer', label: '칼럼/논설톤' },
  { key: 'formal_brief', label: '격식/보고서톤' },
];
const SOURCES = [
  { file: 'samples/digital-notes-demo.txt', label: '개인 경험 메모(구체)', slug: '개인경험' },
  { file: 'samples/it.txt', label: 'IT 도구론(추상+데이터)', slug: 'IT도구론' },
  { file: 'samples/college.txt', label: '대학 생활(경험·성찰)', slug: '대학생활' },
];
const TIMEOUT = Number(process.env.GT_TIMEOUT_MS || 110000);

async function convert(text, skeleton) {
  const signal = AbortSignal.timeout(TIMEOUT);
  const { candidates } = await gt.genreTransferV2Candidates(text, { lang: 'ko', skeletons: [skeleton], signal });
  const c = candidates[0];
  if (!c || c.error) return { error: c ? c.error : 'no candidate' };
  let t = stripSectionMeta(c.text || '');
  const fab = checkFabrication(text, t);
  const rep = fab.ok ? { text: t, dropped: [] } : stripFabricatedSentences(text, t);
  t = rep.text;
  return { text: t, risk: proxy.predict(t).composite_risk, dropped: rep.dropped.length, chars: chars(t), lost: (c.lostFacts && c.lostFacts.count) || 0 };
}

(async () => {
  const rows = [];
  for (const src of SOURCES) {
    const text = fs.readFileSync(src.file, 'utf8').trim();
    const origRisk = proxy.predict(text).composite_risk;
    console.log(`\n■ ${src.label} (원문 ${chars(text)}자, 프록시 ${origRisk.toFixed(3)})`);
    const variants = {};
    for (const tone of TONES) {
      process.stdout.write(`  ${tone.label} 생성...`);
      const r = await convert(text, tone.key);
      variants[tone.key] = r;
      if (r.error) { console.log(` 실패: ${r.error}`); continue; }
      console.log(` 프록시 ${r.risk.toFixed(3)} (원문 ${origRisk.toFixed(3)}→${((1 - r.risk / origRisk) * 100).toFixed(0)}%↓) | 날조제거 ${r.dropped} | ${r.chars}자`);
      rows.push({ doc: src.label, tone: tone.label, origRisk, risk: r.risk, dropped: r.dropped, chars: r.chars });
    }
    // 문서별 측정 MD
    const md = `# 톤 비교 — ${src.label} (측정용 / 2026-06-17)
**프록시**: 원문 ${origRisk.toFixed(3)} | 칼럼 ${variants.debate_explainer && !variants.debate_explainer.error ? variants.debate_explainer.risk.toFixed(3) : 'n/a'} | 격식 ${variants.formal_brief && !variants.formal_brief.error ? variants.formal_brief.risk.toFixed(3) : 'n/a'}
각 블록을 카피킬러에 따로 넣어 비교하세요.

---

## ① 원문

${text}

---

## ② 칼럼/논설톤 변환

${variants.debate_explainer && !variants.debate_explainer.error ? variants.debate_explainer.text : '(생성 실패)'}

---

## ③ 격식/보고서톤 변환

${variants.formal_brief && !variants.formal_brief.error ? variants.formal_brief.text : '(생성 실패)'}
`;
    fs.writeFileSync(`${OUTDIR}/톤비교-${src.slug}-2026-06-17.md`, md, 'utf8');
  }

  // 요약표
  let summary = '# 톤 비교 요약 — 프록시 추정 (2026-06-17)\n\n| 문서 | 원문 | 칼럼/논설 | 격식/보고서 |\n|---|---|---|---|\n';
  for (const src of SOURCES) {
    const col = rows.find(r => r.doc === src.label && r.tone === '칼럼/논설톤');
    const fm = rows.find(r => r.doc === src.label && r.tone === '격식/보고서톤');
    const o = (col || fm || {}).origRisk;
    summary += `| ${src.label} | ${o != null ? o.toFixed(3) : '?'} | ${col ? col.risk.toFixed(3) : 'n/a'} | ${fm ? fm.risk.toFixed(3) : 'n/a'} |\n`;
  }
  summary += '\n(프록시 추정 — 실측은 각 문서 MD를 카피킬러에 넣어 확인. 낮을수록 사람 글에 가까움)\n';
  fs.writeFileSync(`${OUTDIR}/톤비교-요약-2026-06-17.md`, summary, 'utf8');
  console.log('\n=== 요약표 ===\n' + summary);
})().catch(e => { console.error('실패:', e.stack || e.message); process.exit(1); });
