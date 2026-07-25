#!/usr/bin/env node
// [eval/runJudgeEval.js] semanticJudge 정확도 평가 (held-out, LLM) — P1.5 Tier 2
// ────────────────────────────────────────────────────────────────
// 라벨 세트(judge-cases.js)로 judge를 돌려 recall(날조 검출) + FP(충실한데 오탐)를 수치화.
// 과적합 측정용 — judge를 바꿀 때마다 돌려 한 곳 고치다 다른 곳 깨지는지 확인.
// 케이스마다 OpenAI 호출(ledger+judge 2콜)이라 비용·시간이 든다.
//
// 실행:  node eval/runJudgeEval.js   (또는 npm run eval:judge)
const judge = require('../engine-gpt-prod/judge');
const cases = require('./judge-cases');

(async () => {
  let tp = 0, fn = 0, tn = 0, fp = 0, err = 0;
  const rows = [];
  for (const c of cases) {
    try {
      const ledger = await judge.buildSoftClaimLedger(c.source, { lang: c.lang });
      const v = await judge.semanticJudge(c.source, c.output, ledger, { lang: c.lang });
      const pass = v.pass;
      let tag;
      if (c.expectPass && pass) { tn++; tag = '✅ pass'; }
      else if (c.expectPass && !pass) { fp++; tag = '⚠️ FP(오탐)'; }
      else if (!c.expectPass && !pass) { tp++; tag = '✅ 검출'; }
      else { fn++; tag = '❌ 놓침(FN)'; }
      rows.push(`${tag}  ${c.name}  [claims ${ledger.claims.length}, 위반 ${v.violations.length}]`);
    } catch (e) {
      err++;
      rows.push(`💥 err  ${c.name}: ${e.message}`);
    }
  }
  const shouldFail = tp + fn;
  const shouldPass = tn + fp;
  console.log('\n════════ semanticJudge EVAL (held-out · LLM) ════════');
  rows.forEach(r => console.log('  ' + r));
  console.log(`\n검출 recall: ${tp}/${shouldFail}  ·  오탐 FP: ${fp}/${shouldPass}  ·  에러: ${err}/${cases.length}`);
  if (fp > 0) console.log('⚠️ 오탐 있음 → judge가 충실한 의역을 위반으로 잡음(precision 손상)');
  if (fn > 0) console.log('⚠️ 놓침 있음 → judge가 날조를 통과시킴(recall 손상)');
  if (fp === 0 && fn === 0 && err === 0) console.log('✅ 전부 정상 (recall+precision 무결)');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
