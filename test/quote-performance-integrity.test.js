'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const quote=require('../engine-gpt-prod/dependentQuoteLayout');
const layout=require('../engine-gpt-prod/layoutStructure');
const profile=require('../engine-gpt-prod/documentProfile');
const korean=require('../engine/koreanText');
const {syntaxSpans}=require('../engine/textSyntax');
const fragment='관찰 내용은\n“기록”\n이라는 문장으로 작성했다.';

test('dense quotes assemble disjoint edits once and preserve literal bytes at the input limit',()=>{
 const input=(fragment+'\n').repeat(2000).slice(0,50000);
 const got=quote.dependentQuoteLayout(input);
 assert.equal(got.text.replace(/\s/gu,''),input.replace(/\s/gu,''));
 assert.ok(got.repairCount>3000);
 const literals=text=>syntaxSpans(text).filter(s=>s.spanType==='quote').map(s=>text.slice(s.start,s.end));
 assert.deepEqual(literals(got.text),literals(input));
 assert.equal(quote.dependentQuoteLayout(got.text).applied,false);
 for(let i=1;i<got.edits.length;i++)assert.ok(got.edits[i].end<=got.edits[i-1].start);
});

test('nested quotation and parenthetical ownership does not escape its containing span',()=>{
 for(const input of ['(내용은\n“기록”\n이라는 설명이다.)','「내용은\n“기록”\n이라는 설명이다.」']) {
  assert.equal(quote.dependentQuoteLayout(input).text,input);
 }
 const input='```txt\n'+fragment+'\n```\n\n'+fragment+'\n\n~~~txt\n'+fragment+'\n~~~';
 const got=quote.dependentQuoteLayout(input);
 assert.equal(got.repairCount,2);
 assert.ok(got.text.includes('```txt\n'+fragment+'\n```'));
 assert.ok(got.text.includes('~~~txt\n'+fragment+'\n~~~'));
});

test('genre and format reuse one invocation-local quote analysis',()=>{
 const original=quote.dependentQuoteLayout;let calls=0;
 quote.dependentQuoteLayout=(...args)=>{calls++;return original(...args);};
 try {
  const got=profile.detectDocumentProfile((fragment+'\n').repeat(20));
  assert.equal(calls,1);
  assert.notEqual(got.profile,'creative');
  assert.equal(got.formatProfile.flags.includes('line_sensitive'),false);
  assert.equal(Object.hasOwn(got,'quoteAnalysis'),false);
 } finally {quote.dependentQuoteLayout=original;}
});

test('supplied analysis cannot leak source ownership into another document',()=>{
 const analysis={source:fragment,layout:quote.dependentQuoteLayout(fragment)};
 assert.deepEqual(layout.buildLineRecords(fragment,{quoteAnalysis:analysis}),layout.buildLineRecords(fragment));
 const unrelated='제1조 (목적)\n계약의 목적을 정한다.\n\n“독립 인용이다.”\n별도의 설명이다.';
 assert.deepEqual(layout.buildLineRecords(unrelated,{quoteAnalysis:analysis}),layout.buildLineRecords(unrelated));
});

test('indexed punctuation ownership preserves initials, decimals, nested quotes and CRLF spans',()=>{
 const fixtures=[
  '앞 문장이다. “A. B.의 값은 3.14이다.”라는 말이다. 뒤 문장이다.',
  '처음이다. (A. B.는 “같은가?”라고 물었다.) 다음이다.',
  '첫 문장입니다 다음 문장입니다 마지막 문장입니다.',
  '“첫 줄\r\n둘째 줄”이라는 말이다. 마지막이다.',
  '```txt\nA. B. 3.14\n```\n\n본문이다.',
  "인물은 O'Neil이다. 'A. B.'라는 이름이다.",
 ];
 for(const text of fixtures){
  const spans=korean.splitSentenceSpans(text);
  assert.deepEqual(spans.map(s=>s.text),korean.splitSentences(text));
  for(const span of spans)assert.equal(text.slice(span.start,span.end),span.text);
 }
 assert.equal(korean.splitSentences(fixtures[0]).length,3);
 assert.equal(korean.splitSentences(fixtures[2]).length,3);
});
