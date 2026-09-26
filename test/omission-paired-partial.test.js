'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { restoreConfirmedSemanticOmissions: restore } = require('../engine-gpt-prod/omissionRestore');
const { groundViolation } = require('../engine-gpt-prod/judge');
const A = '행사를 준비하며 각 담당자의 역할을 확인했습니다.';
const B = '제가 행사에서 담당했던 업무라고는 안내대에서 방문자에게 안내장을 나눠 준 적이 있고, 좌석을 물어본 분을 도와드린 경험이 있습니다.';
const P = '저는 행사 안내대에서 안내장을 배부하고 좌석 문의를 한 방문객에게 위치를 알려드렸습니다.';
const Z = '다음 행사에도 적극적으로 참여하겠습니다.';
const source = [A, B, Z].join('\n\n'), output = [A, P, Z].join('\n\n');
const rawFinding = { type: 'omission', span: '담당했던 업무라고는', sourceSpan: B, candidateSpan: P,
  detail: '담당한 업무가 열거된 두 활동에 한정된다는 한정이 사라졌습니다.',
  relation: 'modality_negation_causality', origin: 'introduced' };

test('real grounding contract reserves a surviving partial rewrite from whole-sentence insertion', () => {
  const finding = groundViolation(rawFinding, source, output);
  assert.equal(finding.relationGrounded, true);
  assert.equal(finding.repairable, true);
  const result = restore({ source, outputText: output, semanticReport: { pass: false, uncertain: false, violations: [finding] } });
  assert.equal(result.applied, false);
  assert.equal(result.text, output);
  assert.deepEqual(result.remainingViolations, [finding]);
});

test('paired partial finding alone cannot activate unrelated dangling-prefix recovery', () => {
  const extra = '후속 행사에서는 충분한 안내를 제공하며 이동이 어려운 방문객을 돕겠습니다.';
  const s = [A, B, extra, Z].join('\n\n');
  const o = [A, P, '후속 행사에서는 충분한 안내를 제공하며', Z].join('\n\n');
  const finding = groundViolation(rawFinding, s, o);
  assert.equal(finding.repairable, true);
  const result = restore({ source: s, outputText: o, semanticReport: { pass: false, uncertain: false, violations: [finding] } });
  assert.equal(result.text, o);
  assert.deepEqual(result.remainingViolations, [finding]);
});

test('genuine whole-sentence omission keeps established restoration behavior', () => {
  const s = [A, B, Z].join('\n\n'), o = [A, Z].join('\n\n');
  const finding = groundViolation({ ...rawFinding, span: B, sourceSpan: B, candidateSpan: A + '\n\n' + Z }, s, o);
  assert.equal(finding.repairable, true);
  const result = restore({ source: s, outputText: o, semanticReport: { pass: false, uncertain: false, violations: [finding] } });
  assert.equal(result.applied, true);
  assert.equal(result.text.replace(/\s+/gu, ' '), s.replace(/\s+/gu, ' '));
  assert.equal(result.text.split(B).length, 2);
});

test('partial findings in a rewritten final paragraph do not fall through to paragraph append', () => {
  const C = '앞으로도 행사 준비 과정에서 필요한 업무를 먼저 찾아 맡으며 방문객이 편리하게 이용하도록 돕고자 합니다.';
  const Q = '이후에는 행사장을 찾는 분들의 불편을 살피고 운영 업무에 자발적으로 참여하겠습니다.';
  const s = A + '\n\n' + B + ' ' + C;
  const o = A + '\n\n' + P + ' ' + Q;
  const finding = groundViolation(rawFinding, s, o);
  assert.equal(finding.repairable, true);
  const result = restore({ source: s, outputText: o, semanticReport: { pass: false, uncertain: false, violations: [finding] } });
  assert.equal(result.text, o);
  assert.deepEqual(result.remainingViolations, [finding]);
});

test('CRLF and astral characters preserve grounded ownership without guessed offsets', () => {
  const s = '🙂 ' + source.replace(/\n/g, '\r\n'), o = '🙂 ' + output.replace(/\n/g, '\r\n');
  const finding = groundViolation(rawFinding, s, o);
  assert.equal(finding.repairable, true);
  const result = restore({ source: s, outputText: o, semanticReport: { pass: false, uncertain: false, violations: [finding] } });
  assert.equal(result.text, o);
  assert.deepEqual(result.remainingViolations, [finding]);
});
