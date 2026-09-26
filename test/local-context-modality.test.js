'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');
const { meaningPreservationLines } = require('../engine-gpt-prod/humanizeContract');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { buildRelationPatchTargets, applyRelationPatches } = require('../engine-gpt-prod/relationPatch');
const certainty = (a,b) => auditRelationCandidates(a,b).codes.includes('certainty_scope_candidate');

test('short headings cannot steal exact body matches or equally similar fuller spans', () => {
  const title='지역 기록 보존';
  const body='나는 지역 기록 보존이 공동체의 가장 중요한 책임이라고 생각한다.';
  const source=title+'\n\n'+body;
  assert.deepEqual(auditRelationCandidates(source,source).codes,[]);
  const report=auditRelationCandidates(source,title+'\n\n지역 기록 보존은 공동체의 가장 중요한 책임이다.');
  assert.ok(report.codes.includes('certainty_scope_candidate'));
  assert.ok(report.candidates.every(c=>c.sourceSpan===body));
});

for (const ending of ['생각이 든다', '생각이 듭니다', '생각이 들었다', '생각이 들었습니다']) {
  test(`personal opinion cannot become plain assertion: ${ending}`, () => {
    assert.ok(certainty(`지역 기록 보존은 공동체의 책임이라는 ${ending}.`, '지역 기록 보존은 공동체의 책임이다.'));
    assert.equal(certainty(`지역 기록 보존은 공동체의 책임이라는 ${ending}.`, '지역 기록 보존은 공동체의 책임이라고 생각한다.'), false);
  });
}
test('modality loss in one clause is nominated despite a surviving hedge in another', () => {
  const a = '도서관은 기록을 분석해 맞춤 안내를 제공할 수 있고, 이용자는 자료를 편리하게 검색할 수 있다.';
  const b = '도서관은 기록을 분석해 맞춤 안내를 제공하고, 이용자는 자료를 편리하게 검색할 수 있다.';
  const report = auditRelationCandidates(a,b);
  assert.ok(report.codes.includes('certainty_scope_candidate'));
  assert.equal(report.candidateOnly, true);
  assert.equal(report.semanticRequired, true);
  assert.equal(certainty(a, a.replace('있고,', '있으며,')), false);
});
test('shared final modality and benign reduction are not rejected by hedge counts', () => {
  assert.equal(certainty('학생은 자료를 검색할 수 있고 복사할 수 있다.', '학생은 자료를 검색하고 복사할 수 있다.'), false);
  assert.equal(certainty('직원은 안내를 제공할 수 있고 자료를 검색할 수 있다.', '직원은 안내 제공과 자료 검색을 할 수 있다.'), false);
});
test('shared contract preserves local dependency without freezing prose or overriding polish', () => {
  const lines = meaningPreservationLines().join('\n');
  assert.match(lines, /다른 문단에 같은 정보가 있어도/);
  assert.match(lines, /문장 결합이 허용된 모드/);
  assert.match(lines, /결합이 금지된 모드에서는 연결 문장을 유지/);
  assert.match(lines, /반복 문구 자체를 모두 고정하거나/);
  assert.match(lines, /뒤의 가능성이 두 행동을 함께 수식하는 결합은 허용/);
  assert.match(lines, /“조금 어렵다”의 정도를 생략해 “어렵다”로 강화하지 않는다/);
});
test('grounded local context restoration edits only the dependent sentence', () => {
  const earlier = '첫 절에서는 태블릿으로 자료를 찾는 방법을 소개했다. 이 절은 기기의 역사와 도입 배경을 설명한다. 여러 기관의 도입 시기는 서로 다르다.\n\n';
  const sourceSpan = '요즘은 태블릿 하나로 여러 업무를 처리할 수 있다. 기록을 조회하고 신청서를 제출한다.';
  const candidateSpan = '기록을 조회하고 신청서를 제출한다.';
  const tail = ' 다음 절에서는 교육 일정을 검토한다. 교육 시간과 장소는 아직 확정하지 않았다. 담당자는 참가자에게 별도 안내를 제공할 예정이다.';
  const source = earlier + sourceSpan + tail, output = earlier + candidateSpan + tail;
  const finding = { type:'omission', span:'태블릿 하나로', sourceSpan, candidateSpan, relation:'condition_result', origin:'introduced' };
  const grounded = groundViolation(finding, source, output);
  assert.equal(grounded.repairable, true);
  const targets = buildRelationPatchTargets(output, [grounded]);
  assert.equal(targets.length, 1);
  const replacement = '요즘은 태블릿 하나로 기록을 조회하고 신청서를 제출할 수 있다.';
  const result = applyRelationPatches(output, targets, [{id:targets[0].id, replacement}]);
  assert.equal(result.outputText, earlier + replacement + tail);
  assert.equal(buildRelationPatchTargets(output + candidateSpan, [grounded]).length, 0);
  assert.equal(groundViolation({...finding,candidateSpan:'없는 대응 문장을 임의로 복원한다.'},source,output).repairable, false);
});

test('full and compact generation in every strength use the shared local-context contract', () => {
  const prompts = require('../engine-gpt-prod/prompts');
  for (const promptVariant of ['full','compact_v1']) for (const requestStrength of ['polish','basic','advanced']) {
    const prompt = prompts.buildHumanizePrompt(requestStrength === 'polish' ? 'polish' : 'assignment', 'ko', {promptVariant,requestStrength});
    assert.match(prompt.stable, /다른 문단에 같은 정보가 있어도/);
    assert.match(prompt.stable, /주체가 다른 뒤 절/);
    assert.match(prompt.stable, /두 행동을 함께 수식하는 결합은 허용/);
  }
});
test('semantic entry keeps a single call and distinguishes shared scope from loss', async () => {
  const clientPath=require.resolve('../engine-gpt-prod/openaiClient'),judgePath=require.resolve('../engine-gpt-prod/judge');
  const oldClient=require.cache[clientPath],oldJudge=require.cache[judgePath];
  let calls=0;
  require.cache[clientPath]={id:clientPath,filename:clientPath,loaded:true,exports:{completeJson:async opts=>{
    calls++;
    assert.match(opts.system,/현재 문단의 설명 관계/);
    assert.match(opts.system,/단정형 종결만으로 사실의 단정으로 바뀌었다고 보지 않는다/);
    assert.match(opts.system,/자료를 검색하고 복사할 수 있다/);
    return {json:{violations:[]},usage:{estimatedUsd:0},model:'gpt-6-luna'};
  }}};
  delete require.cache[judgePath];
  try {
    const report=await require(judgePath).semanticJudge('학생은 자료를 검색할 수 있고 복사할 수 있다.','학생은 자료를 검색하고 복사할 수 있다.',null,{config:{models:{judge:'gpt-6-luna'}}});
    assert.equal(report.pass,true);
    assert.equal(calls,1);
  } finally {
    if(oldClient)require.cache[clientPath]=oldClient;else delete require.cache[clientPath];
    if(oldJudge)require.cache[judgePath]=oldJudge;else delete require.cache[judgePath];
  }
});
