'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const korean = require('../engine-gpt-prod/koreanRefinement');
const structure = require('../engine-gpt-prod/structureChunk');
const { ordinalMarkers } = require('../engine-gpt-prod/koreanOrdinal');
const { auditCandidateIntegrity } = require('../engine-gpt-prod/candidateIntegrity');

// Synthetic, non-user text: two distinct claims share a topic noun.
const prefix = '조사 대상은 성인 응답자였으므로 분석 결과를 학생의 인식이나 교육 효과로 일반화하지 않았다.';
const tail = '향후 학생 대상 교육과정 개발에 필요한 인식자료를 제공하는 데 연구의 범위를 두었다.';
const source = prefix.replace('않았다.', '않았으며, ') + tail;
const options = { documentProfile: { profile: 'academic_paper' }, mode: 'assignment' };

test('complete unique headings permit local review despite sentence splits and repeated claims', () => {
  const { alignedReviewPairs } = require('../engine-gpt-prod/reviewAlignment');
  const source = '1. 장비\n'+('장비를 점검한 뒤 기록을 검토했다. '.repeat(12))+'\n2. 자료\n'+('자료의 적용 범위를 확인했다. '.repeat(12));
  const output = '1. 장비\n'+('장비를 점검했다. 이후 기록을 검토했다. '.repeat(12))+'\n2. 자료\n'+('자료가 어디까지 적용되는지 확인했다. '.repeat(12));
  const pairs=alignedReviewPairs(source,output,500);
  assert.equal(pairs.length,2);
  assert.ok(pairs.every(p=>p.repairSafe&&p.alignment==='shared_unique_heading'));
  assert.equal(pairs.map(p=>p.sourceContext).join(''),source);
  assert.equal(pairs.map(p=>p.output).join(''),output);
  assert.ok(pairs[1].sourceContext.startsWith('2. 자료'));
  assert.ok(pairs[1].output.startsWith('2. 자료'));
  for(const changed of [output.replace('2. 자료','1. 장비'),output.replace('1. 장비','TEMP').replace('2. 자료','1. 장비').replace('TEMP','2. 자료'),output.replace('2. 자료','')]) {
    assert.ok(alignedReviewPairs(source,changed,500).every(p=>p.alignment!=='shared_unique_heading'));
  }
  assert.ok(alignedReviewPairs(source,output,100).every(p=>p.alignment!=='shared_unique_heading'));
});

test('a restored independent research scope is not rejected as a noun-based predicate echo', () => {
  const candidate = prefix + ' ' + tail;
  const audit = korean.analyzeKoreanRefinement({ source, outputText: candidate, ...options });
  assert.equal(audit.issueCodes.includes('adjacent_semantic_repetition'), false);
  const integrity = auditCandidateIntegrity({ source, before: prefix, candidate, ...options });
  assert.ok(!integrity.reasons.includes('korean_integrity_worsened'), JSON.stringify(integrity));
  const deduped = korean.removeIntroducedGroundedDuplicateSentences({ source, outputText: candidate, audit });
  assert.equal(deduped.text, candidate);
});

test('real new cognitive predicate repetition still requires repair', () => {
  const original = '자료를 비교하면서 측정 기준을 이해하게 되었다. 그래서 기준표를 다시 작성하고 수치를 하나씩 대조했다.';
  const outputText = '자료를 비교하면서 측정 기준을 이해하게 되었다. 기준표를 다시 작성하며 측정 기준을 다시 이해했다.';
  const audit = korean.analyzeKoreanRefinement({ source: original, outputText, ...options });
  assert.ok(audit.issueCodes.includes('adjacent_semantic_repetition'));
});

for (const marker of ['첫째', '여섯째', '일곱째', '여덟째', '아홉째', '열째', '열한째', '스무째', '두 번째']) {
  test(`enumeration prefix is locked but its body remains editable: ${marker}`, () => {
    const text = `${marker}, 여러 집단의 조사 결과를 비교했으므로 반복 검정의 한계를 고려해서 해석할 필요가 있다.`;
    const { chunks } = structure.splitChunksForGpt(text);
    assert.ok(chunks.some(c => c.locked && c.text.trim() === `${marker},`));
    assert.ok(chunks.some(c => !c.locked && c.text.includes('반복 검정')));
    assert.equal(structure.mergeChunks(chunks), text);
    assert.equal(structure.compareOriginalStructuralMarkers(text, text).pass, true);
    assert.equal(structure.compareOriginalStructuralMarkers(text, text.replace(`${marker}, `, '')).pass, false);
  });
}

test('same count cannot hide reordered, duplicated or replaced ordinals', () => {
  const original = '일곱째, 표본을 설명했다.\n여덟째, 검정을 설명했다.\n아홉째, 연령을 설명했다.';
  for (const output of [original.replace('여덟째', '열째'), original.replace('아홉째', '여덟째'),
    original.replace('일곱째', 'TEMP').replace('여덟째', '일곱째').replace('TEMP', '여덟째')]) {
    assert.equal(structure.compareOriginalStructuralMarkers(original, output).pass, false);
  }
});

test('inline, indented and paragraph enumeration uses the same marker policy', () => {
  assert.deepEqual(ordinalMarkers('  첫째, 조사한다. 둘째, 검토한다.\n\n  여덟째, 해석한다.').map(m => m.marker), ['첫째', '둘째', '여덟째']);
});

test('quoted/code ordinals and family/order nouns are not prose enumeration', () => {
  for (const text of ['첫째 아이는 책을 읽었다.', '두 번째 실험은 완료되었다.',
    '“첫째, 조사한다. 여덟째, 검토한다.”', '「첫째, 조사한다.」',
    '`첫째, 조사한다.`', '```\n첫째, 조사한다.\n여덟째, 검토한다.\n```']) {
    assert.deepEqual(ordinalMarkers(text), [], text);
  }
});

test('numeric headings and Korean ordinals retain their document order', () => {
  const markers = structure.extractOriginalStructuralMarkers('1. 한계\n첫째, 표본을 설명한다.\n여덟째, 검정을 설명한다.\n2. 제언');
  assert.deepEqual(markers.map(m => m.marker), ['1.', '첫째', '여덟째', '2.']);
});

test('ordinal surface variants preserve the same item identity without renumbering', () => {
  assert.equal(structure.compareOriginalStructuralMarkers('다섯 번째, 한계를 설명한다.', '다섯째, 한계를 설명한다.').pass, true);
});

test('ordinal predicate frames retain their first item as well as later comma markers', () => {
  const text = '본 연구의 첫 번째 의의는 장비 오차를 파악했다는 데 있다.\n두 번째 의의는 지역의 자료를 함께 비교했다는 점이다.\n세 번째, 현장에서 활용할 방법을 제시했다.';
  assert.deepEqual(ordinalMarkers(text).map(x => x.number), [1,2,3]);
  const { chunks } = structure.splitChunksForGpt(text);
  assert.ok(chunks.some(c => c.locked && c.text.trim() === '본 연구의 첫 번째'));
  assert.ok(chunks.some(c => !c.locked && c.text.startsWith('의의는 장비 오차를')));
  assert.ok(chunks.some(c => !c.locked && c.text.startsWith('의의는 지역의 자료를')));
  assert.ok(chunks.some(c => !c.locked && c.text.includes('장비 오차')));
  assert.equal(structure.mergeChunks(chunks), text);
  assert.equal(structure.compareOriginalStructuralMarkers(text, text.replace('본 연구의 첫 번째 의의는', '본 연구는')).pass, false);
  assert.deepEqual(ordinalMarkers('첫 번째 실험은 완료되었다. 첫째 아이는 책을 읽었다. “두 번째 의의는 조사의 범위다.”'), []);
  const { restoreOrdinalParagraphGaps } = require('../engine-gpt-prod/koreanOrdinal');
  const fixed = restoreOrdinalParagraphGaps('배경을 정리했다.\n'+text, '배경을 정리했다. '+text.replaceAll('\n',' '));
  assert.ok(fixed.text.includes('\n\n본 연구의 첫 번째 의의는'));
  assert.ok(!fixed.text.includes('본 연구의 \n'));
});

test('inline ascending list periods do not orphan an item number', () => {
  const { splitSentences } = require('../engine/koreanText');
  const list = '개선 방안은 1. 전달자의 기준 제시 2. 수신자의 해석 확인이다.';
  assert.deepEqual(splitSentences(list), [list]);
  assert.deepEqual(splitSentences('기록된 점수는 1. 다음 측정을 준비했다.'), ['기록된 점수는 1.', '다음 측정을 준비했다.']);
  assert.deepEqual(splitSentences('평균은 3.14이다. 차이를 확인했다.'), ['평균은 3.14이다.', '차이를 확인했다.']);
});

test('new ranking is a semantic review candidate, not an automatic fact correction', () => {
  const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');
  const original = '설문에서 응급 안내의 만족 비율은 21.4%로 낮게 나타났다.';
  const output = '설문에서 응급 안내의 만족 비율은 21.4%로 가장 낮게 나타났다.';
  const audit = auditRelationCandidates(original, output);
  assert.equal(audit.candidateOnly, true);
  assert.ok(audit.codes.includes('unsupported_ranking_candidate'));
  assert.equal(auditRelationCandidates(output, output).codes.includes('unsupported_ranking_candidate'), false);
  assert.equal(auditRelationCandidates('표본을 확보하려고 노력했다.', '표본을 최대한 확보하려고 노력했다.').codes.includes('unsupported_ranking_candidate'), false);
});

test('restoring a whole sentence cannot silently retain its paraphrased tail', () => {
  const original = '장비 점검에서 센서 오류를 의심했다가 기록을 확인하고 배선 문제로 정정하면서, 부품 교체가 필요하지 않음을 설명했는데 정답이어서 다행이라 생각했다.';
  const tail = '부품 교체가 필요하지 않다고 설명했고, 정답이라 다행이었다.';
  const candidate = original + ' ' + tail;
  const audit = korean.analyzeKoreanRefinement({ source: original, outputText: candidate });
  assert.ok(audit.issueCodes.includes('source_restore_echo'));
  assert.equal(audit.issues.find(i => i.code === 'source_restore_echo').deterministicSafe, false);
  assert.ok(auditCandidateIntegrity({ source: original, before: original, candidate }).reasons.includes('korean_integrity_worsened'));
  assert.equal(korean.removeIntroducedGroundedDuplicateSentences({ source: original, outputText: candidate, audit }).text, candidate);
  assert.ok(!korean.analyzeKoreanRefinement({ source: candidate, outputText: candidate }).issueCodes.includes('source_restore_echo'));
  const separate = '부품 교체가 필요하지 않다고 설명한 뒤 점검 기록을 작성했다.';
  assert.ok(!korean.analyzeKoreanRefinement({ source: original + ' ' + separate, outputText: original + ' ' + separate }).issueCodes.includes('source_restore_echo'));
});

test('author-year et al. citation remains inside its sentence with original offsets', () => {
  const { splitSentenceSpans, splitSentences } = require('../engine/koreanText');
  for (const citation of ['Kim et al. (2021)', 'Lee et al. 2019', 'Park et al. (2020a)']) {
    const text = `${citation}의 분석에서는 해석의 한계를 제시했다. 후속 연구가 필요하다.`;
    const spans = splitSentenceSpans(text);
    assert.equal(spans.length, 2);
    assert.equal(spans[0].text, text.slice(spans[0].start, spans[0].end));
    assert.ok(spans[0].text.includes(citation));
  }
  assert.equal(splitSentences('They discussed Kim et al. Further work is needed.').length, 2);
});

test('embedded uncertainty becoming a direct question is reviewed, not automatically blocked', () => {
  const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');
  const source = '그렇게 답한다면 내가 고민했던 마음은 어디에 있어야 하는지 모르겠어요.';
  const output = '그렇게 답한다면 모르겠어요. 내가 고민했던 마음은 어디에 있어야 할까요?';
  const audit = auditRelationCandidates(source, output);
  assert.equal(audit.candidateOnly, true);
  assert.ok(audit.codes.includes('speech_act_shift_candidate'));
  assert.ok(!auditRelationCandidates(output, output).codes.includes('speech_act_shift_candidate'));
  assert.ok(!auditRelationCandidates(source, '내가 고민했던 마음을 어디에 두어야 할지 모르겠어요.').codes.includes('speech_act_shift_candidate'));
});

test('reading-report labels stay independent while their body can be edited', () => {
  const text = '『먼 길』을 읽고\n지은이\n이 작품의 작가를 먼저 살펴보았다.\n줄거리\n두 친구가 각자의 문제를 해결하는 이야기이다.';
  const { chunks } = structure.splitChunksForGpt(text);
  for (const label of ['『먼 길』을 읽고', '지은이', '줄거리']) {
    assert.ok(chunks.some(c => c.locked && c.text.trim() === label));
  }
  assert.ok(chunks.some(c => !c.locked && c.text.includes('각자의 문제')));
  assert.equal(structure.mergeChunks(chunks), text);
});

test('quoted nominal 란 attaches without touching the quote content or independent words', () => {
  const text = '‘좋은 대화’ 란 서로 듣는 일이다. ‘길’ 이라는 말도 남긴다. “안녕.” 하고 말했다.';
  const fixed = korean.applySafeDeterministicRepairs({ source: text, outputText: text }).text;
  assert.ok(fixed.includes('‘좋은 대화’란'));
  assert.ok(fixed.includes('‘길’이라는'));
  assert.ok(fixed.includes('“안녕.” 하고 말했다.'));
});

test('multiple new Han substitutions use a unique Korean source word, not a transliteration guess', () => {
  const { auditNaturalnessRegression } = require('../engine-gpt-prod/naturalnessRegression');
  const source = '자료에는 한자 原文도 있다. 결론적으로 해당 실험은 다음 과제의 기준이 된다.';
  const output = source.replace('결론적으로', '結論적으로');
  assert.equal(auditNaturalnessRegression(source, output).find(f => f.code === 'introduced_mixed_script_word')?.repair.replacement, '결론적으로');
  for (const text of ['結論として結果を述べる。', '結論是需要更多資料。', '결론적으로 原文을 검토했다.']) {
    assert.equal(auditNaturalnessRegression(text, text).length, 0);
  }
  assert.ok(!auditNaturalnessRegression('이론적으로 해당 자료를 설명한다. 결론적으로 해당 자료를 정리한다.', '結論적으로 해당 자료를 검토한다.').length);
});

test('new repeated predicate wrapper is removed only around an exact source sentence', () => {
  const source = '측정 시간과 장비 설정에 따라 결과의 차이가 나타날 수 있다.';
  const outputText = '나타날 수 있는 결과로는 ' + source;
  assert.ok(korean.analyzeKoreanRefinement({source, outputText}).issueCodes.includes('introduced_predicate_echo_frame'));
  assert.equal(korean.applySafeDeterministicRepairs({source, outputText}).text, source);
  assert.equal(korean.applySafeDeterministicRepairs({source: '장비를 확인했다.' + source, outputText}).text, source);
  assert.equal(korean.applySafeDeterministicRepairs({source: outputText, outputText}).text, outputText);
  const valid = '나타날 수 있는 결과로는 측정값의 차이가 있다.';
  assert.equal(korean.applySafeDeterministicRepairs({source, outputText: valid}).text, valid);
});

test('partial recovery cannot overwrite one arm with a merge and leave the other duplicated', () => {
  const { buildSentenceProposals, accumulateSafeEdits } = require('../engine-gpt-prod/safeEditAccumulator');
  const first = '실제 참가자에게 맞는 교육 자료를 개발하고 적용한 뒤 교육 전후의 지식과 대응 능력을 평가해야 한다.';
  const tail = '이를 통해 교육효과와 현장에서의 적용 가능성을 검증할 필요가 있다.';
  const merged = '실제 참가자에게 맞는 교육 자료를 개발하고 적용한 뒤 교육 전후의 지식과 대응 능력을 평가해 교육효과와 현장에서의 적용 가능성을 검증할 필요가 있다.';
  const current = first + ' ' + tail;
  assert.ok(buildSentenceProposals(current, merged).some(p => p.ownershipConflict));
  const result = accumulateSafeEdits({source:current,current,candidate:merged,
    evaluateDepth:()=>({applicable:true,pass:true,metrics:{substantiveEditRatio:.5}})});
  assert.equal(result.outputText, current);
  assert.ok(result.rejectedCodes.includes('partial_sentence_ownership_ambiguous'));
  // Same total count is not proof of 1:1 correspondence.
  assert.ok(buildSentenceProposals(current, merged + ' 별도 조사를 계획했다.').some(p => p.ownershipConflict));
  assert.ok(buildSentenceProposals(current, first.replace('평가해야 한다', '비교 평가한다')+' '+tail)
    .every(p => !p.ownershipConflict));
});

test('restored tail repetition survives minor whole-sentence repairs and distant similar claims', () => {
  const source = '추가 조사를 통해 교육 효과와 현장 적용 가능성을 검증할 필요가 있다.\n\n앞으로는 실제 참가자에게 맞는 교육 자료를 개발하고 적용한 뒤 교육 전후의 지식과 대응 능력을 평가해 교육 효과와 현장 적용 가능성을 검증할 필요가 있다.';
  const outputText = source.replace('앞으로는', '앞으로')+' 이를 통해 교육 효과와 현장 적용 가능성을 검증할 필요가 있다.';
  assert.ok(korean.analyzeKoreanRefinement({source, outputText}).issueCodes.includes('source_restore_echo'));
});

test('equivalent finite enumeration predicates do not create a false quality warning', () => {
  const text = '첫 번째 의의는 지역 문제를 공동체의 관점에서 다룬 데 있다. 두 번째 의의는 교육의 선행 사례로 활용했다는 점이다.';
  assert.ok(!korean.analyzeKoreanRefinement({source:'지역 문제와 교육 사례를 검토했다.',outputText:text}).issueCodes.includes('enumeration_parallelism'));
});

test('source-backed ordinal item begins its own paragraph after final layout', () => {
  const { restoreOrdinalParagraphGaps } = require('../engine-gpt-prod/koreanOrdinal');
  const source = '조사한 내용을 정리했다.\n첫째, 장비를 점검한다. 기록을 함께 살핀다.\n둘째, 현장의 의견을 듣는다.';
  const outputText = source.replaceAll('\n', ' ');
  const direct = restoreOrdinalParagraphGaps(source, outputText);
  assert.ok(direct.text.includes('\n\n첫째,'));
  assert.ok(direct.text.includes('\n\n둘째,'));
  assert.equal(direct.text.replace(/\s/gu, ''), outputText.replace(/\s/gu, ''));
  assert.equal(restoreOrdinalParagraphGaps(source, direct.text).repairCount, 0);
  assert.equal(restoreOrdinalParagraphGaps(source, outputText.replace('둘째, ', '')).repairCount, 0);
  const quote = '그는 “첫째, 기록한다. 둘째, 점검한다.”라고 말했다.';
  assert.equal(restoreOrdinalParagraphGaps(quote, quote).repairCount, 0);
  const chunks = structure.splitChunksForGpt(source).chunks;
  const final = structure.restoreFinalDocumentLayout({source, outputText, chunks, mode:'blog', normalizeVisualGaps:true});
  assert.ok(final.text.includes('\n\n첫째,'));
  assert.ok(final.text.includes('\n\n둘째,'));
  assert.equal(final.contentPreserved, true);
  const polish = structure.restoreFinalDocumentLayout({source, outputText:source, chunks, mode:'polish', normalizeVisualGaps:false});
  assert.equal(polish.ordinalGapCount, 0);
});
