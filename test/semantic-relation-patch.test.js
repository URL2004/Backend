'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRelationPatchTargets, applyRelationPatches } = require('../engine-gpt-prod/relationPatch');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');

test('short limiting words are located inside exact paired evidence, never guessed globally', () => {
  const sourceSpan = '초반에는 활동을 단순한 연습이라고만 생각했다.';
  const candidateSpan = '처음에는 활동을 단순한 연습이라고 생각했다.';
  const source = '별도 항목은 실습이라고만 적었다. ' + sourceSpan;
  const output = '별도 항목은 실습이라고만 적었다. ' + candidateSpan + ' 이후에는 관점이 달라졌다.';
  const finding = { type: 'omission', span: '라고만', sourceSpan, candidateSpan,
    relation: 'modality_negation_causality', origin: 'introduced' };
  const grounded = groundViolation(finding, source, output);
  assert.equal(grounded.repairable, true);
  assert.equal(source.slice(grounded.spanRange.start, grounded.spanRange.end), '라고만');
  assert.ok(grounded.spanRange.start > source.indexOf('라고만'));
  assert.equal(buildRelationPatchTargets(output, [grounded]).length, 1);
  for (const change of [{ sourceSpan: sourceSpan + sourceSpan }, { candidateSpan: '없는 설명이 담긴 문장이다.' },
    { origin: 'unconfirmed' }, { origin: 'source_issue' }, { span: '없는말' }])
    assert.equal(groundViolation({ ...finding, ...change }, source, output).repairable, false);
  assert.equal(groundViolation(finding, source + ' ' + sourceSpan, output).repairable, false);
  const repeated = '이름이라고만 썼고 내용이라고만 생각했다.';
  assert.equal(groundViolation({ ...finding, sourceSpan: repeated }, repeated, output).repairable, false);
  assert.equal(groundViolation({ type: 'omission', span: '라고만' }, source, output).repairable, false);
});

test('a wide paired finding cannot fall through to unrestricted whole-document repair', async () => {
  const source = '조사자는 결과를 잠정적인 관찰이라고 설명했다.';
  const output = '조사자는 결과가 확정적인 사실이라고 설명했다.';
  const result = await require('../engine-gpt-prod/judge').repairViolations(source, output, null, [{
    type: 'distortion', span: output, sourceSpan: source, candidateSpan: output,
    relation: 'modality_negation_causality', origin: 'introduced'
  }], { config: { models: { repair: 'gpt-6-luna' } } });
  assert.equal(result.repaired, false);
  assert.equal(result.outputText, output);
  assert.equal(result.reason, 'no_bounded_relation_patch');
});

test('a confirmed relation split across four sentences has a local patch target without copying the source', () => {
  const source = '과거 연출가인 수민은 공연을 제안했지만 현재에는 기자인 하준이 자료를 공개한 경위를 추궁한다.';
  const candidate = '과거의 수민은 공연을 제안했다. 공연을 허용해야 한다는 입장이었다. 현재 하준은 기자가 되어 자료를 공개했다. 공개 경위를 두고 추궁이 이어진다.';
  const output = '앞선 장에서는 시대적 배경과 두 인물의 관계를 설명했다.\n\n'+candidate+'\n\n두 사람의 입장은 과거와 달라졌다. 마지막 장에서는 관객이 선택의 결과를 생각하도록 질문을 남긴다.';
  const finding = groundViolation({type:'omission',span:'현재에는 기자인 하준이 자료를 공개한 경위를 추궁한다.',sourceSpan:source,candidateSpan:candidate,relation:'actor_action_target',origin:'introduced'},source,output);
  const targets = buildRelationPatchTargets(output,[finding]);
  assert.equal(targets.length,1);
  const replacement = candidate.replace('공개 경위를 두고 추궁이 이어진다.','수민은 하준이 자료를 공개한 경위를 추궁한다.');
  const result = applyRelationPatches(output,targets,[{id:'R1',replacement}]);
  assert.equal(result.outputText,output.replace(candidate,replacement));
  assert.equal(result.repaired,true);
});

test('patches are atomic, IDs cannot escape their exact windows, and unknown origins cannot authorize edits', () => {
  const output='첫 문장은 변경하지 않아야 한다. 측정 결과는 기준 범위를 벗어났다. 마지막 문장도 변경하지 않는다.';
  const v={repairable:true,relationGrounded:true,origin:'introduced',candidateSpan:'측정 결과는 기준 범위를 벗어났다.'};
  const targets=buildRelationPatchTargets(output,[v]);
  for(const patches of [[],[{id:'R2',replacement:'다른 문장'}],[{id:'R1',replacement:''}],
    [{id:'R1',replacement:'수정'},{id:'R1',replacement:'중복'}]])
    assert.equal(applyRelationPatches(output,targets,patches).outputText,output);
  assert.equal(buildRelationPatchTargets(output,[{...v,origin:'unconfirmed'}]).length,0);
  assert.equal(buildRelationPatchTargets(output+output,[v]).length,0);
  assert.equal(buildRelationPatchTargets(output,[v,{...v,candidateSpan:'결과는 기준 범위를 벗어났다.'}]).length,1);
});

test('equal importance and additional importance must be audited in both directions', () => {
  const equal='판단에는 결과만큼 동기와 원칙도 중요하다.';
  const additional='판단에는 결과뿐 아니라 동기와 원칙도 중요하다.';
  for(const [a,b] of [[equal,additional],[additional,equal]])
    assert(auditRelationCandidates(a,b).codes.includes('comparison_degree_candidate'));
  assert(!auditRelationCandidates(equal,equal).codes.includes('comparison_degree_candidate'));
});

test('exact source restoration may retain old register, never a new grammar or structural error', () => {
  const { assessConfirmedRestorationSafety } = require('../engine-gpt-prod/confirmedRelationRestore');
  const safety = { pass: false, reasons: ['korean_integrity_worsened'],
    candidate: { korean: { introducedIssueCount: 0, issueCodes: ['formal_register_residual'] } } };
  assert.deepEqual(assessConfirmedRestorationSafety(safety), { eligible: true, warnings: ['restored_source_register'] });
  assert.equal(assessConfirmedRestorationSafety({ ...safety, reasons: [...safety.reasons, 'direct_quote_worsened'] }).eligible, false);
  assert.equal(assessConfirmedRestorationSafety({ ...safety, candidate: { korean: { ...safety.candidate.korean, introducedIssueCount: 1 } } }).eligible, false);
  assert.equal(assessConfirmedRestorationSafety({ ...safety, candidate: { korean: { ...safety.candidate.korean, issueCodes: ['adjacent_semantic_repetition'] } } }).eligible, false);
});

test('full-document guard retains source register only for the exact freshly verified repair', () => {
  const { auditGeneralSurfaceCandidate } = require('../engine-gpt-prod');
  const { buildContract } = require('../engine/contract');
  const source = '연구팀은 측정 기록을 검토했다. 담당자는 관찰표를 다시 정리했다. 그래서 조사 항목이 다르다는 생각이 들었다. 다음 조사는 동일한 장비를 사용한다.';
  const before = source.replace('검토했다', '살펴봤다').replace('그래서 조사 항목이 다르다는 생각이 들었다.', '조사 항목이 다르다.');
  const candidate = before.replace('조사 항목이 다르다.', '그래서 조사 항목이 다르다는 생각이 들었다.');
  const profile = { profile: 'academic_paper' };
  const contract = buildContract(source, { mode: 'assignment', lang: 'ko' });
  const check = report => auditGeneralSurfaceCandidate(source, candidate, contract, profile, 'assignment', before, null, report);
  assert.ok(check(null).codes.includes('korean_integrity'));
  const report = { ran: true, pass: true, outputText: candidate, repairStyleWarnings: ['restored_source_register'] };
  assert.ok(!check(report).codes.includes('korean_integrity'));
  assert.ok(check({ ...report, pass: false }).codes.includes('korean_integrity'));
  assert.ok(check({ ...report, outputText: before }).codes.includes('korean_integrity'));
});
