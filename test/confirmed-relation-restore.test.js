'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { restoreConfirmedRelations } = require('../engine-gpt-prod/confirmedRelationRestore');
const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');
const unchanged = '다음 단계에서는 측정 장비를 점검한다.';
const sourceSentence = '회로의 절연 결함은 단락으로 이어지므로 정기적인 점검이 필요하다.';
const outputSentence = '회로의 절연 결함은 단락으로 이어질 수 있으므로 정기적인 점검이 필요하다.';
const confirmed = span => ({ pass: false, uncertain: false, violations: [{ type: 'distortion', span,
  spanVerified: true, repairable: true, grounding: 'unique_exact_span' }] });
test('restores only confirmed certainty drift and keeps unrelated wording and delimiters', () => {
  const output = outputSentence + '\n\n' + unchanged;
  const r = restoreConfirmedRelations(sourceSentence + '\n\n' + unchanged, output, confirmed(outputSentence));
  assert.equal(r.text, sourceSentence + '\n\n' + unchanged);
  assert.equal(r.restoredCount, 1);
});
test('heuristic, uncertain, ungrounded and repeated spans cannot authorize restoration', () => {
  const source = sourceSentence + ' ' + unchanged, output = outputSentence + ' ' + unchanged;
  for (const report of [null, { ...confirmed(outputSentence), uncertain: true },
    { pass: false, violations: [{ type: 'distortion', span: outputSentence }] }]) {
    assert.equal(restoreConfirmedRelations(source, output, report).applied, false);
  }
  assert.equal(restoreConfirmedRelations(source, output + ' ' + outputSentence, confirmed(outputSentence)).applied, false);
});
test('comparison to categorical negation is nominated and restored, not auto certified', () => {
  const a = '도구는 결정을 대신하는 주체가 되기보다 사용자의 판단과 참여를 지원해야 한다.';
  const b = '도구는 결정을 대신하는 주체가 아니라 사용자의 판단과 참여를 지원해야 한다.';
  assert.ok(auditRelationCandidates(a,b).codes.includes('comparison_negation_candidate'));
  assert.equal(restoreConfirmedRelations(a+' '+unchanged,b+' '+unchanged,confirmed(b)).text,a+' '+unchanged);
});
test('technical terms stay local to their claim, not normalized from another paragraph', () => {
  const a = '공원 주변 지대가 상승해 기존 상인들이 이주했다. 지가와 임대료를 각각 조사한다.';
  const b = '공원 주변 지가가 상승해 기존 상인들이 이주했다. 지가와 임대료를 각각 조사한다.';
  const signal = auditRelationCandidates(a,b);
  assert.ok(signal.codes.includes('technical_concept_substitution_candidate'));
  assert.equal(restoreConfirmedRelations(a,b,null).applied,false);
  assert.equal(restoreConfirmedRelations(a,b,confirmed(b.split('. ')[0]+'.')).text,a);
  assert.equal(auditRelationCandidates('휴식 지대에서 산책한다.','휴식 지대에서 걷는다.').codes.includes('technical_concept_substitution_candidate'),false);
});
test('preserved standalone heading prefixes are not duplicated', () => {
  const source = '1. 점검 원칙\n핵심 설명\n'+sourceSentence+' '+unchanged;
  const output = '1. 점검 원칙\n\n핵심 설명\n\n'+outputSentence+' '+unchanged;
  const r = restoreConfirmedRelations(source,output,confirmed(outputSentence));
  assert.equal(r.text, output.replace(outputSentence, sourceSentence));
  assert.equal(r.restoredCount,1);
});
test('quotes, ambiguous source matches and whole-document reset are refused', () => {
  assert.equal(restoreConfirmedRelations(sourceSentence,outputSentence,confirmed(outputSentence)).applied,false);
  assert.equal(restoreConfirmedRelations(sourceSentence+' '+sourceSentence+' '+unchanged,outputSentence+' '+unchanged,confirmed(outputSentence)).applied,false);
  const a='“절연” 결함은 단락으로 이어지므로 점검이 필요하다.';
  const b='“절연” 결함은 단락으로 이어질 수 있으므로 점검이 필요하다.';
  assert.equal(restoreConfirmedRelations(a+' '+unchanged,b+' '+unchanged,confirmed(b)).applied,false);
});

test('document audit re-verifies local restoration, aggregates costs and respects judge-only mode', async () => {
  const judge = require('../engine-gpt-prod/judge');
  const qualityPath = require.resolve('../engine-gpt-prod/finalQualityV2');
  const originalJudge = judge.judgeAndRepair;
  const originalSafety = judge.assessRepairCandidate;
  const source = sourceSentence + ' ' + unchanged;
  const output = outputSentence + ' ' + unchanged;
  let calls = [], verdict = true;
  judge.assessRepairCandidate = () => ({ pass: true });
  judge.judgeAndRepair = async (_, text, options) => {
    calls.push({ text, options });
    return text === output
      ? { ...confirmed(outputSentence), outputText: text, rounds: 1, usage: { estimatedUsd: .03 } }
      : { pass: verdict, uncertain: !verdict, outputText: text, usage: { estimatedUsd: .01 }, violations: [] };
  };
  delete require.cache[qualityPath];
  try {
    const audit = require(qualityPath).runSemanticDocumentAudit;
    let result = await audit({ source, outputText: output, config: {} });
    assert.equal(result.pass, true);
    assert.equal(result.outputText, source);
    assert.equal(result.reports[0].confirmedRelationRestoreCount, 1);
    assert.equal(result.usage.estimatedUsd, .04);
    assert.equal(calls[1].options.maxRounds, 0);
    calls = []; verdict = false;
    result = await audit({ source, outputText: output, config: {} });
    assert.equal(result.outputText, output);
    assert.equal(result.pass, false);
    assert.equal(result.usage.estimatedUsd, .04);
    calls = [];
    result = await audit({ source, outputText: output, config: {}, allowRepair: false });
    assert.equal(calls.length, 1);
    assert.equal(result.outputText, output);
  } finally {
    judge.judgeAndRepair = originalJudge;
    judge.assessRepairCandidate = originalSafety;
    delete require.cache[qualityPath];
  }
});
