'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { finalLayout, compact } = require('./fixtures/korean-report-criteria');
const layout = require('../engine-gpt-prod/layoutStructure');
const { splitProseParagraphs } = require('../engine-gpt-prod/proseParagraphs');
const { applySafeFormattingRepairs } = require('../engine-gpt-prod/koreanRefinement');

for (const [name, code] of [
  ['python indentation', '```python\nif ready:\n    run()\n\n    finish()\n```'],
  ['tab indentation', '~~~js\nif (ready) {\n\n\trun();\n}\n~~~'],
  ['repeated literals', '```js\nconst a = 1;\n\n  run(a);\n```\n\n```js\nconst a = 1;\n\n  run(a);\n```'],
  ['inline literal', '코드 `a  +  b`의 공백은 원문과 같아야 한다.']
]) test('whole code ownership: ' + name, () => {
  const a = finalLayout(code);
  const b = finalLayout(code, a.text);
  assert.equal(a.text, code);
  assert.equal(a.codePass, true);
  assert.equal(a.structuralPass, true);
  assert.equal(a.text, b.text);
  assert.equal(a.converged, true);
});

test('unicode line separators are not table columns', () => {
  const text = '설계 요구사항을 검토하고\u2028 시스템 구조를 정리했다.\n시험 결과를 분석하고\u2028 개선 방향을 설명했다.';
  assert.equal(layout.tableColumnCount(text.split('\n')[0]), 0);
  assert.equal(layout.buildLineRecords(text).some(r => r.role === 'table'), false);
  assert.ok(layout.buildLineRecords('구분\t내용\n항목\t결과').some(r => r.role === 'table'));
});

for (const heading of ['1. 승인 조건', 'Ⅱ. 연구 결과', '향후 계획', '참고문헌']) {
  test('explicit heading stays structural: ' + heading, () => {
    const result = finalLayout(heading + '\n\n연구 자료를 분석하여 주요 결과와 이후의 검토 계획을 정리했다.');
    assert.ok(result.text.includes(heading + '\n'));
    assert.equal(result.structuralPass, true);
  });
}

test('already developed action plan is not split again', () => {
  const text = '운영팀은 오류를 줄이기 위한 조치 계획을 마련했다. 접수된 문의를 검토하고 같은 문제가 있는지 확인했다. 그래서 안내문을 수정하기로 했다. 수정안은 다음 주부터 적용할 예정이다.';
  assert.equal(splitProseParagraphs(text).splitCount, 0);
});

test('spacing correction does not modify quoted words or code', () => {
  const source = '담당자는 “9월말 처리할 수있다.”라고 말했다. 코드 `기록해둘 만하다`는 그대로 둔다.';
  const result = applySafeFormattingRepairs({source, outputText:source}).text;
  assert.ok(result.includes('“9월말 처리할 수있다.”'));
  assert.ok(result.includes('`기록해둘 만하다`'));
  assert.equal(compact(result), compact(source));
});
