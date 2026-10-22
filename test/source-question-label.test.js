const test = require('node:test'), assert = require('node:assert/strict');
const { repairInlineHeadingBoundaries } = require('../engine-gpt-prod/sourcePreflight');
test('attached question labels retain their number, and genuinely fused headings still separate', () => {
 for (const label of ['문항', '질문', '문제', '항목', 'Question', 'Q']) {
  const text = `${label}1. 성장과정\n실습 현장에서 도구 사용법을 배우고 경험을 기록했습니다.`;
  assert.equal(repairInlineHeadingBoundaries(text).text, text);
 }
 const fused = '자료의 의미를 살폈다.2. 본론자료를 비교해 분석하고 그 결과의 한계를 함께 검토하였다.';
 assert.match(repairInlineHeadingBoundaries(fused).text, /살폈다\.\n\n2\. 본론/);
});
