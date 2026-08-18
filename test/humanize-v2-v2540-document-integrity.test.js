'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dedupe = require('../engine/dedupe');
const statisticalAtoms = require('../engine-gpt-prod/statisticalAtoms');
const fingerprint = require('../engine-gpt-prod/fingerprintAudit');
const candidateIntegrity = require('../engine-gpt-prod/candidateIntegrity');
const candidateLedger = require('../engine-gpt-prod/candidateLedger');
const { applyFinalGeneratedDedupe } = require('../engine-gpt-prod');

const ACADEMIC = Object.freeze({ profile: 'academic_paper', confidence: 0.96 });

const ABSTRACT_SOURCE = [
  '본 연구는 정부 창업지원사업이 초기창업기업의 경영성과에 미치는 영향을 구성요소별로 검토하였다.',
  '기존 연구는 정부지원을 단일 개념으로 다루어 평균효과를 검증해 왔으나 결과는 일관되지 않았다.',
  '이에 본 연구는 자원기반관점과 동적역량 관점을 연결하여 기업능력을 조절변수로 설정하였다.'
].join(' ');

const ABSTRACT_DUPLICATE = [
  '초기창업기업의 경영성과에 정부 창업지원사업이 미치는 영향을 지원 구성요소별로 분석하였다.',
  '기존 연구에서는 정부지원을 하나의 개념으로 취급해 평균효과를 검증했으나, 연구 결과는 일관되지 않았다.',
  '기존 연구에서는 정부지원을 단일 개념으로 다루며 평균효과를 검증해 왔지만, 그 결과는 일관되지 않았다.',
  '이에 본 연구는 자원기반관점과 동적역량 관점을 연계하고 기업능력을 조절변수로 설정하였다.'
].join(' ');

const LONG_SOURCE_SENTENCES = [
  '정부 창업지원의 평균효과가 일관되지 않았다는 사실은 구성요소별 검토가 필요함을 보여 준다.',
  '사업화자금은 기업에 직접 재무자원을 제공하지만 프로그램 품질과 동일한 작동 원리를 갖지는 않는다.',
  '창업프로그램 품질은 시장정보와 전문가 조언을 제공하여 의사결정의 정확성을 높일 수 있다.',
  '연구가설은 기업능력이 정부지원과 경영성과의 관계를 조절한다는 논리를 중심으로 설정하였다.',
  '연구모형은 네 가지 지원 구성요소와 기업능력의 상호작용을 한 체계 안에서 비교하도록 구성하였다.',
  '자료는 중부권 창업보육기관의 업력 삼 년 이내 초기창업기업을 대상으로 수집하였다.',
  '표본 자료에는 위계적 회귀분석을 적용하여 각 지원요소의 독립적인 효과를 검증하였다.',
  '분석 결과는 기업능력이 낮을 때 사업화자금의 효과가 제한될 수 있음을 보여 주었다.'
];
const LONG_SOURCE = LONG_SOURCE_SENTENCES.join(' ');
const LONG_REPLAY = [
  ...LONG_SOURCE_SENTENCES,
  '창업프로그램의 품질은 시장정보와 전문가 조언을 제공하면서 의사결정의 정확성을 높일 수 있었다.',
  '연구가설은 정부지원과 경영성과의 관계를 기업능력이 조절한다는 논리를 토대로 명확하게 설정되었다.',
  '연구모형에서는 네 지원 구성요소와 기업능력의 상호작용을 하나의 체계에서 서로 비교할 수 있도록 구성하였다.',
  '연구 자료는 중부권 창업보육기관에 입주한 업력 삼 년 이내의 초기창업기업을 대상으로 수집되었다.',
  '정제한 표본 자료에는 위계적 회귀분석을 적용해 각 지원요소의 독립 효과를 구체적으로 검증하였다.'
].join(' ');

test('v2.5.40: 같은 원문 주장 하나를 연속 의역한 두 문장 중 하나만 남긴다', () => {
  const repaired = dedupe.removeGeneratedLocalOverlapDuplicates(
    ABSTRACT_SOURCE,
    ABSTRACT_DUPLICATE
  );

  assert.equal(repaired.applied, true);
  assert.equal(repaired.removedCount, 1);
  assert.equal(repaired.reasons.includes('single_source_equivalent_paraphrase'), true);
  assert.equal((repaired.text.match(/평균효과/gu) || []).length, 1);
});

test('v2.5.40: 서로 다른 두 원문 주장은 어휘가 겹쳐도 제거하지 않는다', () => {
  const source = [
    '프로그램 품질은 시장정보를 제공하여 기업의 의사결정을 지원한다.',
    '프로그램 품질은 전문가 조언을 제공하여 기업의 실행역량을 높인다.'
  ].join(' ');
  const output = [
    '프로그램 품질은 시장정보를 제공해 기업의 의사결정을 돕는다.',
    '프로그램 품질은 전문가 조언을 제공해 기업의 실행역량을 높인다.'
  ].join(' ');

  const repaired = dedupe.removeGeneratedLocalOverlapDuplicates(source, output);
  assert.equal(repaired.applied, false);
  assert.equal(repaired.text, output);
});

test('v2.5.40: 표현이 달라진 앞 절의 장문 재삽입도 원문 순서 ledger로 제거한다', () => {
  assert.equal(dedupe.removeNewExactDuplicateBlocks(LONG_SOURCE, LONG_REPLAY).applied, false);

  const audit = dedupe.auditGeneratedSourceReplay(LONG_SOURCE, LONG_REPLAY);
  const repaired = dedupe.removeGeneratedSourceReplayBlocks(LONG_SOURCE, LONG_REPLAY);

  assert.equal(audit.pass, false);
  assert.equal(repaired.applied, true);
  assert.equal(repaired.removedBlockCount, 1);
  assert.ok(repaired.removedSentenceCount >= 4);
  assert.equal(dedupe.auditGeneratedSourceReplay(LONG_SOURCE, repaired.text).pass, true);
  assert.equal((repaired.text.match(/연구가설/gu) || []).length, 1);
  assert.equal((repaired.text.match(/연구모형/gu) || []).length, 1);

  const final = applyFinalGeneratedDedupe({
    source: LONG_SOURCE,
    outputText: LONG_REPLAY,
    chunks: [],
    documentProfile: ACADEMIC,
    mode: 'assignment'
  });
  assert.equal(final.applied, true, JSON.stringify(final.reasonCodes));
  assert.equal(final.removedSourceReplayBlockCount, 1);
});

test('v2.5.40: 현재 절 앞부분과 과거 절이 붙은 경계 문장을 복원한 뒤 replay를 제거한다', () => {
  const sourceRows = [
    '정부지원 연구는 지원 수단의 성격을 구분하는 문제에서 출발하였다.',
    '선행연구의 결론이 일치하지 않는다는 점이 본 연구의 출발점이다.',
    '연구가설은 자금 지원과 프로그램 품질의 효과가 서로 다르며 기업능력의 수준에 따라서도 달라질 수 있다고 보았다.',
    '연구모형은 기업능력과 네 가지 지원 구성요소의 상호작용을 하나의 분석 체계에 포함하도록 구체적으로 설계하였다.',
    '연구 방법에서는 표본 선정 기준과 변수 측정 절차와 위계적 회귀분석의 적용 단계를 차례대로 제시하였다.',
    '본 연구는 중부권 소재 창업보육기관 및 창업기업을 조사 대상으로 삼았다.',
    '자료를 정제한 뒤 위계적 회귀분석으로 가설을 검증하였다.',
    '분석 결과는 지원 수단마다 성과에 미치는 효과가 다르다는 점을 보여 주었다.'
  ];
  const source = sourceRows.join(' ');
  const corrupted = [
    ...sourceRows.slice(0, 5),
    '본 연구는 중부권 소재 창업보육기관 및 창선행연구의 결론이 일치하지 않는다는 점이 본 연구의 출발점이다.',
    sourceRows[2],
    sourceRows[3],
    sourceRows[4],
    sourceRows[5],
    sourceRows[6],
    sourceRows[7]
  ].join(' ');
  const repaired = dedupe.removeGeneratedSourceReplayBlocks(source, corrupted);

  assert.equal(repaired.applied, true);
  assert.equal(repaired.restoredSpliceCount, 1, repaired.text);
  assert.equal(repaired.text, source);
});

test('v2.5.40: 원문 자체에 되풀이된 주장과 정상 회상은 자동 삭제하지 않는다', () => {
  const source = [
    '첫 절에서는 연구의 출발점을 설명한다.',
    '둘째 절에서는 표본의 구성과 수집 절차를 설명한다.',
    '연구의 출발점은 기존 결론이 일치하지 않았다는 사실이다.',
    '결론에서는 다시 연구의 출발점을 언급하며 후속 연구의 방향을 제시한다.',
    '마지막으로 표본의 한계를 정리하고 연구 결과의 적용 범위를 밝힌다.',
    '부록에는 설문 문항과 변수 정의를 제시한다.'
  ].join(' ');
  assert.equal(dedupe.auditGeneratedSourceReplay(source, source).pass, true);
  assert.equal(dedupe.removeGeneratedSourceReplayBlocks(source, source).applied, false);
});

test('v2.5.40: 결론에서 세 결과를 압축해 다시 언급한 정상 요약은 replay가 아니다', () => {
  const source = LONG_SOURCE_SENTENCES.join(' ');
  const output = [
    source,
    '정리하면 프로그램 품질은 의사결정의 정확성을 높이는 역할을 했다.',
    '기업능력은 정부지원과 경영성과 사이의 관계를 조절하는 조건으로 확인되었다.',
    '표본 분석에서는 사업화자금의 효과가 기업능력에 따라 제한될 수 있었다.'
  ].join(' ');
  assert.equal(dedupe.auditGeneratedSourceReplay(source, output).pass, true);
  assert.equal(dedupe.removeGeneratedSourceReplayBlocks(source, output).applied, false);
});

test('v2.5.40: 통계 기호와 값 사이의 줄바꿈만 원문 원자로 복원한다', () => {
  const source = '표본은 N=206이며 효과는 β=.380, R²=.230, ΔR²=.024였다. 유의확률은 p<.001이고 다른 경로는 p<.01이었다. 95% CI를 제시했으며 적합도는 χ²=1826.61이었다.';
  const broken = '표본은 N=206이며 효과는 β=.380, R²=.230, ΔR²=.024였다. 유의확률은 p<.0\n01이고 다른 경로는 p<.\n01이었다. 95% CI를 제시했으며 적합도는 χ²=1826.61이었다.';
  const before = statisticalAtoms.auditStatisticalAtoms(source, broken);
  const repaired = statisticalAtoms.restoreWhitespaceBrokenStatisticalAtoms(source, broken);

  assert.equal(before.pass, false);
  assert.equal(before.whitespaceBrokenCount, 2);
  assert.equal(repaired.applied, true);
  assert.equal(repaired.repairCount, 2);
  assert.match(repaired.text, /p<\.001/u);
  assert.match(repaired.text, /p<\.01/u);
  assert.doesNotMatch(repaired.text, /p<\.0\s+01/u);
  assert.equal(repaired.audit.pass, true);
});

test('v2.5.40: 목차 번호와 날짜는 통계 원자로 오인하지 않는다', () => {
  const value = '3.1 자료와 표본\n조사 기간은 2026. 8. 1.부터 11. 30.까지였다.';
  const audit = statisticalAtoms.auditStatisticalAtoms(value, value);
  assert.equal(audit.applicable, false);
  assert.equal(audit.pass, true);
});

test('v2.5.40: 중립 연결의 보완 목적화와 없던 범위 한정 부사를 원문 관계로 복원한다', () => {
  const source = [
    '기존 연구의 결과는 일관되지 않았다.',
    '이에 본 연구는 세 이론을 연결하여 기업능력을 조절변수로 설정하였다.',
    '정책적으로는 지원 총액의 확대보다 기업역량을 고려한 맞춤형 지원이 필요하다.'
  ].join(' ');
  const output = [
    '기존 연구의 결과는 일관되지 않았다.',
    '이를 보완하기 위해 본 연구는 세 이론을 연계하고 기업능력을 조절변수로 설정하였다.',
    '정책적으로는 지원 총액을 일괄적으로 확대하기보다 기업역량을 반영한 맞춤형 지원이 필요하다.'
  ].join(' ');
  const audit = fingerprint.auditFingerprint(source, output, ACADEMIC);
  const families = new Set(audit.semanticRelations.shifts.map(item => item.family));
  assert.equal(families.has('neutral_link_hardened_to_remediation'), true);
  assert.equal(families.has('unsupported_scope_qualifier'), true);

  const restored = fingerprint.restoreUnsafeRelationSentences(source, output, audit);
  assert.equal(restored.applied, true);
  assert.doesNotMatch(restored.text, /보완하기 위해|일괄적으로/u);
  assert.equal(fingerprint.auditFingerprint(source, restored.text, ACADEMIC).pass, true);
});

test('v2.5.40: 원문에 이미 있는 보완 목적과 범위 한정은 관계 오류가 아니다', () => {
  const source = '이 한계를 보완하기 위해 전체 기업을 일괄적으로 지원하지 않고 단계별 기준을 적용하였다.';
  const output = '이러한 한계를 보완하고자 전체 기업을 일괄적으로 지원하는 대신 단계별 기준을 적용하였다.';
  const audit = fingerprint.auditFingerprint(source, output, ACADEMIC);
  const families = new Set(audit.semanticRelations.shifts.map(item => item.family));
  assert.equal(families.has('neutral_link_hardened_to_remediation'), false);
  assert.equal(families.has('unsupported_scope_qualifier'), false);
});

test('v2.5.40: 공통 후보 감사는 새 장문 재삽입과 통계 원자 손상을 거부한다', () => {
  const replayIntegrity = candidateIntegrity.auditCandidateIntegrity({
    source: LONG_SOURCE,
    before: LONG_SOURCE,
    candidate: LONG_REPLAY,
    documentProfile: ACADEMIC,
    mode: 'assignment'
  });
  assert.equal(replayIntegrity.reasons.includes('source_replay_worsened'), true);

  const statSource = '표본은 N=206이었고 유의확률은 p<.001이었다.';
  const statBroken = '표본은 N=206이었고 유의확률은 p<.0\n01이었다.';
  const statIntegrity = candidateIntegrity.auditCandidateIntegrity({
    source: statSource,
    before: statSource,
    candidate: statBroken,
    documentProfile: ACADEMIC,
    mode: 'assignment'
  });
  assert.equal(statIntegrity.reasons.includes('statistical_atom_worsened'), true);
});

test('v2.5.40: 후보 원장은 중복·통계 손상 후보를 1순위 위반으로 분류한다', () => {
  const assessment = candidateLedger.buildCandidateAssessment({
    structureAudit: { pass: true },
    quoteAudit: { pass: true },
    inlineCodeAudit: { pass: true, orderPass: true },
    inlineMathAudit: { pass: true, orderPass: true },
    generatedDuplicateAudit: { pass: false },
    statisticalAtomAudit: { pass: false },
    depthSnapshot: { minimumEffectPass: true },
    transformed: true
  });
  assert.equal(assessment.hardViolationCodes.includes('generated_duplicate_integrity_failed'), true);
  assert.equal(assessment.hardViolationCodes.includes('statistical_atom_integrity_failed'), true);
});

test('v2.5.40: 전달 직전 결정론 중복 제거도 짧은 단일 주장 복제를 안전하게 제거한다', () => {
  const result = applyFinalGeneratedDedupe({
    source: ABSTRACT_SOURCE,
    outputText: ABSTRACT_DUPLICATE,
    chunks: [],
    documentProfile: ACADEMIC,
    mode: 'assignment'
  });
  assert.equal(result.applied, true, JSON.stringify(result.reasonCodes));
  assert.equal(result.removedLocalOverlapCount, 1);
  assert.equal((result.text.match(/평균효과/gu) || []).length, 1);
});
