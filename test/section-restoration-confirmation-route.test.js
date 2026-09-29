'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const realJudge = require('../engine-gpt-prod/judge');
const config = { models: { judge: 'gpt-6-luna', judgeEscalation: 'gpt-6-sol', repair: 'gpt-6-luna' },
  reasoning: { judge: 'medium', escalation: 'high', repair: 'medium' } };
const source = '설비의 가동 결과는 현장의 조건에 따라 달라질 수 있다. 담당자는 점검 항목을 기록했다. 자료는 다음 조사에 활용했다. 별도의 기록은 유지했다. 연구팀은 시설의 이용 현황을 따로 집계했다. 분석 결과는 다음 달 회의에서 공유했다. 조사는 정해진 일정에 따라 진행했다.';
const expected = source.replace('자료는 다음 조사에 활용했다.', '다음 조사에는 자료를 활용했다.');
const output = expected.replace('달라질 수 있다', '달라진다');
const finding = realJudge.groundViolation({ type: 'distortion', origin: 'introduced',
  relation: 'modality_negation_causality', sourceSpan: source.split('. ')[0] + '.',
  candidateSpan: output.split('. ')[0] + '.', span: '달라진다', detail: '가능성을 단정으로 변경했다.' }, source, output);

function load(name, overrides) {
  const file = require.resolve(name), req = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
    require: n => overrides[n] || req(n), AbortSignal, Date, setTimeout, clearTimeout, Buffer, process }, { filename: file });
  return module.exports;
}

for (const route of ['escalated', 'relationConfirmationFirst', 'primary']) {
  for (const verdict of ['pass', 'fail', 'timeout']) test(`section restoration preserves ${route} verdict tier: ${verdict}`, async () => {
    const calls = [];
    const judge = load('../engine-gpt-prod/judge', { './openaiClient': { completeJson: async options => {
      calls.push(options);
      assert.equal(options.meta.task, 'judge');
      if (verdict === 'timeout') throw Object.assign(Error('timeout'), { code: 'OPENAI_TIMEOUT' });
      return { json: require('./helpers/semantic-review-fixture.cjs')({ violations: verdict === 'pass' ? [] : [{
        type: 'distortion', origin: 'introduced', relation: 'other', sourceSpan: source,
        candidateSpan: source, span: source, detail: '합성 재검증에서 별도의 미해결 오류를 확인했다.'
      }] }, options.user), model: options.model, usage: { estimatedUsd: .01 } };
    } } });
    let initial = true;
    const quality = load('../engine-gpt-prod/finalQualityV2', { './judge': { ...judge,
      judgeAndRepair: async (a, b, options) => {
        if (!initial) return judge.judgeAndRepair(a, b, options);
        initial = false;
        // A completed earlier section chain, with its repair round already used.
        return { outputText: output, pass: false, verificationCompleted: true, rounds: 1,
          violations: [finding], initialViolations: [finding],
          selectedJudgeModel: route === 'primary' ? config.models.judge : config.models.judgeEscalation,
          ...(route === 'primary' ? {} : { [route]: true }) };
      }
    } });
    const result = await quality.runSemanticDocumentAudit({ source, outputText: output,
      config, allowRepair: true, stagedConfirmation: false });
    assert.ok(calls.length > 0, 'the literal proposal requires a fresh verdict');
    assert.equal(calls[0].model, route === 'primary' ? config.models.judge : config.models.judgeEscalation);
    assert.equal(calls[0].reasoningEffort, route === 'primary' ? config.reasoning.judge : config.reasoning.escalation);
    if (route !== 'primary') assert.equal(calls.length, 1, 'no weaker fallback or nested repair');
    assert.equal(result.pass, verdict === 'pass');
    assert.equal(result.outputText, verdict === 'pass' ? expected : output);
    if (verdict !== 'pass') assert.equal(result.reports[0].confirmedRelationRestoreRejected, true);
  });
}
