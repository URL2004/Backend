'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {restoreLockedHeadingLayout} = require('../engine-gpt-prod/structureChunk');
const chunks=[{locked:true,lockType:'bullet_prefix',text:'5. '}];
test('heading restoration cannot split a decimal or match a larger ordinal', () => {
  const source='계산값은 35.0795로 나타났다. 15. 다른 번호이다.\n\n5. 결론을 정리한다.';
  const output=source.replace('\n\n',' ');
  const r=restoreLockedHeadingLayout(source,output,chunks);
  assert.equal(r.text,source);
  assert.equal(r.missingCount,0);
  assert.equal(restoreLockedHeadingLayout(source,r.text,chunks).text,r.text);
});
test('a missing numbered heading is reported, not fabricated inside a formula', () => {
  const source='값은 35.0795이다.\n5. 마무리한다.';
  const output='값은 35.0795이다.';
  const r=restoreLockedHeadingLayout(source,output,chunks);
  assert.equal(r.text,output); assert.equal(r.missingCount,1);
});
test('ordinary numbered headings, including missing separator spaces, still restore', () => {
  const source='계산을 마쳤다.\n\n5. 결론을 정리한다.';
  const output='계산을 마쳤다. 5.결론을 정리한다.';
  assert.equal(restoreLockedHeadingLayout(source,output,chunks).text,source);
});
