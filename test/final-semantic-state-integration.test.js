'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

for (const withFinding of [false, true]) test(`engine unknown provenance enters one bounded final audit; nomination=${withFinding}`, async t => {
  const client = require('../engine-gpt-prod/openaiClient');
  const quality = require('../engine-gpt-prod/finalQualityV2');
  const canonical = require('../engine-gpt-prod/semanticCanonicalAudit');
  const provenance = require('../engine-gpt-prod/semanticProvenance');
  const runtime = require('../lib/gptRuntimeConfig');
  const finalRepair = require('../engine-gpt-prod/finalRelationRepair');
  const oldPrepare = finalRepair.prepareFinalRelationRepair;
  const oldClient = client.completeJson, oldAudit = quality.runSemanticDocumentAudit;
  const oldDecision = quality.shouldRunSemanticJudge, oldCanonical = canonical.runCanonicalSemanticAudit;
  const names = ['GPT_LAYOUT_NLP_ENABLED', 'GPT_NIKL_QUALITY_ENABLED', 'GPT_NIKL_EXTERNAL_API_ENABLED', 'HUMANIZATION_DEPTH_GATE_ENABLED'];
  const env = Object.fromEntries(names.map(k => [k, process.env[k]]));
  for (const name of names) process.env[name] = '0';
  const source = '설계 과정에서 전원 노이즈가 기능에 영향을 줄 수 있음을 확인했습니다. 이후 필터 조건을 비교하고 결과를 기록했습니다.';
  const output = '설계 과정에서 전원 노이즈가 기능에 영향을 줄 수 있다는 점을 확인했습니다. 이어서 필터별 조건을 대조한 뒤 결과를 문서에 기록했습니다.';
  client.completeJson = async options => {
    if (options.schemaName === 'gpt_prod_humanize_result') return { json: { outputText: output }, model: options.model, usage: {} };
    throw new Error('Unexpected synthetic model request: ' + options.schemaName);
  };
  quality.shouldRunSemanticJudge = () => ({ run: true, reason: 'synthetic_missing_provenance' });
  const audits = [];
  quality.runSemanticDocumentAudit = async options => {
    audits.push({ allowRepair: options.allowRepair, deadlineMs: options.deadlineMs });
    return provenance.bindSemanticValidation({ ran: true, pass: true, verificationCompleted: true,
      outputText: options.outputText, repairCount: 0, reports: [], violations: [], sourceIssues: [], usage: {},
      progress: { expectedSections: 1, completedSections: 1, unfinishedSections: [] } }, options.source, options.outputText);
  };
  canonical.runCanonicalSemanticAudit = async options => {
    const report = await oldCanonical(options);
    const { validation, ...unbound } = report;
    if (!withFinding) return unbound;
    return { ...unbound, pass:false, verificationCompleted:true, violations:[
      require('../engine-gpt-prod/judge').groundViolation({type:'distortion',origin:'introduced',
        relation:'modality_negation_causality',sourceSpan:source,candidateSpan:output,span:output},source,output)
    ] };
  };
  let preparations=0;
  finalRepair.prepareFinalRelationRepair=async (actualSource,actualOutput,evidence,options)=>{
    preparations++;
    assert.equal(withFinding,true);
    assert.equal(evidence.nominationOnly,true);
    assert.equal(evidence.violations.length,1);
    assert.ok(actualSource.includes(evidence.violations[0].sourceSpan));
    assert.ok(actualOutput.includes(evidence.violations[0].candidateSpan));
    assert.ok(Number.isFinite(options.deadlineMs));
    // Exercise the index proposal route without a synthetic extra model call.
    return {text:actualOutput,applied:false,patchAttempted:false,skipReason:'no_grounded_target'};
  };
  const enginePath = require.resolve('../engine-gpt-prod'); delete require.cache[enginePath];
  const engine = require('../engine-gpt-prod');
  t.after(() => {
    client.completeJson = oldClient; quality.runSemanticDocumentAudit = oldAudit;
    quality.shouldRunSemanticJudge = oldDecision; canonical.runCanonicalSemanticAudit = oldCanonical;
    finalRepair.prepareFinalRelationRepair=oldPrepare;
    delete require.cache[enginePath];
    for (const name of names) { if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name]; }
  });
  const out = await engine.run({ text: source, mode: 'blog', config: runtime.publicConfig(runtime.DEFAULT_CONFIG, 'test') });
  assert.equal(out.engineMeta.finalSemanticRevalidationPriorStatus, 'unknown');
  assert.equal(out.engineMeta.finalSemanticRevalidationAttempted, true);
  assert.equal(out.engineMeta.finalSemanticRevalidationReason, 'revalidated_pass');
  assert.equal(out.engineMeta.finalSemanticState, 'verified_pass');
  assert.equal(preparations,withFinding?1:0);
  const final = audits.filter(a => a.allowRepair === false);
  assert.equal(final.length, 1);
  assert(Number.isFinite(final[0].deadlineMs), 'existing absolute final deadline is retained');
});
