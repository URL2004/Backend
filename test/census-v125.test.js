'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { restoreConfirmedRelations } = require('../engine-gpt-prod/confirmedRelationRestore');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { createCandidateLedger } = require('../engine-gpt-prod/candidateLedger');
const a = '기록 보존도 중요한 과제다.', b = '기록 보존도 남은 과제다.';
const tail = '각 팀은 이전에 작성한 관측 기록을 모아 보관했다. 날짜와 담당자가 다른 자료는 서로 섞이지 않도록 별도의 목록으로 관리했다.';
const source = a + ' ' + tail, output = b + ' ' + tail;
const finding = groundViolation({ type: 'omission', origin: 'introduced', relation: 'other',
  sourceSpan: a, candidateSpan: b, span: a }, source, output);
const report = { pass: false, uncertain: false, verificationCompleted: true, violations: [finding] };

test('short complete grounded sentence is a local proposal, not a semantic pass', () => {
  assert.ok(a.length < 20 && b.length < 20);
  const r = restoreConfirmedRelations(source, output, report);
  assert.equal(r.text, source); assert.equal(r.restoredCount, 1); assert.equal(r.pass, undefined);
  assert.equal(restoreConfirmedRelations(a, b, report).applied, false, 'no whole-document restoration');
  assert.equal(restoreConfirmedRelations(source, output + ' ' + b, report).applied, false);
  assert.equal(restoreConfirmedRelations(source, output, { ...report, uncertain: true }).applied, false);
  assert.equal(restoreConfirmedRelations(source, output, { ...report, violations: [{ ...finding, candidateSpan: b.slice(0, -1) }] }).applied, false);
  assert.equal(restoreConfirmedRelations(source, output, { ...report, violations: [{ ...finding, sourceSpan: a.replace('기록', '“기록”') }] }).applied, false);
});

test('short restoration still requires a fresh passing verdict and honors judge-only mode', async () => {
  const judge = require('../engine-gpt-prod/judge'), modulePath = require.resolve('../engine-gpt-prod/finalQualityV2');
  const saved = { judge: judge.judgeAndRepair, assess: judge.assessRepairCandidate };
  let calls = 0, pass = true;
  judge.assessRepairCandidate = () => ({ pass: true });
  judge.judgeAndRepair = async (_, text) => {
    calls++;
    return text === output ? { ...report, outputText: text, rounds: 1, usage: { estimatedUsd: .02 } }
      : { pass, uncertain: !pass, outputText: text, violations: [], usage: { estimatedUsd: .01 } };
  };
  delete require.cache[modulePath];
  try {
    const run = require(modulePath).runSemanticDocumentAudit;
    let r = await run({ source, outputText: output, config: {} });
    assert.equal(r.outputText, source); assert.equal(r.pass, true); assert.equal(calls, 2);
    calls = 0; pass = false;
    r = await run({ source, outputText: output, config: {} });
    assert.equal(r.outputText, output); assert.equal(r.pass, false); assert.equal(calls, 2);
    calls = 0;
    r = await run({ source, outputText: output, config: {}, allowRepair: false });
    assert.equal(r.outputText, output); assert.equal(calls, 1);
  } finally { judge.judgeAndRepair = saved.judge; judge.assessRepairCandidate = saved.assess; delete require.cache[modulePath]; }
});

test('intentional semantic skip is labeled accurately but never becomes a rollback pass', () => {
  const ledger = createCandidateLedger({ assess: () => ({ transformed: true, minimumEffectPass: true, hardViolationCodes: [] }) });
  const entry = ledger.record({ text: output, semanticReport: { ran: false, decisionReason: 'not_required' } });
  assert.equal(ledger.chooseFinal(entry.id).reason, 'semantic_verification_not_required');
  assert.equal(entry.eligible, false); assert.equal(ledger.snapshot().eligibleCount, 0);
  assert.equal(ledger.chooseFinal(entry.id, { reviewObligations: [{}] }).reason, 'no_safe_transformed_candidate');
});

test('basic and advanced prompts retain reflective change and unique evaluation across profiles', () => {
  const prompts = require('../engine-gpt-prod/prompts');
  for (const requestStrength of ['basic', 'advanced']) for (const profile of ['report_assignment', 'personal_essay']) {
    const p = prompts.buildHumanizePrompt('assignment', 'ko', { requestStrength, register: 'formal',
      documentProfile: { profile, group: profile === 'personal_essay' ? 'personal_essay' : 'academic_report_explainer', targetRegister: 'formal', formatProfile: { flags: [] } } });
    assert.match(p.stable + p.taskContract, /인식의 변화와 현재/u);
    assert.match(p.stable + p.taskContract, /짧은 평가도 유일한 주장/u);
    assert.doesNotMatch(p.stable + p.taskContract, /겹치는 평가 기능만 줄인다/u);
  }
});

test('a colon in bracket-labeled prose is not a new heading; label boundaries still matter', () => {
  const s = require('../engine-gpt-prod/structureChunk');
  const source = '[본문]자료를 꼼꼼하게 읽으며 검토했다. 책의 제목은 <기록과 관찰: 현장 연구>이다.\n\n[결론]확인한 내용은 따로 정리했다.';
  const output = '[본문]자료를 읽으며 자세히 검토했다. 책의 제목은 <기록과 관찰: 현장 연구>이다.\n\n[결론]확인한 내용을 별도로 정리했다.';
  assert.equal(s.compareLineAnchorLayout(source, output).pass, true);
  assert.equal(s.compareBracketedLabelLayout(source, output).pass, true);
  assert.equal(s.compareBracketedLabelLayout(source, output.replace('[결론]', '[요약]')).pass, false);
  assert.equal(s.compareBracketedLabelLayout(source, output.replace('\n\n[결론]', ' [결론]')).pass, false);
  assert.equal(s.compareLineAnchorLayout('검토 기준: 각 항목을 살폈다.', '검토 방법: 각 항목을 확인했다.').pass, false);
});
