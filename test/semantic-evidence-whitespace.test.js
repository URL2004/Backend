'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { locateEvidenceSpan } = require('../engine-gpt-prod/evidenceSpan');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { buildRelationPatchTargets } = require('../engine-gpt-prod/relationPatch');

test('evidence with flattened paragraph whitespace maps back to exact original offsets and bytes', () => {
  const source = '측정 단위의 정의가 중간에 제시되어 있었다.';
  const left = '앞선 계산은 일단 마무리했다.', right = '다음 단계에서 조건을 검토했다.';
  const target = left + '\r\n\r\n' + right;
  const output = '서론은 변경하지 않는다.\n' + target + '\n마지막 결론과 참고문헌은 그대로 남긴다.';
  const finding = groundViolation({ type:'omission',span:source,sourceSpan:source,
    candidateSpan:left+' '+right,relation:'variable_definition',origin:'introduced' },source,output);
  assert.equal(finding.repairable,true);
  assert.equal(finding.candidateSpan,target);
  assert.equal(output.slice(finding.candidateRange.start,finding.candidateRange.end),target);
  const targets=buildRelationPatchTargets(output,[finding]);
  assert.equal(targets.length,1);
  assert.equal(targets[0].text,target);
});

test('whitespace evidence matching never joins words, drops content or resolves duplicates by guessing', () => {
  assert.equal(locateEvidenceSpan('아버지가 방에 들어갔다.','아버지 가방에 들어갔다.'),null);
  assert.equal(locateEvidenceSpan('첫 설명이다. 중간 사실이다. 마지막 설명이다.','첫 설명이다. 마지막 설명이다.'),null);
  assert.equal(locateEvidenceSpan('조건 A는 거절했다.','조건 A는 수락했다.'),null);
  assert.equal(locateEvidenceSpan('앞 문장이다.\n뒤 문장이다. / 앞 문장이다.\t뒤 문장이다.','앞 문장이다.  뒤 문장이다.'),null);
  const raw='🙂 앞 문장이다.\n\n뒤 문장이다.';
  const range=locateEvidenceSpan(raw,'앞 문장이다. 뒤 문장이다.');
  assert.equal(raw.slice(range.start,range.end),'앞 문장이다.\n\n뒤 문장이다.');
});
