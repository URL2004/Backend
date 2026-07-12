'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../engine-gpt-prod');
const runtime = require('../lib/gptRuntimeConfig');
const { safetyIdentifierForUid } = require('../engine-gpt-prod/openaiClient');
const qualityV2 = require('../engine-gpt-prod/finalQualityV2');
const { buildVoiceProfile } = require('../engine-gpt-prod/voiceProfile');

const SOURCE = '이 문장은 표현이 조금 어색하고 연결도 매끄럽지 않습니다. 그래서 읽는 흐름도 자연스럽지가 않습니다.';
const SAFE_POLISH = '이 문장은 표현이 다소 어색하고 연결도 매끄럽지 않습니다. 그래서 읽는 흐름도 자연스럽지 않습니다.';

function config() {
  return runtime.publicConfig(runtime.DEFAULT_CONFIG, 'test');
}

function apiResponse(json) {
  return new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(json) }] }],
    usage: {
      input_tokens: 40,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 60
    }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function installEngineMock(t, options = {}) {
  const originalFetch = global.fetch;
  const originalEnv = {
    key: process.env.OPENAI_API_KEY,
    salt: process.env.OPENAI_SAFETY_SALT,
    v2: process.env.HUMANIZE_ENGINE_V2_ENABLED,
    layout: process.env.GPT_LAYOUT_NLP_ENABLED,
    nikl: process.env.GPT_NIKL_QUALITY_ENABLED,
    qualityPattern: process.env.GPT_QUALITY_PATTERN_ENABLED
  };
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_SAFETY_SALT = 'engine-test-salt';
  process.env.HUMANIZE_ENGINE_V2_ENABLED = '1';
  process.env.GPT_LAYOUT_NLP_ENABLED = '0';
  process.env.GPT_NIKL_QUALITY_ENABLED = '0';
  process.env.GPT_QUALITY_PATTERN_ENABLED = '0';
  const calls = [];
  let semanticCalls = 0;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const name = body.text?.format?.name;
    calls.push({ name, model: body.model, body });
    if (options.refuseHumanize && name === 'gpt_prod_humanize_result') {
      return new Response(JSON.stringify({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'refused' }] }],
        usage: {}
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (name === 'gpt_prod_humanize_result') {
      const outputText = typeof options.humanize === 'function' ? options.humanize(body) : (options.humanize || SAFE_POLISH);
      return apiResponse({ outputText, editIntensity: 'light', protectedTerms: [], riskFlags: [], factualRiskNotes: [], warnings: [] });
    }
    if (name === 'gpt_prod_polish_surface_retry') {
      return apiResponse({
        outputText: options.retryOutput || SAFE_POLISH,
        safeChangeFound: options.safeChangeFound !== false,
        notes: []
      });
    }
    if (name === 'gpt_prod_general_surface_retry') {
      return apiResponse({
        outputText: options.generalRetryOutput || SAFE_POLISH,
        safeChangeFound: options.generalSafeChangeFound !== false,
        notes: []
      });
    }
    if (name === 'gpt_prod_soft_claim_ledger') {
      const source = String(body.input || '').split('[SOURCE]\n')[1] || SOURCE;
      const normalized = source.replace(/\s+/gu, ' ').trim();
      if (options.invalidLedger) {
        return apiResponse({ claims: [{ claim: '검증되지 않은 주장', evidence_text: '원문에 존재하지 않는 근거' }] });
      }
      const claimCount = options.multipleLedgerClaims ? 3 : 1;
      const claims = Array.from({ length: claimCount }, (_, index) => ({
        claim: `원문의 핵심 내용을 보존한다 ${index + 1}.`,
        evidence_text: normalized.slice(index * 24, index * 24 + 20)
      }));
      return apiResponse({ claims });
    }
    if (name === 'gpt_prod_semantic_judge') {
      semanticCalls += 1;
      const violations = options.semanticViolation
        ? [{ type: 'added_claim', span: '미래연구원', detail: '원문에 없는 기관과 주장' }]
        : [];
      return apiResponse({ violations });
    }
    if (name === 'gpt_prod_judge_repair') {
      return apiResponse({ outputText: options.repairOutput || options.humanize || SAFE_POLISH, repaired: true, notes: [] });
    }
    throw new Error(`unexpected schema: ${name}`);
  };
  t.after(() => {
    global.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalEnv.key;
    process.env.OPENAI_SAFETY_SALT = originalEnv.salt;
    process.env.HUMANIZE_ENGINE_V2_ENABLED = originalEnv.v2;
    process.env.GPT_LAYOUT_NLP_ENABLED = originalEnv.layout;
    process.env.GPT_NIKL_QUALITY_ENABLED = originalEnv.nikl;
    process.env.GPT_QUALITY_PATTERN_ENABLED = originalEnv.qualityPattern;
  });
  return { calls, semanticCalls: () => semanticCalls };
}

test('공개 polish는 실제 polish로 연결되고 서버 편집률·HMAC·engineMeta를 기록한다', { concurrency: false }, async t => {
  const mock = installEngineMock(t);
  const uid = 'firebase-user-123';
  const out = await engine.run({ text: SOURCE, mode: 'polish', allowPolish: true, uid, config: config() });
  assert.equal(out.mode, 'polish');
  assert.equal(out.engineMeta.requestedMode, 'polish');
  assert.equal(out.engineMeta.effectiveMode, 'polish');
  assert.equal(out.engineMeta.semanticJudgeRan, true);
  assert.equal(out.engineMeta.logicalChunkCount, out.engineMeta.chunkCount);
  assert.equal(out.engineMeta.lockedChunkCount, 0);
  assert.equal(out.engineMeta.transformedChunkCount, 1);
  assert.equal(out.engineMeta.humanizeCallCount, 1);
  assert.equal(out.engineMeta.semanticModelCallCount, 1);
  assert.equal(out.engineMeta.surfaceRetryCallCount, 0);
  assert.equal(out.engineMeta.modelCallCount, 2);
  assert.equal(out.engineMeta.semanticSectionCount, 1);
  assert.equal(out.result.records[0].changedSentenceRatio, 1);
  assert.ok(out.result.records[0].charEditRatio > 0);
  const humanizeCall = mock.calls.find(call => call.name === 'gpt_prod_humanize_result');
  assert.ok(humanizeCall.body.max_output_tokens >= 2400, '한국어 출력과 추론 토큰을 함께 수용해야 한다');
  const expectedSafety = safetyIdentifierForUid(uid, 'engine-test-salt');
  for (const call of mock.calls) {
    assert.equal(call.body.safety_identifier, expectedSafety);
    assert.equal(JSON.stringify(call.body).includes(uid), false);
  }
});

test('polish는 의미 심사 뒤 새 문단을 만들지 않고 원문 문단 수로 전달한다', { concurrency: false }, async t => {
  const source = '첫 문장은 표현이 조금 어색합니다. 둘째 문장은 연결이 매끄럽지 않습니다. 마지막 문장은 핵심 내용을 정리합니다.';
  const splitOutput = '첫 문장은 표현이 다소 어색합니다.\n\n둘째 문장은 연결이 자연스럽지 않습니다.\n\n마지막 문장은 핵심 내용을 정리합니다.';
  installEngineMock(t, { humanize: splitOutput });
  const out = await engine.run({ text: source, mode: 'polish', allowPolish: true, uid: 'paragraph-polish-user', config: config() });
  assert.notEqual(out.status, 'blocked', JSON.stringify({
    criticals: out.floorReport?.criticals,
    warnings: out.floorReport?.warnings,
    gateWarnings: out.result?.gateWarnings,
    records: out.result?.records
  }));
  assert.equal(out.result.outputText.split(/\n{2,}/u).length, 1);
  assert.equal(out.result.outputText.replace(/\s+/gu, ''), splitOutput.replace(/\s+/gu, ''));
  assert.equal(out.qualityWarnings.some(item => item.code === 'paragraph_structure_changed'), false);
  assert.equal(out.result.structureLock.layoutRepair.paragraphs.policy, 'exact_polish');
  assert.equal(out.result.structureLock.layoutRepair.paragraphs.afterCount, 1);
});

test('원문부터 있던 비인접 반복은 결과에서 늘지 않으면 needs_review로 올리지 않는다', { concurrency: false }, async t => {
  const repeated = '같은 결론을 다시 설명하는 충분히 긴 문장입니다.';
  const source = `${repeated} 중간에는 서로 다른 근거를 자세히 설명합니다. ${repeated} 마지막에는 적용 범위를 정리합니다.`;
  const output = `${repeated} 중간에는 서로 다른 근거를 차례로 설명합니다. ${repeated} 마지막에는 적용 범위를 정돈합니다.`;
  installEngineMock(t, { humanize: output });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'source-repetition-user', config: config() });
  assert.notEqual(out.status, 'blocked', JSON.stringify({
    criticals: out.floorReport?.criticals,
    warnings: out.floorReport?.warnings,
    gateWarnings: out.result?.gateWarnings,
    records: out.result?.records
  }));
  assert.equal(out.qualityWarnings.some(item => item.code === 'repetition'), false);
  assert.equal(out.result.repetitionAudit.increased, false);
  assert.ok(out.result.repetitionAudit.delta.total <= 0);
  assert.equal(out.qualityStatus, 'clean');
});

test('polish 무변환은 표면 수정 재시도 정확히 1회 후 안전 결과를 전달한다', { concurrency: false }, async t => {
  const mock = installEngineMock(t, { humanize: SOURCE, retryOutput: SAFE_POLISH, safeChangeFound: true });
  const out = await engine.run({ text: SOURCE, mode: 'polish', allowPolish: true, uid: 'user-1', config: config() });
  assert.notEqual(out.status, 'blocked');
  assert.equal(out.result.outputText, SAFE_POLISH);
  assert.equal(out.engineMeta.repairCount, 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_polish_surface_retry').length, 1);
});

test('polish에서 안전한 수정이 없으면 차단하고 의미 심사 비용을 쓰지 않는다', { concurrency: false }, async t => {
  const mock = installEngineMock(t, { humanize: SOURCE, retryOutput: SOURCE, safeChangeFound: false });
  const out = await engine.run({ text: SOURCE, mode: 'polish', allowPolish: true, uid: 'user-2', config: config() });
  assert.equal(out.status, 'blocked');
  assert.ok(out.floorReport.criticals.some(item => item.gate === 'polish_unchanged'));
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_polish_surface_retry').length, 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_semantic_judge').length, 0);
});

test('수리 후 의미 위반이 남으면 done 호환 상태인 needs_review로 전달하고 상위 모델은 판정만 승격한다', { concurrency: false }, async t => {
  const source = Array.from({ length: 3 }, () => SOURCE).join(' ');
  const output = `${source} 미래연구원이 새로운 결과를 발표했습니다.`;
  const mock = installEngineMock(t, { humanize: output, repairOutput: output, semanticViolation: true });
  const out = await engine.run({ text: source, mode: 'formal', uid: 'user-3', config: config() });
  assert.equal(out.status, 'needs_review');
  assert.equal(out.qualityStatus, 'needs_review');
  assert.ok(out.qualityWarnings.some(item => item.code === 'semantic_addition'));
  assert.equal(out.fallbackCount, 0);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_judge_repair').length, 1);
  assert.ok(mock.calls.some(call => call.name === 'gpt_prod_semantic_judge' && call.model === 'gpt-5.4'));
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_soft_claim_ledger').length, 0);
});

test('청크에 새 사실이 생기면 상위 모델에 제거 항목을 명시해 재시도한다', { concurrency: false }, async t => {
  const source = '연구팀은 도서관 이용 방식과 학습 환경의 관계를 살펴봤습니다. 설문 문항과 면담 기록을 함께 분석했으며, 조사 절차와 관찰 결과를 구분해 보고서로 정리했습니다. 연구 과정에서 확인한 자료의 범위와 해석의 한계도 원문에 적힌 수준으로 설명했습니다.';
  const unsafe = `${source} 미래연구원은 2027년에 후속 조사를 시작합니다.`;
  const safe = source.replace('함께 분석했으며', '함께 살펴봤으며');
  const mock = installEngineMock(t, {
    humanize: body => JSON.stringify(body.input || '').includes('1차 결과에 원문에 없는 사실이 검출됐다') ? safe : unsafe
  });
  const out = await engine.run({ text: source, mode: 'formal', uid: 'novelty-retry-user', config: config() });
  assert.notEqual(out.status, 'blocked');
  assert.equal(out.result.outputText, safe);
  assert.equal(out.fallbackCount, 0);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  const escalation = mock.calls.find(call => JSON.stringify(call.body.input || '').includes('1차 결과에 원문에 없는 사실이 검출됐다'));
  assert.ok(escalation);
  assert.ok(JSON.stringify(escalation.body.input || '').includes('미래연구원'));
  assert.ok(JSON.stringify(escalation.body.input || '').includes('2027'));
});

test('OpenAI refusal은 최종 결과로 전달하지 않고 strict 차단한다', { concurrency: false }, async t => {
  const mock = installEngineMock(t, { refuseHumanize: true });
  const out = await engine.run({ text: SOURCE, mode: 'blog', uid: 'user-4', config: config() });
  assert.equal(out.status, 'blocked');
  assert.equal(out.result.outputText, SOURCE);
  assert.ok(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length >= 2);
});

test('v2 청크가 보호 사실을 잃으면 상위 모델 재시도 후 원문으로 복귀한다', { concurrency: false }, async t => {
  const source = '한국대학교 연구팀은 학생 20명을 조사해 도서관 이용 방식과 학습 환경의 관계를 살펴봤습니다. 연구팀은 설문 문항과 면담 기록을 함께 분석했고, 조사 절차와 관찰 결과를 구분해 충분한 분량의 보고서로 정리했습니다.';
  const unsafe = '한 대학 연구팀은 여러 학생을 조사해 도서관 이용 방식과 학습 환경의 관계를 살펴봤습니다. 연구팀은 설문 문항과 면담 기록을 함께 분석했고, 조사 절차와 관찰 결과를 구분해 충분한 분량의 보고서로 자연스럽게 정리했습니다.';
  const mock = installEngineMock(t, { humanize: unsafe });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'fact-loss-user', config: config() });
  assert.equal(out.status, 'blocked');
  assert.equal(out.result.outputText, source);
  assert.equal(out.fallbackCount, 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
});

test('두 모델이 보존 게이트에 실패하면 원문에서 안전한 표면 교정 1회만 허용한다', { concurrency: false }, async t => {
  const source = '한국대학교 연구팀은 학생 20명을 조사해 도서관 이용 방식과 학습 환경의 관계를 살펴봤습니다. 연구팀은 설문 문항과 면담 기록을 함께 분석했고, 조사 절차와 관찰 결과를 구분해 충분한 분량의 보고서로 정리했습니다.';
  const unsafe = '한 대학 연구팀은 여러 학생을 조사해 도서관 이용 방식과 학습 환경의 관계를 살펴봤습니다. 연구팀은 설문 문항과 면담 기록을 함께 분석했고, 조사 절차와 관찰 결과를 구분해 충분한 분량의 보고서로 자연스럽게 정리했습니다.';
  const safe = source.replace('함께 분석했고', '함께 살펴봤고');
  const mock = installEngineMock(t, { humanize: unsafe, generalRetryOutput: safe });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'safe-fallback-surface-user', config: config() });
  assert.notEqual(out.status, 'blocked');
  assert.equal(out.result.outputText, safe);
  assert.equal(out.fallbackCount, 0);
  assert.equal(out.engineMeta.repairCount, 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry').length, 1);
});

test('일반 모드 무변환 재시도는 구조를 고정한 최소 수정 지시를 상위 모델에 보낸다', { concurrency: false }, async t => {
  const source = '창가에 빛이 오래 머물렀습니다. 조용한 방 안에서 오래된 책장을 넘기며 지난 계절의 냄새를 떠올렸습니다. 말하지 못한 문장들은 그대로 남아 있었고, 저는 그 여백을 천천히 바라봤습니다. 그날의 바람은 얇은 커튼을 흔들었고, 멀리서 들려오는 발소리는 금세 고요 속으로 사라졌습니다. 저녁이 내려앉을 무렵에는 벽에 걸린 그림자도 조금씩 길어졌습니다. 손끝에 남은 종이의 감촉과 희미한 먼지 냄새가 방 안의 시간을 천천히 붙잡고 있었습니다.';
  const mock = installEngineMock(t, {
    humanize: body => JSON.stringify(body.input || '').includes('원문과 완전히 같은 출력은 이번 재시도 실패다')
      ? source.replace('오래 머물렀습니다', '한동안 머물렀습니다')
      : source
  });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'creative-noop-user', config: config() });
  assert.notEqual(out.status, 'blocked', JSON.stringify({
    criticals: out.floorReport?.criticals?.map(item => item.gate || item.type),
    warnings: out.floorReport?.warnings,
    chunkWarnings: out.chunks?.map(item => ({ hardFailReason: item.hardFailReason, warnings: item.warnings, fallback: item.fallback }))
  }));
  assert.notEqual(out.result.outputText, source);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.ok(mock.calls.some(call => JSON.stringify(call.body.input || '').includes('원문과 완전히 같은 출력은 이번 재시도 실패다')));
});

test('두 일반 모델이 모두 무변환이면 문서 표면 교정 1회로 안전한 최소 수정을 만든다', { concurrency: false }, async t => {
  const source = '조금만 크게 볼 수는 없을까요. 사람마다 살아온 경험과 생각이 다르다는 점을 인정하면 됩니다. 상대를 완전히 이해하기 어렵더라도 서로의 자리와 배경을 존중할 수 있습니다. 유독 정치와 종교 같은 주제 앞에서 이 태도가 흔들리기도 합니다. 서로 다른 생각을 마주할 때에도 먼저 판단하기보다 차분히 듣는 태도가 필요합니다.';
  const safe = source.replace('인정하면 됩니다', '받아들이면 됩니다');
  const mock = installEngineMock(t, { humanize: source, generalRetryOutput: safe });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'general-surface-user', config: config() });
  assert.notEqual(out.status, 'blocked');
  assert.equal(out.result.outputText, safe);
  assert.equal(out.fallbackCount, 0);
  assert.equal(out.engineMeta.repairCount, 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry').length, 1);
});

test('구두점 없는 장문을 균등 분할하면 상위 모델로 1회 재시도해 장단문 분포를 복구한다', { concurrency: false }, async t => {
  const varied = [
    '활동은 뜻깊게 마무리되었습니다.',
    '참여자는 처음에 설명 방향을 정하는 일이 쉽지 않았지만 여러 자료를 차분히 비교하고 상대가 이해하기 어려워하는 지점을 다시 살피면서 핵심 개념을 구체적인 예시와 연결해 전달하는 방법을 익혔습니다.',
    '설명하는 과정에서 모호하게 알고 있던 내용도 스스로 다시 정리할 수 있었습니다.',
    '서로 질문을 주고받으면서 다른 관점을 존중하는 태도도 배웠습니다.',
    '마지막에는 함께 문제를 해결한 과정이 확실한 복습이 되었고 앞으로도 배운 내용을 꾸준히 나누겠다는 생각을 갖게 되었으며, 이 경험을 바탕으로 이후의 학습에서도 필요한 내용을 스스로 점검하는 습관을 이어 가기로 했습니다.'
  ].join(' ');
  const source = varied.replace(/[.!?]/gu, ' ');
  const words = source.trim().split(/\s+/u);
  const targetLength = source.replace(/\s+/gu, '').length / 5;
  const groups = [];
  let current = [];
  let currentLength = 0;
  for (const word of words) {
    if (groups.length < 4 && current.length && currentLength + word.length > targetLength) {
      groups.push(current.join(' '));
      current = [];
      currentLength = 0;
    }
    current.push(word);
    currentLength += word.length;
  }
  groups.push(current.join(' '));
  const uniform = groups.map(item => `${item}.`).join(' ');
  const sourceVoice = buildVoiceProfile(source, { documentProfile: 'unknown' });
  const target = sourceVoice.sentence.sparseSplitTarget;
  const uniformVoice = buildVoiceProfile(uniform, { documentProfile: 'unknown' });
  const variedVoice = buildVoiceProfile(varied, { documentProfile: 'unknown' });
  assert.equal(sourceVoice.sentence.punctuationSparse, true);
  assert.ok(uniformVoice.sentence.min > target.shortMax || uniformVoice.sentence.max < target.longMin);
  assert.ok(variedVoice.sentence.min <= target.shortMax);
  assert.ok(variedVoice.sentence.max >= target.longMin);

  let humanizeCalls = 0;
  const mock = installEngineMock(t, {
    humanize: () => {
      humanizeCalls += 1;
      return humanizeCalls === 1 ? uniform : varied;
    }
  });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'sparse-voice-user', config: config() });
  const outputVoice = buildVoiceProfile(out.result.outputText, { documentProfile: out.engineMeta.documentProfile });
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.equal(out.fallbackCount, 0);
  assert.ok(outputVoice.sentence.min <= target.shortMax);
  assert.ok(outputVoice.sentence.max >= target.longMin);
});

test('기존 장단문을 중간 길이로 평탄화하면 상위 모델이 원문 분포를 복구한다', { concurrency: false }, async t => {
  const source = '짧게 관찰함. 이 문장은 앞 문장보다 조금 더 길게 이어지는 활동 내용을 기록함. 학생이 여러 자료를 직접 찾아 비교하고 발표 과정에서 친구들의 질문에 답하며 탐구 내용을 크게 확장한 매우 긴 관찰 문장을 기록함. 마지막은 다시 짧게 마무리함.';
  const markers = ['[[[V2_SENTENCE_0001]]]', '[[[V2_SENTENCE_0002]]]', '[[[V2_SENTENCE_0003]]]'];
  const uniform = [
    '학생이 여러 자료를 직접 찾아 비교한 활동 내용을 기록함.',
    '발표 과정에서 친구들의 질문에 답하며 탐구 내용을 확장한 관찰 문장을 기록함.',
    '이 문장은 앞 문장보다 조금 더 길게 이어지고 내용을 크게 확장함.',
    '마지막은 활동을 짧게 관찰하고 다시 마무리함.'
  ].map((sentence, index) => `${sentence}${markers[index] || ''}`).join('');
  const safe = source.replace('활동 내용을 기록함', '활동 과정을 기록함');
  const safeMarked = safe.split(/(?<=[.])\s+/u)
    .map((sentence, index) => `${sentence}${markers[index] || ''}`)
    .join('');
  let humanizeCalls = 0;
  const mock = installEngineMock(t, {
    humanize: () => {
      humanizeCalls += 1;
      return humanizeCalls === 1 ? uniform : safeMarked;
    }
  });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'existing-voice-user', config: config() });
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.ok(mock.calls.some(call => String(call.body.input || '').includes('장단문 분포가 평탄해짐')));
  assert.notEqual(out.status, 'blocked');
  assert.equal(out.result.outputText, safe);
  assert.equal(out.fallbackCount, 0);
});

test('두 voice 시도가 모두 실패하면 원문 기반 최소 교정으로 안전 복귀한다', { concurrency: false }, async t => {
  const source = '짧게 관찰함. 이 문장은 앞 문장보다 조금 더 길게 이어지는 활동 내용을 기록함. 학생이 여러 자료를 직접 찾아 비교하고 발표 과정에서 친구들의 질문에 답하며 탐구 내용을 크게 확장한 매우 긴 관찰 문장을 기록함. 마지막은 다시 짧게 마무리함.';
  const markers = ['[[[V2_SENTENCE_0001]]]', '[[[V2_SENTENCE_0002]]]', '[[[V2_SENTENCE_0003]]]'];
  const uniform = [
    '학생이 여러 자료를 직접 찾아 비교한 활동 내용을 기록함.',
    '발표 과정에서 친구들의 질문에 답하며 탐구 내용을 확장한 관찰 문장을 기록함.',
    '이 문장은 앞 문장보다 조금 더 길게 이어지고 내용을 크게 확장함.',
    '마지막은 활동을 짧게 관찰하고 다시 마무리함.'
  ].map((sentence, index) => `${sentence}${markers[index] || ''}`).join('');
  const safe = source.replace('활동 내용을 기록함', '활동 과정을 기록함');
  let humanizeCalls = 0;
  const mock = installEngineMock(t, {
    humanize: () => {
      humanizeCalls += 1;
      return humanizeCalls === 1
        ? uniform
        : source.replace('활동 내용을 기록함', '활동 과정을 기록함');
    },
    generalRetryOutput: safe
  });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'mixed-voice-user', config: config() });
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry').length, 1);
  assert.notEqual(out.status, 'blocked');
  assert.equal(out.result.outputText, safe);
  assert.equal(out.fallbackCount, 0);
  assert.equal(out.qualityWarnings.some(item => item.code === 'sentence_distribution_shift'), false);
});

test('원문 기반 최소 교정도 장단문 분포를 평탄화하면 전달하지 않는다', { concurrency: false }, async t => {
  const source = '짧게 관찰함. 이 문장은 앞 문장보다 조금 더 길게 이어지는 활동 내용을 기록함. 학생이 여러 자료를 직접 찾아 비교하고 발표 과정에서 친구들의 질문에 답하며 탐구 내용을 크게 확장한 매우 긴 관찰 문장을 기록함. 마지막은 다시 짧게 마무리함.';
  const markers = ['[[[V2_SENTENCE_0001]]]', '[[[V2_SENTENCE_0002]]]', '[[[V2_SENTENCE_0003]]]'];
  const uniformSentences = [
    '학생이 여러 자료를 직접 찾아 비교한 활동 내용을 기록함.',
    '발표 과정에서 친구들의 질문에 답하며 탐구 내용을 확장한 관찰 문장을 기록함.',
    '이 문장은 앞 문장보다 조금 더 길게 이어지고 내용을 크게 확장함.',
    '마지막은 활동을 짧게 관찰하고 다시 마무리함.'
  ];
  const uniformMarked = uniformSentences
    .map((sentence, index) => `${sentence}${markers[index] || ''}`)
    .join('');
  const uniform = uniformSentences.join(' ');
  const mock = installEngineMock(t, { humanize: uniformMarked, generalRetryOutput: uniform });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'voice-retry-reject-user', config: config() });
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry').length, 1);
  assert.equal(out.status, 'blocked');
  assert.equal(out.result.outputText, source);
});

test('voice 재시도 실패 후 안전한 접속부사 문장부호는 모델 호출 없이 최소 교정한다', { concurrency: false }, async t => {
  const source = '짧게 관찰함. 이 문장은 앞 문장보다 조금 더 길게 이어지는 활동 내용을 기록함. 학생이 여러 자료를 직접 찾아 비교하고 발표 과정에서 친구들의 질문에 답하며 탐구 내용을 크게 확장한 매우 긴 관찰 문장을 기록함. 그렇다면 마지막은 다시 짧게 마무리함.';
  const markers = ['[[[V2_SENTENCE_0001]]]', '[[[V2_SENTENCE_0002]]]', '[[[V2_SENTENCE_0003]]]'];
  const uniform = [
    '학생이 여러 자료를 직접 찾아 비교한 활동 내용을 기록함.',
    '발표 과정에서 친구들의 질문에 답하며 탐구 내용을 확장한 관찰 문장을 기록함.',
    '이 문장은 앞 문장보다 조금 더 길게 이어지고 내용을 크게 확장함.',
    '그렇다면 마지막은 활동을 짧게 관찰하고 다시 마무리함.'
  ].map((sentence, index) => `${sentence}${markers[index] || ''}`).join('');
  const mock = installEngineMock(t, { humanize: uniform });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'voice-deterministic-surface-user', config: config() });
  assert.notEqual(out.status, 'blocked');
  assert.equal(out.result.outputText, source.replace('그렇다면 마지막은', '그렇다면, 마지막은'));
  assert.equal(out.engineMeta.repairCount, 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry').length, 0);
  assert.equal(out.qualityWarnings.some(item => item.code === 'sentence_distribution_shift'), false);
});

test('18문장 polish는 비문·접속 교정을 위해 문장 경계 토큰을 강제하지 않는다', { concurrency: false }, async t => {
  const source = Array.from({ length: 18 }, (_, index) => (
    `${index + 1}번째 활동에서 ${'여러 내용을 '.repeat((index % 4) + 1)}차분히 살피고 기록함.`
  )).join(' ');
  const output = source.replaceAll('기록함', '정리함');
  const mock = installEngineMock(t, { humanize: output });
  const out = await engine.run({ text: source, mode: 'polish', allowPolish: true, uid: 'long-polish-user', config: config() });
  const humanizeCall = mock.calls.find(call => call.name === 'gpt_prod_humanize_result');
  assert.notEqual(out.status, 'blocked');
  assert.doesNotMatch(String(humanizeCall.body.input || ''), /V2_SENTENCE_/u);
});

test('두 모델이 보조 문장 경계 토큰을 실패하면 원문 기반 최소 교정으로 안전 복귀한다', { concurrency: false }, async t => {
  const source = '짧게 관찰함. 이 문장은 앞 문장보다 조금 더 길게 이어지는 활동 내용을 기록함. 학생이 여러 자료를 직접 찾아 비교하고 발표 과정에서 친구들의 질문에 답하며 탐구 내용을 크게 확장한 매우 긴 관찰 문장을 기록함. 마지막은 다시 짧게 마무리함.';
  const output = source.replace('활동 내용을 기록함', '활동 과정을 정리함');
  const safe = source.replace('활동 내용을 기록함', '활동 과정을 기록함');
  const mock = installEngineMock(t, { humanize: output, generalRetryOutput: safe });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'boundary-review-user', config: config() });
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry').length, 1);
  assert.equal(out.fallbackCount, 0);
  assert.notEqual(out.status, 'blocked');
  assert.equal(out.result.outputText, safe);
  assert.equal(out.engineMeta.repairCount, 1);
  assert.equal(out.qualityWarnings.some(item => item.code === 'sentence_distribution_shift'), false);
});

test('영어 입력은 세 공개 모드 모두 API 호출 전에 한국어 전용 오류로 차단한다', { concurrency: false }, async t => {
  const mock = installEngineMock(t);
  const english = 'This is an English document that should never be sent to the humanizing model because the service is Korean only.';
  for (const mode of ['blog', 'formal', 'polish']) {
    await assert.rejects(
      () => engine.run({ text: english, mode, allowPolish: true, uid: 'english-user', config: config() }),
      error => error.code === 'HUMANIZE_KOREAN_ONLY' && error.noCharge === true
    );
  }
  assert.equal(mock.calls.length, 0);
});

test('v2 플래그를 0으로 내리면 safety salt 없이 레거시 엔진으로 즉시 복귀한다', { concurrency: false }, async t => {
  const mock = installEngineMock(t, { humanize: SAFE_POLISH });
  process.env.HUMANIZE_ENGINE_V2_ENABLED = '0';
  delete process.env.OPENAI_SAFETY_SALT;
  const out = await engine.run({ text: SOURCE, mode: 'blog', uid: 'rollback-user', config: config() });
  assert.equal(out.engineMeta.engineVersion, 'gpt-prod-operating-engine-v1');
  assert.ok(mock.calls.length >= 1);
  for (const call of mock.calls) {
    assert.equal(Object.prototype.hasOwnProperty.call(call.body, 'safety_identifier'), false);
    assert.equal(JSON.stringify(call.body).includes('rollback-user'), false);
  }
});

test('장문 섹션 심사도 문서 전체 수리는 최대 1회만 수행한다', { concurrency: false }, async t => {
  const mock = installEngineMock(t, { semanticViolation: true, multipleLedgerClaims: true });
  const source = '원문의 핵심 주장과 근거를 보존해야 합니다. '.repeat(650);
  const output = '원문의 핵심 주장과 근거를 자연스럽게 보존해야 합니다. '.repeat(560);
  const report = await qualityV2.runSemanticDocumentAudit({ source, outputText: output, mode: 'assignment', config: config() });
  assert.ok(report.sectionCount >= 2);
  assert.equal(report.repairCount, 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_judge_repair').length, 1);
});

test('결정론 claim 원장은 원문 구절만 사용하고 실제 의미 심사를 계속한다', { concurrency: false }, async t => {
  const mock = installEngineMock(t);
  const source = SOURCE.repeat(5);
  const report = await qualityV2.runSemanticDocumentAudit({ source, outputText: source, mode: 'polish', config: config() });
  assert.equal(report.pass, true);
  assert.equal(report.uncertain, false);
  assert.ok(mock.semanticCalls() >= 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_soft_claim_ledger').length, 0);
  const semanticCall = mock.calls.find(call => call.name === 'gpt_prod_semantic_judge');
  assert.ok(String(semanticCall.body.input || '').includes(`[SOURCE]\n${source}`));
  assert.ok(String(semanticCall.body.input || '').includes('[SOURCE CLAIM LEDGER]'));
});

test('괄호형 보호 명칭은 전체 표기나 약어 중 하나가 남으면 같은 규칙으로 보존 판정한다', () => {
  const base = {
    source: '한국어 처리 시스템(KPS)은 문장을 분석합니다.',
    mode: 'assignment',
    contract: {},
    voiceProfile: null,
    documentProfile: { profile: 'report_assignment' },
    structureAudit: null,
    protectedTerms: ['한국어 처리 시스템(KPS)']
  };
  const abbreviationOnly = qualityV2.buildDeterministicAudit({ ...base, outputText: 'KPS는 문장을 분석합니다.' });
  assert.equal(abbreviationOnly.warnings.some(item => item.code === 'protected_term_loss'), false);
  const missing = qualityV2.buildDeterministicAudit({ ...base, outputText: '이 시스템은 문장을 분석합니다.' });
  assert.equal(missing.warnings.some(item => item.code === 'protected_term_loss'), true);
});

test('의미 수리 후보가 문서를 축약하면 폐기하고 수리 전 결과를 상위 모델에 재판정한다', { concurrency: false }, async t => {
  const mock = installEngineMock(t, {
    semanticViolation: true,
    multipleLedgerClaims: true,
    repairOutput: '핵심만 요약합니다.'
  });
  const source = SOURCE.repeat(8);
  const beforeRepair = SAFE_POLISH.repeat(8);
  const report = await qualityV2.runSemanticDocumentAudit({ source, outputText: beforeRepair, mode: 'polish', config: config() });
  assert.equal(report.outputText, beforeRepair);
  assert.equal(report.repairCount, 1);
  assert.equal(report.repairRejected, true);
  assert.equal(report.reports[0].repairRejected, true);
  assert.ok(report.reports[0].repairRejectReasons.includes('repair_collapsed'));
  assert.ok(mock.calls.some(call => call.name === 'gpt_prod_semantic_judge' && call.model === 'gpt-5.4'));
});

test('사실 감사가 깨끗한 변환을 원문으로 완전히 되돌리는 의미 수리는 폐기한다', { concurrency: false }, async t => {
  const source = SOURCE.repeat(8);
  const beforeRepair = SAFE_POLISH.repeat(8);
  const mock = installEngineMock(t, {
    semanticViolation: true,
    multipleLedgerClaims: true,
    repairOutput: source
  });
  const report = await qualityV2.runSemanticDocumentAudit({ source, outputText: beforeRepair, mode: 'assignment', config: config() });
  assert.equal(report.outputText, beforeRepair);
  assert.equal(report.repairRejected, true);
  assert.ok(report.reports[0].repairRejectReasons.includes('repair_erased_transform'));
  assert.ok(mock.calls.some(call => call.name === 'gpt_prod_semantic_judge' && call.model === 'gpt-5.4'));
});

test('의미 수리가 특정 문장만 크게 축약해 원문 리듬을 훼손하면 폐기한다', { concurrency: false }, async t => {
  const source = [
    '학생은 수업 자료를 차분히 살펴보고 핵심 내용을 기록함.',
    '모둠 활동에서는 친구들의 의견을 들으며 서로 다른 관점을 비교함.',
    '발표를 준비하는 과정에서 여러 자료의 공통점과 차이점을 직접 찾아 표로 정리하고 질문에 답할 근거를 충분히 마련함.',
    '발표 중에는 또렷한 목소리로 조사 내용을 설명하고 질문에 답함.',
    '어려운 개념은 교과서의 사례와 연결하여 다시 설명함.',
    '활동 뒤에는 자신의 설명에서 부족했던 부분을 찾아 보완함.',
    '친구의 피드백을 받아 다음 활동의 계획도 구체적으로 세움.',
    '마지막에는 배운 내용을 정리하며 꾸준히 탐구하는 태도를 보임.'
  ].join(' ');
  const beforeRepair = source.replace('차분히', '꼼꼼히');
  const repairOutput = beforeRepair.replace(
    '발표를 준비하는 과정에서 여러 자료의 공통점과 차이점을 직접 찾아 표로 정리하고 질문에 답할 근거를 충분히 마련함.',
    '발표 자료를 간단히 정리함.'
  );
  const mock = installEngineMock(t, {
    semanticViolation: true,
    multipleLedgerClaims: true,
    repairOutput
  });
  const report = await qualityV2.runSemanticDocumentAudit({ source, outputText: beforeRepair, mode: 'assignment', config: config() });
  assert.equal(report.outputText, beforeRepair);
  assert.equal(report.repairRejected, true);
  assert.ok(report.reports[0].repairRejectReasons.includes('sentence_shape_worsened'));
  assert.ok(mock.calls.some(call => call.name === 'gpt_prod_semantic_judge' && call.model === 'gpt-5.4'));
});

test('의미 수리가 청크와 같은 장단문 분포 계약을 깨면 폐기한다', { concurrency: false }, async t => {
  const sentence = (length, first = '가') => `${first}${'가'.repeat(length - 2)}.`;
  const source = [sentence(60), sentence(92), sentence(76), sentence(72)].join(' ');
  const beforeRepair = [sentence(60, '나'), sentence(92), sentence(76), sentence(72)].join(' ');
  const repairOutput = [sentence(63, '나'), sentence(92), sentence(70), sentence(73)].join(' ');
  const mock = installEngineMock(t, { semanticViolation: true, repairOutput });
  const report = await qualityV2.runSemanticDocumentAudit({ source, outputText: beforeRepair, mode: 'assignment', config: config() });
  assert.equal(report.outputText, beforeRepair);
  assert.equal(report.repairRejected, true);
  assert.ok(report.reports[0].repairRejectReasons.includes('sentence_distribution_worsened'));
  assert.ok(mock.calls.some(call => call.name === 'gpt_prod_semantic_judge' && call.model === 'gpt-5.4'));
});
