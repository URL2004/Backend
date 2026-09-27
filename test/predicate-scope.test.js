'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { predicateScopeCandidates: audit, sourceScopeHints } = require('../engine-gpt-prod/predicateScope');
const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');
const { buildHumanizeUser } = require('../engine-gpt-prod/prompts/humanize/userBlock');
const start = '참가자들은 행사 준비를 위해 점검표부터 작성하기 시작했다.';
test('beginning attaches to the edited action, not another surviving beginning verb', () => {
  for (const bad of ['참가자들은 행사 준비를 위해 점검표를 작성했다.', '참가자들은 행사 준비를 시작하면서 점검표를 먼저 작성했다.']) {
    assert.ok(audit(start,bad).includes('action_completion_candidate'));
    assert.ok(auditRelationCandidates(start,bad).codes.includes('action_completion_candidate'));
  }
});
test('unchanged, equivalent beginning, ongoing and unrelated actions are not completion candidates', () => {
  for (const good of [start, '참가자들은 행사 준비를 위해 점검표를 만들기 시작했다.', '참가자들은 행사 준비를 위해 점검표를 작성하고 있었다.', '참가자들은 점검표 작성에 착수했다.', '참가자들은 행사 준비를 시작하면서 안내문을 작성했다.'])
    assert.ok(!audit(start,good).includes('action_completion_candidate'));
  assert.ok(!audit('담당자는 점검표를 작성한 뒤 행사 준비를 시작했다.', '행사를 준비하기에 앞서 담당자는 점검표를 작성했다.').includes('action_completion_candidate'));
});
test('a retrospective interpretation cannot become plain fact', () => {
  const source = '결국 나는 그동안 자신의 선택을 정당화해온 셈이었다.';
  assert.ok(audit(source,'결국 나는 그동안 자신의 선택을 정당화해왔다.').includes('retrospective_interpretation_candidate'));
  for (const good of [source, '결국 자신의 선택을 정당화해온 셈이다.', '결국 나는 자신의 선택을 정당화해왔다고 볼 수 있었다.'])
    assert.ok(!audit(source,good).includes('retrospective_interpretation_candidate'));
  assert.deepEqual(audit('이 문제는 간단한 덧셈이었다.', '간단한 덧셈 문제였다.'),[]);
});
test('source hints are conditional, non-factual and used in the shared chunk path', () => {
  assert.equal(sourceScopeHints('자료를 비교하고 결과를 기록했다.'),'');
  for (const mode of ['blog','assignment','polish']) {
    const text = start+' 자신의 선택을 정당화해온 셈이었다.';
    const prompt = buildHumanizeUser({chunk:{text},chunks:[{text}],index:0,mode});
    assert.match(prompt,/목적어에 연결/u);
    assert.match(prompt,/사후 해석/u);
  }
});
