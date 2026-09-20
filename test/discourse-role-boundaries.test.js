'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreSourceDiscourseRoles: repair } = require('../engine-gpt-prod/sourceParagraphTransitions');
const structure = require('../engine-gpt-prod/structureChunk');
const profile = require('../engine-gpt-prod/documentProfile');
const korean = require('../engine-gpt-prod/koreanRefinement');
const situation = '참가자는 수업에 적극적으로 참여하려는 의지가 있었다. 그러나 과제를 해결하지 못하면서 학습에 대한 자신감이 떨어졌다.';
const response = '이러한 상황에서 교사는 참가자에게 학습의 방향과 학습 강도에 관한 구체적인 요소를 제시해야 한다. 학습 방향에는 공부 기간과 목표가 포함되며 학습 강도에는 하루 학습량이 포함된다.';
const outcome = '이러한 지도는 참가자가 자신의 목표를 구체화하고 작은 성공 경험을 쌓도록 도움을 줄 수 있다. 이는 학습에 꾸준히 참여하도록 하는 데 의미가 있다.';
const source = `1. 사례\n\n${situation}\n\n${response}\n\n${outcome}`;
const output = `1. 사례\n\n${situation} ${response.replace('이러한 상황에서', '이때')} ${outcome}`;
test('restores response and outcome below a heading without length-triggered splitting', () => {
  const result = repair(source, output);
  assert.equal(result.repairedCount, 2);
  assert.match(result.text, /\n\n이때 교사는/);
  assert.match(result.text, /\n\n이러한 지도는/);
  assert.equal(result.text.replace(/\s/gu,''), output.replace(/\s/gu,''));
  assert.equal(repair(source, result.text).text, result.text);
});
test('final structure path applies role repair even to sectioned documents', () => {
  const result = structure.restoreParagraphLayout({source, outputText:output, mode:'formal', requestStrength:'advanced', documentProfile:profile.detectDocumentProfile(source,{mode:'formal'})});
  assert.match(result.text, /\n\n이때 교사는/);
  assert.match(result.text, /\n\n이러한 지도는/);
});
test('does not invent boundaries without source role boundary evidence', () => {
  assert.equal(repair(output, output).text, output);
  const neutral = source.replaceAll('이러한 상황에서','또한').replaceAll('이러한 지도는','이 방법은');
  assert.equal(repair(neutral, output).text, output);
});
test('protects quotes, code and already readable role boundaries', () => {
  for(const text of [`“${output}”`, '```\n'+output+'\n```']) assert.equal(repair(source,text).text,text);
  assert.equal(repair(source,source).text,source);
});
test('polish and creative bypass added discourse layout', () => {
  for(const documentProfile of [{profile:'creative'}, {profile:'report_assignment'}]) {
    const result=structure.restoreParagraphLayout({source:output,outputText:output,mode:'polish',documentProfile});
    assert.equal(result.text,output);
  }
});
test('repeated ambiguous response anchors do not select an arbitrary position', () => {
  const doubled=output+'\n\n'+output;
  assert.equal(repair(source,doubled).text,doubled);
});
test('spliced actor frame enters existing semantic repair without flagging group existence', () => {
  const source='학습 의욕이 떨어져 수업을 포기하려는 참가자가 있다.';
  const output='참가자는 학습 의욕이 떨어져 수업을 포기하려는 참가자가 있다.';
  assert(korean.analyzeKoreanRefinement({source,outputText:output}).repairableCodes.includes('double_topic_chain'));
  for(const text of ['참가자는 여러 명이고 이 가운데 수업을 포기하려는 참가자가 있다.', '참가자는 수업을 끝까지 마치려는 의지가 있다.']) {
    assert(!korean.analyzeKoreanRefinement({source:text,outputText:text}).issueCodes.includes('double_topic_chain'));
  }
});
test('prose comma and noun-particle spacing are repaired outside literal spans only', () => {
  const text='이 상황 에서 생각해보자면,학습이 필요하다. “상황 에서 생각해보자면,학습”';
  const fixed=korean.applySafeFormattingRepairs({source:text,outputText:text}).text;
  assert.equal(fixed,'이 상황에서 생각해보자면, 학습이 필요하다. “상황 에서 생각해보자면,학습”');
  assert.equal(korean.applySafeFormattingRepairs({source:text,outputText:fixed}).text,fixed);
});
