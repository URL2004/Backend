'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {relationDigest,preparationRelationDigest}=require('../engine-gpt-prod/layoutRelations');
const {analyzeKoreanRefinement}=require('../engine-gpt-prod/koreanRefinement');
const {auditCandidateIntegrity}=require('../engine-gpt-prod/candidateIntegrity');

test('preparation offsets tolerate prose spacing without weakening verdict-reuse hashes',()=>{
  const source='## 관찰\n결과를 다시확인했다. 다음 단계도 기록했다.\n## 결론\n추가 검증이 필요하다.';
  const formatted=source.replace('다시확인','다시 확인').replace(' 다음 단계','\n\n다음 단계');
  assert.equal(preparationRelationDigest(source),preparationRelationDigest(formatted));
  assert.notEqual(relationDigest(source),relationDigest(formatted));
});

test('preparation still rejects heading, table, code, enumeration and detached-lead changes',()=>{
  const examples=[
    ['## 관찰\n본문을 기록했다.','## 관찰 본문을 기록했다.'],
    ['| 항목 | 근거 |\n| 분석 | 관찰 |','| 항목 | 근거 | | 분석 | 관찰 |'],
    ['1. 첫 항목이다.\n2. 둘째 항목이다.','1. 첫 항목이다. 2. 둘째 항목이다.'],
    ['```\nx = 1\n```','```\nx  = 1\n```'],
    ['안내문의 첫 부분에서는\n이용 순서를 설명한다.','안내문의 첫 부분에서는\n\n이용 순서를 설명한다.'],
    ['실험군은 관찰을 했다.\n\n대조군은 대기했다.','실험군은 관찰을 했다. 대조군은 대기했다.']
  ];
  for(const [source,broken] of examples)assert.notEqual(preparationRelationDigest(source),preparationRelationDigest(broken),source);
});

const first='이런 경험이 글쓰기 연습에 도움이 되었다.';
const second='이런 변화가 수업을 준비하는 방식에도 영향을 주었다.';
const source=`동아리에서 글을 함께 썼다. ${first} 다음 모임에는 자료를 가져왔다. ${second} 기록은 노트에 남겼다.`;
const out=`동아리에서 글을 함께 썼다.\n\n${first} 다음 모임에는 자료를 가져왔다.\n\n${second} 기록은 노트에 남겼다.`;
const audit=text=>analyzeKoreanRefinement({source,outputText:text});
const notice=r=>r.issues.find(i=>i.code==='repeated_vague_demonstrative');

test('source-owned full sentences exposed by paragraph splits are not new vague wording',()=>{
  const r=audit(out);
  assert.equal(notice(r).afterCount,2);
  assert.equal(notice(r).introducedCount,0);
  assert.equal(r.residualWarnings.some(x=>x.code==='repeated_vague_demonstrative'),false);
  const integrity=auditCandidateIntegrity({source,before:source,candidate:out});
  assert.equal(integrity.reasons.includes('korean_integrity_worsened'),false);
});

test('new wording and duplicated source sentences do not inherit the source exemption',()=>{
  assert.equal(notice(audit(out.replace(first,'이런 경험이 글쓰기 연습에 큰 도움이 되었다.'))).introducedCount,1);
  assert.equal(notice(audit(out+'\n\n'+first)).introducedCount,1);
  const changed=out.replace(first,'이런 경험이 토론에 영향을 주었다.').replace(second,'이런 변화가 발표 시간을 단축했다.');
  assert.equal(notice(audit(changed)).introducedCount,2);
  assert.equal(auditCandidateIntegrity({source,before:source,candidate:changed}).reasons.includes('korean_integrity_worsened'),true);
});
