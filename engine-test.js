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
  console.log(`\n🚀 LLM_BACKEND=${process.env.LLM_BACKEND}  mode=${modeArg}  lang=${langArg}  FLOOR_V2=${floorV2 ? 'ON' : 'OFF'}  optIn=${optIn}  입력 ${text.length}자`);
  line();
  console.log('[입력 미리보기]');
  console.log(text.slice(0, 300) + (text.length > 300 ? ' …' : ''));
  line();

  const t0 = Date.now();
  let out;
  try {
    out = await analyze.runHumanize({ text, mode: modeArg, lang: langArg, floorV2, optIn });
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

  console.log('[FLOOR 가드 — ★ 사실성·보존 (전 모드)]');
  const pd = out.povDrift || {};
  const nov = (r.floorNovelty && r.floorNovelty.items) || r.noveltyInjectionItems || [];
  console.log(`  ★ 화자 드리프트(pov)    : 원문 1인칭 ${pd.input_fp_singular ?? '?'} → 출력 ${pd.output_fp_singular ?? '?'}  ${pd.introducedFirstPerson ? '⚠️ 새 1인칭 주입(화자 변경)' : '✅ 보존'}`);
  console.log(`  ★ 신규 사실 주입(novelty): ${nov.length ? '⚠️ ' + nov.join(', ') : '0건 ✅'}`);
  if (r.fakeInternalRefs) console.log(`  ★ 허위 내부참조(thesis)  : ${r.fakeInternalRefs.count ? '⚠️ ' + r.fakeInternalRefs.fabricated.join(', ') : '0건 ✅'}`);
  const lr = r.lengthRatio;
  let lmark = '✅';
  if (typeof lr === 'number') { if (lr > 1.3) lmark = '⚠️ 과확장'; else if (lr < 0.9) lmark = '⚠️ 분량 부족'; }
  console.log(`  ★ 분량비(length)        : ${pct(lr)} ${lmark}  (목표 0.9~1.3)`);

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
  const s = out.surfaceReport || {};
  console.log('[표면 시그널 — regression report (게이트 아님, §11)]');
  console.log(`  3+나열:${s.listOfThree ?? '–'}  의문문:${s.questions ?? '–'}  콤마복문:${pct(s.commaClauseRatio)}  수동:${pct(s.passiveRatio)}  장문:${pct(s.longSentenceRatio)}  추상:${pct(s.abstractRatio)}  흐름연결:${pct(s.interSentenceConnector)}  주제어max:${s.topNounMax ?? '–'}`);
  line();
  console.log('');
})();
