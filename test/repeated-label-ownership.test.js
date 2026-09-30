'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const structure = require('../engine-gpt-prod/structureChunk');
const bare = text => text.replace(/\s/gu, '');

// Synthetic source: the same citation prefix occurs both inline and as a
// standalone field. Its occurrence, not just its spelling, owns the body.
const source = [
  '1. 관찰 결과',
  '첫 번째 실험에서는 빛의 방향에 따른 차이를 관찰했다. 참고 자료: p.21 관찰 기록',
  '참고 자료: p.21 관찰 기록',
  '2. 실험의 장점과 한계',
  '1) 관찰의 장점',
  '동일한 조건에서 반복하여 차이를 확인할 수 있었다. 참고 자료: p.22 반복 관찰',
  '2) 관찰의 한계',
  '측정 장비에 따라 오차가 발생할 수 있다.',
  '관찰 시간도 충분히 확보해야 한다. 참고 자료: p.23 측정 조건',
  '참고 자료: p.23 측정 조건',
  '3. 다음 실험 계획',
  '다음 실험에서는 측정 조건을 일정하게 유지한다.'
].join('\n');

test('repeated inline and standalone labels never absorb the next section', () => {
  const restored = structure.restoreInlineLabelBodyLayout(source, source);
  assert.equal(restored.text, source);
  assert.equal(restored.applied, false);
  assert.equal(structure.compareInlineLabelBodyLayout(source, source).pass, true);
});

test('locked heading recovery survives subsequent repeated-label restoration', () => {
  const chunks = structure.splitChunksForGpt(source).chunks;
  const output = source.replace('\n2) 관찰의 한계\n', ' 2) 관찰의 한계 ');
  const result = structure.restoreLockedStructureLayout({source, outputText: output, chunks});
  assert.match(result.text, /\n2\) 관찰의 한계\n/u);
  assert.equal(bare(result.text), bare(output));
  assert.equal(structure.restoreLockedStructureLayout({source, outputText: result.text, chunks}).text, result.text);
  assert.equal(structure.compareLineAnchorLayout(source, result.text).pass, true);
});

test('locked label prefixes retain their source occurrence and inline/standalone boundary', () => {
  const chunks = structure.splitChunksForGpt(source).chunks;
  const fixed = structure.restoreLockedStructureLayout({source, outputText: source, chunks});
  assert.equal(fixed.text, source);
  assert.equal(structure.compareInlineLabelBodyLayout(source, fixed.text).pass, true);
});

test('each repeated label repairs only its own split body', () => {
  const text = '1. 첫 기록\n결과: 온도 변화가 관찰되었다.\n2. 다음 기록\n결과: 질량 변화가 관찰되었다.\n3. 정리\n측정 결과를 기록했다.';
  const broken = text.replace('온도 변화가', '온도\n변화가').replace('질량 변화가', '질량\n변화가');
  assert.equal(structure.compareInlineLabelBodyLayout(text, broken).pass, false);
  const fixed = structure.restoreInlineLabelBodyLayout(text, broken);
  assert.equal(fixed.text, text);
  assert.equal(structure.compareInlineLabelBodyLayout(text, fixed.text).pass, true);
});

test('missing or added repeated labels cannot shift ownership to another section', () => {
  for (const output of [
    source.replace('참고 자료: p.21 관찰 기록\n', ''),
    source.replace('2) 관찰의 한계', '추가 참고 자료: p.24 보충\n2) 관찰의 한계')
  ]) {
    const fixed = structure.restoreInlineLabelBodyLayout(source, output);
    assert.equal(fixed.text, output);
    assert.equal(fixed.pass, false);
    assert.equal(structure.compareInlineLabelBodyLayout(source, output).pass, false);
  }
});

test('label recovery cannot consume a generated structural row', () => {
  const text = '측정 결과: 온도가 일정하게 유지되었다.\n검토 의견: 반복 관찰이 필요하다.';
  const output = text.replace('온도가 일정하게', '온도가\n2) 추가 항목\n일정하게');
  const fixed = structure.restoreInlineLabelBodyLayout(text, output);
  assert.equal(fixed.text, output);
  assert.equal(fixed.pass, false);
});

test('occurrence offsets agree for CRLF, indentation and supplementary characters', () => {
  const text = source.replaceAll('참고 자료:', '  🔎 참고 자료:').replaceAll('\n', '\r\n');
  assert.equal(structure.restoreInlineLabelBodyLayout(text, text).text, text.replaceAll('\r\n', '\n'));
  assert.equal(structure.compareInlineLabelBodyLayout(text, text).pass, true);
});

test('CRLF source chunk offsets still select the witnessed label occurrence', () => {
  const text = source.replaceAll('\n', '\r\n');
  const chunks = structure.splitChunksForGpt(text).chunks;
  const result = structure.restoreLockedStructureLayout({source: text, outputText: text, chunks});
  assert.equal(result.text, source);
  assert.equal(result.missingCount, 0);
});

test('a stale source offset refuses label repair instead of selecting a global match', () => {
  const chunks = [{locked: true, lockType: 'label_prefix', text: '참고 자료: ', start: 1}];
  const result = structure.restoreLockedHeadingLayout(source, source, chunks);
  assert.equal(result.text, source);
  assert.equal(result.missingCount, 1);
});

test('Markdown heading and blockquote anchors retain their literal line prefixes', () => {
  for (const anchor of ['## 다음 절', '> 인용한 문장은 그대로 보존한다.']) {
    const text = `# 실험 기록\n관찰 결과: 온도가 일정하게 유지되었다.\n${anchor}`;
    const output = text.replace('온도가 일정하게', '온도가\n일정하게');
    const result = structure.restoreInlineLabelBodyLayout(text, output);
    assert.equal(result.applicableCount, 1);
    assert.equal(result.text, text);
    assert.equal(structure.compareInlineLabelBodyLayout(text, text).pass, true);
  }
});
