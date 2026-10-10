'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../engine-gpt-prod/sourcePreflight');
const body = '이번 조사는 지역 시설의 운영 현황을 확인하고 필요한 지원을 파악하기 위해 실시하였다. 조사 담당자는 항목별 결과를 기록하고 차이를 검토하였다.';
test('only independent trailing tool requests are removed, with diagnostics but no new notice', () => {
  for (const request of ['논문 과제를 간단하게 사람처럼 써줘요','어려운 단어를 쓰지 않고 적어줘','이 문장을 자연스럽게 다듬어 주세요']) {
    const audit = p.auditAndSanitizeSource(body+'\n\n'+request);
    assert.equal(audit.text,body);
    assert.equal(audit.submittedContentText,body);
    assert.equal(audit.engineMeta.sourceToolRequestRemovedChars,request.length);
    assert.equal(audit.engineMeta.sourceToolRequestRemovalCode,'source_trailing_tool_request_removed');
    assert.ok(!audit.warnings.some(w=>w.code==='source_trailing_tool_request_removed'));
  }
});
test('letters, assignments, quotations, code and inline or ambiguous requests stay intact', () => {
  for (const tail of ['회신 부탁드립니다.', '자신의 견해를 서술하시오.', '친구에게 편지를 써줘요',
    '“이 문장을 자연스럽게 써줘요”', '```\n이 문장을 자연스럽게 써줘요\n```',
    '예시 문장은 다음과 같다. 자연스럽게 써줘요']) {
    const source = body+'\n\n'+tail;
    assert.equal(p.stripTrailingToolRequest(source).text,source);
  }
  assert.equal(p.stripTrailingToolRequest(body+' 어려운 단어를 쓰지 않고 적어줘').text,body+' 어려운 단어를 쓰지 않고 적어줘');
});
test('two final request lines can be removed, but interior requests are preserved', () => {
  const tail = '이 글을 자연스럽게 써줘요\n어려운 단어를 쓰지 않고 적어줘';
  assert.equal(p.stripTrailingToolRequest(body+'\n\n'+tail).text,body);
  const source = body+'\n이 글을 자연스럽게 써줘요\n'+body;
  assert.equal(p.stripTrailingToolRequest(source).text,source);
});
