'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { assessRepairCandidate } = require('../engine-gpt-prod/judge');
const { assessSemanticRepairPriority } = require('../engine-gpt-prod/semanticRepairPolicy');

// Synthetic report: no evaluation document or user-supplied text is stored.
const prefix = [
  '연구팀은 4월에 진행한 현장 조사 자료를 살펴보고 참여 현황과 비용 부담을 구분해 점검표에 정리했다.',
  '최종 분석에 앞서 운영팀은 중복된 응답이 없는지 확인했으며 누락된 항목은 별도 목록에 남겼다.',
  '점검표에는 참여자 120명과 비용 30만원이 적혀 있었고 담당자는 이 수치가 잠정 집계라고 설명했다.',
  '안내문에는 “자료는 잠정치다”라는 문구가 붙어 있었으며 추가 확인이 필요한 항목에는 표시가 남아 있었다.'
];
const sourceRelation = '담당자는 참여자가 120명을 넘었지만 비용 부담이 큰 상황이므로, 비용 부담이 참여 감소와 관련이 있을 수 있다며 운영팀이 참여자들이 체감할 수 있는 비용 절감 방안을 마련해야 한다고 밝혔다.';
const wrongRelation = '담당자는 참여자가 120명을 넘어선 데다 비용 부담이 큰 만큼, 이런 여건이 참여 감소와 관련이 있을 수 있다며 운영팀이 참여자들이 체감할 수 있는 비용 절감 방안을 마련해야 한다고 밝혔다.';
const fixedRelation = '담당자는 참여자가 120명을 넘었지만 큰 비용 부담이 참여 감소와 관련이 있을 수 있다며 운영팀이 참여자가 체감할 비용 절감 방안을 마련해야 한다고 밝혔다.';
const source = [...prefix, sourceRelation].join(' ');
const before = [prefix[0].replace('살펴보고', '검토하고'), ...prefix.slice(1), wrongRelation].join(' ');
const candidate = before.replace(wrongRelation, fixedRelation);
const violations = [{ type: 'distortion', span: '참여자가 120명을 넘어선 데다 비용 부담이 큰 만큼', detail: '대조 배경을 인과 요인으로 확장했다.' }];
const config = { models: { judge: 'gpt-5.6-luna', judgeEscalation: 'gpt-5.6-luna', repair: 'gpt-5.6-luna' } };

function mockedJudge(responses) {
  const file = path.join(__dirname, '../engine-gpt-prod/judge.js');
  const actualRequire = createRequire(file);
  const calls = [];
  const module = { exports: {} };
  const context = {
    module, exports: module.exports,
    require: name => name === './openaiClient' ? {
      completeJson: async options => {
        calls.push(options);
        const json = responses[calls.length - 1];
        assert.ok(json, `unexpected model call: ${options.meta.phase}`);
        return { json, model: options.model, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, estimatedUsd: 0.001 } };
      }
    } : actualRequire(name)
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { judge: module.exports, calls };
}

test('local meaning repair can be reviewed despite a real rhythm-distribution rejection', () => {
  const safety = assessRepairCandidate(source, before, candidate);
  assert.deepEqual(safety.reasons, ['sentence_distribution_worsened']);
  assert.equal(safety.beforeDistributionShift.shift, false);
  assert.equal(safety.candidateDistributionShift.shift, true);
  const priority = assessSemanticRepairPriority(before, candidate, violations, safety);
  assert.equal(priority.eligible, true);
  assert.equal(priority.targetCount, 1);
});

test('meaning repair wins over rhythm only after a fresh semantic judge passes', async () => {
  const { judge, calls } = mockedJudge([
    { violations },
    { outputText: candidate, repaired: true, notes: [] },
    { violations: [] }
  ]);
  const result = await judge.judgeAndRepair(source, before, { config });
  assert.equal(result.pass, true);
  assert.equal(result.outputText, candidate);
  assert.equal(result.outputText.includes(prefix[0].replace('살펴보고', '검토하고')), true);
  assert.deepEqual([...result.repairStyleWarnings], ['sentence_distribution_worsened']);
  assert.deepEqual(calls.map(call => call.meta.phase), ['primary:semantic', 'primary:repair', 'primary:semantic_after_repair']);
  assert.equal(result.usage.inputTokens, 300);
});

test('a rhythm exception cannot deliver a repair whose meaning is still unverified', async () => {
  const { judge, calls } = mockedJudge([
    { violations },
    { outputText: candidate, repaired: true, notes: [] },
    { violations: [{ type: 'distortion', span: fixedRelation, detail: '문맥 범위가 아직 바뀌었다.' }] }
  ]);
  const result = await judge.judgeAndRepair(source, before, { config });
  assert.equal(result.pass, false);
  assert.equal(result.outputText, before);
  assert.ok(result.repairRejectReasons.includes('semantic_repair_not_verified'));
  assert.equal(calls.length, 3);
});

test('editing another sentence cannot use a semantic target to waive rhythm preservation', async () => {
  const unrelated = candidate.replace('별도 목록에 남겼다', '별도 목록으로 정리했다');
  const priority = assessSemanticRepairPriority(before, unrelated, violations, { reasons: ['sentence_distribution_worsened'] });
  assert.equal(priority.eligible, false);
  assert.equal(priority.reason, 'unrelated_text_changed');
  const { judge, calls } = mockedJudge([{ violations }, { outputText: unrelated, repaired: true, notes: [] }]);
  const result = await judge.judgeAndRepair(source, before, { config });
  assert.equal(result.pass, false);
  assert.equal(result.outputText, before);
  assert.equal(calls.length, 2);
});

test('numbers and quote contents remain hard repair boundaries', () => {
  for (const [changed, reason] of [
    [candidate.replace('120명을 넘었지만', '121명을 넘었지만'), 'number_facts_worsened'],
    [candidate.replace('자료는 잠정치다', '자료는 확정치다'), 'direct_quote_worsened']
  ]) {
    const safety = assessRepairCandidate(source, before, changed);
    assert.ok(safety.reasons.includes(reason), JSON.stringify(safety.reasons));
    assert.equal(assessSemanticRepairPriority(before, changed, violations, safety).eligible, false);
  }
});

test('rhythm priority does not allow full source reset, fabricated targets or style-only findings', () => {
  const reset = assessRepairCandidate(source, before, source);
  assert.ok(reset.reasons.includes('repair_erased_transform'));
  assert.equal(assessSemanticRepairPriority(before, source, violations, reset).eligible, false);
  const safety = { reasons: ['sentence_distribution_worsened'] };
  assert.equal(assessSemanticRepairPriority(before, candidate, [{ ...violations[0], span: '원문에 없는 근거 문장입니다' }], safety).eligible, false);
  assert.equal(assessSemanticRepairPriority(before, candidate, [{ ...violations[0], type: 'overstructured_causality' }], safety).eligible, false);
});

test('repeated spans and document-wide targets do not authorize a broad repair exception', () => {
  const safety = { reasons: ['sentence_distribution_worsened'] };
  const repeated = `${before} ${before}`;
  assert.equal(assessSemanticRepairPriority(repeated, repeated, violations, safety).eligible, false);
  assert.equal(assessSemanticRepairPriority(before, candidate, [{ type: 'distortion', span: before }], safety).eligible, false);
});

test('an unchanged repair skips an identical judgment and does not consume another repair round', async () => {
  const { judge, calls } = mockedJudge([{ violations }, { outputText: before, repaired: false, notes: [] }]);
  let reserved = 0;
  const result = await judge.judgeAndRepair(source, before, { config, maxRounds: 3, reserveRepair: () => { reserved++; return true; } });
  assert.equal(result.pass, false);
  assert.equal(result.outputText, before);
  assert.equal(result.rounds, 1);
  assert.equal(result.unchangedRepairCount, 1);
  assert.equal(calls.length, 2);
  assert.equal(reserved, 1);
  assert.equal(result.usage.inputTokens, 200);
});

test('a distinct escalation judge still checks unresolved unchanged output', async () => {
  const { judge, calls } = mockedJudge([{ violations }, { outputText: before, repaired: false, notes: [] }, { violations }]);
  const result = await judge.judgeAndRepair(source, before, { config: { models: { ...config.models, judgeEscalation: 'gpt-5.6-terra' } } });
  assert.equal(result.pass, false);
  assert.equal(result.escalated, true);
  assert.equal(result.unchangedRepairCount, 1);
  assert.deepEqual(calls.map(call => call.meta.phase), ['primary:semantic', 'primary:repair', 'escalation:semantic']);
  assert.equal(result.usage.inputTokens, 300);
});

test('section boundary whitespace is preserved when a repair only trims its unchanged text', async () => {
  const padded = `\n${before}\n\n`;
  const { judge, calls } = mockedJudge([{ violations }, { outputText: before, repaired: false, notes: [] }]);
  const result = await judge.judgeAndRepair(source, padded, { config, maxRounds: 2 });
  assert.equal(result.outputText, padded);
  assert.equal(result.unchangedRepairCount, 1);
  assert.equal(calls.length, 2);
});

test('the full-document gate only relaxes rhythm for the exact verified semantic output', () => {
  const { auditGeneralSurfaceCandidate } = require('../engine-gpt-prod');
  const { buildContract } = require('../engine/contract');
  const contract = buildContract(source, { mode: 'assignment', lang: 'ko' });
  const verified = { ran: true, pass: true, outputText: candidate, repairStyleWarnings: ['sentence_distribution_worsened'] };
  const audit = (text, report) => auditGeneralSurfaceCandidate(source, text, contract, null, 'assignment', before, null, report);
  assert.ok(audit(candidate, null).codes.includes('voice_shift'));
  assert.equal(audit(candidate, verified).pass, true);
  assert.ok(audit(candidate, { ...verified, pass: false }).codes.includes('voice_shift'));
  assert.ok(audit(candidate, { ...verified, outputText: before }).codes.includes('voice_shift'));
  assert.ok(audit(candidate, { ...verified, repairStyleWarnings: [] }).codes.includes('voice_shift'));
  const wrongNumber = candidate.replace('120명을 넘었지만', '121명을 넘었지만');
  assert.ok(audit(wrongNumber, { ...verified, outputText: wrongNumber }).codes.includes('number_changed'));
  const wrongQuote = candidate.replace('자료는 잠정치다', '자료는 확정치다');
  assert.ok(audit(wrongQuote, { ...verified, outputText: wrongQuote }).codes.includes('quote_loss'));
});

test('full humanization delivers the verified relation fix instead of restoring the distorted rewrite', { concurrency: false }, async t => {
  const engine = require('../engine-gpt-prod');
  const { extractPromptDataSection } = require('../engine-gpt-prod/promptEnvelope');
  const env = { OPENAI_API_KEY: 'test-key', OPENAI_SAFETY_SALT: 'semantic-repair-test', GPT_LAYOUT_NLP_ENABLED: '0', GPT_NIKL_QUALITY_ENABLED: '0', GPT_NIKL_EXTERNAL_API_ENABLED: '0', HUMANIZATION_DEPTH_GATE_ENABLED: '0' };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const oldFetch = global.fetch;
  const calls = [];
  t.after(() => {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const name = body.text?.format?.name;
    calls.push(name);
    let json;
    if (name === 'gpt_prod_humanize_result') json = { outputText: before };
    else if (name === 'gpt_prod_semantic_judge') {
      const rewrite = extractPromptDataSection(body.input, 'REWRITE');
      json = { violations: rewrite.includes(violations[0].span) ? violations : [] };
    } else if (name === 'gpt_prod_judge_repair') json = { outputText: candidate, repaired: true, notes: [] };
    else if (/retry$/u.test(name)) json = { outputText: extractPromptDataSection(body.input, 'CURRENT') || before, safeChangeFound: false, notes: [] };
    else throw new Error(`unexpected schema: ${name}`);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(json) }] }], usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await engine.run({ text: source, mode: 'formal', requestStrength: 'advanced', uid: 'semantic-repair-test', config });
  assert.equal(result.result.outputText.includes(violations[0].span), false, JSON.stringify({ calls, meta: result.engineMeta }));
  assert.ok(result.result.outputText.includes('참여자가 120명을 넘었지만 큰 비용 부담이 참여 감소와 관련이 있을 수 있다'));
  assert.ok(result.result.outputText.includes('자료는 잠정치다'));
  assert.ok(result.result.outputText.includes('30만원'));
  assert.deepEqual(result.engineMeta.semanticRepairStyleWarnings, ['sentence_distribution_worsened']);
  assert.equal(result.qualityWarnings.some(warning => ['semantic_distortion', 'semantic_repair_rejected'].includes(warning.code)), false);
  assert.equal(calls.filter(name => name === 'gpt_prod_judge_repair').length, 1);
});
