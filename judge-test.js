#!/usr/bin/env node
// [judge-test.js] Soft Claim Ledger + semanticJudge 데모: 충실한 출력 vs 날조된 출력.
// 사용: node judge-test.js   (LLM_BACKEND 미설정 시 claudecode)
if (!process.env.LLM_BACKEND) process.env.LLM_BACKEND = 'claudecode';
const judge = require('./engine/judge');

const source = '디지털 기술은 사람들 사이 관계의 깊이를 얕게 만들 수 있다. 온라인 소통은 빠르지만 비언어적 신호가 빠져 오해가 생기기 쉽다.';
const goodOut = '디지털 기술이 관계의 밀도를 떨어뜨릴 수 있다. 온라인 소통은 신속하지만 표정 같은 신호가 없어 오해를 부르기 쉽다.';
const badOut = '디지털 기술은 관계를 얕게 만든다. 앞으로 10년 후에는 대면 소통이 완전히 사라질 것이다. 솔직히 나는 그 변화가 두렵다.';

function line() { console.log('─'.repeat(60)); }
(async () => {
  console.log(`LLM_BACKEND=${process.env.LLM_BACKEND}`);
  line();
  const ledger = await judge.buildSoftClaimLedger(source, { lang: 'ko' });
  console.log(`[Soft Claim Ledger] 추출 ${ledger.total} · 채택 ${ledger.claims.length} · 폐기(evidence 미매칭) ${ledger.dropped}`);
  ledger.claims.forEach((c, i) => console.log(`  ${i + 1}. ${c.claim}\n     ev: "${c.evidence_text}"`));
  line();
  const g = await judge.semanticJudge(source, goodOut, ledger, { lang: 'ko' });
  console.log(`[충실한 출력] pass=${g.pass}  위반 ${g.violations.length}건`);
  g.violations.forEach(v => console.log(`  ⚠️ [${v.type}] "${v.span}" — ${v.detail}`));
  line();
  const b = await judge.semanticJudge(source, badOut, ledger, { lang: 'ko' });
  console.log(`[날조된 출력] pass=${b.pass}  위반 ${b.violations.length}건`);
  b.violations.forEach(v => console.log(`  ⚠️ [${v.type}] "${v.span}" — ${v.detail}`));
  line();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
