'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSpeaker, speakerShift } = require('../engine/humanizeV6TestEngine/src/analysis/speakerProfile');
const { extractProtectedTerms } = require('../engine/humanizeV6TestEngine/src/analysis/protectedTerms');
const { buildPrompt } = require('../engine/humanizeV6TestEngine/src/prompt/promptBuilder');

test('격식 존댓말을 평어체 -다와 구분한다', () => {
  const profile = analyzeSpeaker('현장을 확인했습니다. 작업 순서를 정리합니다. 마무리 상태도 점검합니다.');
  assert.equal(profile.ending, 'formal_polite');
  assert.equal(profile.formalPolite, 3);
  assert.equal(profile.casualPolite, 0);
  assert.equal(profile.plainDa, 0);
});

test('격식 존댓말에 새 -요체가 생기면 speaker shift로 판정한다', () => {
  const before = analyzeSpeaker('현장을 확인했습니다. 작업 순서를 정리합니다. 마무리 상태도 점검합니다.');
  const after = analyzeSpeaker('현장을 확인했습니다. 작업 순서를 정리해요. 마무리 상태도 점검합니다.');
  assert.deepEqual(speakerShift(before, after), ['ending_shift_formal_polite_to_casual_polite']);
});

test('V9 시스템 프롬프트가 종결형과 유효 변화량을 신뢰 영역에서 잠근다', () => {
  const text = '현장을 확인했습니다. 작업 순서를 정리합니다. 마무리 상태도 점검합니다.';
  const speaker = analyzeSpeaker(text);
  const prompt = buildPrompt({
    text,
    blocks: [],
    targets: [],
    mode: 'full_single_call',
    policy: {},
    profile: { type: 'generalText' },
    risk: { risk: 0.43 },
    protectedTerms: [],
    speaker
  });
  assert.match(prompt.system, /신뢰된 종결형 잠금/);
  assert.match(prompt.system, /-요\/-해요\/-했어요/);
  assert.match(prompt.system, /문장의 절반 이상/);
});

test('보호어는 사실 명사만 남기고 조사·서술어·연결어는 잠그지 않는다', () => {
  const text = [
    '에어컨은 내부 오염을 확인하는 일이 중요합니다.',
    '먼저 에어컨은 송풍팬 오염을 확인하는 일이 중요합니다.',
    '먼저 에어컨은 필터 오염도 확인하는 일이 중요합니다.'
  ].join(' ');
  const terms = extractProtectedTerms(text);
  assert.ok(terms.includes('에어컨'));
  assert.ok(terms.includes('오염'));
  assert.ok(!terms.includes('에어컨은'));
  assert.ok(!terms.includes('중요합니다'));
  assert.ok(!terms.includes('먼저'));
});
