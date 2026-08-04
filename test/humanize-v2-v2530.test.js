'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const humanizationDepth = require('../engine-gpt-prod/humanizationDepth');
const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const layoutStructure = require('../engine-gpt-prod/layoutStructure');
const structureChunk = require('../engine-gpt-prod/structureChunk');

test('번호 목록의 들여쓰기 탭 하나를 표 열로 오인하지 않고 본문은 편집 가능하게 둔다', () => {
  const source = [
    '1.\t수용과 공감을 바탕으로 한 대화 전략을 설명하고, 실제 갈등 상황에서 어떤 방식으로 상대의 말을 들을지 구체적으로 정리한다.',
    '2.\t나는 먼저 계획을 고집한 이유를 설명한 뒤 친구가 여행에서 기대했던 여유가 무엇인지 질문하고 답을 끝까지 듣는다.'
  ].join('\n');
  const records = layoutStructure.buildLineRecords(source).filter(record => !record.blank);
  assert.equal(records.some(record => record.role === 'table'), false);
  assert.ok(records.every(record => record.role === 'list'));
  const chunks = structureChunk.splitChunksForGpt(source).chunks;
  assert.ok(chunks.some(chunk => chunk.lockType === 'bullet_prefix'));
  assert.ok(chunks.some(chunk => chunk.locked !== true && /수용과 공감/u.test(chunk.text)));
});

test('긴 번호형 과제 본문을 carryover와 문단 깊이 감사의 일반 산문으로 센다', () => {
  const source = Array.from({ length: 12 }, (_, index) => (
    `${index + 1}. 이 항목에서는 실제 사례 ${index + 1}의 배경과 판단 과정을 설명한다. `
    + '처음에는 정해진 계획만 따르면 문제가 없다고 생각했지만 상대의 말을 듣고 보니 서로 중요하게 여긴 기준이 달랐고, 그 차이를 확인한 뒤 다음 행동을 조정했다. '
    + '마지막에는 같은 갈등이 반복되지 않도록 질문할 내용과 합의할 범위를 구체적으로 정리했다.'
  )).join('\n\n');
  const eligible = humanizationDepth.eligibleProseSentences(source);
  const plan = humanizationDepth.buildHumanizationPlan(source, {
    requestStrength: 'advanced',
    documentProfile: { profile: 'report_assignment' }
  });
  assert.ok(eligible.length >= 12);
  assert.equal(plan.carryoverApplicable, true);
  assert.ok(plan.eligibleParagraphCount >= 12);
});

test('원문 한 줄 인용 내부와 닫는 인용 뒤 귀속 표현에 새로 생긴 줄바꿈만 합친다', () => {
  const source = '친구들은 "왜 숙제하듯 움직여야 하느냐"며 불만을 드러냈다. 친구들은 \'성장 동기\'를 추구하고 있었다.';
  const output = '친구들은 "왜 숙제하듯 움직여야 하느냐"\n며 불만을 드러냈다. 친구들은 \'성장\n 동기\'를 추구하고 있었다.';
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.ok(audit.issueCodes.includes('introduced_quote_boundary_linebreak'));
  const repaired = koreanRefinement.applySafeFormattingRepairs({
    source,
    outputText: output,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.equal(repaired.text, source);
  assert.equal(repaired.changeCounts.quote_internal_linebreak_join, 1);
  assert.equal(repaired.changeCounts.quote_attribution_linebreak_join, 1);

  const intentional = '친구들은 \'성장\n동기\'라는 표현을 두 행으로 제시했다.';
  assert.equal(koreanRefinement.applySafeFormattingRepairs({
    source: intentional,
    outputText: intentional,
    documentProfile: { profile: 'report_assignment' }
  }).text, intentional);
});

test('항목명 뒤에 남은 원문 미완성 앞부분을 대응 문장과 대조해 제거한다', () => {
  const source = '② 친밀함의 역설: 고슴도치의 딜레마 우리는 너무나 소중한 관계였기에 서로에게 더 높은 기대를 가졌고, 그만큼 서로의 가시에 더 깊게 찔렸다.';
  const output = [
    '② 친밀함의 역설: 고슴도치의 딜레마 우리는 너무나 소중한 관계',
    '서로를 소중하게 여겼기에 기대 수준도 높았고, 그에 비례해 서로의 가시에 더 깊이 찔렸다.'
  ].join('\n');
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.ok(audit.issueCodes.includes('introduced_rewrite_residue_fragment'));
  const repaired = koreanRefinement.applySafeDeterministicRepairs({
    source,
    outputText: output,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.equal(repaired.text, [
    '② 친밀함의 역설: 고슴도치의 딜레마',
    '서로를 소중하게 여겼기에 기대 수준도 높았고, 그에 비례해 서로의 가시에 더 깊이 찔렸다.'
  ].join('\n'));
  assert.ok(repaired.changeCodes.includes('introduced_rewrite_residue_fragment'));
});

test('기준이 무엇에 있다고 보는 관계의 주격이 새 주제로 바뀌면 원문 조사를 복원한다', () => {
  const source = '나는 좋은 프로그램을 판단하는 기준이 ‘활동의 수’가 아니라 ‘참여자가 이후 무엇을 할 수 있는가’에 있다고 생각한다.';
  const output = '나는 좋은 프로그램을 판단하는 기준은 ‘활동의 수’가 아니라 ‘참여자가 이후 무엇을 할 수 있는가’에 있다고 생각한다.';
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.ok(audit.issueCodes.includes('introduced_case_particle_relation_shift'));
  const repaired = koreanRefinement.applySafeDeterministicRepairs({
    source,
    outputText: output,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.equal(repaired.text, source);

  const valid = '내가 중요하게 보는 기준은 참여자가 이후 무엇을 할 수 있는가에 있다.';
  assert.equal(koreanRefinement.applySafeDeterministicRepairs({
    source: valid,
    outputText: valid,
    documentProfile: { profile: 'report_assignment' }
  }).text, valid);
});
