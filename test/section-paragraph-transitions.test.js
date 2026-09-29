'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restoreSourceParagraphTransitions:restore}=require('../engine-gpt-prod/sourceParagraphTransitions');
const {splitSentenceSpans}=require('../engine/koreanText');
const {restoreSourceParagraphTransitionsSteps:steps}=require('../engine-gpt-prod/sourceParagraphTransitions');
const {runLayout}=require('../engine-gpt-prod/paragraphAlignment');
const one=Array.from({length:8},(_,i)=>`연구자는 열 전달에 관한 ${i+1}차 관측 자료를 검토하고 해당 조건에서 측정한 값을 자세하게 설명하였다.`).join(' ');
const two=Array.from({length:8},(_,i)=>`담당자는 빛의 반사에 관한 ${i+1}차 실험 결과를 분석하고 별도 장치에서 확인한 현상을 구체적으로 논의하였다.`).join(' ');
const build=(separator,count=12)=>Array.from({length:count},(_,i)=>`${i+1}. 실험 조건 ${i+1}\n${one}${separator}${two}`).join('\n\n');
test('long sectioned input recovers complete single-newline units without lifting per-window limits',()=>{
  const source=build('\n'),output=build(' ');
  assert.ok(splitSentenceSpans(output).length>180);
  const r=restore(source,output);
  assert.equal(r.repairedCount,12);
  assert.equal(r.text.replace(/\s/gu,''),output.replace(/\s/gu,''));
  assert.equal(restore(source,r.text).repairedCount,0);
});
test('duplicate or mismatched heading windows are not assigned arbitrary ownership',()=>{
  const source=build('\n').replace('2. 실험 조건 2','1. 실험 조건 1');
  const output=build(' ').replace('2. 실험 조건 2','1. 실험 조건 1');
  assert.equal(restore(source,output).repairedCount,10);
  const mismatch=build(' ').replace(/실험 조건/gu,'다른 조건');
  assert.equal(restore(build('\n'),mismatch).repairedCount,0);
});
test('short physical wraps, quote blocks and existing blank boundaries remain unchanged',()=>{
  const heading='1. 분석 기준\n',tail='\n\n2. 결과 해석\n짧은 요약이다.';
  const wrapped=heading+'연구자는 열 전달을\n검토하고 있다.'+tail;
  assert.equal(restore(wrapped,wrapped.replace('을\n','을 ')).repairedCount,0);
  const source=heading+'“'+one+'\n'+two+'”'+tail;
  assert.equal(restore(source,source.replace(one+'\n',one+' ')).repairedCount,0);
  assert.equal(restore(build('\n\n'),build('\n\n')).repairedCount,0);
});
test('section alignment yields between bounded scans and honours cancellation',async()=>{
  const source=build('\n'),output=build(' '),controller=new AbortController();
  const pending=runLayout(function*(){return yield* steps(source,output);},{signal:controller.signal});
  setImmediate(()=>controller.abort());
  await assert.rejects(pending,{name:'AbortError'});
  const result=await runLayout(function*(){return yield* steps(source,output);});
  assert.equal(result.text,restore(source,output).text);
});
