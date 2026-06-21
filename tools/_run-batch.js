'use strict';
// [tools/_run-batch.js] 실사용 가정 글 N개를 칼럼톤(debate)으로 일괄 변환·채점.
//   긴 글은 문단 경계로 ~1800자 발췌(단일패스 적정). meta-strip+날조제거+프록시. 문서별 측정 MD + 요약.
//   실행: LLM_BACKEND=api node tools/_run-batch.js
require('dotenv').config({ path: '.env' });
process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'api';
const fs = require('fs');
const gt = require('../engine/genretransfer');
const proxy = require('../engine/copykiller-proxy');
const { checkFabrication, stripFabricatedSentences } = require('../engine/experimental/fidelity-guard');
const { stripSectionMeta } = require('../engine/experimental/meta-strip');

const chars = s => String(s || '').replace(/\s/g, '').length;
const OUTDIR = '../문서/03_원문-결과-분석';
const TIMEOUT = Number(process.env.GT_TIMEOUT_MS || 130000);

// 실사용 가정 — 학생이 실제 제출할 만한 주제 essay 5종
const SOURCES = [
  { file: 'samples/ev.txt', label: '전기차 캐즘과 배터리 산업', slug: '전기차' },
  { file: 'samples/privacy.txt', label: '디지털 개인정보 보호', slug: '개인정보' },
  { file: 'samples/health.txt', label: '현대인 건강관리와 생활습관', slug: '건강' },
  { file: 'samples/space.txt', label: '우주 탐사의 필요성', slug: '우주' },
  { file: 'samples/birth.txt', label: '저출산 고령화 대응', slug: '저출산' },
];

// 긴 글은 문단 경계 기준 ~maxChars(공백제외)까지 발췌
function excerpt(text, maxChars = 1800) {
  const paras = text.split(/\n{2,}/);
  let out = [], n = 0;
  for (const p of paras) {
    const c = chars(p);
    if (n + c > maxChars && out.length) break;
    out.push(p.trim()); n += c;
    if (n >= maxChars) break;
  }
  return out.join('\n\n');
}

async function convert(text) {
  const signal = AbortSignal.timeout(TIMEOUT);
  const { candidates } = await gt.genreTransferV2Candidates(text, { lang: 'ko', skeletons: ['debate_explainer'], signal });
  const c = candidates[0];
  if (!c || c.error) return { error: c ? c.error : 'no candidate' };
  let t = stripSectionMeta(c.text || '');
  const fab = checkFabrication(text, t);
  const rep = fab.ok ? { text: t, dropped: [] } : stripFabricatedSentences(text, t);
  t = stripSectionMeta(rep.text); // 날조제거 후 한 번 더(잔재 정리)
  return { text: t, risk: proxy.predict(t).composite_risk, dropped: rep.dropped.length, chars: chars(t) };
}

(async () => {
  const rows = [];
  for (const src of SOURCES) {
    const raw = fs.readFileSync(src.file, 'utf8').trim();
    const text = excerpt(raw);
    const origRisk = proxy.predict(text).composite_risk;
    process.stdout.write(`■ ${src.label} (발췌 ${chars(text)}자, 프록시 ${origRisk.toFixed(3)}) 칼럼톤 생성...`);
    const r = await convert(text);
    if (r.error) { console.log(` 실패: ${r.error}`); continue; }
    console.log(` 프록시 ${r.risk.toFixed(3)} | 날조제거 ${r.dropped} | ${r.chars}자`);
    rows.push({ label: src.label, origRisk, risk: r.risk });
    const md = `# 실사용 배치 — ${src.label} (칼럼톤 / 측정용 / 2026-06-18)
**프록시**: 원문(발췌) ${origRisk.toFixed(3)} → 변환 ${r.risk.toFixed(3)}

---

## ① 원문(발췌)

${text}

---

## ② 칼럼톤 변환

${r.text}
`;
    fs.writeFileSync(`${OUTDIR}/실사용-${src.slug}-2026-06-18.md`, md, 'utf8');
  }
  let summary = '# 실사용 5글 칼럼톤 — 프록시 요약 (2026-06-18)\n\n| 문서 | 원문(발췌) | 칼럼톤 변환 |\n|---|---|---|\n';
  for (const r of rows) summary += `| ${r.label} | ${r.origRisk.toFixed(3)} | ${r.risk.toFixed(3)} |\n`;
  summary += '\n(프록시는 출력 예측 신뢰 낮음 — 각 MD를 카피킬러로 실측 필요)\n';
  fs.writeFileSync(`${OUTDIR}/실사용-요약-2026-06-18.md`, summary, 'utf8');
  console.log('\n' + summary);
})().catch(e => { console.error('실패:', e.stack || e.message); process.exit(1); });
