'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const q=require('../engine-gpt-prod/koreanRefinement');
const args=(source,outputText)=>({source,outputText,documentProfile:'report_assignment'});
test('new Han substitution is repaired only with a unique source word and predicate context',()=>{
 const source='관찰을 시작하고 기록을 정리했다.';
 const output='觀찰을 시작하며 기록을 정리했다.';
 assert.ok(q.analyzeKoreanRefinement(args(source,output)).issueCodes.includes('introduced_mixed_script_word'));
 const fixed=q.applySafeDeterministicRepairs(args(source,output));
 assert.equal(fixed.text,'관찰을 시작하며 기록을 정리했다.');
 assert.equal(q.applySafeDeterministicRepairs(args(source,fixed.text)).applied,false);
});
test('original multilingual text and protected quotations or code are not transliterated',()=>{
 for(const text of ['觀찰을 시작했다.','中国的观察方法。','日本語の観察方法です。','“觀찰을 시작했다.”','`觀찰을 시작했다.`']) {
  assert.equal(q.applySafeDeterministicRepairs(args(text,text)).text,text);
 }
 const source='관찰을 시작했다.';
 for(const text of ['“觀찰을 시작했다.”','`觀찰을 시작했다.`'])assert.equal(q.applySafeDeterministicRepairs(args(source,text)).text,text);
});
test('ambiguous words, absent context and multiple replaced characters are not guessed',()=>{
 const source='관찰을 시작했다. 순찰을 시작했다.';
 const output='觀찰을 시작하며 자료를 수집했다.';
 assert.equal(q.applySafeDeterministicRepairs(args(source,output)).text,output);
 for(const text of ['觀찰을 마치고 돌아왔다.','觀察을 시작했다.'])assert.equal(q.applySafeDeterministicRepairs(args('관찰을 시작했다.',text)).text,text);
});
