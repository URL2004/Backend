'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../engine-gpt-prod');
const runtime = require('../lib/gptRuntimeConfig');
const provenance = require('../engine-gpt-prod/semanticProvenance');
const ledgerApi = require('../engine-gpt-prod/candidateLedger');
const { extractPromptDataSection } = require('../engine-gpt-prod/promptEnvelope');

const SOURCE = '설계 과정에서 전원 노이즈가 기능에 영향을 줄 수 있음을 확인했습니다. 이후 필터 조건을 비교하고 결과를 기록했습니다.';
// 첫 문장에 원문에 없던 강한 수식이 남는다. 의미 심사 뒤의 결정론 원문 복원이
// 그 문장만 되돌리므로 최종 본문은 심사한 후보와 실제로 달라진다.
const LATE_RESTORED_OUTPUT = '설계 과정에서 심각한 전원 노이즈가 기능에 영향을 줄 수 있음을 확인했습니다. 이어서 필터별 조건을 대조한 뒤 결과를 문서에 기록했습니다.';

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

function installMock(t, options = {}) {
  const originalFetch = global.fetch;
  const names = ['OPENAI_API_KEY', 'OPENAI_SAFETY_SALT', 'GPT_LAYOUT_NLP_ENABLED', 'GPT_NIKL_QUALITY_ENABLED',
    'GPT_NIKL_EXTERNAL_API_ENABLED', 'HUMANIZATION_DEPTH_GATE_ENABLED'];
  const originalEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_SAFETY_SALT = 'engine-test-salt';
  process.env.GPT_LAYOUT_NLP_ENABLED = '0';
  process.env.GPT_NIKL_QUALITY_ENABLED = '0';
  process.env.GPT_NIKL_EXTERNAL_API_ENABLED = '0';
  process.env.HUMANIZATION_DEPTH_GATE_ENABLED = '0';
  const calls = [];
  let judgeCalls = 0;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const name = body.text?.format?.name;
    calls.push({ name, model: body.model, body });
    if (name === 'gpt_prod_humanize_result') return apiResponse({
      outputText: typeof options.humanize === 'function' ? options.humanize(body) : options.humanize
    });
    if (name === 'gpt_prod_soft_claim_ledger') {
      const source = extractPromptDataSection(body.input, 'SOURCE') || SOURCE;
      return apiResponse({ claims: [{ claim: '원문의 핵심 내용을 보존한다.', evidence_text: source.replace(/\s+/gu, ' ').trim().slice(0, 20) }] });
    }
    if (name === 'gpt_prod_semantic_judge') {
      judgeCalls += 1;
      if (options.failFinal && judgeCalls >= 2) {
        return new Response(JSON.stringify({ error: { message: 'test audit unavailable' } }), { status: 400 });
      }
      const rewrite = extractPromptDataSection(body.input, 'REWRITE');
      const violation = typeof options.violation === 'function' ? options.violation(body, judgeCalls, rewrite) : false;
      return apiResponse({
        violations: Array.isArray(violation) ? violation : violation
          ? [{ type: 'added_claim', span: rewrite, detail: '최종 본문 재검증에서 반환하는 테스트 판정', sourceSpan: extractPromptDataSection(body.input, 'SOURCE'), candidateSpan: rewrite, relation: 'other', origin: 'introduced' }]
          : []
      });
    }
    if (name === 'gpt_prod_judge_repair') {
      throw new Error('final revalidation must never call repair');
    }
    if (name === 'gpt_prod_relation_patch' && options.patch)
      return apiResponse({ patches: typeof options.patch === 'function' ? options.patch(body) : options.patch });
    throw new Error(`unexpected schema: ${name}`);
  };
  t.after(() => {
    global.fetch = originalFetch;
    for (const name of names) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  });
  return { calls, judgeCalls: () => judgeCalls };
}

for (const accept of [true, false]) test(`late split relation patch is bounded and needs a fresh verdict (${accept})`, async t => {
  const a = '과거 연출가인 수민은 공연을 제안했지만 현재에는 기자인 하준이 자료를 공개한 경위를 추궁한다.';
  const b = '과거의 수민은 공연을 제안했다. 공연을 허용해야 한다는 입장이었다. 현재 하준은 기자가 되어 자료를 공개했다. 공개 경위를 두고 추궁이 이어진다.';
  const fixed = b.replace('공개 경위를 두고 추궁이 이어진다.', '수민은 하준이 자료를 공개한 경위를 추궁한다.');
  const tail = '관찰 기록은 날짜 순으로 보관한다. 다음 연구는 새로운 자료를 사용한다. 이후 담당자는 결과를 분류한다.';
  const source = SOURCE + ' ' + a + ' ' + tail;
  const mock = installMock(t, { humanize: LATE_RESTORED_OUTPUT + ' ' + b + ' ' + tail,
    patch: body => JSON.parse(extractPromptDataSection(body.input, 'TARGETS')).map(target => ({ id:target.id,
      replacement:target.text.replace('공개 경위를 두고 추궁이 이어진다.', '수민은 하준이 자료를 공개한 경위를 추궁한다.') })),
    violation: (_body, call, rewrite) => {
      const current = rewrite.slice(rewrite.indexOf('과거의 수민'),rewrite.indexOf('관찰 기록은')).trim();
      const wrong = rewrite.includes('공개 경위를 두고 추궁이 이어진다.');
      if (call < 2 || (!wrong && accept)) return [];
      if (!wrong) return [{ type: 'distortion', span: current, sourceSpan: a, candidateSpan: current,
        relation: 'actor_action_target', origin: 'introduced', detail: '검증 실패 모의: 통과로 바꾸지 않는다.' }];
      return [{ type: 'distortion', span: current, sourceSpan: a, candidateSpan: current,
        relation: 'actor_action_target', origin: 'introduced', detail: '추궁한 행위자가 사라졌다.' }];
    }
  });
  const out = await engine.run({ text: source, mode: 'blog', config: config() });
  assert.equal(out.engineMeta.finalRelationPatchAttempted, true, JSON.stringify({output:out.result.outputText,
    final:out.engineMeta.finalSemanticRevalidationReason, prior:out.engineMeta.finalSemanticRevalidationPriorStatus,
    names:mock.calls.map(c=>c.name), findings:out.result.semanticAudit.violations}));
  assert.equal(mock.calls.filter(c => c.name === 'gpt_prod_relation_patch').length, 1);
  assert.equal(out.engineMeta.finalRelationRestorationAttempted, true);
  assert.equal(provenance.verifySemanticValidation(out.result.semanticAudit, {
    source, candidate: out.result.outputText, requireDigest: true
  }).status, accept ? 'pass' : 'fail');
  assert.equal(out.result.outputText.includes('수민은 하준이 자료를 공개한 경위를 추궁한다.'), accept);
  assert.ok(out.result.outputText.includes(tail));
});

test('full pipeline audits materialized equations against materialized source chunks', async t => {
  const source = '1. 적분 성질\n\n이 식은 적분 결과를 나타낸다. 계산 결과를 기록하고 기준값과 비교한다.\n\n∫ δ(t)dt = 1\n\n설정값은 `delay = 3`이다. 이후 결과를 확인한다.';
  installMock(t, { humanize: body => extractPromptDataSection(body.input, 'EDITABLE_TEXT')
    .replace('이 식은 적분 결과를 나타낸다.', '적분 결과는 이 식으로 나타낸다.')
    .replace('이후 결과를 확인한다.', '그 뒤 결과를 확인한다.') });
  const out = await engine.run({ text: source, mode: 'blog', config: config() });
  assert.ok(out.result.outputText.includes('∫ δ(t)dt = 1'));
  assert.ok(out.result.outputText.includes('`delay = 3`'));
  assert.doesNotMatch(out.result.outputText, /ZXQ(?:MATH|CODE|LOCK)/u);
  assert.equal(out.result.structureLock.lostLockedCount, 0);
  assert.equal(out.result.structureLock.protectedBlockChangedCount, 0);
  assert.equal(out.result.structureLock.pass, true);
});

function revalidationSignals(calls) {
  return calls
    .filter(call => call.name === 'gpt_prod_semantic_judge')
    .map(call => extractPromptDataSection(call.body.input, 'DETERMINISTIC_DISCOURSE_SIGNALS'));
}

test('어절 공백 교정은 최종 의미 재검증보다 먼저 완료하고 이후 본문을 수정하지 않는다', () => {
  const source = require('node:fs').readFileSync(require.resolve('../engine-gpt-prod'), 'utf8');
  const start = source.indexOf('let finalSemanticRevalidation =');
  const end = source.indexOf('const result = buildResult({', start);
  assert.ok(source.lastIndexOf('const deliveredFormatting =', start) > 0);
  assert.ok(!source.slice(start, end).includes('applySafeFormattingRepairs'));
  const mandatoryStart = source.indexOf('let depthTugRejudgeCount = 0;');
  const decisionStart = source.indexOf('const semanticDecision =', mandatoryStart);
  assert.ok(!source.slice(mandatoryStart, decisionStart).includes('!polishStrictFailure'));
  assert.match(source.slice(mandatoryStart, decisionStart), /if \(outputText\.trim\(\) && !polishTerminalFailure\)/);
  assert.doesNotMatch(source.slice(mandatoryStart, decisionStart), /includes\(polishStrictFailure\)[\s\S]*polish_excessive_change/);
});

test('공백 배치만 달라진 최종본은 결정론 투영으로 같은 판정을 유지하고 띄어쓰기 변경은 stale로 남긴다', () => {
  const source = '행사에는 30명이 참석했다. 이후 보고서를 정리했다.';
  const candidate = '참석 인원은 30명이었다. 그 뒤 보고서를 정리했다.';
  const report = provenance.bindSemanticValidation({ ran: true, pass: true }, source, candidate);
  const exact = provenance.verifySemanticValidation(report, { source, candidate, requireDigest: true });
  assert.equal(exact.status, 'pass');
  assert.equal(exact.materialization, 'exact');
  for (const layout of [
    '참석 인원은 30명이었다.\n\n그 뒤 보고서를 정리했다.',
    '참석 인원은 30명이었다.\r\n그 뒤 보고서를 정리했다.',
    '  참석 인원은 30명이었다.   그 뒤 보고서를 정리했다.\n'
  ]) {
    const projected = provenance.verifySemanticValidation(report, { source, candidate: layout, requireDigest: true });
    assert.equal(projected.status, 'pass', layout);
    assert.equal(projected.materialization, 'whitespace_layout');
    assert.deepEqual(provenance.finalValidationWarnings(report, projected), []);
  }
  // 원문 쪽 문단 구분 차이도 같은 투영으로 허용한다.
  assert.equal(provenance.verifySemanticValidation(report, {
    source: source.replace('. 이후', '.\n\n이후'), candidate, requireDigest: true
  }).status, 'pass');
  // 글자 사이 공백을 지우거나 넣는 변경은 단어 경계가 달라지므로 stale이다.
  assert.equal(provenance.verifySemanticValidation(report, {
    source, candidate: '참석 인원은 30명이었다. 그뒤 보고서를 정리했다.', requireDigest: true
  }).status, 'stale');
  assert.equal(provenance.verifySemanticValidation(report, {
    source, candidate: '참석 인원은 31명이었다.\n\n그 뒤 보고서를 정리했다.', requireDigest: true
  }).status, 'stale');
  // 실패 판정도 같은 본문의 공백 변형에 그대로 적용된다(fail이 stale로 숨지 않는다).
  const failed = provenance.bindSemanticValidation({ ran: true, pass: false, violations: [{ type: 'distortion' }] }, source, candidate);
  assert.equal(provenance.verifySemanticValidation(failed, {
    source, candidate: candidate.replace('. 그 뒤', '.\n\n그 뒤'), requireDigest: true
  }).status, 'fail');
  // 건너뛴 심사와 digest 없는 옛 보고서는 투영과 무관하게 그대로 남는다.
  assert.equal(provenance.verifySemanticValidation({ ran: false, pass: true }, { source, candidate, requireDigest: true }).status, 'skipped');
  assert.equal(provenance.verifySemanticValidation({ ran: true, pass: true }, { source, candidate, requireDigest: true }).status, 'unknown');
});

test('잠금 토큰 복원 투영 뒤에도 공백 배치 투영이 이어지고 후보 원장은 그 후보를 안전 후보로 인정한다', () => {
  const report = provenance.bindSemanticValidation({ ran: true, pass: true }, 'LOCK 원문', 'LOCK 후보. 둘째 문장.');
  const next = provenance.projectSemanticValidation(report, {
    source: 'LOCK 원문', candidate: 'LOCK 후보. 둘째 문장.', project: text => text.replace('LOCK', '원래 인용')
  });
  assert.equal(provenance.verifySemanticValidation(next, {
    source: '원래 인용 원문', candidate: '원래 인용 후보.\n\n둘째 문장.', requireDigest: true
  }).materialization, 'whitespace_layout');
  const ledger = ledgerApi.createCandidateLedger({
    source: '원문', assess: () => ({ hardViolationCodes: [], transformed: true, minimumEffectPass: true })
  });
  const validated = provenance.bindSemanticValidation({ ran: true, pass: true }, '원문', '안전 후보. 둘째 문장.');
  const exact = ledger.record({ stage: 'judged', text: '안전 후보. 둘째 문장.', semanticReport: validated });
  const layout = ledger.record({ stage: 'post_layout', text: '안전 후보.\n\n둘째 문장.', semanticReport: validated });
  const rewritten = ledger.record({ stage: 'late', text: '다른 후보. 둘째 문장.', semanticReport: validated });
  assert.equal(exact.eligible, true);
  assert.equal(layout.eligible, true);
  assert.equal(layout.semanticMaterialization, 'whitespace_layout');
  assert.equal(rewritten.eligible, false);
  assert.equal(rewritten.semanticStatus, 'stale');
  // 공백만 다른 현재 후보는 롤백 대상이 아니다.
  const choice = ledger.chooseFinal(layout.id);
  assert.equal(choice.applied, false);
  assert.equal(choice.entry.text, '안전 후보.\n\n둘째 문장.');
});

test('의미 심사 뒤 늦은 원문 복원이 본문을 바꾸면 최종 본문을 판정만 다시 하고 통과하면 clean으로 전달한다', { concurrency: false }, async t => {
  const mock = installMock(t, { humanize: LATE_RESTORED_OUTPUT });
  const out = await engine.run({ text: SOURCE, mode: 'blog', uid: 'final-revalidation-pass-user', config: config() });

  assert.equal(out.status, 'clean');
  assert.equal(out.engineMeta.semanticValidationStatus, 'pass');
  assert.equal(out.engineMeta.semanticValidationMaterialization, 'exact');
  assert.equal(out.engineMeta.finalCandidateDigest, provenance.textDigest(out.result.outputText));
  assert.equal(out.result.semanticAudit.validation.candidateDigest, out.engineMeta.finalCandidateDigest);
  assert.equal(out.result.semanticAudit.decisionReason, 'final_semantic_revalidation');
  assert.equal(out.engineMeta.finalSemanticRevalidationAttempted, true);
  assert.equal(out.engineMeta.finalSemanticRevalidationApplied, true);
  assert.equal(out.engineMeta.finalSemanticRevalidationReason, 'revalidated_pass');
  assert.equal(out.engineMeta.finalSemanticRevalidationPriorStatus, 'stale');
  assert.equal(out.engineMeta.finalSemanticRevalidationJudgeCallCount, 1);
  assert.equal(mock.judgeCalls(), 2);
  assert.equal(out.engineMeta.semanticModelCallCount, 2);
  assert.deepEqual(revalidationSignals(mock.calls).slice(-1), ['final_semantic_revalidation']);
  assert.ok(out.engineMeta.finalSourceIntegrityRestoreCodes.includes('discourse_intensity_source_restore'));
  assert.doesNotMatch(out.result.outputText, /심각한/u);
  assert.equal(out.qualityWarnings.some(item => item.code === 'semantic_validation_stale'), false);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_judge_repair').length, 0);
  assert.equal(out.result.humanizeMeta.callLedger.entries.filter(item => item.stage === 'final_semantic_revalidation').length, 1);
  assert.equal(out.engineMeta.recoveryBudgetStageUsageUsd.final_semantic_revalidation, undefined);
});

test('선택적 회복 금액이 부족해도 필수 최종 재검증을 수행한다', { concurrency: false }, async t => {
  const mock = installMock(t, { humanize: LATE_RESTORED_OUTPUT });
  const out = await engine.run({
    text: SOURCE, mode: 'blog', uid: 'final-revalidation-budget-user', config: config(), recoveryBudgetUsd: 0.000001
  });

  assert.equal(out.status, 'clean');
  assert.equal(out.engineMeta.semanticValidationStatus, 'pass');
  assert.ok(!out.qualityWarnings.some(item => item.code === 'semantic_validation_stale'));
  assert.equal(out.engineMeta.finalSemanticRevalidationAttempted, true);
  assert.equal(out.engineMeta.finalSemanticRevalidationApplied, true);
  assert.equal(out.engineMeta.finalSemanticRevalidationReason, 'revalidated_pass');
  assert.equal(mock.judgeCalls(), 2);
  assert.equal(out.engineMeta.semanticModelCallCount, 2);
  assert.doesNotMatch(out.result.outputText, /심각한/u);
});

test('최종 재검증이 실패하면 옛 pass를 재사용하지 않고 기존 의미 실패 경로로 검토 전달하며 수리는 부르지 않는다', { concurrency: false }, async t => {
  const mock = installMock(t, {
    humanize: LATE_RESTORED_OUTPUT,
    violation: (_body, call) => call >= 2
  });
  const out = await engine.run({ text: SOURCE, mode: 'blog', uid: 'final-revalidation-fail-user', config: config() });

  assert.equal(out.status, 'needs_review');
  assert.equal(out.engineMeta.semanticValidationStatus, 'fail');
  assert.equal(out.engineMeta.finalSemanticRevalidationApplied, true);
  assert.equal(out.engineMeta.finalSemanticRevalidationReason, 'revalidated_fail');
  assert.equal(out.result.semanticAudit.pass, false);
  assert.ok(out.qualityWarnings.some(item => item.code === 'semantic_addition'));
  assert.equal(out.qualityWarnings.some(item => item.code === 'semantic_validation_stale'), false);
  assert.equal(out.engineMeta.semanticViolationCount >= 1, true);
  assert.equal(mock.calls.filter(call => call.name === 'gpt_prod_judge_repair').length, 0);
  assert.ok(mock.judgeCalls() >= 2);
  assert.equal(out.engineMeta.finalCandidateDigest, provenance.textDigest(out.result.outputText));
  assert.equal(out.result.semanticAudit.validation.candidateDigest, out.engineMeta.finalCandidateDigest);
});

test('본문이 심사한 후보 그대로면 재검증 호출이 없다', { concurrency: false }, async t => {
  const source = '이 문장은 표현이 조금 어색하고 연결도 매끄럽지 않습니다. 그래서 읽는 흐름도 자연스럽지가 않습니다.';
  const mock = installMock(t, { humanize: '이 문장은 표현이 다소 어색하고 연결도 매끄럽지 않습니다. 그래서 읽는 흐름도 자연스럽지 않습니다.' });
  const out = await engine.run({ text: source, mode: 'polish', allowPolish: true, uid: 'final-revalidation-noop-user', config: config() });
  assert.notEqual(out.status, 'blocked');
  assert.equal(out.engineMeta.semanticValidationStatus, 'pass');
  assert.equal(out.engineMeta.finalSemanticRevalidationAttempted, false);
  assert.equal(out.engineMeta.finalSemanticRevalidationReason, 'not_needed');
  assert.equal(mock.judgeCalls(), 1);
});

test('최종 심사 HTTP 실패는 완료로 표시하지 않고 검증된 후보 또는 기존 검토 정책을 사용한다', { concurrency: false }, async t => {
  installMock(t, { humanize: LATE_RESTORED_OUTPUT, failFinal: true });
  const out = await engine.run({ text: SOURCE, mode: 'blog', uid: 'final-audit-unavailable', config: config() });
  assert.equal(out.engineMeta.finalSemanticRevalidationAttempted, true);
  assert.equal(out.engineMeta.finalSemanticRevalidationApplied, false);
  assert.equal(out.engineMeta.finalSemanticRevalidationReason, 'audit_incomplete');
  if (out.engineMeta.semanticValidationStatus !== 'pass') assert.notEqual(out.status, 'clean');
  if (out.engineMeta.semanticValidationStatus === 'pass') {
    assert.equal(provenance.verifySemanticValidation(out.result.semanticAudit, {
      source: SOURCE, candidate: out.result.outputText, requireDigest: true
    }).status, 'pass');
  }
});

for (const accept of [true, false]) test(`최종 관계 복구는 같은 기한 안에서 재검증하고 ${accept ? '새 pass만 채택한다' : '거절 시 실패를 숨기지 않는다'}`, { concurrency: false }, async t => {
  const unchanged = '마지막 단계에서는 측정 장비를 점검했습니다. 정리한 자료는 다음 실험에서도 참고할 수 있도록 보관했습니다.';
  const a = '전압 차이는 정상 범위 안에서 나타나는 차이를 의미합니다.';
  const b = '전압 차이는 정상 범위를 벗어난 정도를 의미합니다.';
  const source = SOURCE + ' ' + a + ' ' + unchanged;
  const mock = installMock(t, {
    humanize: LATE_RESTORED_OUTPUT + ' ' + b + ' ' + unchanged,
    violation: (_body, call, rewrite) => {
      if (call < 2 || (!rewrite.includes(b) && accept)) return [];
      if (!rewrite.includes(b)) return [{ type: 'added_claim', span: rewrite,
        sourceSpan: source, candidateSpan: rewrite, relation: 'other', origin: 'introduced', detail: '재검증 실패를 정상으로 덮지 않는 회귀 사례' }];
      return [{ type: 'distortion', span: b, sourceSpan: a, candidateSpan: b,
        relation: 'condition_result', origin: 'introduced', detail: '범위 내 차이가 범위 이탈로 바뀌었다.' }];
    }
  });
  const out = await engine.run({ text: source, mode: 'blog', config: config() });
  assert.equal(out.engineMeta.finalRelationRestorationAttempted, true);
  assert.equal(out.engineMeta.finalSemanticRevalidationJudgeCallCount, mock.judgeCalls() - 1);
  assert.equal(mock.calls.filter(c => c.name === 'gpt_prod_judge_repair').length, 0);
  assert.ok(mock.judgeCalls() >= 3);
  assert.equal(out.engineMeta.semanticModelCallCount, mock.judgeCalls());
  assert.equal(out.result.humanizeMeta.callLedger.entries.filter(e => e.stage === 'final_relation_restoration_verification').length, accept ? 1 : 2);
  assert.equal(provenance.verifySemanticValidation(out.result.semanticAudit, {
    source, candidate: out.result.outputText, requireDigest: true
  }).status, accept ? 'pass' : 'fail');
  if (accept) {
    assert.ok(out.result.outputText.includes(a));
    assert.ok(!out.result.outputText.includes(b));
    assert.equal(out.engineMeta.finalRelationRestoredCount, 1);
  } else {
    assert.ok(out.result.outputText.includes(b));
    assert.equal(out.engineMeta.finalRelationRestorationRejected, true);
    assert.notEqual(out.status, 'clean');
  }
});

test('final restoration receives bounded request-local audit history without treating it as a new verdict', async t => {
  const restorer = require('../engine-gpt-prod/confirmedRelationRestore');
  const original = restorer.restoreConfirmedRelations;
  const observed = [];
  restorer.restoreConfirmedRelations = (source, output, report, options) => {
    if (options?.priorReports) observed.push(options.priorReports);
    return original(source, output, report, options);
  };
  t.after(() => { restorer.restoreConfirmedRelations = original; });
  const a = '전압 차이는 정상 범위 안에서 나타나는 차이를 의미합니다.';
  const b = '전압 차이는 정상 범위를 벗어난 정도를 의미합니다.';
  const tail = '마지막 단계에서는 측정 장비를 점검했습니다. 정리한 자료는 다음 실험을 위해 보관했습니다.';
  const source = SOURCE + ' ' + a + ' ' + tail;
  const mock = installMock(t, {
    humanize: LATE_RESTORED_OUTPUT + ' ' + b + ' ' + tail,
    violation: (_body, call, rewrite) => call < 2 || !rewrite.includes(b) ? [] : [{
      type: 'distortion', span: b, sourceSpan: a, candidateSpan: b,
      relation: 'condition_result', origin: 'introduced', detail: '범위 내 차이와 이탈 정도는 다릅니다.'
    }]
  });
  const out = await engine.run({ text: source, mode: 'blog', config: config() });
  assert.equal(observed.length, 1);
  assert.ok(observed[0].length >= 2 && observed[0].length <= 9);
  assert.ok(observed[0].some(report => report.ran === true && report.validation));
  assert.ok(mock.judgeCalls() >= 3);
  assert.equal(out.engineMeta.finalRelationRestorationAttempted, true);
  assert.equal(provenance.verifySemanticValidation(out.result.semanticAudit, {
    source, candidate: out.result.outputText, requireDigest: true
  }).status, 'pass');
});
