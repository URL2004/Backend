'use strict';
// Synthetic examples, not production user text. Page references refer to the
// user-provided Korean paragraph/sentence/spacing report dated 2026-09-18.
// Editorial targets are product acceptance examples, NOT orthographic laws.
const assert = require('node:assert/strict');
const text = require('../../engine/koreanText');
const korean = require('../../engine-gpt-prod/koreanRefinement');
const structure = require('../../engine-gpt-prod/structureChunk');
const pre = require('../../engine-gpt-prod/sourcePreflight');
const profile = { profile: 'report_assignment', confidence: .95 };
const compact = s => s.replace(/\s/gu, '');
const cases = [];
function add(id, category, pages, label, input, verify, extra = {}) {
  cases.push({ id, category, pages, label, input, verify, ...extra });
}
function finalLayout(source, outputText = source, documentProfile = profile, mode = 'blog') {
  const chunks = structure.splitChunksForGpt(source, { coalesceEditable: true }).chunks;
  return structure.restoreFinalDocumentLayout({ source, outputText, chunks, mode,
    requestStrength: mode === 'assignment' ? 'advanced' : 'basic', documentProfile,
    normalizeVisualGaps: true });
}
const sentenceExamples = [
  ['날짜', '2026. 9. 18. 회의를 열었다. 이후 기록을 남겼다.', 2],
  ['소수', '측정값은 3.14이다. 결과를 기록했다.', 2],
  ['버전', '버전 2.1.0을 설치했다. 재시작했다.', 2],
  ['불확실성 괄호', '작성 연도는 1920년(?)이다. 추가 확인이 필요하다.', 2],
  ['불확실성 범위', '작가의 생몰년은 1900~?이다. 자료가 부족하다.', 2],
  ['영문 이니셜', 'A. B. Kim의 연구를 읽었다. 내용을 정리했다.', 2],
  ['중첩 인용', '그는 “담당자가 ‘끝났나요?’라고 물었다.”라고 말했다. 답변을 기다렸다.', 2],
  ['인용 내부 여러 문장', '그는 “끝났나요? 확인해 주세요.”라고 말했다. 대답을 기다렸다.', 2],
  ['인용 뒤 띄어진 귀속 표현', '그는 “끝났나요?” 라고 물었다. 대답을 기다렸다.', 2],
  ['인용 안 줄바꿈', '그는 “자료를\n확인했습니다.”라고 말했다. 기록을 남겼다.', 2],
  ['인용 안 빈 줄', '그는 “자료를 확인했다.\n\n결과를 기록했다.”라고 말했다. 답변을 기다렸다.', 2],
  ['괄호 내부 마침표', '자료(확인 완료. 오류 없음.)를 제출했다. 답변을 기다렸다.', 2],
  ['줄임표', '정말……. 믿기 어렵다.', 2],
  ['선택 질문', '오늘 할까요, 내일 할까요? 내일 하겠습니다.', 2],
  ['종결 다 글자', '나는 그가 온다고 생각했다. 그러나 오지 않았다.', 2],
  ['대화 종결', '자료가 있는데요. 확인해 주세요.', 2],
  ['인라인 코드', '코드는 `a.b(); c.d()`이다. 실행했다.', 2],
  ['URL', 'https://example.org/a.b?q=1.2 에서 자료를 확인했다. 기록했다.', 2],
  ['메일', 'user.name@example.org로 문의했다. 답변을 기다렸다.', 2],
  ['CRLF PDF 행갈이', '기업의 책임 의식을\r\n변화시킬 수 있다는 사실은 중요하다. 논의를 계속했다.', 2],
  ['단문 대화 행', '네.\n아니요.\n알겠습니다.', 3],
  ['시각 비율', '15:30에 1:2 비율로 섞었다. 확인했다.', 2],
  ['번호 제목', '1. 연구 목적', 1]
];
sentenceExamples.forEach(([label,input,count],i)=>add(`S${i+1}`, 'sentence', '8,12–15,22', label,input,()=>{
  const spans=text.splitSentenceSpans(input);
  assert.equal(spans.length,count,'바깥 서술문 층위의 문장 수');
  for(const s of spans)assert.equal(input.slice(s.start,s.end),s.text,'원문 offset 보존');
  assert.equal(compact(spans.map(s=>s.text).join(' ')),compact(input),'내용 누락·중복 없음');
  return {count:spans.length};
}));

const acceptedSpellings = [
  '책을 읽어 보다.', '책을 읽어보다.', '그 일은 할 만하다.', '그 일은 할만하다.',
  '세 권을 읽었다.', '12 명이 참여했다.', '12명이 참여했다.',
  '기록해 두었다.', '기억해 둘 만하다.', '읽어볼 만하다.', '읽어도 보았다.',
  '그를 도와주었다.', '그를 예뻐한다.', '글씨가 지워진다.', '먹고 싶어 한다.',
  '한번 확인해 보자.', '한 번 더 확인했다.', '한번 더 확인했다.',
  '일이 잘 안된다.', '들어가면 안 된다.', '그 사정이 참 안됐다.',
  '수정하는 데 시간이 든다.', '수정했는데 오류가 남았다.',
  '삼 년 만에 만났다.', '너만 남았다.', '필요한 만큼 가져왔다.', '예상만큼 늘었다.',
  '입사한 지 두 달이 지났다.', '어디에 있는지 모른다.',
  '부서 간 협의를 이틀간 진행했다.', '내가 할 게 있다.', '내가 할게.',
  '상대성 이론을 배웠다.', '상대성이론을 배웠다.', '김하늘 님과 교수님이 만났다.'
];
acceptedSpellings.forEach((input,i)=>add(`A${i+1}`,'allowed-spacing','5–11,22',input,input,()=>{
  const out=korean.applySafeFormattingRepairs({source:input,outputText:input,documentProfile:profile});
  assert.equal(out.text,input,'정상·허용형 또는 문맥 의존 표기 유지');
  return {text:out.text};
}));
[
 ['닫는 법률명 조사','「청소년기본법」 에서는 권리를 규정한다.','「청소년기본법」에서는 권리를 규정한다.'],
 ['인용 뒤 조사','“보류” 라고 답했다.','“보류”라고 답했다.'],
 ['의존 명사 수','진행할 수있다.','진행할 수 있다.'],
 ['월 말','9월말까지 제출한다.','9월 말까지 제출한다.'],
 ['보조 용언 제한','기억해둘 만하다.','기억해 둘 만하다.']
].forEach(([label,input,expected],i)=>add(`C${i+1}`,'correction','6,8,9,22',label,input,()=>{
 const out=korean.applySafeFormattingRepairs({source:input,outputText:input,documentProfile:profile});
 assert.equal(out.text,expected,'확정 가능한 표기 교정 목표');return {text:out.text};
}));

const body='기업의 책임 의식을 변화시킬 수 있다는 사실은 중요하다. 구체적인 실천 방법을 함께 검토해야 한다.';
[
 ['명사구 뒤 강제 행갈이',body.replace('의식을 ','의식을\n')],
 ['명사구 뒤 강제 빈 줄',body.replace('의식을 ','의식을\n\n')],
 ['CRLF 행갈이',body.replace('의식을 ','의식을\r\n')],
 ['부정 범위','모든 항목이 틀린 것은\n아니다. 결과를 다시 확인해야 한다.'],
 ['조건절','수정안이 승인되면\n다음 주부터 시행할 예정이다. 담당자에게 확인을 요청했다.'],
 ['후치 수식어','참가자의 학습을 돕기 위해서는 지도자의 지속적인\n피드백이 필요하다. 개선 방향을 구체적으로 안내해야 한다.']
].forEach(([label,input],i)=>add(`W${i+1}`,'wrap','4,15,18,22',label,input,()=>{
 const out=pre.repairSourceLayoutArtifacts(input).text;
 assert.equal(out,input.replace(/\r?\n+/gu,' '),'강제 줄바꿈을 산문 문장 내부에서만 복원');
 assert.equal(pre.repairSourceLayoutArtifacts(out).text,out,'멱등성');return {text:out};
}));

const scenes={
 response:'참가자는 자신이 세운 계획에 따라 학습 과제를 꾸준히 수행하면서 목표를 이루려고 노력했다. 하지만 반복된 실패가 쌓이면서 자신감을 잃었고 과제 참여를 중단하려는 모습을 보였다. 이때 지도자는 참가자에게 적절한 난이도의 과제를 제시하고 실천 방법을 구체적으로 설명해야 한다. 단계별 연습 기회를 제공하고 필요한 도움을 받을 수 있도록 지속해서 지원해야 한다. 이러한 지도는 참가자가 작은 성공 경험을 쌓으며 자신감을 회복하는 데 도움이 될 수 있다. 이후에도 참여를 유지하면서 스스로 학습 방법을 점검할 수 있다는 점에서 의미가 있다.',
 findings:'운영팀은 지난달 접수된 문의 30건을 검토했다. 이 중 12건은 같은 오류와 관련돼 있었다. 원인을 확인하는 데 이틀이 걸렸지만 같은 오류가 다시 발생할 수 있다. 그래서 안내문을 수정해 두기로 했다. 다만 수정안이 승인되면 다음 주부터 적용할 예정이다. 담당자는 “추가 확인이 필요합니다.”라고 말했다.',
 noConnector:'연구팀은 지역 하천에서 발견된 오염 물질의 종류와 유입 경로를 조사하고 지점별 농도를 기록했다. 공장 주변의 측정 지점에서는 다른 지점보다 높은 농도가 반복적으로 확인되어 추가 조사가 필요했다. 개선 대책은 사업장 배출 시설의 정기 점검과 배출 기록 공개를 중심으로 마련했다. 주민에게 측정 자료를 제공하고 정화 시설의 운영 결과를 정기적으로 검토하여 관리의 투명성을 높일 계획이다.',
 contrast:'도시 도서관은 이용자가 많아 다양한 자료를 갖추고 야간에도 열람 공간을 운영한다. 전문 사서가 상주하여 자료 검색과 독서 모임을 지원하지만 공간 부족으로 예약이 필요할 때도 있다. 반면 농촌 도서관은 주민 수가 적어 장서와 운영 인력이 제한되며 접근성에서도 차이가 난다. 이동 도서관과 학교 연계 프로그램을 운영하여 부족한 자료와 인력을 보완하는 방법을 사용한다.',
 time:'실습 첫 주에는 현장 조직과 안전관리 절차를 익히는 데 시간을 보냈다. 작업 시작 전에 담당자를 따라 시설을 확인하며 장비의 명칭과 사용 방법을 기록했다. 한 달 뒤에는 수집한 기록을 바탕으로 개선 제안서를 작성하고 팀 회의에서 설명했다. 담당자의 의견을 반영하여 제안서를 수정한 뒤 후속 점검 계획을 세우고 실습 결과를 정리했다.'
};
const desired=[['response','이때 지도자는'],['findings','그래서 안내문을'],['noConnector','개선 대책은'],['contrast','반면 농촌 도서관은'],['time','한 달 뒤에는']];
desired.forEach(([key,boundary],i)=>{
 for(const sectioned of [false,true])add(`P${i+1}${sectioned?'H':'B'}`,'paragraph-target','16–19,22',`${key} / ${sectioned?'제목 있는 본문':'일반 본문'}`,(sectioned?'1. 검토 내용\n\n':'')+scenes[key],()=>{
  const input=(sectioned?'1. 검토 내용\n\n':'')+scenes[key];
  const out=finalLayout(input);
  assert.equal(compact(out.text),compact(input),'문단 작업은 어휘·순서를 바꾸지 않음');
  assert.ok(out.text.includes('\n\n'+boundary),'선정한 의미 전환 경계가 최종 출력에 남아야 함');
  assert.equal(finalLayout(input,out.text).text,out.text,'최종 처리 재실행 멱등성');
  assert.equal(out.structuralPass,true);assert.equal(out.converged,true);
  return {text:out.text};
 },{normative:false,expectation:'보고서 원칙을 적용한 제품 편집 목표. 유일한 문단 정답을 뜻하지 않음'});
});

const negatives=[
 ['짧은 반론 보충','자료를 비교했다. 결과는 비슷했다. 그러나 표본이 적다. 추가 조사가 필요하다.'],
 ['같은 주장의 또한 보충','도서관은 주민에게 다양한 자료를 제공한다. 어린이 자료와 지역 기록을 함께 갖추어 접근성을 높인다. 또한 담당자는 이용자에게 검색 방법을 안내한다. 이런 지원은 자료 이용의 어려움을 줄인다.'],
 ['긴 단일 논증','검사 결과를 해석할 때는 표본을 수집한 시기와 측정 장비의 상태를 함께 고려해야 한다. 장비의 감도가 일정하지 않으면 같은 조건에서도 결과가 달라질 수 있으므로 보정 기록을 먼저 확인하는 것이 중요하다. 또한 반복 측정의 오차 범위를 살펴보면 관측된 차이가 실제 변화인지 판단하는 데 도움이 된다. 따라서 하나의 측정값만으로 전체 경향을 단정하지 않고 관련 기록을 함께 검토하는 절차가 필요하다.'],
 ['한 사건의 시간순 전개','아침에 도서관에 도착해 예약한 책을 찾았다. 이어 안내 데스크에서 대출 절차를 확인했다. 그다음 열람실에서 필요한 내용을 읽고 메모했다. 마지막으로 책을 반납하고 집으로 돌아왔다.']
];
negatives.forEach(([label,input],i)=>add(`N${i+1}`,'paragraph-negative','16–18,22',label,input,()=>{
 const out=finalLayout(input);assert.equal(out.text,input,'접속어·길이만으로 문단을 강제 분리하지 않음');return {text:out.text};
}));

const protectedCases=[
 ['코드 펜스','```js\nconst a = 1;\n\n  console.log(a);\n```'],
 ['틸드 펜스','~~~txt\n가  나\n\n다\n~~~'],
 ['파이프 표','| 이름 | 값 |\n|---|---|\n| 항목 | 3.14 |'],
 ['탭 표','항목\t수량\n자료\t12권'],
 ['목록','● 확인할 것\n● 읽을 수 있는 자료\n● 자료 제출'],
 ['라벨','담당: 운영팀\n시간: 15:30\n대상: 신청자'],
 ['제목 계층','1. 연구 목적\n\n연구 목적을 설명한다.\n\n2. 연구 방법\n\n연구 방법을 설명한다.'],
 ['인라인 코드','식별자는 `a.b`이며, URL은 https://example.org/a.b 이다.'],
 ['독립 인용','“자료를 확인했다.\n결과를 기록했다.”'],
 ['시 행갈이','바람이 분다\n\n나뭇잎 하나\n천천히 내려앉는다','creative'],
 ['대화 단답','“알겠어요.”\n“네.”\n“다음에 만나요.”','creative'],
 ['법률 조문','제1조(목적) 이 계약은 자료 이용에 관한 권리와 의무를 정한다.\n제2조(해지) 당사자는 조건이 충족되면 계약을 해지할 수 있다.','legal_contract']
];
protectedCases.forEach(([label,input,kind],i)=>add(`B${i+1}`,'protected-structure','10,15,18,21–22',label,input,()=>{
 const prof=kind?{profile:kind,confidence:.99}:profile;
 const out=finalLayout(input,input,prof);
 assert.equal(out.text,input,'보호 블록 내용·탭·행 경계 왕복 보존');
 assert.equal(out.structuralPass,true);return {text:out.text};
}));

const meanings=['승인되면 시행할 예정이다.','일부 사용자는 오류를 경험했다.','모든 항목이 틀린 것은 아니다.',
 '오류가 늘었지만 원인은 확인되지 않았다.','A 또는 B를 제출한다.','원인을 확인하기 위해 점검했다.',
 '효과가 있을 수 있다.','수치가 증가했다(조사 A).','“확인 중”이라고 밝혔다.','최소 10명 이상이 참여할 수 있다.'];
meanings.forEach((input,i)=>add(`M${i+1}`,'meaning-surface','14,20–22',input,input,()=>{
 const out=finalLayout(input);
 assert.equal(out.text,input,'문단 처리에서 조건·부정·인용·가능성 등을 변경하지 않음');return {text:out.text};
}));
// Integration probes: no model calls. These deliberately combine actual
// production formatting/chunk/layout functions rather than a mock formatter.
function layoutPipeline(input, output = input) {
 const source=pre.repairSourceLayoutArtifacts(input).text;
 const chunks=structure.splitChunksForGpt(source,{coalesceEditable:true}).chunks;
 const formatted=korean.applySafeFormattingRepairs({source,outputText:output,documentProfile:profile}).text;
 const layout=finalLayout(source,formatted);
 const last=korean.applySafeFormattingRepairs({source,outputText:layout.text,documentProfile:profile});
 const lastAudit=structure.buildStructureAudit({source,outputText:last.text,chunks});
 const delivered=last.applied&&compact(last.text)===compact(layout.text)&&lastAudit.pass===true?last.text:layout.text;
 return {source,formatted,layout,delivered,lastAudit};
}
[
 ['인용 공백 교정 후 문장 수','그는 “끝났나요?” 라고 물었다. 대답을 기다렸다.',null, out=>assert.equal(text.splitSentenceSpans(out.delivered).length,2)],
 ['조건절 강제 행갈이','수정안이 승인되면\n다음 주부터 시행할 예정이다. 담당자에게 확인을 요청했다.',null,out=>assert.ok(!out.delivered.includes('\n'))],
 ['부정절 강제 행갈이','모든 항목이 틀린 것은\n아니다. 결과를 다시 확인해야 한다.',null,out=>assert.ok(!out.delivered.includes('\n'))],
 ['목적어 강제 빈 줄',body.replace('의식을 ','의식을\n\n'),null,out=>assert.ok(!out.delivered.includes('\n'))],
 ['모델이 만든 목적어 절단',body,body.replace('의식을 ','의식을\n\n'),out=>assert.equal(out.delivered,body)],
 ['모델이 만든 인용 귀속 절단','그는 “자료를 확인했다.”라고 말했다. 결과를 기록했다.','그는 “자료를 확인했다.”\n\n라고 말했다. 결과를 기록했다.',out=>assert.equal(out.delivered,'그는 “자료를 확인했다.”라고 말했다. 결과를 기록했다.')],
 ['편집 가능한 본문과 빈 줄 있는 코드','코드의 실행 결과를 확인했다.\n\n```js\nconst a = 1;\n\n  console.log(a);\n```\n\n이후 결과를 기록했다.',null,out=>assert.ok(out.delivered.includes('```js\nconst a = 1;\n\n  console.log(a);\n```'))],
 ['기존 의미 경계 유지',scenes.response.replace(' 이때','\n\n이때').replace(' 이러한 지도','\n\n이러한 지도'),null,out=>{assert.ok(out.delivered.includes('\n\n이때'));assert.ok(out.delivered.includes('\n\n이러한 지도'));}],
 ['인용 안 빈 줄 전체 경로','그는 “자료를 확인했다.\n\n결과를 기록했다.”라고 말했다. 답변을 기다렸다.',null,out=>assert.equal(text.splitSentenceSpans(out.delivered).length,2)],
 ['탭 표와 편집 본문','자료를 확인했다.\n\n항목\t수량\n자료\t12권\n\n결과를 기록했다.',null,out=>assert.ok(out.delivered.includes('항목\t수량\n자료\t12권'))]
].forEach(([label,input,output,check],i)=>add(`I${i+1}`,'integration','15,18,21–22',label,input,()=>{
 const result=layoutPipeline(input,output??input);check(result);
 assert.equal(compact(result.delivered),compact(output??input),'결정론 경로 내용 보존');return {text:result.delivered};
},{outputText:output??input}));
const longBody=Array.from({length:8},(_,i)=>`${i+1}. 조사 내용\n\n연구팀은 자료의 수집 방법을 구체적으로 설명하고 분석에 필요한 기록을 정리했다. 담당자는 관측 자료를 검토하며 측정 시기와 장비의 상태를 함께 확인했다. 연구 결과를 해석할 때는 표본의 특성과 한계를 고려해야 한다. 이 절차는 측정 결과의 신뢰성을 확인하는 데 필요한 정보를 제공한다.`).join('\n\n');
const syntheticRefs='Park. 김하늘 역. 『지역 기록』. 서울: 예시출판, 2020.\nPark. Regional Records. Translated by Research Group. Revised by Sample Editor. Seoul: Sample Press, 2021.';
const longWithRefs=longBody+'\n\n참고문헌\n'+syntheticRefs;
add('L1','convergence','16–18,21–22','참고문헌 때문에 정상 본문을 반복 분할하지 않음',longWithRefs,()=>{
 const first=finalLayout(longWithRefs),second=finalLayout(longWithRefs,first.text);
 assert.equal(first.converged,true,'보호 참고문헌의 문장 수가 일반 본문의 분할 목표를 늘리면 안 됨');
 assert.equal(first.text,second.text,'최종 레이아웃의 멱등성');
 assert.equal(first.text,longWithRefs,'4문장짜리 정상 본문은 참고문헌 길이 때문에 쪼개지면 안 됨');
 return {text:first.text};
});
module.exports={cases,finalLayout,compact,layoutPipeline};
