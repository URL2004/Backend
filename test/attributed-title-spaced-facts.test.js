'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const layout=require('../engine-gpt-prod/layoutStructure');
const chunks=require('../engine-gpt-prod/structureChunk');
const floor=require('../engine/floor');
const body='주말이면 동네 도서관에 들러 과학책을 읽는다. 친구들과 읽은 내용을 정리한다.';

test('explicit bracketed cover attribution protects an imperative title through chunking and layout',()=>{
  for(const title of ['<204200-123456 홍가람> _ 동네 도서관에 가자!', '[204200 홍가람] — 책에서 만난 세계']){
    const source=title+'\n'+body;
    assert.equal(layout.buildLineRecords(source)[0].role,'title');
    assert.ok(chunks.splitChunksForGpt(source,{coalesceEditable:true}).chunks.some(c=>c.locked&&c.text.includes(title)));
    const rows=layout.buildLineRecords(title+' '+body);
    assert.notEqual(rows[0].role,'title','a fused body must not be protected wholesale');
  }
});

test('names, body citations and plain imperatives are not cover evidence',()=>{
  for(const source of ['도서관에 가자!\n'+body, '<홍가람> _ 도서관에 가자!\n'+body,
    body+'\n<204200 홍가람> _ 도서관에 가자!\n'+body]){
    assert.equal(layout.buildLineRecords(source).some(r=>r.role==='title'),false);
  }
});

test('same organization characters across PDF spacing are not a newly invented fact',()=>{
  const result='마을교육지원센터를 방문한다.';
  for(const source of ['마을교육지 원센터를 방문한다.','마을교육지\n원센터를 방문한다.','마을 교육 지원 센터를 방문한다.'])
    assert.equal(floor.measureNovelty(source,result).count,0);
  assert.equal(floor.measureNovelty('관련 기관을 방문한다.',result,'마을교육지 원센터').count,0);
});

test('organization matching cannot cross paragraphs, punctuation or different entity prefixes',()=>{
  const result='마을교육지원센터를 방문한다.';
  for(const source of ['마을교육지\n\n원센터를 방문한다.','마을교육지, 원센터를 방문한다.',
    '새마을교육지원센터를 방문한다.','마을교육지\n원\n센터를 방문한다.','다른교육지원센터를 방문한다.'])
    assert.ok(floor.measureNovelty(source,result).count>0,source);
  assert.ok(floor.measureNovelty('지원금은 25만원이다.','지원금은 35만원이다.').count>0);
});
