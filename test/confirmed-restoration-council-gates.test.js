'use strict';
const assert=require('node:assert/strict'),path=require('path');
const repo=path.resolve(__dirname,'..');
const {restoreConfirmedRelations}=require(path.join(repo,'engine-gpt-prod/confirmedRelationRestore'));
const pairs=[
 ['기계의 온도는 작업이 끝나면 내려갈 수 있다.','기계의 온도는 작업이 끝나면 내려간다.'],
 ['새로운 재료는 오래 보관하면 색이 바뀔 가능성이 있다.','새로운 재료는 오래 보관하면 색이 바뀐다.'],
 ['조명 장치를 교체하면 화면이 밝아질 수도 있다.','조명 장치를 교체하면 화면이 밝아진다.']
];
const filler=['정원에서는 봄에 피어난 꽃들을 관찰하고 잎의 형태를 사진으로 기록했다.','학교 도서관에서는 새로운 소설과 역사서를 분류하고 서가의 번호를 점검했다.','우주 탐사 연구원들은 탐사선에 설치된 망원경으로 먼 은하의 형태를 살펴보았다.','해양 관측팀은 배를 타고 먼바다로 나가 다양한 해저 지형과 조류를 조사했다.'];
const text=side=>pairs.map((p,i)=>filler[i]+' '+p[side]).join(' ')+' '+filler[3]+' '+filler.join(' ');
const findings=pairs.map(([a,b])=>({type:'distortion',origin:'introduced',relation:'modality_negation_causality',sourceSpan:a,candidateSpan:b,span:b,spanVerified:true,relationGrounded:true,repairable:true,grounding:'unique_exact_span'}));
const report={pass:false,uncertain:false,verificationCompleted:true,violations:findings};
require('node:test')('multiple confirmed splices and post-repair digest binding remain exact',()=>{
const r=restoreConfirmedRelations(text(0),text(1),report);
assert.equal(r.restoredCount,3);assert.equal(r.text,text(0));assert.equal(r.pass,undefined);
const {bindSemanticValidation,verifySemanticValidation}=require(path.join(repo,'engine-gpt-prod/semanticProvenance'));
const verdict=bindSemanticValidation({ran:true,pass:true,verificationCompleted:true},text(0),text(1));
assert.equal(verifySemanticValidation(verdict,{source:text(0),candidate:r.text,requireDigest:true}).status,'stale');
for(const marker of ['앞부분 😀 🧪 ', '라벨 e\u0301 ', '한글 '.normalize('NFD')]){
 const x=restoreConfirmedRelations(marker+text(0),marker+text(1),report);
 assert.equal(x.text,marker+text(0));assert.equal(x.restoredCount,3);
}
});
