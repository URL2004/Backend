'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { restoreConfirmedRelations, PAIRED_RESTORATION_TYPES } = require('../engine-gpt-prod/confirmedRelationRestore');
const { groundViolation } = require('../engine-gpt-prod/judge');

const names = ['동쪽', '서쪽', '남쪽', '북쪽', '중앙', '해안', '산간', '도심', '농촌'];
const pair = name => ({
  source: `${name} 관측소에서는 기온이 낮아 내부 배관이 얼었다는 점을 확인했다.`,
  output: `${name} 관측소에서는 기온이 낮고 내부 배관이 얼었다는 점을 확인했다.`
});
const tail = Array.from({ length: 24 }, (_, i) => `보관 자료 ${i + 1}번의 측정값은 별도 기록에 남겼으며 다른 관측 결과와 혼동하지 않도록 관리했다.`).join(' ');
function fixture(count = 2) {
  const pairs = names.slice(0, count).map(pair);
  const source = pairs.map(p => p.source).join(' ') + ' ' + tail;
  const output = pairs.map(p => p.output).join(' ') + ' ' + tail;
  const findings = pairs.map(p => groundViolation({ type: 'distortion', origin: 'introduced',
    relation: 'other', sourceSpan: p.source, candidateSpan: p.output, span: p.output }, source, output));
  return { pairs, source, output, findings };
}
const report = violations => ({ pass: false, uncertain: false, verificationCompleted: true, violations });

test('restoration and nomination retention share one bounded type contract', () => {
  assert.deepEqual(PAIRED_RESTORATION_TYPES, ['distortion', 'omission', 'scope_expansion']);
  assert.equal(Object.isFrozen(PAIRED_RESTORATION_TYPES), true);
});

test('exact paired other findings are restored in source order, not model finding order', () => {
  const f = fixture();
  const actual = restoreConfirmedRelations(f.source, f.output, report([...f.findings].reverse()));
  assert.equal(actual.text, f.source);
  assert.equal(actual.restoredCount, 2);
  assert.equal(actual.pass, undefined, 'a proposal never certifies itself');
});

test('earlier still-exact grounded findings supplement nominations without mutating the official verdict', () => {
  const f = fixture(3);
  const current = report([f.findings[2]]);
  const prior = { ...report([]), initialViolations: [f.findings[0]], reports: [report([f.findings[1]])] };
  const snapshot = JSON.stringify({ current, prior });
  const actual = restoreConfirmedRelations(f.source, f.output, current, { priorReports: [prior, prior] });
  assert.equal(actual.text, f.source);
  assert.equal(actual.restoredCount, 3);
  assert.equal(JSON.stringify({ current, prior }), snapshot);
});

test('stale, ungrounded, uncertain and already-passed prior findings cannot nominate edits', () => {
  const f = fixture();
  const current = report([f.findings[1]]);
  const expected = f.output.replace(f.pairs[1].output, f.pairs[1].source);
  for (const prior of [
    { ...report([f.findings[0]]), uncertain: true },
    { ...report([f.findings[0]]), pass: true },
    { ...report([f.findings[0]]), skipped: true },
    { ...report([f.findings[0]]), verificationCompleted: false },
    report([{ ...f.findings[0], relationGrounded: false }]),
    report([{ ...f.findings[0], candidateSpan: '이미 교정되어 더 이상 남아 있지 않은 과거 결과 문장입니다.' }]),
    report([{ ...f.findings[0], sourceSpan: '현재 원문과 일치하지 않는 다른 자료의 완결된 문장입니다.' }])
  ]) assert.equal(restoreConfirmedRelations(f.source, f.output, current, { priorReports: [prior] }).text, expected);
  assert.equal(restoreConfirmedRelations(f.source, f.output, { ...current, pass: true }, { priorReports: [report(f.findings)] }).applied, false);
});

test('eight exact local windows can be proposed while the ninth remains unchanged', () => {
  const f = fixture(9);
  const actual = restoreConfirmedRelations(f.source, f.output, report([...f.findings].reverse()));
  assert.equal(actual.restoredCount, 8);
  assert.equal(actual.text, f.source.replace(f.pairs[8].source, f.pairs[8].output));
});

test('paired findings cannot bypass the 30 percent cap through legacy similarity fallback', () => {
  const a = '절연 결함은 단락으로 이어지므로 정기적인 점검이 필요하다.';
  const b = '절연 결함은 단락으로 이어질 수 있으므로 정기적인 점검이 필요하다.';
  const source = `${a} 기록을 보관한다.`, output = `${b} 기록을 보관한다.`;
  const v = groundViolation({ type: 'distortion', origin: 'introduced', relation: 'modality_negation_causality',
    sourceSpan: a, candidateSpan: b, span: b }, source, output);
  assert.equal(restoreConfirmedRelations(source, output, report([v])).applied, false);
});

test('judge-confirmed exact scope expansion restores only its paired sentence', () => {
  const a = '야간 근무자에게는 신청 기간에 보충 교육을 받을 기회를 제공해야 한다.';
  const b = '모든 직원에게는 신청 기간에 보충 교육을 받을 기회를 제공해야 한다.';
  const source = a + ' ' + tail, output = b + ' ' + tail;
  const finding = groundViolation({ type: 'scope_expansion', origin: 'introduced', relation: 'other',
    sourceSpan: a, candidateSpan: b, span: b }, source, output);
  const result = restoreConfirmedRelations(source, output, report([finding]));
  assert.equal(result.restoredCount, 1);
  assert.equal(result.text, source);
  assert.equal(result.pass, undefined);
  for (const candidate of [null, report([]), report([{ ...finding, relationGrounded: false }]),
    report([{ ...finding, origin: 'source_issue' }])]) {
    assert.equal(restoreConfirmedRelations(source, output, candidate).applied, false);
  }
});

test('partial boundaries, changed protected quotes, repeated ownership and crossed order stay untouched', () => {
  const f = fixture();
  const first = f.findings[0];
  for (const v of [
    { ...first, sourceSpan: first.sourceSpan.slice(4) },
    { ...first, candidateSpan: first.candidateSpan.slice(4) },
    { ...first, repairable: false },
    { ...first, origin: 'source_issue' }
  ]) assert.equal(restoreConfirmedRelations(f.source, f.output, report([v])).applied, false);
  const a = '보고서는 「운영 원칙」을 검토한 뒤 현장의 변화 원인을 설명했다.';
  const b = '보고서는 「검토 원칙」을 검토한 뒤 현장의 변화 원인을 설명했다.';
  const v = groundViolation({ type: 'distortion', origin: 'introduced', relation: 'other',
    sourceSpan: a, candidateSpan: b, span: b }, a + ' ' + tail, b + ' ' + tail);
  assert.equal(restoreConfirmedRelations(a + ' ' + tail, b + ' ' + tail, report([v])).applied, false);
  assert.equal(restoreConfirmedRelations(f.source, f.output + ' ' + f.pairs[0].output, report([first])).applied, false);
  const reversed = f.pairs[1].output + ' ' + f.pairs[0].output + ' ' + tail;
  assert.equal(restoreConfirmedRelations(f.source, reversed, report(f.findings)).restoredCount, 1);
});

test('a rejected repair retains exact findings only as private nominations, not its official verdict', async () => {
  const f = fixture();
  const scope = { source: '야간 근무자에게는 신청 기간에 보충 교육을 받을 기회를 제공해야 한다.',
    output: '모든 직원에게는 신청 기간에 보충 교육을 받을 기회를 제공해야 한다.' };
  f.source = f.source.replace(f.pairs[1].source, scope.source);
  f.output = f.output.replace(f.pairs[1].output, scope.output);
  f.pairs[1] = scope;
  f.findings[1] = groundViolation({ type: 'scope_expansion', origin: 'introduced', relation: 'other',
    sourceSpan: scope.source, candidateSpan: scope.output, span: scope.output }, f.source, f.output);
  const judge = require('../engine-gpt-prod/judge');
  const originalJudge = judge.judgeAndRepair, originalSafety = judge.assessRepairCandidate;
  const qualityPath = require.resolve('../engine-gpt-prod/finalQualityV2');
  let calls = 0, uncertain = false;
  judge.assessRepairCandidate = () => ({ pass: true });
  judge.judgeAndRepair = async (source, output) => {
    calls++;
    assert.equal(source, f.source);
    if (calls % 2 === 1) {
      assert.equal(output, f.output);
      return { ...report([f.findings[0]]), outputText: output, rounds: 0 };
    }
    assert.equal(output, f.output.replace(f.pairs[0].output, f.pairs[0].source));
    return { ...report([f.findings[1]]), uncertain, outputText: output, rounds: 0 };
  };
  delete require.cache[qualityPath];
  try {
    const audit = require(qualityPath).runSemanticDocumentAudit;
    const result = await audit({ source: f.source, outputText: f.output, config: {} });
    assert.equal(calls, 2);
    assert.equal(result.outputText, f.output, 'rejected output is not adopted');
    assert.equal(result.pass, false);
    assert.deepEqual(result.violations, [f.findings[0]], 'official verdict is unchanged');
    assert.equal(result.restorationNominationReports.length, 1);
    assert.deepEqual(result.restorationNominationReports[0].violations, [f.findings[1]]);
    assert.equal(result.restorationNominationReports[0].outputText, undefined);
    assert.equal(result.restorationNominationReports[0].source, undefined);
    const finalProposal = restoreConfirmedRelations(f.source, f.output, report([f.findings[0]]), { priorReports: [result] });
    assert.equal(finalProposal.restoredCount, 2);
    assert.equal(finalProposal.text, f.source);
    uncertain = true;
    const unconfirmed = await audit({ source: f.source, outputText: f.output, config: {} });
    assert.equal(calls, 4);
    assert.deepEqual(unconfirmed.restorationNominationReports, []);
  } finally {
    judge.judgeAndRepair = originalJudge;
    judge.assessRepairCandidate = originalSafety;
    delete require.cache[qualityPath];
  }
});
