'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {looksGeneratedTruncated:truncated}=require('../engine-gpt-prod/generatedTruncation');
const source='참여자가 제시한 자료를 확인했다. 다음 활동을 간단히 설명하면,';
test('an unchanged source-owned unfinished final fragment permits a rewritten body',()=>{
  assert.ok(require('../engine-gpt-prod/sourcePreflight').auditAndSanitizeSource(source).issueCodes.includes('source_incomplete_sentence'));
  assert.equal(truncated(source,source.replace('제시한','내놓은')),false);
  assert.equal(truncated(source,source.replace('제시한','내놓은').replace('다음 활동을','다음  활동을')),false);
  assert.equal(truncated('활동은 이어지고','활동은 이어지고'),false);
});
test('new, shortened, or different incomplete tails remain rejected',()=>{
  for(const output of ['', '참여자의 자료를 확인했다. 설명하면,',
    '참여자의 자료를 확인했다. 다른 활동을 설명하면,',
    '참여자의 자료를 확인했다. 다음 활동을 간단히 설명하면, 그리고',
    '참여자의 자료를 확인했다. 다음 활동을']) assert.equal(truncated(source,output),true,output);
  assert.equal(truncated('활동을 마쳤다.','활동을 마쳤다,'),true);
  assert.equal(truncated('독일의 속담을 떠올렸다.','독일의 속담 중에'),true);
});
test('new complete endings and quoted source fragments are handled without guessing text',()=>{
  assert.equal(truncated(source,'자료를 확인한 뒤 다음 활동을 설명했다.'),false);
  assert.equal(truncated('그는 말했다. "다음으로,','그는 설명했다. "다음으로,'),false);
  assert.equal(truncated('그는 말했다. "다음으로,','그는 설명했다. 다음으로,'),true);
});
