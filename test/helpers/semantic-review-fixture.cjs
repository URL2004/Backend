'use strict';
// Test-only explicit simulated adjudication. Never used by production or paid
// runners. Callers already supply the synthetic verdict; this fills its new
// response contract. Missing-review behavior has dedicated negative tests.
const {extractPromptDataSection}=require('../../engine-gpt-prod/promptEnvelope');
module.exports=(json,prompt)=>{
 if(!json || !Array.isArray(json.violations))return json;
 const data=extractPromptDataSection(prompt,'PRIOR_FINDING_OBLIGATIONS');
 let obligations=[];try{if(data)obligations=JSON.parse(data);}catch{return json;}
 let operators=[];try{operators=JSON.parse(extractPromptDataSection(prompt,'OPERATOR_REVIEW_TARGETS')||'[]');}catch{return json;}
 const candidate=extractPromptDataSection(prompt,'REWRITE');
 return {...json,...(operators.length?{operatorReviews:operators.map(o=>({id:o.id,sourceSpan:o.sourceSpan,candidateSpan:o.candidateSpan,status:json.violations.length?'uncertain':'preserved',
  detail:'Synthetic fixture explicitly adjudicates this paired operator.'}))}:{}),...(obligations.length?{obligationReviews:obligations.map(o=>({id:o.id,sourceSpan:o.sourceSpan,candidateSpan:candidate,
  status:json.violations.length?'unresolved':candidate.includes(o.previousCandidateSpan)?'not_error':'resolved',
  detail:json.violations.length?'Synthetic fixture explicitly retains this issue.':'Synthetic fixture explicitly verifies the given correction or dismissal.'}))}:{})};
};
