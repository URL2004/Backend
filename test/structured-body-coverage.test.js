'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldCallModel, primaryCoverage } = require('../engine-gpt-prod/chunkPolicy');
const { splitChunksForGpt, mergeChunks } = require('../engine-gpt-prod/structureChunk');
const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');
const { buildChunkWorkUnits } = require('../engine-gpt-prod/shortChunkBatch');

for (const mode of ['blog', 'formal', 'polish']) {
  test(`${mode}: short editable content is not bypassed by length, ending or unfamiliar typo`, () => {
    for (const text of ['결과를 정리하는 방싟', '다음 관찰 계획', 'abc', '観察記録', '实验记录', '42']) {
      assert.equal(shouldCallModel({ text }, mode), true, text);
      assert.equal(shouldCallModel({ text, locked: true }, mode), false, text);
    }
    for (const text of ['', ' \n\t', '---', '•']) assert.equal(shouldCallModel({ text }, mode), false);
  });
  test(`${mode}: label-heavy document retains every editable ID in both worker plans`, () => {
    const source = Array.from({length: 26}, (_, i) => `항목 ${i + 1}\n관찰: 시료 ${i + 1}의 색과 냄새를 기록하였다.\n계획: 다음 관찰 결과를 비교하는 방식`).join('\n\n');
    const profile = detectDocumentProfile(source);
    assert.ok(profile.formatProfile.flags.includes('label_heavy'));
    const {chunks} = splitChunksForGpt(source, {coalesceEditable: true, formatProfile: profile.formatProfile});
    const expected = chunks.filter(c => shouldCallModel(c, mode));
    assert.ok(expected.length > 18);
    for (const enabled of [false, true]) {
      const records = buildChunkWorkUnits(chunks, enabled).flat().map(i => ({ index: chunks[i].index,
        locked: !!chunks[i].locked, skipped: !shouldCallModel(chunks[i], mode) }));
      const summary = primaryCoverage(chunks, records, mode);
      assert.equal(summary.primaryEligibleChunkCount, expected.length);
      assert.equal(summary.primaryAttemptedChunkCount, expected.length);
      assert.equal(summary.primaryUnattemptedChunkCount, 0);
      assert.equal(new Set(records.map(r=>r.index)).size, chunks.length);
    }
    assert.equal(mergeChunks(chunks).trim(), source.trim());
  });
}
test('coverage distinguishes a skipped body from an attempted model failure', () => {
  const chunks = [{index:0,text:'제목',locked:true},{index:1,text:'짧은 본문'},{index:2,text:'다른 본문'},{index:3,text:'끝 본문'}];
  assert.deepEqual(primaryCoverage(chunks,[{index:0,locked:true},{index:1,skipped:true},{index:2,error:'timeout',fallback:true}], 'formal'), {
    primaryEligibleChunkCount:3,primaryAttemptedChunkCount:1,primaryUnattemptedChunkCount:2
  });
});
