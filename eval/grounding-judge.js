// [eval/grounding-judge.js] FLOOR 경계 — judge층 검증 (LLM 필요, deterministic eval과 분리).
// 사용:  node eval/grounding-judge.js        (claudecode 기본)
//        $env:LLM_BACKEND="api"; node eval/grounding-judge.js   (API)
//
// grounding-cases.js 의 catcher:'judge' 케이스에 대해:
//   - allowed   는 semanticJudge 통과(pass=true) 해야 하고,
//   - forbidden 은 added_claim/distortion으로 잡혀야(pass=false) 한다.
// catcher:'novelty' 케이스는 결정론 measureNovelty가 잡으므로 runEval(데이터)에서 확인.

if (!process.env.LLM_BACKEND) process.env.LLM_BACKEND = 'claudecode';
const judge = require('../engine/judge');
const cases = require('./grounding-cases').filter(c => c.catcher === 'judge');

(async () => {
  let fail = 0;
  for (const c of cases) {
    const ledger = await judge.buildSoftClaimLedger(c.source, { lang: 'ko' });
    const okV = await judge.semanticJudge(c.source, c.allowed, ledger, { lang: 'ko' });
    const badV = await judge.semanticJudge(c.source, c.forbidden, ledger, { lang: 'ko' });
    const pass = okV.pass === true && badV.pass === false;
    if (!pass) fail++;
    console.log(`${pass ? '✅' : '❌'} ${c.id}  allowed.pass=${okV.pass}  forbidden.pass=${badV.pass}`);
    if (!badV.pass) badV.violations.forEach(v => console.log(`     ⚠ [${v.type}] "${v.span}"`));
    if (!okV.pass) okV.violations.forEach(v => console.log(`     FP! [${v.type}] "${v.span}"`));
  }
  console.log(fail ? `\n${fail}건 실패` : `\n전부 통과 — judge층 경계 OK (allowed 통과, forbidden 적중)`);
  process.exit(fail ? 1 : 0);
})();
