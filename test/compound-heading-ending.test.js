'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const preflight=require('../engine-gpt-prod/sourcePreflight');
const seam=require('../engine-gpt-prod/koreanEndingSeam');
const clean=text=>preflight.auditAndSanitizeSource(text).text;
test('compound report headings are not split after their shorter prefix',()=>{
  for(const title of ['결론 및 고찰','결론및고찰','결론 및 제언','결론 및 시사점','결과 및 논의']) {
    const source=`3. 연구 방법\n조별 발표의 준비 과정과 수행 결과를 항목별로 정리하였다.\n4. ${title}본 보고서는 조별 활동에서 역할 분담과 자료 검토가 어떤 영향을 주었는지 정리한다.`;
    const out=clean(source);
    assert.ok(out.includes(`4. ${title}\n`),out);
    assert.equal(out.replace(/\s/gu,''),source.replace(/\s/gu,''));
  }
});
test('source seam replay does not rejoin a recovered heading to its body',()=>{
  const restore=require('../engine-gpt-prod/physicalProseLines').restoreSubmittedSourceSeams;
  const source='조별 발표 준비 과정과 결과를 본문에 정리하였다.4. 결론 및 고찰본 보고서는 역할 분담의 효과를 정리한다.';
  const output='조별 발표 준비 과정과 결과를 본문에 정리하였다.\n\n4. 결론 및 고찰\n본 보고서는 역할 분담의 효과를 정리한다.';
  assert.equal(restore(source,output).text,output);
});
test('coordinated words in prose, tables and quotes are not newly split',()=>{
  for(const source of ['본문의 결론 및 고찰에서는 앞선 결과를 정리하고 해석하였다.',
    '5. 결론적으로 본 연구는 조별 활동의 효과를 구체적인 자료를 통해 분석하였다.',
    '"4. 결론 및 고찰본 보고서는 결과를 정리한다."라고 쓰여 있었다.',
    '항목\t설명\n4. 결론 및 고찰\t실습 결과와 한계']) assert.equal(clean(source),source);
});
test('whole 이어간 stem repairs a detached ending without confusing noun 간',()=>{
  const left='학생들은 매주 발표에 사용할 자료를 모으고 토의한 내용을 함께 정리하며 논의를 이어간';
  assert.equal(seam.isEndingSeam(left,'다. 다음 모임에서는 초안을 점검한다.'),true);
  assert.ok(clean(`${left}\n다. 다음 모임에서는 초안을 점검한다.`).includes('이어간다.'));
  const negative='이 과제는 조별 활동의 결과를 검토한 기록이며 모든 학생에게 적용되는 결과는 아니';
  assert.ok(clean(`${negative}\n다. 결과는 해당 활동의 범위 안에서 해석한다.`).includes('아니다.'));
  for(const noun of ['시간','기간','공간']) assert.equal(seam.isEndingSeam(`학생들이 함께 모여 발표 자료와 초안을 검토하도록 마련된 ${noun}`,'다. 점검 결과'),false);
});
