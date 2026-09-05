'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prompt = require('../engine-gpt-prod/prompts/detect');
const engine = require('../engine-gpt-prod');
const { DETECT_SCHEMA } = require('../engine-gpt-prod/schemas');

test('감지 프롬프트는 장르 자체를 AI 근거로 쓰지 않고 반대 근거와 점수 앵커를 요구한다', () => {
  const ko = prompt.buildDetectPrompt('ko');
  assert.equal(prompt.DETECT_PROMPT_VERSION, 'detect-prompt-v5-cause-aligned-grounded-v2');
  assert.match(ko, /실제 작성 주체를 판정하는 확률이 아니다/u);
  assert.match(ko, /학술문·보고서·자소서·SEO 글/u);
  assert.match(ko, /만으로 점수를 올리지 않는다/u);
  assert.match(ko, /반대 근거도 반드시 반영/u);
  assert.match(ko, /0~20[\s\S]*21~49[\s\S]*50~74[\s\S]*75~100/u);
  assert.match(ko, /대표값이나 둥근 수에 몰지/u);
  assert.match(ko, /제목·표·목록·직접 인용·참고문헌/u);
  assert.match(ko, /독립 신호가 최소 2개/u);
  assert.match(ko, /21~49점에는 other_observed_style이 아닌 적격 category가 최소 1개/u);
  assert.match(ko, /moderate 또는 strong이면서 recurring 또는 pervasive/u);
  assert.match(ko, /other_observed_style은 보조 관찰 정보일 뿐이며 20점을 넘는 점수의 근거로 사용할 수 없다/u);
  assert.match(ko, /strength와 scope/u);
  assert.match(ko, /evidenceSentences/u);
  assert.match(ko, /4문장 미만/u);
  assert.match(ko, /8문장 이상/u);
});

test('영문 감지 프롬프트와 엔진 provenance도 같은 정책 버전을 노출한다', () => {
  const en = prompt.buildDetectPrompt('en');
  assert.match(en, /not a claim about who actually wrote/u);
  assert.match(en, /genre conventions and clean grammar alone are not AI evidence/u);
  assert.match(en, /21-49 requires at least one eligible category other than other_observed_style/u);
  assert.match(en, /moderate or strong strength and recurring or pervasive scope/u);
  assert.match(en, /other_observed_style is supplementary context only and can never support a score above 20/u);
  assert.equal(engine.DETECT_VERSION, 'gpt-detect-v1.26');
  assert.equal(engine.DETECT_PROMPT_VERSION, prompt.DETECT_PROMPT_VERSION);
});

test('감지 스키마는 자유 서술·원문 인용 없이 닫힌 원인 범주만 받는다', () => {
  const signal = DETECT_SCHEMA.properties.signals.items;
  assert.equal(Object.hasOwn(DETECT_SCHEMA.properties, 'summary'), false);
  assert.equal(Object.hasOwn(DETECT_SCHEMA.properties, 'detail'), false);
  assert.deepEqual(signal.required, ['category', 'strength', 'scope', 'evidenceSentences']);
  assert.equal(signal.properties.evidenceSentences.items.type, 'integer');
  assert.equal(signal.additionalProperties, false);
  assert.equal(signal.properties.description, undefined);
  assert.ok(signal.properties.category.enum.includes('insufficient_grounding'));
});

test('감지 장르 힌트는 충분히 확실하고 서로 분리된 세부 프로필에만 붙는다', () => {
  const trusted = engine.trustedDetectProfile({
    profile: 'academic_paper', confidence: 0.55, profileMargin: 0.5
  });
  assert.match(trusted, /profile=academic_paper/u);
  assert.match(trusted, /confidence=0\.55/u);
  assert.match(trusted, /profile_margin=0\.50/u);

  for (const profile of [
    { profile: 'unknown', confidence: 0.99, profileMargin: 0.9 },
    { profile: 'general', confidence: 0.99, profileMargin: 0.9 },
    { profile: 'academic_paper', confidence: 0.54, profileMargin: 0.9 },
    { profile: 'academic_paper', confidence: 0.9, profileMargin: 0.49 },
    { profile: 'academic_paper', confidence: 0.9 }
  ]) {
    assert.equal(engine.trustedDetectProfile(profile), '');
  }
});

test('감지 primary와 승격은 하나의 제한된 절대 시간 예산을 사용한다', () => {
  assert.equal(engine.detectTotalTimeoutMs(undefined), 120000);
  assert.equal(engine.detectTotalTimeoutMs(1000), 30000);
  assert.equal(engine.detectTotalTimeoutMs(999999), 240000);
});

test('유효한 primary 뒤 승격 실패는 모델 선택 호출 두 번에서 끝나고 primary를 사용한다', { concurrency: false }, async t => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalRetries = process.env.OPENAI_API_MAX_RETRIES;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_API_MAX_RETRIES = '0';
  const models = [];
  global.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    models.push(body.model);
    if (models.length > 1) {
      return new Response(JSON.stringify({ error: { message: 'bad escalation request' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    }
    const structured = {
      probability: 72,
      signals: [{ category: 'sentence_uniformity', strength: 'moderate', scope: 'recurring', evidenceSentences: [0, 1] }],
      confidence: 'low'
    };
    return new Response(JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(structured) }] }],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalRetries === undefined) delete process.env.OPENAI_API_MAX_RETRIES;
    else process.env.OPENAI_API_MAX_RETRIES = originalRetries;
  });

  const result = await engine.detect({
    text: '문장 길이가 비슷하게 반복됩니다. 같은 구조도 여러 문장에서 이어집니다. 다만 구체적인 경험 한 가지는 포함됩니다. 판단 근거를 확인할 수 있는 문장도 있습니다.',
    allowLocalFallback: false,
    config: {
      models: { detect: 'gpt-5.6-luna', detectEscalation: 'gpt-5.6-terra' },
      reasoning: { detect: 'low', escalation: 'high' },
      cache: { enabled: false }
    }
  });
  assert.deepEqual(models, ['gpt-5.6-luna', 'gpt-5.6-terra']);
  assert.equal(result.probability, 49);
  assert.equal(result.gptMeta.escalationFailed, true);
});
