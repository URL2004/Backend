'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const korean = require('../engine-gpt-prod/koreanRefinement');
const {auditNaturalnessRegression:audit} = require('../engine-gpt-prod/naturalnessRegression');
const layout = require('../engine-gpt-prod/layoutStructure');
const structure = require('../engine-gpt-prod/structureChunk');
const profile = {profile:'report_assignment',confidence:.95};
const source = '이번 행사에서는 참가자 모집 및 발표 준비를 위해 온라인 게시판을 활용하였다.';
const bad = '이번 행사에서는 참가자를 모집하고 발표 준비를 위해 온라인 게시판을 활용하였다.';
const repair = (s,o) => korean.applySafeDeterministicRepairs({source:s,outputText:o,documentProfile:profile}).text;

test('source named examples are not lost when their class label survives',()=>{
  const s='운영 대상: 도서관, 미술관, 박물관 등 각 기관별 이용자의 만족도를 주기적으로 조사한다.';
  const o='운영 대상: 각 기관의 이용자 만족도를 정기적으로 조사한다.';
  const expected=o.replace('각 기관','도서관, 미술관, 박물관 등 각 기관');
  assert.equal(repair(s,o),expected);
  assert.equal(repair(s,expected),expected);
  assert.ok(korean.analyzeKoreanRefinement({source:s,outputText:o,documentProfile:profile})
    .repairableCodes.includes('introduced_named_example_loss'));
});

test('example recovery rejects partial, ambiguous, quoted and unrelated contexts',()=>{
  const s='도서관, 미술관, 박물관 등 각 기관별 이용자의 만족도를 주기적으로 조사한다.';
  const o='각 기관의 이용자 만족도를 정기적으로 조사한다.';
  for(const [source,output] of [[s,'도서관 등 '+o],[s,o+' '+o],[s+' '+s,o],
    [s,'각 기관은 올해 신규 설비의 도입을 완전히 중단하였다.'],
    [`“${s}”`,`“${o}”`],['```text\n'+s+'\n```','```text\n'+o+'\n```']])
    assert.equal(audit(source,output).filter(x=>x.code==='introduced_named_example_loss').length,0);
});

test('a quoted category anchors a weakened restriction clause without undoing other edits',()=>{
  const s="과거 교육 과정이 '기초 이론'에 국한되었다면, 현재는 실습과 공동 과제, 현장 견학까지 포함해 교육 범위가 넓어졌다.";
  const o="과거 교육의 중심이 '기초 이론'에 있었다면, 현재는 실습과 공동 과제, 현장 견학까지 포함해 교육 범위가 확대되었다.";
  const expected="과거 교육 과정이 '기초 이론'에 국한되었다면, 현재는 실습과 공동 과제, 현장 견학까지 포함해 교육 범위가 확대되었다.";
  assert.equal(repair(s,o),expected);
  assert.equal(repair(s,expected),expected);
  assert.ok(korean.analyzeKoreanRefinement({source:s,outputText:o,documentProfile:profile})
    .repairableCodes.includes('introduced_restriction_frame_weakening'));
  for(const source of [s.replace('국한되었다면','국한되지 않았다면'),s+' '+s,s.replace('기초 이론','응용 실습')])
    assert.equal(repair(source,o),o);
  assert.equal(repair('```text\n'+s+'\n```','```text\n'+o+'\n```'),'```text\n'+o+'\n```');
});

test('new subject-to-possessive damage uses the same source clause and leaves valid edits',()=>{
  for (const noun of ['안내 교육','참고 자료']) {
    const particle=noun.endsWith('육')?'이':'가';
    const s=`${noun}${particle} 도움이 될 것이라는 응답은 61.2%였다.`;
    const o=`${noun}의 도움이 될 것이라는 응답은 61.2%에 달했다.`;
    const expected=o.replace(`${noun}의`,`${noun}${particle}`);
    assert.equal(repair(s,o),expected);
    assert.equal(repair(s,expected),expected);
    assert.ok(korean.analyzeKoreanRefinement({source:s,outputText:o,documentProfile:profile})
      .repairableCodes.includes('introduced_help_subject_particle'));
    assert.ok(require('../engine-gpt-prod/candidateIntegrity').auditCandidateIntegrity({
      source:s,before:s,candidate:o,documentProfile:profile
    }).reasons.includes('korean_integrity_worsened'));
    assert.equal(repair(s+' '+s,o),expected);
  }
});

test('subject repair does not guess possessives, changed clauses, quotes or code',()=>{
  const s='자료가 도움이 될 것이라는 응답은 많았다.';
  for(const o of ['자료의 도움 정도는 충분했다.','자료의 도움이 될지는 아직 모르겠다.',
    '자료의 도움이 될 것이라는 생각은 많았다.'])assert.equal(repair(s,o),o);
  const o=s.replace('자료가','자료의');
  assert.equal(repair(o,o),o);
  for(const wrap of [t=>`“${t}”`,t=>'`'+t+'`',t=>'```text\n'+t+'\n```'])
    assert.equal(repair(wrap(s),wrap(o)),wrap(o));
});

test('source subject evidence follows equivalent quoted prediction frames',()=>{
  const base='참고 자료가 도움이 될 것이라는 응답은 많았다.';
  for(const verb of ['본','답한','응답한','판단한']) {
    const s=base.replace('것이라는',`것이라고 ${verb}`);
    for(const pair of [[base,s],[s,base]]) {
      const o=pair[1].replace('자료가','자료의');
      assert.equal(repair(pair[0],o),pair[1]);
      assert.equal(repair(pair[0],o.replace('응답은','생각은')),o.replace('응답은','생각은'));
    }
  }
});

test('ordinal predicate relocation preserves identity without splitting the predicate',()=>{
  const {ordinalMarkers,restoreOrdinalParagraphGaps}=require('../engine-gpt-prod/koreanOrdinal');
  const s='1. 기여\n첫 번째 의의는 관측 범위를 넓힌 점이다.\n\n두 번째 의의는 자료를 정리한 점이다.\n2. 한계\n첫째, 표본이 작다.\n둘째, 반복 관측하지 않았다.';
  const o='1. 기여\n관측 범위를 넓혔다. 이 점이 첫 번째 의의다.\n\n자료를 정리한 점이 두 번째 의의입니다.\n2. 한계\n첫째, 표본이 작다.\n둘째, 반복 관측하지 않았다.';
  assert.deepEqual(ordinalMarkers(o).map(m=>m.number),[1,2,1,2]);
  assert.equal(structure.compareOriginalStructuralMarkers(s,o).pass,true);
  const restored=restoreOrdinalParagraphGaps(s,o).text;
  assert.ok(restored.includes('이 점이 첫 번째 의의다.'));
  assert.ok(restored.includes('자료를 정리한 점이 두 번째 의의입니다.'));
  for(const altered of [o.replace('첫 번째 의의다','의의다'),o.replace('두 번째 의의입니다','세 번째 의의입니다')])
    assert.equal(structure.compareOriginalStructuralMarkers(s,altered).pass,false);
  const adverbial=o.replace('자료를 정리한 점이 두 번째 의의입니다.', '두 번째 의의로, 자료를 정리한 점을 들 수 있다.');
  assert.equal(structure.compareOriginalStructuralMarkers(s,adverbial).pass,true);
  assert.equal(ordinalMarkers('네 번째 장점으로, 자료의 범위를 들 수 있다.')[0].number,4);
});

test('ordinal predicates exclude citations, negation, experiments and adjective mentions',()=>{
  const {ordinalMarkers}=require('../engine-gpt-prod/koreanOrdinal');
  for(const s of ['첫 번째 실험이다.','첫 번째 의의가 아니다.','첫 번째 의의라는 말을 썼다.',
    '첫 번째 의의에 관한 설명이다.','“이 점이 첫 번째 의의다.”','`이 점이 첫 번째 의의다.`',
    '```text\n이 점이 첫 번째 의의다.\n```']) assert.deepEqual(ordinalMarkers(s),[],s);
  assert.equal(ordinalMarkers('이 점이 네 번째 의의다(작성자, 2025).')[0].number,4);
});

test('coordinated purposes keep scope and retain unrelated valid edits',()=>{
  const output = bad.replace('이번 행사에서는','이번 행사에서');
  const expected = source.replace('이번 행사에서는','이번 행사에서');
  assert.equal(repair(source,output),expected);
  assert.equal(repair(source,expected),expected);
  assert.ok(korean.analyzeKoreanRefinement({source,outputText:output,documentProfile:profile})
    .repairableCodes.includes('introduced_parallel_purpose_mismatch'));
});
test('candidate selection sees purpose and role regressions before accepting a rewrite',()=>{
  const {auditCandidateIntegrity}=require('../engine-gpt-prod/candidateIntegrity');
  assert.ok(auditCandidateIntegrity({source,before:source,candidate:bad,documentProfile:profile})
    .reasons.includes('korean_integrity_worsened'));
  const s='이 장치는 시범 사업을 위해 제작한 임시 도구로서 별도의 환경 시험은 실시하지 않았다.';
  const o=s.replace('도구로서','도구이므로');
  assert.ok(korean.analyzeKoreanRefinement({source:s,outputText:o,documentProfile:profile})
    .repairableCodes.includes('introduced_role_causality'));
  assert.equal(repair(s,o),s);
});
test('different actions and conjunctions use source evidence, not a term-specific replacement',()=>{
  for(const join of ['및','과','와']) {
    const s=`자료 수집 ${join} 결과 분석을 위해 공용 시스템을 활용하였다.`;
    const o='자료를 수집하고 결과 분석을 위해 공용 시스템을 활용하였다.';
    assert.equal(repair(s,o),s);
  }
});
test('existing action sequence, changed tail and duplicate source are not repaired',()=>{
  assert.equal(repair(bad,bad),bad);
  assert.equal(repair(source,bad.replace('온라인 게시판','현장 안내소')),bad.replace('온라인 게시판','현장 안내소'));
  assert.equal(repair(source+' '+source,bad),bad);
  const valid='참가자를 모집하고 이후 발표 준비를 위해 온라인 게시판을 활용하였다.';
  assert.equal(repair(valid,valid),valid);
});
test('purpose repairs do not cross quotes, code, list headings or separate sentences',()=>{
  for(const wrap of [s=>`“${s}”`,s=>`「${s}」`,s=>'`'+s+'`',s=>'```text\n'+s+'\n```'])
    assert.equal(audit(wrap(source),wrap(bad)).length,0);
  assert.equal(audit(source,bad.replace('모집하고','모집하였다. 그리고')).length,0);
});

const labelSource='1. 활동 영역\n시설 관리 및 운영: 시설 점검을 수행한다. 운영 상태도 기록한다.\n제작, 유통 및 서비스: 제품을 제작한다. 유통과 서비스도 담당한다.';
const merged=labelSource.replace('\n제작,',' 제작,');
test('comma compound labels share classification and editable chunk locking',()=>{
  assert.equal(layout.labelParts('제작, 유통 및 서비스: 제품을 제작한다.').label,'제작, 유통 및 서비스');
  const chunks=structure.splitChunksForGpt(labelSource).chunks;
  assert.ok(chunks.some(c=>c.locked&&c.text.includes('제작, 유통 및 서비스:')));
  assert.ok(chunks.some(c=>!c.locked&&c.text.includes('제품을 제작한다.')));
  assert.equal(structure.compareLineAnchorLayout(labelSource,merged).pass,false);
});
for(const mode of ['blog','formal','polish'])test(`${mode}: merged sibling category boundary is restored without rewriting words`,()=>{
  const args={source:labelSource,outputText:merged,mode,chunks:structure.splitChunksForGpt(labelSource).chunks,
    normalizeVisualGaps:mode!=='polish',documentProfile:profile};
  const fixed=structure.restoreFinalDocumentLayout(args);
  assert.ok(fixed.text.includes('\n제작, 유통 및 서비스:'));
  assert.equal(fixed.text.replace(/\s/gu,''),merged.replace(/\s/gu,''));
  assert.equal(structure.compareLineAnchorLayout(labelSource,fixed.text).pass,true);
  assert.equal(structure.restoreFinalDocumentLayout({...args,outputText:fixed.text}).text,fixed.text);
});
test('commas in prose, malformed labels, time and URLs are not compound categories',()=>{
  assert.ok(layout.labelParts('광고, 로고 및 홍보: 디자인을 검토한다.'));
  for(const s of ['상태를 확인했고, 결론을 내렸다: 모두 정상이다.', '확인하면, 결과: 정상',
    '제작,, 유통: 설명', '제작, : 설명','https://example.com','08:30 일정 시작'])assert.equal(layout.labelParts(s),null,s);
  for(const s of ['```text\n제작, 유통: 원문이다.\n```','“제작, 유통: 원문이다.”']){
    const chunks=structure.splitChunksForGpt(s).chunks;
    const fixed=structure.restoreFinalDocumentLayout({source:s,outputText:s,chunks,mode:'formal'});
    assert.equal(fixed.text,s);
  }
});
test('academic style contract is scoped and consistent across generation modes and variants',()=>{
  const {academicStyleLines}=require('../engine-gpt-prod/prompts/academicStyle');
  const {buildHumanizePrompt,validateHumanizePrompt}=require('../engine-gpt-prod/prompts/humanize');
  for(const mode of ['blog','formal','polish']) for(const promptVariant of ['full','compact_v1']) {
    const p=buildHumanizePrompt(mode,'ko',{documentProfile:profile,register:'plain',promptVariant});
    for(const line of academicStyleLines(profile))assert.ok(p.stable.includes(line));
    assert.equal(validateHumanizePrompt(p.stable,{humanizeContract:p.humanizeContract}).pass,true);
  }
  for(const p of ['creative','clinical_record','legal_contract','personal_essay','unknown'])
    assert.deepEqual(academicStyleLines(p),[]);
  assert.match(academicStyleLines(profile).join('\n'),/필요·가능성·권고의 강도를 바꾸는 단정형 치환/);
});
