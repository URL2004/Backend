'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const st = require('../engine-gpt-prod/structureChunk');
const layout = require('../engine-gpt-prod/layoutStructure');
const pre = require('../engine-gpt-prod/sourcePreflight');
const {proseTabLineIndices} = require('../engine-gpt-prod/proseTabLayout');
const bare = s => s.replace(/\s/gu, '');
const poem = '저녁 길을 걸으며\n네 곁에 멈추었을 때,\n나는 잠시\n들리는 소리를 기다렸다.\n\n오래된 창가에서\n작은 빛을 보았다.';
const editedPoem = poem.replace('네 곁에 멈추었을 때,', '너에게 다가갔을 때,');

for (const profile of ['creative', 'student_record_teacher']) {
  test(profile + ': final prose repair cannot consume a rewritten preserved line', () => {
    const chunks = st.splitChunksForGpt(poem, {preserveLineBoundaries:'all', coalesceEditable:true}).chunks;
    assert.ok(chunks.some(c => c.lineBoundaryPolicy === 'all'));
    const args = {source:poem, outputText:editedPoem, chunks, mode:'blog',
      documentProfile:{profile,confidence:.95}, normalizeVisualGaps:false};
    const result = st.restoreFinalDocumentLayout(args);
    assert.equal(result.text, editedPoem);
    assert.equal(result.pass, true, JSON.stringify(result.returnedStructureAudit));
    assert.equal(result.midSentenceParagraphRepairCount, 0);
    assert.equal(st.restoreFinalDocumentLayout({...args,outputText:result.text}).text,result.text);
  });
}

test('creative profile preserves deliberate lines even without all-lines chunk metadata', () => {
  const result = st.restoreFinalDocumentLayout({source:poem,outputText:editedPoem,
    chunks:st.splitChunksForGpt(poem).chunks,mode:'blog',documentProfile:{profile:'creative',confidence:.95}});
  assert.equal(result.text,editedPoem);
  assert.equal(result.midSentenceParagraphRepairCount,0);
});

test('an already collapsed poetic line still fails; no audit waiver or guessed split', () => {
  const chunks = st.splitChunksForGpt(poem,{preserveLineBoundaries:'all',coalesceEditable:true}).chunks;
  const collapsed = editedPoem.replace('때,\n나는','때, 나는');
  const out = st.restoreFinalDocumentLayout({source:poem,outputText:collapsed,chunks,mode:'blog',
    documentProfile:{profile:'creative',confidence:.95}});
  assert.equal(out.structuralPass,false);
  assert.equal(out.returnedStructureAudit.exactLineStructurePass,false);
});

test('ordinary prose still repairs introduced comma and clause breaks', () => {
  const source='작성자는 자료를 검토한 뒤, 내용을 정리하고 다음 활동에서 확인할 부분을 구체적으로 설명했다.';
  const output='작성자는 자료를 확인한 뒤,\n내용을 정리하고 다음 활동에서 확인할 부분을 구체적으로 설명했다.';
  const out=st.repairIntroducedMidSentenceParagraphBreaks(source,output);
  assert.ok(out.repairCount>0);
  assert.equal(out.text,output.replace('\n',' '));
});

const first='이 조사는 이용자가 자료를 살펴보는 과정에서 어떤 정보를 필요로 하는지 확인하기 위해 진행되었다. 조사자는 참여자에게 같은 안내를 제공하고 각자의 경험을 설명하도록 요청했으며 응답 내용은 조사 목적에 맞추어 분류하고 서로 다른 의견을 구분하여 기록하였다.';
const second='참여자는 자료를 살펴본 뒤 자신이 이해한 내용을 설명하고 확인하기 어려운 부분에 대해 추가로 질문하였다. 조사자는 답변을 요약하되 참여자가 말하지 않은 이유를 덧붙이지 않았으며 기록한 내용이 실제 경험과 일치하는지 다시 확인하고 수정할 사항을 함께 검토하였다.';

for(const prefix of ['\t', ' \t ', '\t   ']) test('a single leading tab is indentation with developed prose evidence: '+JSON.stringify(prefix), () => {
  const source=first+'\n'+prefix+second;
  assert.deepEqual([...proseTabLineIndices(source)],[1]);
  assert.deepEqual(layout.buildLineRecords(source).map(r=>r.role),['prose','prose']);
  const prepared=pre.auditAndSanitizeSource(source).text;
  const chunks=st.splitChunksForGpt(prepared,{coalesceEditable:true}).chunks;
  assert.ok(chunks.some(c=>!c.locked && c.text.includes('참여자는')));
  assert.equal(chunks.some(c=>c.lockType==='table'),false);
  const output=first.replace('진행되었다','이루어졌다')+'\n'+second;
  const options={source:prepared,outputText:output,chunks,mode:'formal',
    documentProfile:{profile:'report_assignment',confidence:.95},normalizeVisualGaps:true};
  const result=st.restoreFinalDocumentLayout(options);
  assert.equal(result.structuralPass,true,JSON.stringify(result.returnedStructureAudit));
  assert.equal(bare(result.text),bare(output));
  assert.equal(st.restoreFinalDocumentLayout({...options,outputText:result.text}).text,result.text);
});

test('list exposition plus indented explanation remains editable, not a two-column table', () => {
  const source='- '+first+'\n\t'+second;
  assert.deepEqual([...proseTabLineIndices(source)],[1]);
  assert.deepEqual(layout.buildLineRecords(source).map(r=>r.role),['list','prose']);
  const chunks=st.splitChunksForGpt(source).chunks;
  assert.equal(chunks.some(c=>c.lockType==='table'),false);
  assert.ok(chunks.some(c=>c.lockType==='bullet_prefix'));
});

for(const source of [
  '항목\t설명\n\t'+second,
  first+'\n\t\t'+second,
  first+'\n\t'+second+'\t비고',
  '\t'+second,
  '항목\t값\n\t누락 값',
  first+'\n\t짧은 설명',
  '| 항목 | 설명 |\n| | '+second+' |'
]) test('real/ambiguous empty cells retain table protection: '+source.slice(0,16), () => {
  assert.equal(proseTabLineIndices(source).size,0);
  assert.ok(layout.buildLineRecords(source).some(r=>r.role==='table'));
  assert.ok(st.splitChunksForGpt(source).chunks.some(c=>c.lockType==='table'));
});

test('a real table losing its leading empty cell still fails its column ownership audit', () => {
  const source='항목\t설명\n\t'+second;
  const chunks=st.splitChunksForGpt(source).chunks;
  const audit=st.buildStructureAudit({source,outputText:source.replace('\n\t','\n'),chunks});
  assert.equal(audit.pass,false);
  assert.equal(audit.tableColumnOwnershipPass,false);
});
