'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../engine-gpt-prod');
const runtime = require('../lib/gptRuntimeConfig');
const { safetyIdentifierForUid } = require('../engine-gpt-prod/openaiClient');
const qualityV2 = require('../engine-gpt-prod/finalQualityV2');

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
  const output = `${SOURCE} 미래연구원이 새로운 결과를 발표했습니다.`;
  const mock = installEngineMock(t, { humanize: output, repairOutput: output, semanticViolation: true });
  const out = await engine.run({ text: SOURCE.repeat(3), mode: 'formal', uid: 'user-3', config: config() });
  assert.equal(out.status, 'needs_review');
  assert.equal(out.qualityStatus, 'needs_review');
  assert.ok(out.qualityWarnings.some(item => item.code === 'semantic_addition'));
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_judge_repair').length, 1);
  assert.ok(mock.calls.some(call => call.name === 'gpt_prod_semantic_judge' && call.model === 'gpt-5.4'));
});

test('OpenAI refusal은 최종 결과로 전달하지 않고 strict 차단한다', { concurrency: false }, async t => {
  const mock = installEngineMock(t, { refuseHumanize: true });
  const out = await engine.run({ text: SOURCE, mode: 'blog', uid: 'user-4', config: config() });
  assert.equal(out.status, 'blocked');
  assert.equal(out.result.outputText, SOURCE);
  assert.ok(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length >= 2);
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

test('모델 claim 원장이 불건전하면 원문 문장 원장으로 대체해 실제 의미 심사를 계속한다', { concurrency: false }, async t => {
  const mock = installEngineMock(t, { invalidLedger: true });
  const source = SOURCE.repeat(5);
  const report = await qualityV2.runSemanticDocumentAudit({ source, outputText: source, mode: 'polish', config: config() });
  assert.equal(report.pass, true);
  assert.equal(report.uncertain, false);
  assert.ok(mock.semanticCalls() >= 1);
  const semanticCall = mock.calls.find(call => call.name === 'gpt_prod_semantic_judge');
  assert.ok(String(semanticCall.body.input || '').includes(`[SOURCE]\n${source}`));
});
