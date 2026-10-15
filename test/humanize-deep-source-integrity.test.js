'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const preflight = require('../engine-gpt-prod/sourcePreflight').auditAndSanitizeSource;
const integrity = require('../engine-gpt-prod/candidateIntegrity').auditCandidateIntegrity;
const voice = require('../engine-gpt-prod/voiceProfile');

test('factual detector methodology and autobiographical writing context remain semantic source', () => {
  const body = '이러한 관찰은 다양한 자료를 함께 검토해야 한다는 점을 보여 준다.';
  for (const claim of [
    'AI 탐지기는 문장의 표현과 통계적 특성을 분석하여 작성 주체를 판별한다.',
    '인공지능 판별기는 표본의 차이를 예측하지만 새로운 환경에서는 정확도가 낮아진다.',
    '교수님이 경험을 적으라고 하셔서 봉사활동에서 배운 점을 작성해 보았습니다.',
    '본인의 생각을 쓰라고 해서 학교에서 관찰한 경험을 써 보았어요.',
    'AI 검사기가 탐지할 수 없도록 문장을 바꿨지만 연구자는 그 과정의 한계를 기록했다.'
  ]) for (const source of [claim + '\n' + body, body + '\n' + claim]) {
    const result = preflight(source);
    assert.ok(result.text.includes(claim), claim);
    assert.ok(result.integrityText.includes(claim), claim);
    assert.equal(result.removedLineCount, 0);
  }
});

test('an explicit generated-output wrapper can own its accompanying rewriting report', () => {
  const wrapper = '글자 수 기준을 반영하여 작성한 완성본입니다.';
  const process = 'AI 검사기가 예측할 수 없도록 문장의 표현을 바꿨습니다.';
  const body = '도시의 녹지 공간은 주민들의 휴식과 교류를 지원하는 역할을 한다.';
  assert.equal(preflight([wrapper, process, body].join('\n')).text, body);
  assert.ok(preflight([process, body].join('\n')).text.includes(process));
  assert.ok(preflight(['“' + wrapper + '”', process, body].join('\n')).text.includes(process));
  assert.ok(preflight(['```', wrapper, '```', process, body].join('\n')).text.includes(process));
});

const source = '민수는 “오늘은 맑다”고 말했다. 지수는 “내일은 춥다”고 말했다.';
const before = '민수의 말은 “오늘은 흐리다”였다. 지수는 “내일은 춥다”고 밝혔다.';

test('fixing one quote does not authorize corrupting another at equal risk count', () => {
  const candidate = '민수의 말은 “오늘은 맑다”였다. 지수는 “내일은 덥다”고 밝혔다.';
  const audit = integrity({ source, before, candidate, mode: 'assignment' });
  assert.equal(audit.before.quoteRisk, audit.candidate.quoteRisk);
  assert.ok(audit.reasons.includes('direct_quote_worsened'));
  assert.equal(voice.directQuoteIntegrityWorsened(source, before, before), false);
  assert.equal(voice.directQuoteIntegrityWorsened(source, before,
    '민수의 말은 “오늘은 맑다”였다. 지수는 “내일은 춥다”고 밝혔다.'), false);
});

test('quote multiplicity and new quote identities cannot exchange deficits', () => {
  const original = '그는 “출발한다”고 말했다. 다시 “출발한다”고 말했다. 동료는 “기다린다”고 답했다.';
  const current = '그는 “출발한다”고 말했다. 동료는 “기다린다”고 답했다.';
  const candidate = '그는 “출발한다”고 말했다. 다시 “출발한다”고 말했다.';
  assert.equal(voice.directQuoteIntegrityWorsened(original, current, candidate), true);
  assert.equal(voice.directQuoteIntegrityWorsened(source, before,
    before.replace('오늘은 흐리다', '오늘은 덥다')), true);
});

test('source-owned multiline quotations receive the same identity protection', () => {
  const original = '민수는 “첫 번째 관찰은\n이전 기록과 일치한다.”고 말했다. 지수는 “두 번째 관찰은\n추가 검토가 필요하다.”고 말했다.';
  const current = original.replace('이전 기록과 일치한다', '이전 기록과 다르다');
  const candidate = original.replace('추가 검토가 필요하다', '추가 검토가 불필요하다');
  assert.equal(voice.directQuoteIntegrityWorsened(original, current, candidate), true);
});

test('benign repeated reference titles and corrected quote delimiters remain allowed', () => {
  const original = '제목 “푸른 길”을 확인했다. 작품 “푸른 길”의 배경도 살펴보았다.';
  const candidate = '제목 “푸른 길”을 확인했다. 작품의 배경도 살펴보았다.';
  assert.equal(voice.auditDirectQuoteIntegrity(original, candidate).pass, true);
  assert.equal(voice.directQuoteIntegrityWorsened(original, original, candidate), false);
  const changedDelimiters = source.replaceAll('“', '「').replaceAll('”', '」');
  assert.equal(voice.auditDirectQuoteIntegrity(source, changedDelimiters).pass, true);
  assert.equal(voice.directQuoteIntegrityWorsened(source, before, changedDelimiters), false);
});
