#!/usr/bin/env node
// [engine-test.js] 엔진 로컬 테스트 러너 (billing/auth/Firebase 없이 humanize만)
// ────────────────────────────────────────────────────────────────
// 사용법:  node engine-test.js <입력파일> [mode] [lang]
//   mode : assignment(기본) | blog | thesis | resume
//   lang : ko(기본) | en
//
// LLM_BACKEND 미설정 시 claudecode(내 Claude Code 구독 Sonnet)로 자동 설정 → API 키 불필요.
// API로 돌리려면:  $env:LLM_BACKEND="api"; $env:ANTHROPIC_API_KEY="sk-..."; node engine-test.js ...
//
// 예)  node engine-test.js samples/sample-assignment.txt assignment

const fs = require('fs');
const path = require('path');

if (!process.env.LLM_BACKEND) process.env.LLM_BACKEND = 'claudecode';
const floorV2 = process.env.FLOOR_V2 === '1';   // FLOOR_V2=1 → 화자 보존 게이트 ON
const optIn = process.env.OPT_IN === '1';       // OPT_IN=1 → "내 경험 추가" 허용
const chunked = process.env.CHUNK === '1';      // CHUNK=1 → server-side chunking 경로(자동 floorV2)
const doJudge = process.env.JUDGE === '1';      // JUDGE=1 → semanticJudge 강제 실행(P2-c)
const doAntiDetect = process.env.ANTIDETECT === '1'; // ANTIDETECT=1 → GPTZero 전용 2차 우회 패스
const doGrounding = process.env.GROUNDING === '1'; // GROUNDING=1 → source-internal stance-grounding 패스(카피킬러)
// NOTES=파일경로 또는 NOTES_TEXT=인라인 → 사용자 경험 메모(추상 문단 구체화 재료, novelty 허용)
let userNotes = process.env.NOTES_TEXT || '';
if (!userNotes && process.env.NOTES && fs.existsSync(process.env.NOTES)) userNotes = fs.readFileSync(process.env.NOTES, 'utf8');

const [, , fileArg, modeArg = 'assignment', langArg = 'ko'] = process.argv;
if (!fileArg) {
  console.error('사용법: node engine-test.js <입력파일> [assignment|blog|thesis|resume] [ko|en]');
  process.exit(1);
}
const filePath = path.resolve(fileArg);
if (!fs.existsSync(filePath)) {
  console.error(`파일 없음: ${filePath}`);
  process.exit(1);
}
const text = fs.readFileSync(filePath, 'utf8').trim();

const analyze = require('./routes/analyze');

function line() { console.log('─'.repeat(64)); }
function pct(n) { return typeof n === 'number' ? (n * 100).toFixed(0) + '%' : '–'; }

(async () => {
  console.log(`\n🚀 LLM_BACKEND=${process.env.LLM_BACKEND}  mode=${modeArg}  lang=${langArg}  FLOOR_V2=${floorV2 || chunked ? 'ON' : 'OFF'}  CHUNK=${chunked ? 'ON' : 'OFF'}  optIn=${optIn}  입력 ${text.length}자`);
  line();
  console.log('[입력 미리보기]');
  console.log(text.slice(0, 300) + (text.length > 300 ? ' …' : ''));
  line();

  const t0 = Date.now();
  let out;
  try {
    out = chunked
      ? await analyze.runHumanizeChunked({ text, mode: modeArg, lang: langArg, floorV2: true, optIn, judge: doJudge ? 'force' : false, antiDetect: doAntiDetect, grounding: doGrounding, userNotes })
      : await analyze.runHumanize({ text, mode: modeArg, lang: langArg, floorV2, optIn, judge: doJudge ? 'force' : false, antiDetect: doAntiDetect, grounding: doGrounding, userNotes });
  } catch (e) {
    console.error('❌ runHumanize 실패:', e.message);
    process.exit(1);
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  const r = out.result;

  console.log('[출력 결과]');
  console.log(r.outputText || '(없음)');
  line();

  console.log(`⏱  ${sec}s   refine: ${out.refined ? `발동(${out.refineReason})` : '없음'}`);
  if (out.preInfo) {
    console.log(`🧹 사전처리: GPT-ism ${out.preInfo.gptismCount} · 콤마분할 ${out.preInfo.commaSplitCount} · 단정정의문 ${out.preInfo.declarativeCount}`);
  }
  line();

  if (r.grounding) {
    const gd = r.grounding;
    const ba = gd.before && gd.after ? ` 의심 ${gd.before.suspect}/${gd.before.segments}→${gd.after.suspect}/${gd.after.segments}` : '';
    console.log(`🧩 grounding 패스: ${gd.applied ? '적용됨 ✅ (' + gd.repaired + '/' + gd.targets + ' 교체)' : '미적용(' + (gd.reason || '?') + ')'}${ba}`);
    line();
  }
  if (r.antiDetect) {
    console.log(`🕶  anti-detect 2차 패스: ${r.antiDetect.applied ? '적용됨 ✅' : '미적용(' + (r.antiDetect.reason || '?') + ')'}`);
    line();
  }
  const fr = out.floorReport || { status: '?', criticals: [] };
  console.log(`[🚦 출고 판정: ${String(fr.status).toUpperCase()}]${fr.criticals && fr.criticals.length ? ' criticals: ' + fr.criticals.map(c => c.gate + '(' + c.detail + ')').join(', ') : ''}`);
  line();
  console.log('[FLOOR 가드 — ★ 사실성·보존 (전 모드)]');
  const ct = r.contract || out.contract;
  if (ct) console.log(`  · contract: pov(fp단수 ${ct.povSeed.fp_singular}) 화자게이트=${ct.speakerGateClosed ? 'closed' : 'open'} 길이[${ct.lengthPolicy.min}~${ct.lengthPolicy.max}/${ct.lengthPolicy.hardMax}] ledger=${ct.softClaimLedger ? ct.softClaimLedger.claims.length + 'claims' : '-'}`);
  const pd = out.povDrift || {};
  const nov = (r.floorNovelty && r.floorNovelty.items) || r.noveltyInjectionItems || [];
  const povMark = pd.introducedFirstPerson ? (optIn ? '✅ 허용(opt-in)' : '⚠️ 새 1인칭 주입(화자 변경)') : '✅ 보존';
  console.log(`  ★ 화자 드리프트(pov)    : 원문 1인칭 ${pd.input_fp_singular ?? '?'} → 출력 ${pd.output_fp_singular ?? '?'}  ${povMark}`);
  console.log(`  ★ 신규 사실 주입(novelty): ${nov.length ? '⚠️ ' + nov.join(', ') : '0건 ✅'}`);
  if (r.fakeInternalRefs) console.log(`  ★ 허위 내부참조(thesis)  : ${r.fakeInternalRefs.count ? '⚠️ ' + r.fakeInternalRefs.fabricated.join(', ') : '0건 ✅'}`);
  const fl = r.floorLength || {};
  const lmark = fl.status === 'overHard' ? '⚠️ 과확장(hard)' : fl.status === 'overSoft' ? '△ 상한 초과(soft)' : fl.status === 'short' ? '⚠️ 분량 부족' : '✅';
  const pol = fl.policy ? `(목표 ${fl.policy.min}~${fl.policy.max}, hard ${fl.policy.hardMax})` : '';
  console.log(`  ★ 분량비(length)        : ${pct(fl.ratio ?? r.lengthRatio)} ${lmark}  ${pol}`);
  if (out.chunked) {
    const rep = out.repetition || r.repetition || {};
    console.log(`  ★ 결론 반복(repetition) : ${rep.count ? '⚠️ ' + rep.count + '건(최대 ' + rep.maxRepeat + '회)' : '0건 ✅'}`);
    console.log(`  · 청크 ${out.chunkCount}개: ${out.chunks.map(c => `${c.position}(${c.inLen}→${c.outLen})`).join(', ')}`);
  }
  const sd = r.softDrift || {};
  console.log(`  · soft drift (judge 후보): ${sd.flagged ? '⚠️ flagged' : 'none ✅'}  added=${JSON.stringify(sd.added || {})} modalΔ=${sd.modalShift ?? '-'}`);
  if (r.judge) {
    if (r.judge.ran) {
      console.log(`  ★ semanticJudge        : ${r.judge.pass ? 'pass ✅' : '⚠️ 위반 ' + r.judge.violations.length + '건'} (claims ${r.judge.claims}, evidence폐기 ${r.judge.dropped})`);
      (r.judge.violations || []).forEach(v => console.log(`      [${v.type}${v.nearest_chunk_id != null ? ' @chunk' + v.nearest_chunk_id : ''}] "${(v.span || '').slice(0, 50)}" — ${v.detail}`));
    } else {
      console.log(`  ★ semanticJudge        : skip (${r.judge.reason || r.judge.error})`);
    }
  }

  line();
  if (floorV2) {
    const fv = out.floorViolations || [];
    console.log(`[FLOOR 위반 (refine 후)] ${fv.length ? '⚠️ ' + fv.length + '건 미해결' : '없음 ✅'}`);
    fv.forEach((v, i) => console.log(`  ${i + 1}. [${v.type}] ${v.detail}`));
  } else if (out.failedFields && out.failedFields.length) {
    console.log('[legacy refine 위반 항목]');
    out.failedFields.forEach((f, i) => console.log(`  ${i + 1}. ${f.slice(0, 120)}${f.length > 120 ? '…' : ''}`));
  }

  line();
  if (out.surface) {
    const sf = out.surface, pg = sf.paragraphs || {};
    console.log('[surfaceguard — 카피킬러 대응 지표 (게이트 아님)]');
    console.log(`  문단 ${pg.total}: 구체 ${pg.concrete} / 위험 ${pg.abstractRisk} = 추상위험비율 ${pg.abstractRiskRatio} (≈카피킬러 AI구간)`);
    console.log(`  generic ${sf.genericness.ratio}(${sf.genericness.level}) · anchor ${sf.realAnchorDensity.ratio}(${sf.realAnchorDensity.level}) · stance ${sf.stanceDensity.ratio}(${sf.stanceDensity.level}) · lenCV ${sf.uniformity.lengthCV} · 종결연속 ${sf.uniformity.maxEndingRun}`);
    if (out.inputRisk && out.inputRisk.needsUserAnchor) console.log(`  ⚠️ needsUserAnchor: 원문 추상위험 ${out.inputRisk.abstractRiskRatio} — 실제 경험 메모 권장(가짜 생성 안 함)`);
    line();
  }
  const s = out.surfaceReport || {};
  console.log('[표면 시그널 — regression report (게이트 아님, §11)]');
  console.log(`  3+나열:${s.listOfThree ?? '–'}  의문문:${s.questions ?? '–'}  콤마복문:${pct(s.commaClauseRatio)}  수동:${pct(s.passiveRatio)}  장문:${pct(s.longSentenceRatio)}  추상:${pct(s.abstractRatio)}  흐름연결:${pct(s.interSentenceConnector)}  주제어max:${s.topNounMax ?? '–'}`);
  line();
  console.log('');
})();
