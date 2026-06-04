#!/usr/bin/env node
// [make-md.js] 입력 글을 엔진에 돌려 결과를 .md로 저장.
// 사용: node make-md.js <입력> <mode> <lang> <출력.md>
//   영문은 optIn=true로 화자 게이트(한국어 전용) 오작동 회피. novelty/length 가드는 적용.
const fs = require('fs');
process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claudecode';
const [, , inFile, mode = 'assignment', lang = 'en', outFile = 'result.md'] = process.argv;
const analyze = require('./routes/analyze');
const text = fs.readFileSync(inFile, 'utf8').trim();

const doJudge = process.env.JUDGE === '1';

(async () => {
  const t0 = Date.now();
  const out = await analyze.runHumanize({ text, mode, lang, floorV2: true, optIn: lang === 'en', judge: doJudge ? 'force' : false });
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  const r = out.result;
  const fl = r.floorLength || {};
  const nov = r.floorNovelty || {};
  const sd = r.softDrift || {};
  let judgeLine = '';
  if (r.judge) {
    judgeLine = r.judge.ran
      ? `> semanticJudge: ${r.judge.pass ? 'pass ✅' : '⚠️ 위반 ' + r.judge.violations.length + '건'} (claims ${r.judge.claims}, rounds ${r.judge.rounds ?? '-'})\n`
      : `> semanticJudge: skip (${r.judge.reason || r.judge.error})\n`;
    (r.judge.violations || []).forEach(v => { judgeLine += `>   - [${v.type}] "${(v.span || '').slice(0, 60)}" — ${v.detail}\n`; });
  }
  const ct = r.contract || {};
  const rep = r.repetition || {};
  const inLen = text.replace(/\s+/g, '').length;
  const outLen = (r.outputText || '').replace(/\s+/g, '').length;
  const fr = out.floorReport || { status: '?', criticals: [] };
  const critLine = fr.criticals && fr.criticals.length
    ? ' — ' + fr.criticals.map(c => `${c.gate}(${c.detail})`).join(', ')
    : '';
  const md =
    `# Humanized — ${mode}/${lang}\n\n` +
    `## 엔진 리포트 (FLOOR v2)\n` +
    `- 🚦 **출고 판정: ${String(fr.status).toUpperCase()}**${fr.status === 'blocked' ? ' (노출 차단)' : ''}${critLine}\n` +
    `- LLM_BACKEND: ${process.env.LLM_BACKEND} · 소요 ${sec}s · refine: ${out.refineReason || '-'}\n` +
    `- 입력 ${inLen}자 → 출력 ${outLen}자 (분량비 **${fl.ratio ?? '?'}**, ${fl.status ?? '?'}; 목표 ${ct.lengthPolicy ? ct.lengthPolicy.min + '~' + ct.lengthPolicy.max : '-'})\n` +
    `- ★ 화자 보존(pov): 원문 1인칭 ${out.povDrift ? out.povDrift.input_fp_singular : '?'} → 출력 ${out.povDrift ? out.povDrift.output_fp_singular : '?'} → ${out.povDrift && out.povDrift.introducedFirstPerson ? '⚠️ 새 1인칭 주입' : '✅ 보존'} (화자게이트 ${ct.speakerGateClosed ? 'closed' : 'open'})\n` +
    `- ★ 신규 사실(novelty): ${nov.count ?? '?'}건 ${nov.count ? '⚠️ (' + (nov.items || []).join(', ') + ')' : '✅'}\n` +
    `- ★ 사실 증발(lost facts): ${(r.lostFacts && r.lostFacts.count) ? '⚠️ ' + r.lostFacts.count + '건 (' + r.lostFacts.items.join(', ') + ')' : '0건 ✅'}\n` +
    `- ★ 결론 반복(repetition): ${rep.count ? '⚠️ ' + rep.count + '건' : '0건 ✅'}\n` +
    `- soft drift (judge 후보): ${sd.flagged ? '⚠️ flagged' : 'none ✅'} · added=${JSON.stringify(sd.added || {})} · modalΔ=${sd.modalShift ?? '-'}\n` +
    (judgeLine ? judgeLine : '') +
    `\n---\n\n` + (r.outputText || '(없음)') + '\n';
  fs.writeFileSync(outFile, md, 'utf8');
  console.log(`✅ wrote ${outFile}`);
  console.log(`   🚦 ${String(fr.status).toUpperCase()}${critLine} | length=${fl.ratio}(${fl.status}) novelty=${nov.count} lost=${(r.lostFacts||{}).count} judge=${r.judge ? (r.judge.ran ? (r.judge.pass ? 'pass' : 'fail') : 'skip') : '-'} ${sec}s`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
