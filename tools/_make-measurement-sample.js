'use strict';
// [tools/_make-measurement-sample.js] 측정용 변환 샘플 생성(P0 가드 + 재랭커 통합).
//   후보 생성(genreTransferV2Candidates) → meta-strip → 날조문장 제거 → 프록시 채점 → 최저위험 winner.
//   원문+변환 before/after MD 출력(사장님이 카피킬러로 측정 → 트랙2 누적).
//   실행: LLM_BACKEND=api node tools/_make-measurement-sample.js <source.txt> <out.md> "<제목>"
require('dotenv').config({ path: '.env' });
process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'api';
const fs = require('fs');
const gt = require('../engine/genretransfer');
const proxy = require('../engine/copykiller-proxy');
const { checkFabrication, stripFabricatedSentences } = require('../engine/copykiller/fidelity-guard');
const { stripSectionMeta } = require('../engine/copykiller/meta-strip');

const chars = s => String(s || '').replace(/\s/g, '').length;

(async () => {
  const srcPath = process.argv[2];
  const outPath = process.argv[3] || 'results/measurement.md';
  const title = process.argv[4] || '측정 샘플';
  const text = fs.readFileSync(srcPath, 'utf8').trim();
  const origRisk = proxy.available() ? proxy.predict(text).composite_risk : null;
  console.log(`원문 ${chars(text)}자 | 프록시 ${origRisk != null ? origRisk.toFixed(3) : 'n/a'}`);
  const skeletons = (process.env.SKELETONS || 'debate_explainer,policy_column,news_article_style')
    .split(',').map(s => s.trim()).filter(Boolean);
  const timeoutMs = Number(process.env.GT_TIMEOUT_MS || 120000);
  console.log(`후보 생성 중(스켈레톤 ${skeletons.join(',')} | 타임아웃 ${timeoutMs / 1000}s)...`);
  const signal = AbortSignal.timeout(timeoutMs);
  const { candidates } = await gt.genreTransferV2Candidates(text, { lang: 'ko', skeletons, signal });

  const scored = [];
  for (const c of candidates) {
    if (c.error) { console.log(`  [${c.skeleton}] 실패: ${c.error}`); continue; }
    let t = stripSectionMeta(c.text || '');
    const fabBefore = checkFabrication(text, t);
    const rep = fabBefore.ok ? { text: t, dropped: [] } : stripFabricatedSentences(text, t);
    t = rep.text;
    const after = checkFabrication(text, t);
    const risk = proxy.predict(t).composite_risk;
    scored.push({ sk: c.skeleton, text: t, risk, fabBefore, dropped: rep.dropped, afterOk: after.ok, chars: chars(t), lost: (c.lostFacts && c.lostFacts.count) || 0 });
    console.log(`  [${c.skeleton}] 프록시 ${risk.toFixed(3)} | 날조 ${fabBefore.ok ? '없음' : '적발→' + rep.dropped.length + '문장 제거(잔여 ' + (after.ok ? '0' : 'O') + ')'} | ${chars(t)}자 | 사실손실 ${(c.lostFacts && c.lostFacts.count) || 0}`);
  }
  scored.sort((a, b) => (a.risk - b.risk));
  const w = scored[0];
  if (!w) { console.log('승자 없음'); process.exit(1); }
  const rel = origRisk ? ((1 - w.risk / origRisk) * 100).toFixed(0) : '?';
  console.log(`\n승자 [${w.sk}] 프록시 ${w.risk.toFixed(3)} (원문 ${origRisk != null ? origRisk.toFixed(3) : '?'} → ${rel}%↓), 제거된 날조문장 ${w.dropped.length}`);

  const md = `# 재랭커 결과 — ${title} (측정용 / 2026-06-17)

**측정 방법**: 아래 ①원문, ②변환 결과를 각각 통째로 복사해 카피킬러에 따로 넣고 AI작성률 비교.
**프록시 추정**: 원문 ${origRisk != null ? origRisk.toFixed(3) : '?'} → 변환 ${w.risk.toFixed(3)} (스켈레톤 ${w.sk}).
**무날조 처리**: meta-strip 적용${w.dropped.length ? ` + 날조 문장 ${w.dropped.length}개 자동 제거` : ' (날조 없음)'}.
${w.dropped.length ? '\n**제거된 날조 문장**:\n' + w.dropped.map(d => '- ~~' + d + '~~').join('\n') + '\n' : ''}
---

## ① 원문 (전문 — 그대로 복사)

${text}

---

## ② 변환 결과 (전문 — 그대로 복사)

${w.text}
`;
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`MD 작성: ${outPath}`);
})().catch(e => { console.error('실패:', e.stack || e.message); process.exit(1); });
