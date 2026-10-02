'use strict';
// Read-only, offline impact census. Never output private text or call a model.
const fs=require('node:fs');
const path=require('node:path');
const review=require('../engine-gpt-prod/adjacentDuplicateReview');
const operators=require('../engine-gpt-prod/semanticOperatorReview');
const folder=process.argv[2];
if(!folder) throw new Error('Provide the private export directory.');
const first=Number(process.argv[3]||1),last=Number(process.argv[4]||177);
const fence=String.fromCharCode(96).repeat(3);
function section(text,heading){
  const start=text.indexOf(heading);
  if(start<0)throw new Error('Missing section');
  const open=text.indexOf(fence,start);
  const end=text.indexOf(fence,open+fence.length);
  if(open<0||end<0)throw new Error('Missing fence');
  return text.slice(open+fence.length,end).trim();
}
const result={first,last,records:0,candidates:[],inheritedCandidates:[],evidenceFailures:[],integrationFailures:[],errors:[]};
for(let n=first;n<=last;n++){
  const id='H'+String(n).padStart(4,'0');
  try {
    const markdown=fs.readFileSync(path.join(folder,id+'.md'),'utf8');
    const source=section(markdown,'## 원문'),output=section(markdown,'## 휴머나이징 결과');
    const candidates=review.candidates(source,output);
    if(candidates.length){
      const targets=operators.targets(source,output).filter(t=>t.codes.includes(review.CODE));
      result.candidates.push({id,count:candidates.length,explicitReviewTargets:targets.length});
      if(targets.length!==candidates.length)result.integrationFailures.push(id);
    }
    if(candidates.some(c=>source.slice(c.sourceStart,c.sourceEnd)!==c.sourceSpan
      ||output.slice(c.outputStart,c.outputEnd)!==c.outputSpan))result.evidenceFailures.push(id);
    if(review.candidates(source,source).length)result.inheritedCandidates.push(id);
    result.records++;
  }catch(error){result.errors.push({id,type:error.name});}
}
console.log(JSON.stringify(result,null,2));
if(result.errors.length||result.integrationFailures.length||result.evidenceFailures.length||result.inheritedCandidates.length)process.exitCode=1;
