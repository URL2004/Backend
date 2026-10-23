'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { bindSemanticValidation } = require('../engine-gpt-prod/semanticProvenance');
const { confirmedOmissions } = require('../engine-gpt-prod/confirmedDeliveryIntegrity');
const { reinstateDroppedSentences } = require('../engine-gpt-prod/finalRelationRepair');
const claim = '지역 상담은 주민이 일상에서 겪는 어려움을 예방하고 스스로 문제를 해결하도록 체계적으로 지원하는 활동이다.';
const citation = '(가상저자, 2004).';
const body = '이 목적을 실현하기 위해 지역 센터는 상담실과 협력 기관을 운영하고 전문 인력을 배치하고 있다. 상담실은 지역에 따라 차이가 있으며 해당 자료는 해마다 새로 집계한다. 정기적으로 참여자의 의견을 받고 운영 결과를 날짜별로 기록하여 별도의 보고서를 작성하고 있다.';
const source = '1. 서론\n' + claim + citation + ' ' + body;
const output = '1. 서론\n\n' + citation + ' ' + body;
function verdict(candidate = output) {
  const context = citation + ' ' + body.split('. ')[0] + '.';
  const v = groundViolation({ type: 'omission', origin: 'introduced', relation: 'other',
    sourceSpan: claim, candidateSpan: context, span: claim }, source, candidate);
  return bindSemanticValidation({ ran: true, pass: false, verificationCompleted: true, violations: [v] }, source, candidate);
}
test('definition missing between an intact heading and citation is restored once and cannot be charged as review', () => {
  const report = verdict();
  assert.equal(confirmedOmissions(source, output, report).length, 1);
  const repair = reinstateDroppedSentences(source, output, report);
  assert.equal(repair.restoredCount, 1); assert.equal(repair.text, output.replace(citation, claim + citation));
  assert.equal(reinstateDroppedSentences(source, repair.text, report).applied, false);
});
test('moved claim, ambiguous citation, changed neighbour and unconfirmed findings are not deletion proof', () => {
  for (const value of [output + ' ' + claim, output + citation, output.replace('센터는 상담실', '센터는 새 시설')]) {
    assert.equal(confirmedOmissions(source, value, verdict(value)).length, 0);
  }
  const report = verdict(); report.violations[0].origin = 'unconfirmed';
  assert.equal(reinstateDroppedSentences(source, output, report).applied, false);
});

test('preflight inserting a space before the citation cannot hide the same dropped definition', () => {
  const normalized = source.replace(claim + citation, claim + ' ' + citation);
  const original = verdict();
  const report = bindSemanticValidation({ ...original, violations: original.violations.map(v => groundViolation(v, normalized, output)) }, normalized, output);
  assert.equal(confirmedOmissions(normalized, output, report).length, 1);
  assert.equal(reinstateDroppedSentences(normalized, output, report).text, output.replace(citation, claim + ' ' + citation));
});
