'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVoiceProfile, auditVoice, voicePromptBlock } = require('../engine-gpt-prod/voiceProfile');
const { limitConfidenceToSample } = require('../lib/detectConfidence');

test('unidentified informal endings do not create a false register shift', () => {
  const source = '전개는 답답하고 결말은 너무 급함. 배우 연기는 괜찮았는데 많이 아쉬운 작품.';
  const profile = buildVoiceProfile(source);
  assert.equal(profile.register, 'unknown');
  const audit = auditVoice(profile, '전개가 답답하고 결말도 너무 급하다. 배우 연기는 괜찮았지만 많이 아쉬운 작품이다.', { sourceText: source });
  assert.equal(audit.warnings.some(x => x.code === 'register_shift'), false);
  const injected = auditVoice(profile, '나는 전개가 답답하다고 느꼈다.', { sourceText: source });
  assert(injected.warnings.some(x => x.code === 'speaker_injected'));
});

test('identified plain and polite register changes still warn', () => {
  for (const [source, output] of [
    ['결말이 아쉽다. 연기는 좋았다.', '결말이 아쉽습니다. 연기는 좋았습니다.'],
    ['결말이 아쉽습니다. 연기는 좋았습니다.', '결말이 아쉽다. 연기는 좋았다.'],
    ['결말이 아쉬워요. 연기는 좋아요.', '결말이 아쉽다. 연기는 좋았다.'],
    ['결말이 아쉽다. 연기는 좋았다.', '아쉬운 결말. 좋은 연기.']
  ]) {
    assert(auditVoice(buildVoiceProfile(source), output, { sourceText: source }).warnings.some(x => x.code === 'register_shift'));
  }
});

test('short unclassified prose retains expressive voice without overriding a requested target style', () => {
  const block = voicePromptBlock(buildVoiceProfile('배우 연기는 최고!! 결말도 마음에 쏙. 정말 추천!!!'));
  assert.match(block, /별도로 요청한 목표 문체가 없다면/);
  assert.match(block, /감탄과 평가의 강도/);
  assert.doesNotMatch(voicePromptBlock(buildVoiceProfile('결말이 아쉽다.')), /짧은 원문의 종결체 판정이 불확실/);
});

test('confidence ceiling preserves scores and never upgrades evidence sufficiency', () => {
  const sentence = '지역 도서관에서 신청 방법을 확인했다. ';
  for (const count of [0, 1, 3, 4, 7, 8]) {
    for (const confidence of ['low', 'medium', 'high']) {
      const original = { probability: 68, confidence, signalEvidence: [], modelProbability: 71 };
      const output = limitConfidenceToSample(original, sentence.repeat(count));
      assert.equal(output.confidence, count < 4 ? 'low' : count < 8 && confidence === 'high' ? 'medium' : confidence);
      assert.equal(output.probability, 68);
      assert.equal(output.modelProbability, 71);
      assert.equal(output.signalEvidence, original.signalEvidence);
    }
  }
  assert.equal(limitConfidenceToSample({ probability: 8, confidence: 'high' }, 'A short review.').confidence, 'low');
});

test('actual detect limits delivered confidence after selection without additional calls or score changes', async t => {
  const client = require('../engine-gpt-prod/openaiClient');
  const original = client.completeJson;
  let calls = 0;
  client.completeJson = async options => {
    calls++;
    return { model: options.model, usage: {}, json: { probability: 12, confidence: 'high', signals: [] } };
  };
  const file = require.resolve('../engine-gpt-prod');
  delete require.cache[file];
  let engine;
  try { engine = require('../engine-gpt-prod'); } finally { client.completeJson = original; }
  t.after(() => delete require.cache[file]);
  const output = await engine.detect({
    text: '지역 도서관에서 신청 방법을 확인했다.', allowLocalFallback: false,
    config: { models: { detect: 'primary-test', detectEscalation: 'recheck-test' }, reasoning: { detect: 'low', escalation: 'high' } }
  });
  assert.equal(calls, 1);
  assert.equal(output.probability, 12);
  assert.equal(output.confidence, 'low');
  assert.equal(output.detectDiagnostics.attempts[0].confidence, 'high');
  assert.equal(output.detectDiagnostics.recheckReason, 'none');
});
