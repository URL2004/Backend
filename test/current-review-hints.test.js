'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {currentReviewHints:filter}=require('../engine-gpt-prod/currentReviewHints');
test('fresh review drops stale quotations without changing source, verdict or control flags',()=>{
 const source='관측을 수행하기 위한 과정이다.',before='관측을 수행하는 과정이다.',after='관측을 수행하기 위한 단계이다.';
 const old=JSON.stringify({code:'purpose_action_candidate',sourceSpan:source,outputSpan:before});
 const fresh=JSON.stringify({code:'other',sourceSpan:source,outputSpan:after});
 const signals=['final_semantic_revalidation',old,fresh,JSON.stringify({code:'prior_semantic_findings',findings:[{sourceSpan:source,candidateSpan:before},{sourceSpan:source,candidateSpan:after}]})];
 const snapshot=JSON.stringify(signals),result=filter(signals,source,after);
 assert.equal(result.length,3);assert.equal(result[0],signals[0]);assert.equal(result[1],fresh);
 assert.equal(JSON.parse(result[2]).findings.length,1);assert.equal(JSON.stringify(signals),snapshot);
 assert.equal(filter([fresh],source,after+after).length,0);
});
