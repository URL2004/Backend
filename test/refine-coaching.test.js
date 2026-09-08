'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectRefineTargets } = require('../lib/refineCoaching');

// Synthetic fixtures: no stored user reports or personal text.
const purpose = '이번 실험의 목적은 센서를 활용한 측정 장치의 동작을 이해하는 데 있다. 신호가 처리되는 과정을 직접 확인하고 측정 장치의 기본 원리를 이해하고자 하였다.';
const theory = '센서는 외부의 물리량을 전기 신호로 변환하는 장치이다. 이러한 장치는 여러 분야에서 활용되며 측정값의 변화를 확인하는 데 중요한 역할을 한다.';
const issue = '실습 중 출력 표시가 예상과 다르게 나타나 연결 상태를 점검해야 했다. 입력선을 구분하기 어려웠고 확인할 항목이 많아 각 연결을 다시 살펴보았다.';
const observation = '실습에서 입력 조건을 바꾸면서 표시 상태를 직접 확인하였다. 조건을 변경할 때마다 출력이 바뀌는 것을 관찰했고 장치의 동작 과정을 기록하였다.';

test('report purpose and theory stay excluded; existing troubleshooting wins over observation', () => {
  const paragraphs = ['Chapter 1. 실험 목적', purpose, 'Chapter 2. 관련 이론', theory,
    'Chapter 3. 실험 결과', observation, issue];
  const targets = selectRefineTargets(paragraphs.join('\n\n'), { creditForLength: n => n });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].index, 6);
  assert.equal(targets[0].credit, issue.length);
  assert.match(targets[0].coaching.question, /출력|연결/);
  assert.ok(issue.includes(targets[0].snippet));
});

test('headings sharing a paragraph and blank-line separators preserve source indexes', () => {
  const output = `\n\n## 실험 목적\n${purpose}\n \n## 관련 이론\n${theory}\n\n## 실험 결과\n${issue}`;
  assert.equal(selectRefineTargets(output)[0].index, 2);
});

test('theory and instructions are not incomplete experiences even with numbers absent', () => {
  assert.deepEqual(selectRefineTargets(`관련 이론\n\n${theory}\n\n${observation}`), []);
  assert.deepEqual(selectRefineTargets(`${purpose}\n\n${theory}`), []);
  assert.deepEqual(selectRefineTargets('실험 방법\n\n직접 회로를 연결하고 출력 상태를 확인해야 한다. 오류가 나타나면 연결 상태를 점검하고 실험 조건을 변경해야 한다.'), []);
});

test('counts, dates, and genericness are not prerequisites for an observation follow-up', () => {
  const target = selectRefineTargets(`실험 결과\n\n${observation}`)[0];
  assert.match(target.coaching.question, /조건/);
  assert.doesNotMatch(target.coaching.placeholder, /편의점|30분|세 번/);
});

test('already refined paragraphs are not offered again', () => {
  assert.deepEqual(selectRefineTargets(issue, { refinedIndices: [0] }), []);
});

test('a numbered subsection cannot lift the parent theory exclusion', () => {
  assert.deepEqual(selectRefineTargets(`Chapter 2. 관련 이론\n\n1. 센서 구성\n\n${observation}`), []);
  const targets = selectRefineTargets(`Chapter 2. 관련 이론\n\n1. 센서 구성\n\n${observation}\n\nChapter 3. 실험 결과\n\n${issue}`);
  assert.equal(targets[0].index, 4);
});

test('neutral explanatory prose does not get generic personal-experience homework', () => {
  assert.deepEqual(selectRefineTargets('성실함은 누구에게나 중요한 가치라고 할 수 있다. 꾸준히 노력하는 태도는 사회에 긍정적인 영향을 주며 미래를 준비하는 과정에서 중요한 역할을 한다.'), []);
});

test('personal reflection and choices receive relevant prompts without invented example facts', () => {
  const personal = selectRefineTargets('자기소개서\n\n꾸준히 노력하며 성장하는 태도를 중요하게 여긴다. 성실함은 새로운 일을 익히는 과정에서 도움이 되며 앞으로도 이러한 태도를 유지하고 싶다.');
  assert.match(personal[0].coaching.question, /직접 한 일/);
  const choice = selectRefineTargets('나는 발표를 준비하며 자료의 순서를 바꾸기로 결정했다. 전달하려는 내용과 듣는 사람의 이해를 고려하여 설명 방식을 수정했다.');
  assert.match(choice[0].coaching.question, /선택/);
});

test('existing experience remains available even when it already contains a number', () => {
  assert.equal(selectRefineTargets(issue + ' 연결은 3회 점검했다.').length, 1);
});
