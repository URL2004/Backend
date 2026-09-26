'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { repairMissingSentenceSpacingLine: repair } = require('../engine-gpt-prod/sentenceSpacing');

test('sentence spacing preserves quotation particles after internal terminal marks', () => {
  for (const source of [
    '그는 “확인했다.”라고 말했다.',
    '‘질문?’라는 표현을 살폈다.',
    '그는 "확인했다."이라며 자료를 건넸다.',
    '“정말이다!”라는 답을 받았다.',
    '“확인했다.”라고도 말했다.',
    '“확인했다.”이라면서 자료를 건넸다.',
    '‘그렇다.’에서는 근거가 생략됐다.',
    '“완료했다.”도 기록했다.',
    '「완료했다。」에서도 같은 뜻을 읽었다.',
    '『알았다！』라는 답변을 받았다.',
    '《질문이다？》라고 적었다.',
    '〈완료했다。〉만으로는 충분하지 않다.',
    '“『완료했다。』”라고 적었다.',
    '그 문구는 (“확인했다.”)라는 형식이다.',
    '‘완료했다.’로서는 충분하지 않다.',
    '‘끝이다.’부터이며 다음은 별도다.'
  ]) assert.equal(repair(source), source);
});

test('sentence spacing still separates real next sentences and nested quotation endings', () => {
  const cases = [
    ['자료를 확인했다.다음 결과를 정리했다.', '자료를 확인했다. 다음 결과를 정리했다.'],
    ['자료를 확인했다.결과가 나왔다.다음 단계다.', '자료를 확인했다. 결과가 나왔다. 다음 단계다.'],
    ['“확인했다.”다음 문장을 읽었다.', '“확인했다.” 다음 문장을 읽었다.'],
    ['“확인했다.”이 문장은 짧다.', '“확인했다.” 이 문장은 짧다.'],
    ['“확인했다.”이것은 기록이다.', '“확인했다.” 이것은 기록이다.'],
    ['“확인했다.”가장 중요한 근거다.', '“확인했다.” 가장 중요한 근거다.'],
    ['“『확인했다。』”다음 단계로 넘어갔다.', '“『확인했다。』” 다음 단계로 넘어갔다.'],
    ['확인했다.A단계로 넘어갔다.', '확인했다. A단계로 넘어갔다.'],
    ['확인했다.(다음은 검토 단계다.)', '확인했다. (다음은 검토 단계다.)'],
    ['‘다 끝났나？’하지만 검토는 남았다.', '‘다 끝났나？’ 하지만 검토는 남았다.']
  ];
  for (const [source, expected] of cases) assert.equal(repair(source), expected);
});

test('sentence spacing only inserts missing boundaries without removing existing spacing', () => {
  for (const source of [
    '“확인했다.” 라고 적은 원문은 별도 교정 대상이다.',
    '“확인했다.” 하고 말했다.',
    '“확인했다.”  다음 단계다.',
    '‘자료’라고 적었다.',
    'A. B. Kim은 3.14를 기록했다.',
    'https://example.com/a.b?x=1.2 와 sample@example.com을 확인했다.',
    '결과는 10.5점이다.',
    '그는 “확인했다.”라고 말했다. 다음 문장을 읽었다.'
  ]) {
    assert.equal(repair(source), source);
    assert.equal(repair(repair(source)), repair(source));
  }
});

test('quote suffix exemption is bounded and does not swallow later sentence repairs', () => {
  const source = '“알았다.”라고 답했다.그는 “질문?”이라는 글을 읽었다.다음은 검토다.';
  const expected = '“알았다.”라고 답했다. 그는 “질문?”이라는 글을 읽었다. 다음은 검토다.';
  assert.equal(repair(source), expected);
  assert.equal(repair(expected), expected);
});
