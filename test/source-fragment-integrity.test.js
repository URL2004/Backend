'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const korean = require('../engine-gpt-prod/koreanRefinement');
const { humanizeStableCore } = require('../engine-gpt-prod/prompts/humanize/stableCore');
const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');
const code = 'source_editing_fragment_candidate';
const broken = '이 유형은 목표를 세우고 그것을 성향 검사 결과 나의 유형은 달성하기 위해 꾸준히 움직인다.';
const fixed = '이 유형은 목표를 세우고 그것을 달성하기 위해 꾸준히 움직인다.';
test('inherited editing fragment enters source hints and residual audit, without regex deletion', () => {
  assert.match(korean.buildSourcePromptHints(broken), new RegExp(code));
  const audit = korean.analyzeKoreanRefinement({ source: broken, outputText: broken });
  assert.ok(audit.repairableCodes.includes(code));
  assert.equal(audit.issues.find(i => i.code === code).introducedCount, 0);
  assert.equal(korean.applySafeDeterministicRepairs({source: broken, outputText: broken}).text, broken);
  assert.ok(!korean.analyzeKoreanRefinement({source: broken, outputText: fixed}).issueCodes.includes(code));
});
for (const text of [
  fixed,
  '나는 그것을 내 동생이 이루기 위해 노력한다는 사실을 알고 있었다.',
  '이 유형은 목표를 세우고 그것을 자신이 원하는 방식으로 달성하기 위해 노력한다.',
  '그 목표는 어렵지만 그것을 내 동생은 이루기 위해 노력한다.',
  `그는 “${broken}”라고 적었다.`,
  `\`\`\`text\n${broken}\n\`\`\``,
  `| 문장 |\n| --- |\n| ${broken} |`
]) test('normal clauses and locked literals are not deletion targets: ' + text.slice(0, 22), () => {
  assert.ok(!korean.detectTextIssues(text).some(i => i.code === code));
});
for (const promptVariant of ['full', 'compact_v1']) test('all prompt variants separate preserved meaning from inherited syntax ' + promptVariant, () => {
  const prompt = humanizeStableCore(null, {promptVariant});
  assert.match(prompt, /오탈자/u);
  assert.match(korean.buildSourcePromptHints(broken), /모호|불확실/u);
});
test('tentative negation remains distinct from outer personal opinion', () => {
  const source = '계획된 행사만이 성공적인 행사는 아닐 수도 있겠다는 생각이 들었다.';
  const result = '계획된 행사만이 성공적인 행사는 아니라는 생각이 들었다.';
  assert.ok(auditRelationCandidates(source, result).candidates.some(c => c.code === 'certainty_scope_candidate'));
  assert.ok(!auditRelationCandidates(source, source).candidates.some(c => c.code === 'certainty_scope_candidate'));
});
test('observed thought is not silently promoted to known thought', () => {
  const source = '팀원들이 다른 경로를 생각하는 모습을 보며 선택을 이해했다.';
  const result = '팀원들은 다른 경로를 생각했다. 그 선택을 이해했다.';
  assert.ok(auditRelationCandidates(source, result).candidates.some(c => c.code === 'certainty_scope_candidate'));
});
test('a second clause hedge cannot conceal lost tentative negation', () => {
  const source = '예정된 행사만 성공적인 것은 아닐 수도 있으며 우연한 만남이 행사를 풍성하게 만들 수도 있다.';
  const output = '예정된 행사만 성공적인 것은 아니며 우연한 만남이 행사를 풍성하게 만들 수도 있다.';
  assert.ok(auditRelationCandidates(source, output).codes.includes('certainty_scope_candidate'));
  assert.ok(!auditRelationCandidates('예정된 행사만 성공적인 것은 아닐 수도 있다.', '예정된 행사만 성공적인 것은 아니라고 볼 수도 있다.').codes.includes('certainty_scope_candidate'));
});
test('same operands changing from alternatives to conjunction require early review', () => {
  const a = '참가자의 신청서나 최근 기록을 바탕으로 상담 내용을 구성하고 다음 면담을 준비했다.';
  const b = '참가자의 신청서와 최근 기록을 바탕으로 상담 내용을 구성했다. 다음 면담도 준비했다.';
  assert.ok(auditRelationCandidates(a,b).codes.includes('alternative_conjunction_candidate'));
  for (const normal of [a, '참가자의 신청서 또는 최근 기록을 바탕으로 상담 내용을 구성하고 다음 면담을 준비했다.'])
    assert.ok(!auditRelationCandidates(a,normal).codes.includes('alternative_conjunction_candidate'));
  assert.ok(!auditRelationCandidates('참가자의 신청서와 최근 기록을 바탕으로 상담 내용을 구성했다.', b).codes.includes('alternative_conjunction_candidate'));
});
test('split observation nominates changed subject ownership without judging active-passive grammar', () => {
  const source = '모양은 달랐지만 여러 조형물들이 전시장 안에 모여 조화를 이루는 걸 보면서 구성의 중요성을 느꼈다.';
  const changed = '모양이 다른 조형물을 전시장에 모은 작가들이 조화를 이루는 모습을 보았다. 구성의 중요성을 느꼈다.';
  const result = auditRelationCandidates(source, changed);
  assert.ok(result.codes.includes('observation_ownership_candidate'));
  assert.equal(result.candidateOnly, true);
  for (const same of [source, '모양이 다른 조형물들이 전시장에 모여 조화를 이루는 모습을 보았다. 구성의 중요성을 느꼈다.'])
    assert.ok(!auditRelationCandidates(source, same).codes.includes('observation_ownership_candidate'));
});
