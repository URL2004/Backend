'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {exactLinewrappedOutput:match}=require('../lib/historyLinewrap');
const source=Array.from({length:14},(_,i)=>`실험 자료를 정리하는 연구자는 관찰 기록을 검토합니다. 항목 ${i+1}번은 별도 보관함에 넣었습니다.`).join('\n\n');
const wrapped=source.replaceAll('검토합니다','검토합\n니다').replaceAll('연구자는','연구\n자는').replace('관찰','관\n\n찰');
test('full text with repeated internal PDF wraps is a distinct exact proof',()=>{
 assert.equal(match(wrapped,source),true);
 assert.equal(match(wrapped.replaceAll('\n','\r\n'),source),true);
 assert.equal(match(source,source),false,'normal exact route remains separate');
});
test('word-space changes, numerals, edits, excerpts and isolated breaks cannot claim PDF equality',()=>{
 for(const text of [wrapped.replace('연구\n자는','연구 자는'),wrapped.replace('자료를 정리','자료를정리'),wrapped.replace('자료를','기록을'),wrapped.slice(60),source.replace('연구자는','연구\n자는'),wrapped.replace('14번','1\n4번'),wrapped.replace('관\n\n찰','관\n\n\n찰')]){
  assert.equal(match(text,source),false);
 }
});
