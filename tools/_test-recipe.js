'use strict';
// [tools/_test-recipe.js] 새 글 3개 × 레시피(재구성 debate + 입장메모) 검증. 변환문만 측정용 MD 출력.
//   실행: LLM_BACKEND=api node tools/_test-recipe.js
require('dotenv').config({ path: '.env' });
process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'api';
const fs = require('fs');
const gt = require('../engine/genretransfer');
const proxy = require('../engine/copykiller-proxy');
const chars = s => String(s || '').replace(/\s/g, '').length;
const OUTDIR = '../문서/03_원문-결과-분석';

const SOURCES = [
  {
    file: 'samples/sample-management-ko.txt', slug: '경영',
    memo: '내 생각엔 요즘 기업이 흔들리는 건 시장이 빨라져서가 아니라, 빠른 척하는 전략만 베끼고 자기 기준이 없어서다. 예측을 포기하고 대응만 반복하면 결국 시장에 끌려다니게 된다.',
  },
  {
    file: 'samples/nk-report.txt', slug: '북한정보통제',
    memo: '나는 북한의 정보 통제가 단순한 억압이 아니라 체제 유지의 핵심 설계라고 본다. 외부 정보가 새어 들어가는 순간 통제의 전제 자체가 무너지기 때문이다. 그래서 통제는 느슨해지는 게 아니라 더 정교해진다.',
  },
];

function excerpt(text, maxChars = 1700) {
  const paras = text.split(/\n{2,}/); let out = [], n = 0;
  for (const p of paras) {
    const c = chars(p);
    if (n + c > maxChars && out.length) break;
    if (c > maxChars - n) {   // 단일 문단이 너무 길면 문장 경계로 하드캡(과압축 방지)
      const sents = p.split(/(?<=[.!?]|다\.)\s+/); let buf = '';
      for (const s of sents) { if (chars(buf + s) > maxChars - n && buf) break; buf += s + ' '; }
      if (buf.trim()) out.push(buf.trim());
      break;
    }
    out.push(p.trim()); n += c;
    if (n >= maxChars) break;
  }
  return out.join('\n\n');
}

(async () => {
  const rows = [];
  for (const s of SOURCES) {
    const text = excerpt(fs.readFileSync(s.file, 'utf8').trim());
    const o0 = proxy.predict(text).composite_risk;
    process.stdout.write(`■ ${s.slug} (발췌 ${chars(text)}자, 프록시 ${o0.toFixed(3)}) 재구성+메모... `);
    let raw = '';
    try {
      const out = await gt.genreTransferV2(text, { skeleton: 'debate_explainer', userNotes: s.memo, lang: 'ko', signal: AbortSignal.timeout(170000) });
      raw = out.text || '';
      if (raw) console.log(`프록시 ${proxy.predict(raw).composite_risk.toFixed(3)} | ${chars(raw)}자 | 사실손실 ${out.lostFacts && out.lostFacts.count}`);
    } catch (e) { console.log('실패:', e.message); continue; }
    if (!raw) { console.log('결과없음'); continue; }
    rows.push({ slug: s.slug, o0, r: proxy.predict(raw).composite_risk });
    fs.writeFileSync(`${OUTDIR}/레시피검증-${s.slug}-2026-06-18.md`,
      `# 레시피검증 — ${s.slug} (변환문만, 카피킬러 측정용 / 2026-06-18)\n\n[넣은 입장메모]\n${s.memo.split('\n').map(l => '· ' + l).join('\n')}\n\n아래 변환문만 카피킬러에 넣으세요.\n\n---\n\n${raw}\n`, 'utf8');
  }
  console.log('\n=== 요약(프록시 추정 — 실측 필요) ===');
  for (const r of rows) console.log(`${r.slug}: 원문 ${r.o0.toFixed(3)} → 변환 ${r.r.toFixed(3)}`);
})().then(() => process.exit(0), e => { console.error(e.stack || e.message); process.exit(1); });
