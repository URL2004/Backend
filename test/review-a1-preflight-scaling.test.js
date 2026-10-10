'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../engine-gpt-prod/sourcePreflight');
test('boundary-only removal still uses the first and last two content rows', () => {
  const body = '담당자는 실험에 필요한 자료를 검토하고 관찰 결과를 차례로 기록하였다.';
  const request = '이 글을 자연스럽게 써 주세요';
  const source = [body,body,request,...Array(1000).fill(body),request].join('\n');
  const result = p.auditAndSanitizeSource(source);
  assert.equal(result.text.split(request).length-1,1);
  assert.ok(result.text.includes(body+'\n'+request+'\n'+body));
});
