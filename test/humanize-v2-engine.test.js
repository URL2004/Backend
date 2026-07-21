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
const EVALUATIVE_POLISH = '이 문장은 표현이 조금 어색하고 연결도 매끄럽지 않습니다. 그래서 읽는 흐름도 효율적이지 않습니다.';

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
    qualityPattern: process.env.GPT_QUALITY_PATTERN_ENABLED,
    humanizationDepth: process.env.HUMANIZATION_DEPTH_GATE_ENABLED
  };
  const restoreEnv = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_SAFETY_SALT = 'engine-test-salt';
  process.env.HUMANIZE_ENGINE_V2_ENABLED = '1';
  process.env.GPT_LAYOUT_NLP_ENABLED = '0';
  process.env.GPT_NIKL_QUALITY_ENABLED = '0';
  process.env.GPT_QUALITY_PATTERN_ENABLED = '0';
  process.env.HUMANIZATION_DEPTH_GATE_ENABLED = options.humanizationDepth === true ? '1' : '0';
  const calls = [];
  let semanticCalls = 0;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const name = body.text?.format?.name;
    calls.push({ name, model: body.model, body });
    if (name === 'gpt_prod_humanize_result' && options.concurrencyProbe) {
      options.concurrencyProbe.active += 1;
      options.concurrencyProbe.max = Math.max(options.concurrencyProbe.max, options.concurrencyProbe.active);
      const callNumber = calls.filter(call => call.name === name).length;
      await new Promise(resolve => setTimeout(resolve, callNumber % 2 ? 20 : 5));
      options.concurrencyProbe.active -= 1;
    }
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
      const outputText = typeof options.generalRetryOutput === 'function'
        ? options.generalRetryOutput(body, calls.filter(call => call.name === name).length)
        : (options.generalRetryOutput || SAFE_POLISH);
      return apiResponse({
        outputText,
        safeChangeFound: options.generalSafeChangeFound !== false,
        notes: []
      });
    }
    if (name === 'gpt_prod_korean_refinement_retry') {
      return apiResponse({
        outputText: options.koreanRefinementOutput || options.humanize || SAFE_POLISH,
        safeChangeFound: options.koreanRefinementSafeChangeFound !== false,
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
      const semanticViolation = typeof options.semanticViolation === 'function'
        ? options.semanticViolation(body, semanticCalls)
        : options.semanticViolation;
      const violations = semanticViolation
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
    restoreEnv('OPENAI_API_KEY', originalEnv.key);
    restoreEnv('OPENAI_SAFETY_SALT', originalEnv.salt);
    restoreEnv('HUMANIZE_ENGINE_V2_ENABLED', originalEnv.v2);
    restoreEnv('GPT_LAYOUT_NLP_ENABLED', originalEnv.layout);
    restoreEnv('GPT_NIKL_QUALITY_ENABLED', originalEnv.nikl);
    restoreEnv('GPT_QUALITY_PATTERN_ENABLED', originalEnv.qualityPattern);
    restoreEnv('HUMANIZATION_DEPTH_GATE_ENABLED', originalEnv.humanizationDepth);
  });
  return { calls, semanticCalls: () => semanticCalls };
}

test('공개 polish는 실제 polish로 연결되고 서버 편집률·HMAC·engineMeta를 기록한다', { concurrency: false }, async t => {
  const mock = installEngineMock(t);
  const uid = 'firebase-user-123';
  const out = await engine.run({ text: SOURCE, mode: 'polish', allowPolish: true, uid, config: config() });
  assert.equal(out.mode, 'polish');
  assert.equal(out.engineMeta.requestedMode, 'polish');
  assert.equal(out.engineMeta.engineVersion, 'gpt-prod-v2.5.0');
  assert.equal(out.engineMeta.requestStrength, 'polish');
  assert.equal(out.engineMeta.effectiveMode, 'polish');
  assert.ok(['content_only', 'low_confidence_preserve'].includes(out.engineMeta.profileDecisionSource));
  assert.ok(Array.isArray(out.engineMeta.candidateProfiles));
  assert.ok(Array.isArray(out.engineMeta.safetyProfiles));
  assert.ok(Array.isArray(out.engineMeta.formatProfile.flags));
  assert.ok(Array.isArray(out.engineMeta.riskFlags));
  assert.equal(out.engineMeta.tonePolicy, 'source_preserve');
  assert.equal(out.engineMeta.semanticJudgeRan, true);
  assert.equal(out.engineMeta.discourseAuditVersion, 2);
  assert.equal(out.engineMeta.discoursePass, true);
  assert.deepEqual(out.engineMeta.discourseWarningCodes, []);
  assert.equal(out.engineMeta.logicalChunkCount, out.engineMeta.chunkCount);
  assert.equal(out.engineMeta.lockedChunkCount, 0);
  assert.equal(out.engineMeta.transformedChunkCount, 1);
  assert.equal(out.engineMeta.humanizeCallCount, 1);
  assert.equal(out.engineMeta.semanticModelCallCount, 1);
  assert.equal(out.engineMeta.surfaceRetryCallCount, 0);
  assert.equal(out.engineMeta.modelCallCount, 2);
  assert.equal(out.engineMeta.semanticSectionCount, 1);
  const semanticCall = mock.calls.find(call => call.name === 'gpt_prod_semantic_judge');
  assert.match(String(semanticCall?.body?.instructions || ''), /1인칭 화자·관점/u);
  assert.match(String(semanticCall?.body?.instructions || ''), /~자체보다.*~에서 나아가/u);
  assert.match(String(semanticCall?.body?.instructions || ''), /행위 주체와 대상이 뒤바뀌/u);
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

test('복사된 UI 행은 모델 입력 전에 제외하고 원문 없는 코드·횟수만 기록한다', { concurrency: false }, async t => {
  const source = `접기\n${SOURCE}`;
  const mock = installEngineMock(t, { humanize: SAFE_POLISH });
  const out = await engine.run({ text: source, mode: 'polish', allowPolish: true, uid: 'source-preflight-user', config: config() });
  assert.equal(out.result.outputText, SAFE_POLISH);
  assert.equal(out.engineMeta.sourcePreflightChanged, true);
  assert.equal(out.engineMeta.sourceArtifactRemovedCount, 1);
  assert.deepEqual(out.engineMeta.sourcePreflightIssueCodes, ['source_ui_artifact']);
  assert.equal(out.result.sourcePreflight.removedLineCount, 1);
  assert.ok(out.result.sourceReviewWarnings.some(item => item.code === 'source_ui_artifact'));
  const humanizeCall = mock.calls.find(call => call.name === 'gpt_prod_humanize_result');
  assert.equal(JSON.stringify(humanizeCall?.body?.input || '').includes('접기'), false);
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

test('최종 전달 전 문장 중간 줄바꿈과 문맥형 띄어쓰기를 공백만 바꿔 보정한다', { concurrency: false }, async t => {
  const source = '윤리적 소비는 기업과 소비자의 관계를 함께 살피는 주제다. 소비자의 작은 선택은 생산 방식과 기업의 책임 의식을 \n\n변화시킬 수 있다는 사실을 보여주는 사례이다. 이는 가치소비와 지속이용의도를 함께 살펴야 하는 이유다.';
  const humanized = '윤리적 소비는 기업과 소비자의 관계를 함께 살피는 주제다. 소비자의 작은 선택은 생산 방식과 기업의 책임 의식을 \n\n바꿀 수 있다는 사실을 보여주는 사례다. 이는 가치소비와 지속이용의도를 함께 살펴야 할 이유다.';
  installEngineMock(t, {
    humanize: body => {
      const marker = String(body.input || '').match(/\[\[\[V2_BOUNDARY_\d{3}\]\]\]/u)?.[0] || '\n\n';
      return humanized.replace('\n\n', marker);
    }
  });
  const out = await engine.run({ text: source, mode: 'polish', allowPolish: true, uid: 'formatting-final-user', config: config() });
  assert.notEqual(out.status, 'blocked', JSON.stringify(out.floorReport?.criticals || []));
  assert.match(out.result.outputText, /책임 의식을 바꿀 수/u);
  assert.doesNotMatch(out.result.outputText, /의식을\s*\n\s*\n\s*바꿀/u);
  assert.match(out.result.outputText, /보여 주는 사례/u);
  assert.match(out.result.outputText, /가치 소비와 지속 이용 의도를/u);
  assert.ok(out.engineMeta.finalFormattingRepairCount >= 4);
  assert.equal(out.engineMeta.brokenParagraphBreakRepairCount, 1);
  assert.ok(out.engineMeta.contextualSpacingRepairCount >= 3);
});

test('빈도 충돌은 국소 한국어 수리 후 의미 심사를 거치고 원문 알림과 분리한다', { concurrency: false }, async t => {
  const source = '그때마다 고객에게서 감사 인사를 자주 들었습니다. 이 문장은 표현이 조금 어색합니다.';
  const humanized = '그때마다 고객에게서 감사 인사를 자주 들었습니다. 이 문장은 표현이 다소 어색합니다.';
  const repaired = '고객에게서 감사 인사를 자주 들었습니다. 이 문장은 표현이 다소 어색합니다.';
  const mock = installEngineMock(t, { humanize: humanized, koreanRefinementOutput: repaired });
  const out = await engine.run({ text: source, mode: 'polish', allowPolish: true, uid: 'korean-refinement-user', config: config() });
  assert.equal(out.result.outputText, repaired);
  assert.equal(out.engineMeta.koreanRefinementRetryAttemptCount, 1);
  assert.equal(out.engineMeta.koreanRefinementRetryApplied, true);
  assert.equal(out.engineMeta.koreanRefinementPass, true);
  assert.equal(out.engineMeta.semanticJudgeRan, true);
  assert.ok(out.sourceReviewWarnings.some(item => item.code === 'frequency_quantifier_conflict'));
  assert.equal(out.qualityWarnings.some(item => item.code === 'korean_frequency_quantifier_conflict'), false);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_korean_refinement_retry').length, 1);
  assert.match(String(mock.calls.find(call => call.name === 'gpt_prod_korean_refinement_retry')?.body?.instructions || ''), /과학·법률·게임이론/u);
});

test('고급 연구개발 자소서의 전문 개념을 구어적 동사로 낮추면 국소 수리한다', { concurrency: false }, async t => {
  const source = [
    '저의 가장 큰 경쟁력은 공정 조건을 최적화하고 구조와 성능 간 상관관계를 분석하는 연구개발 역량입니다.',
    '신축성 전극 연구에서 원인을 분석하고 실험 조건을 조정했습니다.',
    '반복 실험을 통해 재현성을 검증하고 조건별 결과를 수치화했습니다.',
    '연구실에서는 분석 장비를 관리하고 측정 결과를 공정 조건과 연결해 데이터 해석을 수행했습니다.',
    '앞으로도 최적 공정을 도출해 소재 개발에 기여하는 연구원이 되겠습니다.'
  ].join(' ');
  const weakened = source.replace('원인을 분석하고', '원인을 짚고');
  const corrected = weakened.replace('원인을 짚고 실험 조건을 조정했습니다', '원인을 분석한 뒤 실험 조건을 조정했습니다');
  const mock = installEngineMock(t, {
    humanize: weakened,
    koreanRefinementOutput: corrected
  });
  const out = await engine.run({ text: source, mode: 'formal', uid: 'resume-professional-register-user', config: config() });
  assert.notEqual(out.status, 'blocked', JSON.stringify({
    floorReport: out.floorReport,
    engineMeta: out.engineMeta,
    calls: mock.calls.map(call => ({ name: call.name, model: call.model }))
  }));
  assert.equal(out.engineMeta.documentProfile, 'resume_application');
  assert.equal(out.result.outputText, corrected);
  assert.equal(out.engineMeta.koreanRefinementRetryApplied, true);
  const repairCall = mock.calls.find(call => call.name === 'gpt_prod_korean_refinement_retry');
  assert.ok(repairCall);
  assert.match(String(repairCall.body.instructions || ''), /최적화·상관관계·원인 분석·재현성 검증·수치화·데이터 해석/u);
  assert.match(String(repairCall.body.instructions || ''), /cause_analysis/u);
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

test('polish에 새 평가어가 붙으면 자연성 점수와 무관하게 보존형 표면 수리로 제거한다', { concurrency: false }, async t => {
  const before = qualityV2.comparePolishEvaluativePadding(SOURCE, EVALUATIVE_POLISH);
  assert.equal(before.increased, true);
  assert.deepEqual(before.introducedCodes, ['efficiency_label']);

  const mock = installEngineMock(t, {
    humanize: EVALUATIVE_POLISH,
    retryOutput: SAFE_POLISH,
    safeChangeFound: true
  });
  const out = await engine.run({ text: SOURCE, mode: 'polish', allowPolish: true, uid: 'polish-padding-repair-user', config: config() });
  assert.notEqual(out.status, 'blocked', JSON.stringify(out.floorReport?.criticals || []));
  assert.equal(out.result.outputText, SAFE_POLISH);
  assert.equal(out.engineMeta.polishRetryReason, 'evaluative_padding');
  assert.deepEqual(out.engineMeta.polishEvaluativePaddingCodes, ['efficiency_label']);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_polish_surface_retry').length, 1);
  const retry = mock.calls.find(call => call.name === 'gpt_prod_polish_surface_retry');
  assert.match(String(retry?.body?.instructions || ''), /효율성 평가/u);
});

test('polish의 평가어가 특정 문장에만 추가되면 그 문장만 원문으로 복원해 다른 안전 교정을 유지한다', { concurrency: false }, async t => {
  const mixed = '이 문장은 표현이 다소 어색하고 연결도 매끄럽지 않습니다. 그래서 읽는 흐름도 효율적이지 않습니다.';
  const expected = '이 문장은 표현이 다소 어색하고 연결도 매끄럽지 않습니다. 그래서 읽는 흐름도 자연스럽지가 않습니다.';
  const restored = qualityV2.restorePolishEvaluativePaddingSentences(SOURCE, mixed);
  assert.equal(restored.applied, true);
  assert.equal(restored.text, expected);

  const mock = installEngineMock(t, { humanize: mixed });
  const out = await engine.run({ text: SOURCE, mode: 'polish', allowPolish: true, uid: 'polish-padding-local-restore-user', config: config() });
  assert.notEqual(out.status, 'blocked', JSON.stringify(out.floorReport?.criticals || []));
  assert.equal(out.result.outputText, expected);
  assert.equal(out.engineMeta.polishRetryReason, 'evaluative_padding');
  assert.equal(out.engineMeta.polishDeterministicPaddingRestoreCount, 1);
  assert.equal(out.engineMeta.surfaceRetryCallCount, 0);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_polish_surface_retry').length, 0);
});

test('polish 평가어가 전용 수리 후에도 남으면 새 판단을 전달하지 않고 차단한다', { concurrency: false }, async t => {
  const mock = installEngineMock(t, {
    humanize: EVALUATIVE_POLISH,
    retryOutput: EVALUATIVE_POLISH,
    safeChangeFound: true
  });
  const out = await engine.run({ text: SOURCE, mode: 'polish', allowPolish: true, uid: 'polish-padding-block-user', config: config() });
  assert.equal(out.status, 'blocked');
  assert.ok(out.floorReport.criticals.some(item => item.gate === 'polish_evaluative_padding_added'));
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_polish_surface_retry').length, 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_semantic_judge').length, 0);
});

test('장문 polish는 자연스러운 청크의 무변환을 허용하고 문서 한 곳이 수정되면 재시도하지 않는다', { concurrency: false }, async t => {
  const firstBody = Array.from({ length: 16 }, (_, index) => (
    `첫 구간 ${index + 1}번째 문장은 원문의 사실과 흐름을 차분하게 설명하며 이미 자연스러운 상태를 유지합니다.`
  )).join(' ');
  const secondBody = Array.from({ length: 16 }, (_, index) => (
    `둘째 구간 ${index + 1}번째 문장은 자료를 살피고 내용을 정리했으며 연결이 자연스럽지가 않습니다.`
  )).join(' ');
  const source = `Ⅰ. 첫 구간\n${firstBody}\n\nⅡ. 둘째 구간\n${secondBody}`;
  const mock = installEngineMock(t, {
    humanize: body => {
      const input = String(body.input || '');
      const marker = '[편집할 텍스트]\n';
      const start = input.lastIndexOf(marker);
      const editable = start >= 0 ? input.slice(start + marker.length).trim() : input;
      return editable.includes('둘째 구간')
        ? editable.replace('자연스럽지가 않습니다', '자연스럽지 않습니다')
        : editable;
    }
  });
  const out = await engine.run({ text: source, mode: 'polish', allowPolish: true, uid: 'document-polish-user', config: config() });
  assert.notEqual(out.status, 'blocked', JSON.stringify(out.floorReport?.criticals || []));
  const beforeAwkward = (source.match(/자연스럽지가 않습니다/gu) || []).length;
  const afterAwkward = (out.result.outputText.match(/자연스럽지가 않습니다/gu) || []).length;
  assert.equal(afterAwkward, beforeAwkward - 1);
  assert.ok(out.result.editMetrics.charEditRatio > 0);
  assert.ok(out.result.editMetrics.charEditRatio < 0.01, '긴 문서의 안전한 한 곳 수정은 비율 하한으로 실패시키지 않는다');
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_polish_surface_retry').length, 0);
  assert.ok(out.chunks.some(chunk => (chunk.warnings || []).includes('polish_chunk_unchanged_allowed')));
});

test('질문지는 번호·질문을 잠그고 답변별로만 편집하며 기본 말투가 장르를 바꾸지 않는다', { concurrency: false }, async t => {
  const questions = [
    '1. 이번 수업 활동에서 맡은 역할은 무엇인가요?',
    '2. 자료를 찾으며 배운 점은 무엇인가요?',
    '3. 다음 활동에서 개선할 점을 작성하세요.'
  ];
  const answers = [
    '모둠의 의견을 모아 발표 순서를 정리했다.',
    '여러 자료의 출처와 내용을 비교하며 핵심을 확인했다.',
    '준비 시간을 나누고 설명이 부족한 부분을 다시 살필 계획이다.'
  ];
  const source = questions.map((question, index) => `${question}\n${answers[index]}`).join('\n\n');
  const replacements = new Map([
    [answers[0], '모둠의 의견을 모아 발표 순서를 정돈했다.'],
    [answers[1], '여러 자료의 출처와 내용을 비교하며 핵심을 살폈다.'],
    [answers[2], '준비 시간을 나누고 설명이 부족한 부분을 다시 확인할 계획이다.']
  ]);
  const mock = installEngineMock(t, {
    humanize: body => {
      const input = String(body.input || '');
      const marker = '[편집할 텍스트]\n';
      const start = input.lastIndexOf(marker);
      const editable = start >= 0 ? input.slice(start + marker.length).trim() : input;
      return replacements.get(editable) || editable;
    }
  });
  const out = await engine.run({
    text: source,
    mode: 'blog',
    basicStyle: 'blog',
    uid: 'questionnaire-user',
    config: config()
  });
  assert.notEqual(out.status, 'blocked', JSON.stringify(out.floorReport?.criticals || []));
  assert.equal(out.engineMeta.documentProfile, 'student_self_assessment');
  assert.equal(out.engineMeta.requestStrength, 'basic');
  assert.equal(out.engineMeta.effectiveMode, 'assignment');
  assert.equal(out.engineMeta.tonePolicy, 'formal');
  assert.equal(out.engineMeta.targetRegister, 'student_formal');
  assert.equal(out.engineMeta.formatProfile.primary, 'questionnaire');
  assert.ok(out.engineMeta.riskFlags.includes('questionnaire_answer_boundary'));
  assert.equal(out.result.structureLock.lockedByType.questionnaire_question, 3);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 3);
  for (const question of questions) assert.equal((out.result.outputText.split(question).length - 1), 1);
  assert.equal(out.result.outputText.includes('저는'), false);
  assert.equal(out.result.outputText.includes('정돈했다'), true);
  assert.equal(out.result.outputText.includes('살폈다'), true);
  assert.equal(out.result.outputText.includes('다시 확인할 계획이다'), true);
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

test('구두점 없는 개인 에세이의 문장 중간 나는·나도를 기존 화자로 보존한다', { concurrency: false }, async t => {
  const clauses = [
    '팀 프로젝트를 시작하면서 역할과 일정을 먼저 정리했다',
    '나는 자료를 읽고 핵심 내용을 친구들이 이해하기 쉬운 순서로 묶었다',
    '나도 처음에는 설명 방향을 잡기 어려웠지만 질문을 기록하며 차근차근 고쳤다',
    '우리는 마지막까지 서로의 의견을 확인하고 발표 내용을 함께 마무리했다'
  ];
  const source = clauses.join(' ');
  const output = `${clauses.join('. ')}.`;
  const mock = installEngineMock(t, { humanize: output });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'punctuationless-personal-voice-user', config: config() });
  assert.notEqual(out.status, 'blocked', JSON.stringify(out.floorReport?.criticals || []));
  assert.equal(out.result.contract.povSeed.fp_singular, 2);
  assert.equal(out.result.contract.povSeed.fp_plural, 1);
  assert.equal(out.result.povDrift.introducedAnyFirstPerson, false);
  assert.equal(out.result.povDrift.droppedAnyFirstPerson, false);
  assert.equal(out.fallbackCount, 0);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 1);
});

test('상위 모델 수리 뒤 화자 경고만 남은 안전 후보는 차단 대신 needs_review로 전달한다', { concurrency: false }, async t => {
  const source = '자료를 먼저 분류한 뒤 핵심 내용을 순서대로 정리했습니다. 서로 다른 관점을 비교하면서 설명이 겹치는 부분도 줄였습니다. 마지막에는 전체 흐름을 다시 읽고 어색한 연결을 고쳤습니다.';
  const output = '저는 자료를 먼저 분류한 뒤 핵심 내용을 순서대로 정리했습니다. 서로 다른 관점을 비교하면서 겹치는 설명은 줄였습니다. 마지막에는 전체 흐름을 다시 읽으며 어색한 연결을 고쳤습니다.';
  const mock = installEngineMock(t, { humanize: output });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'residual-pov-review-user', config: config() });
  assert.equal(out.status, 'needs_review', JSON.stringify(out.floorReport));
  assert.equal(out.result.outputText, output);
  assert.equal(out.fallbackCount, 0);
  assert.equal(out.floorReport.criticals.length, 0);
  assert.ok(out.qualityWarnings.some(item => item.code === 'speaker_injected' || item.code === 'pov'));
  assert.ok(out.chunks[0].warnings.includes('v2_residual:pov'));
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.ok(mock.calls.some(call => JSON.stringify(call.body.input || '').includes('1차 결과가 원문의 화자 종류를 바꿨다')));
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
  assert.ok(out.engineMeta.chunkFailureCodes.includes('novelty'));
  assert.ok(out.engineMeta.chunkPrimaryFailureCodes.includes('novelty'));
  assert.deepEqual(out.engineMeta.chunkFallbackReasonCodes, []);
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
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 1,
    'refusal은 품질 승격 대상으로 재시도하지 않는다');
});

test('v2 청크가 보호 사실을 잃고 회복도 실패하면 원문 동일 결과를 전달하지 않는다', { concurrency: false }, async t => {
  const source = '한국대학교 연구팀은 학생 20명을 조사해 도서관 이용 방식과 학습 환경의 관계를 살펴봤습니다. 연구팀은 설문 문항과 면담 기록을 함께 분석했고, 조사 절차와 관찰 결과를 구분해 충분한 분량의 보고서로 정리했습니다.';
  const unsafe = '한 대학 연구팀은 여러 학생을 조사해 도서관 이용 방식과 학습 환경의 관계를 살펴봤습니다. 연구팀은 설문 문항과 면담 기록을 함께 분석했고, 조사 절차와 관찰 결과를 구분해 충분한 분량의 보고서로 자연스럽게 정리했습니다.';
  const mock = installEngineMock(t, { humanize: unsafe });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'fact-loss-user', config: config() });
  assert.equal(out.status, 'blocked');
  assert.equal(out.result.outputText, source);
  assert.equal(out.fallbackCount, 1);
  assert.equal(out.engineMeta.humanizationNoBenefitDelivered, false);
  assert.ok(out.floorReport.criticals.some(item => item.gate === 'gpt_noop_unchanged'));
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
});

test('두 모델이 보존 게이트에 실패하면 원문에서 안전한 표면 교정 1회만 허용한다', { concurrency: false }, async t => {
  const source = '한국대학교 연구팀은 학생 20명을 조사해 도서관 이용 방식과 학습 환경의 관계를 살펴봤습니다. 연구팀은 설문 문항과 면담 기록을 함께 분석했고, 조사 절차와 관찰 결과를 구분해 충분한 분량의 보고서로 정리했습니다.';
  const unsafe = '한 대학 연구팀은 여러 학생을 조사해 도서관 이용 방식과 학습 환경의 관계를 살펴봤습니다. 연구팀은 설문 문항과 면담 기록을 함께 분석했고, 조사 절차와 관찰 결과를 구분해 충분한 분량의 보고서로 자연스럽게 정리했습니다.';
  const safe = '한국대학교 연구팀은 학생 20명을 대상으로 조사하면서 도서관 이용 방식과 학습 환경이 어떻게 연결되는지 살펴봤습니다. 설문 문항과 면담 기록은 함께 분석하되 조사 절차와 관찰 결과를 구분했고, 이를 충분한 분량의 보고서로 정리했습니다.';
  const mock = installEngineMock(t, { humanize: unsafe, generalRetryOutput: safe });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'safe-fallback-surface-user', config: config() });
  assert.notEqual(out.status, 'blocked');
  assert.equal(out.result.outputText, safe);
  assert.equal(out.fallbackCount, 0);
  assert.equal(out.engineMeta.repairCount, 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry').length, 1);
});

test('일반 모드 무변환 재시도는 구조를 보존한 실질 재구성 지시를 상위 모델에 보낸다', { concurrency: false }, async t => {
  const source = '창가에 빛이 오래 머물렀습니다. 조용한 방 안에서 오래된 책장을 넘기며 지난 계절의 냄새를 떠올렸습니다. 말하지 못한 문장들은 그대로 남아 있었고, 저는 그 여백을 천천히 바라봤습니다. 그날의 바람은 얇은 커튼을 흔들었고, 멀리서 들려오는 발소리는 금세 고요 속으로 사라졌습니다. 저녁이 내려앉을 무렵에는 벽에 걸린 그림자도 조금씩 길어졌습니다. 손끝에 남은 종이의 감촉과 희미한 먼지 냄새가 방 안의 시간을 천천히 붙잡고 있었습니다.';
  const mock = installEngineMock(t, {
    humanize: body => JSON.stringify(body.input || '').includes('원문과 완전히 같거나 조사·구두점·동의어 한두 개만 바꾼 출력은 이번 재시도 실패다')
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
  assert.ok(mock.calls.some(call => JSON.stringify(call.body.input || '').includes('원문과 완전히 같거나 조사·구두점·동의어 한두 개만 바꾼 출력은 이번 재시도 실패다')));
  assert.ok(mock.calls.some(call => JSON.stringify(call.body.input || '').includes('절 순서·연결 방식·호흡을 실질적으로 다시 구성한다')));
  assert.equal(mock.calls.some(call => JSON.stringify(call.body.input || '').includes('안전한 한 곳만 자연스럽게 다듬는다')), false);
});

test('두 일반 모델이 모두 무변환이면 실질 휴머나이징을 한 번 재시도해 기준 충족 결과만 전달한다', { concurrency: false }, async t => {
  const source = '조금만 크게 볼 수는 없을까요. 사람마다 살아온 경험과 생각이 다르다는 점을 인정하면 됩니다. 상대를 완전히 이해하기 어렵더라도 서로의 자리와 배경을 존중할 수 있습니다. 유독 정치와 종교 같은 주제 앞에서 이 태도가 흔들리기도 합니다. 서로 다른 생각을 마주할 때에도 먼저 판단하기보다 차분히 듣는 태도가 필요합니다.';
  const safe = '조금만 크게 볼 수는 없을까요. 사람마다 살아온 경험과 생각은 다르다는 점을 먼저 인정해야 합니다. 상대를 완전히 이해하기는 어려워도 서로의 자리와 배경은 존중할 수 있습니다. 이 태도는 정치와 종교 같은 주제 앞에서 유독 흔들리기도 합니다. 서로 다른 생각을 마주할 때에도 먼저 판단하기보다 차분히 듣는 태도가 필요합니다.';
  const mock = installEngineMock(t, { humanize: source, generalRetryOutput: safe, humanizationDepth: true });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'general-surface-user', config: config() });
  assert.notEqual(out.status, 'blocked');
  assert.equal(out.result.outputText, safe);
  assert.equal(out.fallbackCount, 0);
  assert.equal(out.engineMeta.repairCount, 1);
  assert.equal(out.engineMeta.humanizationDepthEnabled, true);
  assert.equal(out.engineMeta.humanizationDepthPass, true);
  assert.equal(out.engineMeta.humanizationDepthRetryApplied, true);
  assert.ok(out.engineMeta.substantiveEditRatio >= out.engineMeta.humanizationMinimumRatio);
  assert.equal(out.engineMeta.humanizationPolicyVersion, 'perceived-v2.4.17');
  assert.equal(out.engineMeta.humanizationPlanSignalSource, 'deterministic_targets_input_risk');
  assert.deepEqual(out.engineMeta.humanizationDepthReasonCodes, []);
  assert.deepEqual(out.engineMeta.humanizationDepthBlockingReasonCodes, []);
  assert.ok(out.engineMeta.humanizationTargetMinRatio > out.engineMeta.humanizationMinimumRatio);
  assert.ok(['minimum', 'target', 'above_target'].includes(out.engineMeta.humanizationDeliveryDepthBand));
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry').length, 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_semantic_judge').length, 1);
  assert.ok(mock.calls.some(call => String(call.body.instructions || '').includes('실질 휴머나이징 계약')));
  const retryCall = mock.calls.find(call => call.name === 'gpt_prod_general_surface_retry');
  assert.match(String(retryCall?.body?.instructions || ''), /수정 대상 문장 번호/u);
  assert.match(String(retryCall?.body?.instructions || ''), /문서 전체를 다시 쓰지 않는다/u);
  assert.doesNotMatch(String(retryCall?.body?.instructions || ''), /\d+(?:\.\d+)?\s*%|SOURCE에서 다시 시작/u);
  assert.ok(out.engineMeta.humanizationDepthRetryTargetSentenceCount >= 1);
});

test('기본 첫 회복도 구두점 수준이면 mini로 한 번 더 실질 회복한다', { concurrency: false }, async t => {
  const source = '조금만 크게 볼 수는 없을까요. 사람마다 살아온 경험과 생각이 다르다는 점을 인정하면 됩니다. 상대를 완전히 이해하기 어렵더라도 서로의 자리와 배경을 존중할 수 있습니다. 유독 정치와 종교 같은 주제 앞에서 이 태도가 흔들리기도 합니다. 서로 다른 생각을 마주할 때에도 먼저 판단하기보다 차분히 듣는 태도가 필요합니다.';
  const punctuationOnly = source.replace('않을까요.', '않을까요?');
  const substantive = '조금만 크게 볼 수는 없을까요. 먼저 인정할 것은 사람마다 살아온 경험과 생각이 다르다는 사실입니다. 상대를 완전히 이해하기는 어려워도 서로의 자리와 배경은 존중할 수 있습니다. 이 태도는 정치와 종교 같은 주제 앞에서 유독 흔들리기도 합니다. 서로 다른 생각과 마주할 때에도 판단부터 내리기보다는 차분히 듣는 태도가 필요합니다.';
  const mock = installEngineMock(t, {
    humanize: source,
    generalRetryOutput: (_body, callNumber) => callNumber === 1 ? punctuationOnly : substantive,
    humanizationDepth: true
  });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'basic-no-effect-recovery-user', config: config() });
  assert.equal(out.result.outputText, substantive);
  assert.equal(out.engineMeta.humanizationNoEffectRetryAttemptCount, 0);
  assert.equal(out.engineMeta.humanizationDepthEscalationAttemptCount, 1);
  const retryCalls = mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry');
  assert.equal(retryCalls.length, 2);
  assert.equal(retryCalls[0].model, 'gpt-5.4-mini');
  assert.equal(retryCalls[1].model, 'gpt-5.4');
});

test('기본 지원서는 첫 회복이 최소 편집률을 넘어도 의미 반복이 남으면 두 번째 회복을 수행한다', { concurrency: false }, async t => {
  const source = [
    '저는 아직 전공을 정하지 못해 대학을 직접 경험하는 과정이 필요하다고 생각했습니다. 이름이나 입시 결과만으로 판단하기보다 여러 학문 분야를 살펴 저에게 맞는 방향을 찾고 싶었습니다. 이번 캠프에서 여러 전공을 비교하며 흥미와 적성을 확인하고 싶어 신청하게 되었습니다.',
    '저에게 가장 어려운 점은 진로를 하나로 좁히지 못했다는 것입니다. 인터넷 자료로는 학과 소개 정도만 확인할 수 있고 실제로 무엇을 배우며 어떤 역량이 필요한지 비교하기 어려웠습니다. 하나를 성급히 선택하기보다 직접 부딪혀 판단할 기회가 필요했습니다.',
    '캠프에 참여하게 된다면 각 분야의 공부 내용과 필요한 역량을 살피겠습니다. 교수님과 재학생에게 질문하고 배운 내용을 분야별로 정리해 비교하겠습니다. 그중 저에게 맞는 방향을 중심으로 이후 학습 계획을 세우고 끝까지 성실하게 참여하겠습니다.'
  ].join('\n');
  const weak = source.replace('과정이 필요하다고', '과정이 더 필요하다고').replace('정도만', '정도는');
  const firstRecovery = source
    .replace('저는 아직 전공을 정하지 못해 대학을 직접 경험하는 과정이 필요하다고 생각했습니다.', '아직 전공을 정하지 못한 저는 대학을 직접 경험하는 과정이 필요하다고 생각했습니다.')
    .replace('저에게 가장 어려운 점은 진로를 하나로 좁히지 못했다는 것입니다.', '진로를 하나로 좁히지 못했다는 것이 저에게 가장 어려운 점입니다.')
    .replace('캠프에 참여하게 된다면 각 분야의 공부 내용과 필요한 역량을 살피겠습니다.', '캠프에 참여하면 각 분야의 공부 내용과 필요한 역량부터 살피겠습니다.');
  const strong = firstRecovery
    .replace('인터넷 자료로는 학과 소개 정도만 확인할 수 있고 실제로 무엇을 배우며 어떤 역량이 필요한지 비교하기 어려웠습니다.', '인터넷 자료만으로는 학과 소개 정도를 알 수 있었을 뿐, 실제 학습 내용과 요구 역량의 차이는 파악하기 어려웠습니다.')
    .replace('캠프에 참여하면 각 분야의 공부 내용과 필요한 역량부터 살피겠습니다.', '캠프에 참여하면 각 영역의 공부 내용과 요구되는 역량부터 살피겠습니다.')
    .replace('교수님과 재학생에게 질문하고 배운 내용을 분야별로 정리해 비교하겠습니다.', '교수님과 재학생에게 질문하고 배운 내용은 항목별로 정리해 서로 대조하겠습니다.');
  const mock = installEngineMock(t, {
    humanize: weak,
    humanizationDepth: true,
    generalRetryOutput: (_body, callNumber) => callNumber === 1 ? firstRecovery : strong
  });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'basic-resume-semantic-repetition-user', config: config() });
  assert.notEqual(out.status, 'blocked', JSON.stringify(out.floorReport));
  assert.equal(out.engineMeta.documentProfile, 'resume_application');
  assert.equal(out.engineMeta.effectiveMode, 'assignment');
  assert.equal(out.result.outputText, strong, JSON.stringify({
    status: out.status,
    rejectionCodes: out.engineMeta.humanizationDepthRetryRejectionCodes,
    rejected: out.engineMeta.humanizationDepthRetryRejectedCount,
    depth: out.result.humanizationDepth,
    warnings: out.qualityWarnings
  }));
  assert.equal(out.engineMeta.resumeRepetitionApplicable, true);
  assert.equal(out.engineMeta.resumeRepetitionPass, true, JSON.stringify(out.result.humanizationDepth));
  assert.equal(out.engineMeta.humanizationRoleRecoveryAttemptCount, 0);
  assert.equal(out.engineMeta.humanizationDepthEscalationAttemptCount, 1);
  assert.equal(out.engineMeta.humanizationNoEffectRetryAttemptCount, 0);
  const retryCalls = mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry');
  assert.equal(retryCalls.length, 2);
  assert.match(String(retryCalls[1].body.instructions || ''), /같은 지원 전제/u);
  assert.doesNotMatch(String(retryCalls[1].body.instructions || ''), /앞선 회복도 공백·구두점/u);
});

test('약 3%의 동의어 교체 결과도 그대로 전달하지 않고 실질 휴머나이징을 재시도한다', { concurrency: false }, async t => {
  const source = '조금만 크게 볼 수는 없을까요. 사람마다 살아온 경험과 생각이 다르다는 점을 인정하면 됩니다. 상대를 완전히 이해하기 어렵더라도 서로의 자리와 배경을 존중할 수 있습니다. 유독 정치와 종교 같은 주제 앞에서 이 태도가 흔들리기도 합니다. 서로 다른 생각을 마주할 때에도 먼저 판단하기보다 차분히 듣는 태도가 필요합니다.';
  const polishLike = source.replace('인정하면 됩니다', '받아들이면 됩니다');
  const substantive = '조금만 크게 볼 수는 없을까요. 사람마다 살아온 경험과 생각은 다르다는 점을 먼저 인정해야 합니다. 상대를 완전히 이해하기는 어려워도 서로의 자리와 배경은 존중할 수 있습니다. 이 태도는 정치와 종교 같은 주제 앞에서 유독 흔들리기도 합니다. 서로 다른 생각을 마주할 때에도 먼저 판단하기보다 차분히 듣는 태도가 필요합니다.';
  const mock = installEngineMock(t, {
    humanize: polishLike,
    generalRetryOutput: substantive,
    humanizationDepth: true
  });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'low-depth-retry-user', config: config() });
  assert.notEqual(out.status, 'blocked');
  assert.equal(out.result.outputText, substantive);
  assert.equal(out.engineMeta.humanizationDepthPass, true);
  assert.equal(out.engineMeta.humanizationDepthRetryApplied, true);
  assert.ok(out.engineMeta.substantiveEditRatio >= out.engineMeta.humanizationMinimumRatio);
  assert.ok(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length >= 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry').length, 1);
});

test('고급의 첫 깊이 회복이 여전히 약하면 상위 모델이 두 문단을 다시 회복한다', { concurrency: false }, async t => {
  const source = [
    '저의 가장 큰 경쟁력은 공정 조건을 분석하고 결과를 정리하는 연구개발 역량입니다. 첫 프로젝트에서는 실험 조건을 여러 차례 조정하며 원하는 구조를 찾았습니다. 결과가 예상과 다를 때에는 원인을 분석하고 조건별 데이터를 비교했습니다. 이 과정을 통해 실험 설계와 검증 역량을 길렀습니다.',
    '연구실에서는 분석 장비를 관리하며 여러 시편의 측정을 지원했습니다. 측정 결과를 공정 조건과 연결해 해석하고 연구 보고서에 정리했습니다. 구성원들과 결과를 검토하며 데이터 해석 능력을 키웠습니다. 앞으로 소재 개발에 기여하는 연구원이 되겠습니다.'
  ].join('\n\n');
  const weak = source.replace('결과를 정리하는', '결과를 체계화하는');
  const firstRecovery = source
    .replace('여러 차례 조정하며', '반복해서 조정하며')
    .replace('원인을 분석하고', '원인을 먼저 분석하고')
    .replace('능력을 키웠습니다', '능력을 길렀습니다');
  const strong = [
    '저의 가장 큰 경쟁력은 공정 조건과 결과의 관계를 분석해 목표에 맞게 조정하는 연구개발 역량입니다. 첫 프로젝트에서는 원하는 구조를 찾기 위해 실험 조건을 여러 차례 달리하고 차이를 확인했습니다. 결과가 예상과 다르면 원인을 먼저 짚은 뒤 조건별 데이터를 비교했습니다. 이 과정에서 실험을 설계하고 검증하는 역량을 길렀습니다.',
    '연구실에서는 분석 장비를 맡아 관리하면서 여러 시편의 측정을 지원했습니다. 측정 결과는 공정 조건과 연결해 해석한 뒤 연구 보고서로 정리했습니다. 데이터 해석 능력은 구성원들과 결과를 함께 검토하며 키웠습니다. 앞으로 소재 개발에 기여하는 연구원이 되겠습니다.'
  ].join('\n\n');
  const mock = installEngineMock(t, {
    humanize: weak,
    humanizationDepth: true,
    generalRetryOutput: (_body, callNumber) => callNumber === 1 ? firstRecovery : strong
  });
  const out = await engine.run({ text: source, mode: 'formal', uid: 'advanced-depth-escalation-user', config: config() });
  assert.notEqual(out.status, 'blocked', JSON.stringify(out.floorReport));
  assert.equal(out.result.outputText, strong);
  assert.equal(out.engineMeta.documentProfile, 'resume_application');
  assert.equal(out.engineMeta.requestStrength, 'advanced');
  assert.equal(out.engineMeta.humanizationDepthPass, true, JSON.stringify(out.result.humanizationDepth));
  assert.equal(out.engineMeta.humanizationTargetChangedParagraphCount, 2);
  assert.equal(out.engineMeta.humanizationTargetParagraphCoverage, 1);
  assert.equal(out.engineMeta.humanizationDepthEscalationAttemptCount, 1);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry').length, 2);
  const retryCalls = mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry');
  assert.equal(retryCalls[0].model, 'gpt-5.4-mini');
  assert.equal(retryCalls[1].model, 'gpt-5.4');
  assert.match(String(retryCalls[1].body.instructions || ''), /첫 문단만 고치고 멈추지 않는다/u);
});

test('재시도 결과가 단일 깊이 지표만 약하면 사용자 경고 대신 shadow로 전달한다', { concurrency: false }, async t => {
  const source = '또한 학습 과정은 현대 사회에서 중요한 역할을 할 수 있습니다. 따라서 관련 내용을 체계적으로 살펴볼 필요가 있습니다. 결론적으로 지속적인 관심과 노력이 중요하다고 볼 수 있습니다.';
  const weak = source.replace('중요한 역할', '핵심적인 역할');
  const improved = '학습 과정이 현대 사회에서 맡는 역할은 결코 작지 않습니다. 따라서 관련 내용을 체계적으로 살펴볼 필요가 있습니다. 결론적으로 지속적인 관심과 노력이 중요하다고 볼 수 있습니다.';
  const mock = installEngineMock(t, {
    humanize: weak,
    generalRetryOutput: improved,
    humanizationDepth: true
  });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'soft-depth-delivery-user', config: config() });
  assert.equal(out.status, 'clean', JSON.stringify(out.floorReport));
  assert.equal(out.result.outputText, improved);
  assert.equal(out.engineMeta.humanizationDepthPass, false);
  assert.equal(out.engineMeta.humanizationMinimumEffectPass, true);
  assert.equal(out.engineMeta.humanizationDepthSoftDelivered, true);
  assert.equal(out.engineMeta.humanizationEffectStatus, 'below_target_shadow');
  assert.equal(out.engineMeta.humanizationDepthUserReviewRequired, false);
  assert.equal(out.engineMeta.humanizationDepthRetryApplied, true);
  assert.equal(out.floorReport.criticals.length, 0);
  assert.equal(out.qualityWarnings.some(item => item.code === 'humanization_depth_below_minimum'), false);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry').length, 1);
});

test('의미 수리 뒤 결과가 원문으로 돌아가면 최종 회복과 재심사를 거쳐 안전 결과를 전달한다', { concurrency: false }, async t => {
  const source = '한국대학교 연구팀은 학생 20명을 조사해 도서관 이용 방식과 학습 환경의 관계를 살펴봤습니다. 연구팀은 설문 문항과 면담 기록을 함께 분석했고, 조사 절차와 관찰 결과를 구분해 충분한 분량의 보고서로 정리했습니다.';
  const unsafe = `${source} 미래연구원은 후속 조사를 시작합니다.`;
  const safe = '한국대학교 연구팀은 학생 20명을 대상으로 조사하면서 도서관 이용 방식과 학습 환경이 어떻게 연결되는지 살펴봤습니다. 설문 문항과 면담 기록은 함께 분석하되 조사 절차와 관찰 결과를 구분했고, 이를 충분한 분량의 보고서로 정리했습니다.';
  const mock = installEngineMock(t, {
    humanize: unsafe,
    semanticViolation: (_body, callNumber) => callNumber === 1,
    repairOutput: source,
    generalRetryOutput: safe
  });
  const out = await engine.run({ text: source, mode: 'formal', uid: 'final-noop-recovery-user', config: config() });
  assert.notEqual(out.status, 'blocked', JSON.stringify({
    floorReport: out.floorReport,
    engineMeta: out.engineMeta,
    calls: mock.calls.map(call => ({ name: call.name, model: call.model }))
  }));
  assert.equal(out.result.outputText, safe);
  assert.equal(out.engineMeta.finalNoopRecoveryAttempted, true);
  assert.equal(out.engineMeta.finalNoopRecoveryApplied, true);
  assert.equal(out.engineMeta.finalNoopRecoveryCount, 1);
  assert.equal(out.engineMeta.finalNoopRecoveryMethod, 'post_semantic_model');
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

test('원문 기반 최소 교정도 장단문 분포를 평탄화하고 회복에 실패하면 동일 결과를 차단한다', { concurrency: false }, async t => {
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
  assert.equal(out.engineMeta.humanizationNoBenefitDelivered, false);
});

test('voice 재시도 실패 후 구두점만 바뀌면 동일 결과를 차단한다', { concurrency: false }, async t => {
  const source = '짧게 관찰함. 이 문장은 앞 문장보다 조금 더 길게 이어지는 활동 내용을 기록함. 학생이 여러 자료를 직접 찾아 비교하고 발표 과정에서 친구들의 질문에 답하며 탐구 내용을 크게 확장한 매우 긴 관찰 문장을 기록함. 그렇다면 마지막은 다시 짧게 마무리함.';
  const markers = ['[[[V2_SENTENCE_0001]]]', '[[[V2_SENTENCE_0002]]]', '[[[V2_SENTENCE_0003]]]'];
  const uniform = [
    '학생이 여러 자료를 직접 찾아 비교한 활동 내용을 기록함.',
    '발표 과정에서 친구들의 질문에 답하며 탐구 내용을 확장한 관찰 문장을 기록함.',
    '이 문장은 앞 문장보다 조금 더 길게 이어지고 내용을 크게 확장함.',
    '그렇다면 마지막은 활동을 짧게 관찰하고 다시 마무리함.'
  ].map((sentence, index) => `${sentence}${markers[index] || ''}`).join('');
  const punctuationOnly = source.replace('그렇다면 마지막은', '그렇다면, 마지막은');
  const mock = installEngineMock(t, { humanize: uniform, generalRetryOutput: punctuationOnly, humanizationDepth: true });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'voice-deterministic-surface-user', config: config() });
  assert.equal(out.status, 'blocked');
  assert.equal(out.result.outputText, source);
  assert.ok(out.floorReport.criticals.some(item => item.gate === 'gpt_noop_unchanged'));
  assert.equal(out.engineMeta.humanizationNoBenefitDelivered, false);
  assert.equal(out.engineMeta.repairCount, 0);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length, 2);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_general_surface_retry').length, 2);
  assert.equal(out.engineMeta.humanizationNoEffectRetryAttemptCount, 0);
  assert.equal(out.engineMeta.humanizationDepthEscalationAttemptCount, 1);
  assert.equal(out.engineMeta.humanizationDepthRetryApplied, false);
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

test('운영 엔진은 구형 플래그와 무관하게 v2.5 경로만 사용한다', { concurrency: false }, async t => {
  const mock = installEngineMock(t, { humanize: SAFE_POLISH });
  process.env.HUMANIZE_ENGINE_V2_ENABLED = '0';
  const out = await engine.run({ text: SOURCE, mode: 'blog', uid: 'rollback-user', config: config() });
  assert.equal(out.engineMeta.engineVersion, 'gpt-prod-v2.5.0');
  assert.ok(mock.calls.length >= 1);
  for (const call of mock.calls) {
    assert.equal(Object.prototype.hasOwnProperty.call(call.body, 'safety_identifier'), true);
    assert.equal(JSON.stringify(call.body).includes('rollback-user'), false);
  }
});

test('일반 청크 worker pool은 동시성 2에서도 결과 순서를 보존한다', { concurrency: false }, async t => {
  const previous = process.env.HUMANIZE_CHUNK_CONCURRENCY;
  process.env.HUMANIZE_CHUNK_CONCURRENCY = '2';
  t.after(() => {
    if (previous === undefined) delete process.env.HUMANIZE_CHUNK_CONCURRENCY;
    else process.env.HUMANIZE_CHUNK_CONCURRENCY = previous;
  });
  const probe = { active: 0, max: 0 };
  const source = Array.from({ length: 4 }, (_, paragraph) => (
    Array.from({ length: 16 }, (_, sentence) => `문단 ${paragraph + 1}의 ${sentence + 1}번째 문장은 분석 절차와 관찰 결과를 구체적으로 설명합니다.`).join(' ')
  )).join('\n\n');
  const mock = installEngineMock(t, { refuseHumanize: true, concurrencyProbe: probe });
  const out = await engine.run({ text: source, mode: 'blog', uid: 'pool-user', config: config() });
  assert.equal(out.status, 'blocked');
  assert.equal(out.engineMeta.chunkConcurrency, 2);
  assert.ok(probe.max >= 2);
  assert.deepEqual(out.chunks.map(chunk => chunk.index), out.chunks.map(chunk => chunk.index).slice().sort((a, b) => a - b));
  assert.ok(mock.calls.filter(call => call.name === 'gpt_prod_humanize_result').length >= 2);
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
