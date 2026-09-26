'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const structure=require('../engine-gpt-prod/structureChunk');
test('repeated formula cannot jump past the next unique locked block to prefer a clean boundary',()=>{
  const source='첫 기준을 설명한다.\n\nu = 4\n\n이 값은 첫 기준이다.\n\nv = 8\n\n두 번째 위치에서 첫 기준을 다시 확인한다.\n\nu = 4\n\n검토를 마쳤다.';
  const candidate=source.replace('u = 4\n\n이 값','u = 4 이 값');
  const chunks=structure.splitChunksForGpt(source).chunks;
  const result=structure.restoreExactLockedBlocks(candidate,chunks,source);
  assert.equal(result.missingCount,0);
  assert.equal(result.text,source);
  assert.equal(structure.restoreExactLockedBlocks(result.text,chunks,source).applied,false);
});
test('intact inline occurrence stays prose while the later standalone occurrence owns the lock',()=>{
  const source='본문에서 u = 4를 먼저 언급한다.\n\nu = 4\n\n이는 별도로 제시한 기준이다.\n\nv = 8\n\n설명을 마친다.';
  const chunks=structure.splitChunksForGpt(source).chunks;
  const result=structure.restoreExactLockedBlocks(source,chunks,source);
  assert.equal(result.missingCount,0);
  assert.equal(result.text,source);
});
