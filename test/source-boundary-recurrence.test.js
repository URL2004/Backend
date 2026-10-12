'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { restoreSourceBoundaries: restore } = require('../engine-gpt-prod/sourceBoundaryIntegrity');
const structure = require('../engine-gpt-prod/structureChunk');
const layout = require('../engine-gpt-prod/layoutStructure');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const duplicates = require('../engine-gpt-prod/fragmentDuplication').introducedClauseDuplicates;

test('unique URL and split year recover their literal whitespace without moving characters', () => {
  const source = '연구 계획의 수립 시점은 2031년에 해당하며 문서에 기록했다. 출처 https://doi.org/10.1111/example';
  const output = source.replace('2031', '20\n31').replace('https://', 'https: //');
  assert.equal(restore(source, output).text, source);
  assert.equal(restore(source, output).repairCount, 2);
  assert.equal(restore(source, source).repairCount, 0);
});

test('source-attested physical seam cannot be promoted into an internal paragraph', () => {
  const source = '1. 보고서에 나타난 여러 관점을 설명하고, 각\n관점을 충분한 근거와 함께 비교하여 서술하세요.';
  const output = source.replace('\n', '\n\n');
  assert.equal(restore(source, output).text, source);
  const plan = structure.splitChunksForGpt(preflight.auditAndSanitizeSource(source).text);
  assert.ok(plan.chunks.some(c => c.locked && c.text.includes('각\n관점')));
  assert.equal(structure.mergeChunks(plan.chunks), source);
  const graded = source + '(12점)';
  const gradedPlan = structure.splitChunksForGpt(preflight.auditAndSanitizeSource(graded).text);
  assert.ok(gradedPlan.chunks.some(c=>c.locked && c.text.includes('각\n관점') && c.text.includes('(12점)')));
});

test('proposition headings own a boundary distinct from supporting prose', () => {
  const source = '주장 1. 모든 도서관의 이용 시간을 같게 정할 수는 없다\n지역별 수요를 조사하여 운영 시간을 정한다.\n주장 2.이용자 의견을 먼저 확인해야 한다.\n설문 결과를 공개한다.';
  const prepared = preflight.auditAndSanitizeSource(source).text;
  assert.equal(prepared, source);
  const plan = structure.splitChunksForGpt(prepared);
  assert.equal(plan.chunks.filter(c => c.locked && c.lockType === 'heading').length, 2);
});

test('word-spaced Korean instructions are prose while tabular cells keep ownership', () => {
  const source = '1. 여러  이론의  핵심개념에  대해  서술하고  나는  어떤  입장인지 설명하세요.\n2. 각  관점의  차이에  대하여  설명하고  나는  어떤  근거를 쓰는지 적으세요.';
  assert.ok(layout.buildLineRecords(source).every(r => r.role !== 'table'));
  const table = '항목\t관측값\t단위\n속도\t10\tm/s';
  assert.equal(layout.buildLineRecords(table).filter(r => r.role === 'table').length, 2);
});

test('source paragraphs, creative lines, ambiguous repeats and code are not recomposed', () => {
  const source = '반복해서 기록한 긴 문장 앞부분에서 각\n관점을 설명하며 차이를 살펴본다.';
  const output = source.replace('\n', '\n\n');
  assert.equal(restore(source, output, { preserveLines: true }).text, output);
  assert.equal(restore(source + '\n' + source, output).text, output);
  assert.equal(restore(output, output).text, output);
  const code = '```\nconst link = "https://example.org/long";\n```';
  assert.equal(restore(code, code.replace('https://', 'https: //')).repairCount, 0);
  const adjacent = '이 문장은 완전히 끝났다.\n그다음 문장은 별도의 근거를 충분하게 설명한다.';
  const spaced = adjacent.replace('\n','\n\n');
  assert.equal(restore(adjacent, spaced).text, spaced);
  for (const text of [
    '제2장 실험에 사용한 재료와 준비 과정\n시편은 세 종류를 같은 조건에서 준비하였다.',
    '- 첫째 항목은 재료의 준비와 보관 방법\n- 둘째 항목은 장비의 점검과 기록 방식',
    '구분\t첫째 분기 실적과 전망치 합계\n합계\t둘째 분기 실적과 전망치 합계표'
  ]) assert.equal(restore(text,text.replace('\n','\n\n')).text,text.replace('\n','\n\n'));
});

test('new long copied clauses are blocked but inherited paraphrased repetition is allowed', () => {
  const clause = '장비 상태와 작업자의 숙련도 및 재료 보관 방법과 주변 온도를 함께 고려하여 안전한 실험 절차를 마련해야 한다';
  const source = '검토 결과 ' + clause + '. 다음에는 관찰 내용을 정리한다.';
  const output = '검토 결과 ' + clause + '.\n\n또한 ' + clause + '.';
  assert.equal(duplicates(source, output).length, 1);
  assert.equal(duplicates(source, output, { preserveLines: true }).length, 0);
  assert.equal(duplicates(output, output).length, 0);
  const prior = source + '\n\n다시 말해 ' + clause.replace('함께 고려하여','모두 고려해서') + '.';
  assert.equal(duplicates(prior, output).length, 0);
  const quoted = source + '\n\n“' + clause + '.”';
  assert.equal(duplicates(source, quoted).length, 0);
  for (const gate of ['confirmed_fragment_corruption','literal_layout_corruption']) {
    assert.equal(require('../lib/humanizeDeliveryPolicy').applyDeliveryPolicy({criticals:[{gate}]}).decision,'block_technical');
  }
});

test('a rewritten owner cannot leave its dependent physical tail as a second sentence', () => {
  const f = require('../engine-gpt-prod/fragmentDuplication').introducedResidualTails;
  const source = '기록 단계에서 담당자가 유형을 표시하면, 관리자는 실험별 재료를 기본 물량과 추가\n\n물량으로 구분해 관리한다. 다음으로 담당자가 상태를 확인한다.';
  const output = '기록 단계에서 담당자가 유형을 표시하면, 관리자는 실험별 재료를 기본 물량과 추가 물량으로 나누어 관리한다.\n\n물량으로 구분해 관리한다. 다음으로 담당자가 상태를 확인한다.';
  assert.equal(f(source, output).length,1);
  assert.equal(f(source.replace('구분해','나누어'), output).length,1);
  assert.equal(f(source, output, { preserveLines: true }).length,0);
  assert.equal(f(output,output).length,0);
  assert.equal(f(source,output.replace('나누어 관리한다','나누어 확인한다')).length,0);
});

test('footnote interleaving within a source table reference is rejected, not guessed away', () => {
  const audit = require('../engine-gpt-prod/sourceBoundaryIntegrity').auditIntroducedReferenceBreaks;
  const source = '조사 결과를 정리했다(표 IV-\n2). 설명을 이어간다.';
  const output = '조사 결과를 정리했다(표 IV-\n37\n\n2) 설명을 이어간다.';
  assert.equal(audit(source,output).length,1);
  assert.equal(audit(output,output).length,0);
  assert.equal(audit(source,source).length,0);
  assert.equal(audit('1) 설문 개요는 표 3-1에 정리했다.\n2) 응답 결과는 표 3-2에 정리했다.',
    '1) 설문 개요: 표 3-1\n2) 응답 결과: 표 3-2').length,0);
});

test('unrelated counts and experience years cannot be joined using a year elsewhere in the source', () => {
  const source = '2021년에 개설한 강좌이다. 모집 인원은 20명이었고 21년 경력의 강사가 지도했다.';
  const output = '2021년에 개설한 강좌이다.\n모집 인원: 20\n21년 경력의 강사가 지도했다.';
  assert.equal(restore(source,output).text,output);
  const short = '표본 수는 1234명이며 응답률은 높았다고 보고서에 적혀 있다.';
  assert.equal(restore(short,short.replace('1234','12\n34')).text,short);
});

test('numbered wrapped prose remains editable and nominal space-aligned tables stay protected', () => {
  const source = '1. 본 연구는 대학생의 학습 동기를 여러 측면에서 살펴보고 그 결과를\n바탕으로 수업 설계의 방향을 제안하는 데 목적이 있으며 이를 위해 설문과\n면담을 함께 실시하였다. 설문은 두 차례에 걸쳐 진행하였다.';
  const plan = structure.splitChunksForGpt(source);
  assert.ok(plan.chunks.filter(c=>c.locked).reduce((n,c)=>n+c.text.length,0) < source.length / 2);
  const inline = '주장 2: 나는 시간을 지역마다 다르게 정해야 한다고 본다. 그 근거는 수요의 차이이다. 설문에서도 같은 차이가 드러났다.';
  const headingPlan = structure.splitChunksForGpt(inline);
  assert.ok(headingPlan.chunks.some(c=>!c.locked && c.text.includes('설문')));
  const table = '자본주의  사회주의  민주주의  공산주의\n시장경제  계획경제  대의제도  일당제도';
  assert.ok(layout.buildLineRecords(table).every(r=>r.role === 'table'));
});

test('a repeated source thesis may be paraphrased equally in introduction and conclusion', () => {
  const thesis = '학교 도서관의 운영 시간을 늘리는 일은 학생들의 자기주도 학습 습관을 기르는 데 가장 먼저 필요한 조건이라고 생각한다';
  const source = '서론에서 밝히건대 '+thesis+'. 그 이유를 살핀다.\n\n설문 결과를 정리했다.\n\n결론적으로 '+thesis+'. 이 점을 강조한다.';
  for (const rewritten of [
    '학교 도서관 운영 시간을 늘리는 것이야말로 학생들이 스스로 공부하는 습관을 들이는 데 가장 먼저 갖춰야 할 조건이라고 본다',
    '학생이 스스로 공부하는 버릇을 들이려면 무엇보다 학교 도서관을 더 오래 열어 두는 일부터 이루어져야 한다고 나는 본다'
  ]) assert.equal(duplicates(source,source.split(thesis).join(rewritten)).length,0);
});
