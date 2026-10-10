'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prompt = require('../engine-gpt-prod/prompts/detect');
const engine = require('../engine-gpt-prod');
const { DETECT_SCHEMA } = require('../engine-gpt-prod/schemas');

test('감지 프롬프트는 장르 자체를 AI 근거로 쓰지 않고 반대 근거와 점수 앵커를 요구한다', () => {
  const ko = prompt.buildDetectPrompt('ko');
  assert.equal(prompt.DETECT_PROMPT_VERSION, 'detect-prompt-v9h-recurring-cause-band');
  assert.match(ko, /문법적인 어미 일치와 내용을 담은 상투적 틀을 구별/u);
  assert.match(ko, /동일 관찰을 재분류하는 것이지 두 번 세는 것이 아니다/u);
  assert.match(ko, /최소 2개가 필요/u);
  assert.match(ko, /신호 강도는 길이와 무관/u);
  assert.match(ko, /실제 작성 주체를 판정하는 확률이 아니다/u);
  assert.match(ko, /학술문·보고서·자소서처럼 원래 정돈된 장르/u);
  assert.match(ko, /만으로 점수를 올리지 않는다/u);
  assert.match(ko, /반대 근거로 반영한다/u);
  assert.match(ko, /조직의 균일함/u, 'v9: 현세대 생성문의 조직 균일성 단서');
  assert.match(ko, /overstructured_progression·formulaic_transition·sentence_uniformity로 센다/u);
  assert.doesNotMatch(ko, /같은 반복을 category만 바꾸어/u, 'v8의 검출 억제 규칙은 제외');
  assert.match(ko, /0~20[\s\S]*21~49[\s\S]*50~74[\s\S]*75~100/u);
  assert.match(ko, /대표값이나 둥근 수에 몰지/u);
  assert.match(ko, /제목·표의 틀과 숫자 셀·목록 표지·직접 인용·참고문헌/u);
  assert.match(ko, /표 안의 자연어 답변도 table_prose이며 eligibleForDetection=true이면 분석/u);
  assert.match(ko, /행·열의 소속을 유지/u);
  assert.match(ko, /eligibleForDetection=true/u);
  assert.match(ko, /referenceContext는 문맥 참고 자료/u);
  assert.match(ko, /독립 신호가 최소 2개/u);
  assert.match(ko, /21~49점에는 other_observed_style이 아닌 적격 category가 최소 1개/u);
  assert.match(ko, /moderate 또는 strong이면서 recurring 또는 pervasive/u);
  assert.match(ko, /other_observed_style은 보조 관찰 정보일 뿐이며 20점을 넘는 점수의 근거로 사용할 수 없다/u);
  assert.match(ko, /signals에는 서로 독립된 실제 원인만/u);
  assert.match(ko, /evidenceSentences/u);
  assert.match(ko, /4문장 미만/u);
  assert.match(ko, /8문장 이상/u);
});

test('영문 감지 프롬프트와 엔진 provenance도 같은 정책 버전을 노출한다', () => {
  const en = prompt.buildDetectPrompt('en');
  assert.match(en, /not a claim about who actually wrote/u);
  assert.match(en, /genre conventions and clean grammar alone are not evidence/u);
  assert.match(en, /uniformity of organization/u);
  assert.match(en, /21-49 requires at least one eligible category other than other_observed_style/u);
  assert.match(en, /moderate or strong strength and recurring or pervasive scope/u);
  assert.match(en, /other_observed_style is supplementary context only and can never support a score above 20/u);
  assert.match(en, /Reclassify the same observation rather than counting it twice/u);
  assert.equal(engine.DETECT_VERSION, 'gpt-detect-v1.53');
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

test('저점수 검토는 일괄 가산 대신 본문 신호 관찰과 국소 반대 근거를 요구한다', () => {
  const ko = prompt.buildDetectPrompt('ko');
  assert.match(ko, /먼저 위치가 확인되는 신호/u);
  assert.match(ko, /이름·숫자·전문용어·일인칭·경험했다는 주장·오탈자의 존재만으로 문체 신호를 상쇄하지/u);
  assert.match(ko, /해당 구간에서만 평가/u);
  assert.match(ko, /특정 평균 분포를 목표로 삼지도/u);
  assert.match(ko, /구체적 정보 한두 개, 사람이 썼을 가능성, strong 신호가 없다는 사실은 그런 균형이 아니다/u);
  assert.match(ko, /불균일한 전개가 관찰된 패턴을 실제로 끊는 해당 구간에서만/u);
  assert.deepEqual(Object.keys(DETECT_SCHEMA.properties), ['signals', 'probability', 'confidence']);
  const en = prompt.buildDetectPrompt('en');
  assert.match(en, /Observe located signals first/u);
  assert.match(en, /does not by itself cancel a style signal/u);
  assert.match(en, /uneven development actually interrupts the observed pattern/u);
});

test('두 독립 moderate 반복 원인이 주된 전개를 이루면 strong 없이도 50~74에서 판단한다', () => {
  const ko = prompt.buildDetectPrompt('ko');
  const en = prompt.buildDetectPrompt('en');
  assert.match(ko, /독립된 moderate 반복 패턴 두 개 이상이 함께 본문의 주된 전개를 특징지으면 50~74 구간을 선택/u);
  assert.match(ko, /50~74는 위치가 확인된 독립적 적격 원인 두 개 이상이 moderate 이상의 강도로 반복되어 함께 주된 전개를 이루고 비슷한 범위의 반대 근거는 없는 상태/u);
  assert.match(ko, /50~74에는 moderate 반복으로 충분하며 strong·내용 부실·빈틈없는 균일함을 추가로 요구하지 않는다/u);
  assert.match(en, /two independent moderate recurring patterns jointly characterize the main development, choose the 50-74 band/u);
  assert.match(en, /50-74 two or more independent located recurring causes of at least moderate strength that jointly shape the main development without comparably broad counterevidence/u);
  assert.match(en, /Moderate recurring evidence is sufficient for 50-74: do not require strong strength, empty content, or flawless uniformity/u);
});

test('국소 반복이나 비슷한 범위의 실질적 반대 근거는 21~49이며 원인 개수만으로 올리지 않는다', () => {
  const ko = prompt.buildDetectPrompt('ko');
  const en = prompt.buildDetectPrompt('en');
  assert.match(ko, /같은 반복 패턴을 실제로 끊는 반대 근거가 분석 가능 본문의 비슷한 범위에 있어야/u);
  assert.match(ko, /반복이 작은 국소 구간에만 있거나 실질적인 불균일 전개가 실제로 균형을 이루면 21~49/u);
  assert.match(ko, /개수만 보지 말고 범위와 강도를 판단/u);
  assert.match(ko, /0~20은 적격 반복 원인이 없거나 약한·일회성 신호뿐인 상태, 21~49는 적격 반복 원인 하나 또는 여러 원인의 범위가 작거나 실제 반대 근거와 균형을 이루는 혼합 상태/u);
  assert.match(en, /located counterevidence that interrupts the same recurring patterns across a comparable part of the eligible prose/u);
  assert.match(en, /keep 21-49 when their repetition is confined to a small local part or substantive uneven development actually balances it/u);
  assert.match(en, /Judge scope and intensity, never count alone/u);
  assert.match(en, /0-20 no eligible recurring cause or only weak\/isolated evidence; 21-49 one eligible recurring cause, or multiple causes whose limited reach or actual counterevidence makes the overall evidence mixed/u);
});

test('입증된 반복을 장르 이름만으로 약화하지 않고 전개를 지배하는 규칙성도 strong으로 본다', () => {
  const ko = prompt.buildDetectPrompt('ko');
  const en = prompt.buildDetectPrompt('en');
  assert.match(ko, /weak는 모호하거나 우연한 일치 또는 일반적인 장르 관습만으로 설명되는 표현/u);
  assert.match(ko, /moderate는 그 관습을 넘어 위치가 명확하게 반복되는 패턴/u);
  assert.match(ko, /strong은 전개를 지배하는 두드러지고 지속적인 규칙성 또는 정보나 논증을 거듭 대신하는 반복 패턴/u);
  assert.match(ko, /장르 이름만으로 독립적으로 입증된 패턴을 약하게 낮추지 않는다/u);
  assert.match(en, /weak is ambiguous or incidental, or explained solely by an ordinary genre convention/u);
  assert.match(en, /moderate is a clearly located repeated pattern that exceeds that convention/u);
  assert.match(en, /strong is conspicuous persistent regularity that controls development or repeatedly substitutes for information or argument/u);
  assert.match(en, /A genre label alone does not weaken an independently demonstrated pattern/u);
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
  assert.deepEqual(models, ['gpt-6-luna', 'gpt-6.1-sol']);
  assert.equal(result.probability, 49);
  assert.equal(result.gptMeta.engine, engine.DETECT_VERSION);
  assert.equal(result.gptMeta.detectPromptVersion, prompt.DETECT_PROMPT_VERSION);
  assert.equal(result.gptMeta.escalationFailed, true);
});
