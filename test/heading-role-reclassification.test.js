'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const v=require('../engine-gpt-prod/voiceProfile');
const q=require('../engine-gpt-prod/finalQualityV2');
const body='측정 장치를 확인한 다음 각 조건에서 얻은 관찰 결과를 분석하고 기록했다. 결과에 나타난 차이를 비교하고 원인을 검토하여 이후 실험에서 보완할 사항을 구체적으로 정리하였다.';
const source='분석 보고서\n\n'+body+'\n## 1. 실험 관찰\n측정값과 실험 목표\n'+body;
const output='분석 보고서\n\n'+body+'\n\n## 1. 실험 관찰\n\n측정값과 실험 목표\n\n'+body;
const opts={documentProfile:'report_assignment',mode:'humanize'};
const profile=v.buildVoiceProfile(source,opts);
const headings=warnings=>warnings.map(x=>x.code).filter(x=>['heading_structure_changed','title_line_merged'].includes(x));
test('identical standalone headings survive title to heading reclassification',()=>{
 const current=v.buildVoiceProfile(output,opts);
 assert.notEqual(profile.headingCount,current.headingCount);
 assert.notEqual(profile.layout.titleLineCount,current.layout.titleLineCount);
 assert.deepEqual(headings(v.auditVoice(profile,output,{...opts,sourceText:source}).warnings),[]);
 assert.deepEqual(headings(q.buildDeterministicAudit({source,outputText:output,...opts,voiceProfile:profile}).warnings),[]);
});
test('merged and missing titles still warn and profiles without source retain fallback',()=>{
 for(const changed of [output.replace('측정값과 실험 목표\n\n',''),output.replace('측정값과 실험 목표\n\n','측정값과 실험 목표 ')]) {
  assert.ok(headings(v.auditVoice(profile,changed,{...opts,sourceText:source}).warnings).length);
 }
 assert.ok(headings(v.auditVoice(profile,output,opts).warnings).length);
});

