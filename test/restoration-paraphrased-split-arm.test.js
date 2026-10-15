'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreSourceSentenceOrdinals } = require('../engine-gpt-prod/sourceSentenceRestore');
const fingerprint = require('../engine-gpt-prod/fingerprintAudit');

// Synthetic shape of a production duplicate: one compound source sentence is
// split in two, the lead arm is paraphrased below the exact-token join ratio,
// and only the tail arm was overwritten with the whole compound.
const SOURCE = '다음 설계에는 실험 결과를 반영해야 한다.\n\n'
  + '인쇄오류는 경고가 명확하지 않은 조건에서도 지속가능해 직원이 번짐을 확인할 때만 점검소를 이용하는 절차로는 초기에 파악하기 어렵다. '
  + '따라서 소모품을 교체할 때 시험 인쇄를 확인하는 과정이 중요하다.';
const OUTPUT = '다음 설계에는 실험에서 얻은 결과를 반영해야 한다.\n\n'
  + '인쇄오류는 뚜렷한 경고가 없어도 지속될 수 있다. '
  + '그래서 직원이 번짐을 볼 때만 점검소에 가는 절차로는 초기 파악이 어렵다. '
  + '따라서 소모품을 교체할 때 시험 인쇄를 확인하는 과정이 중요하다.';

test('a paraphrased split lead arm vetoes a partial whole-compound overwrite', () => {
  for (const maxOutputGroup of [1, 3]) {
    const restored = restoreSourceSentenceOrdinals(SOURCE, OUTPUT, [2], { maxOutputGroup });
    if (maxOutputGroup === 1) {
      assert.equal(restored.applied, false);
      assert.equal(restored.text, OUTPUT);
    }
    // A wider, proven alignment may replace both arms. Neither path may leave
    // the paraphrased lead next to the complete source clause.
    assert.equal(restored.text.includes('뚜렷한 경고가 없어도') && restored.text.includes('지속가능해'), false);
  }
  const relation = fingerprint.restoreUnsafeRelationSentences(SOURCE, OUTPUT, {
    violations: [{ code: 'semantic_relation_shift', sentenceOrdinals: [2] }]
  });
  assert.equal((relation.text.match(/지속가능해/gu) || []).length <= 1, true);
  assert.equal(relation.text.includes('뚜렷한 경고가 없어도') && relation.text.includes('지속가능해'), false);
});

test('a neighbour owned by the adjacent source sentence does not block restoration', () => {
  const source = '고혈압은 증상이 뚜렷하지 않아 관리 필요성을 느끼기 어렵다. '
    + '환자가 불편함을 느낄 때만 의료기관을 방문하는 방식으로는 조기에 발견하기 어렵다.';
  const output = '고혈압은 증상이 뚜렷하지 않아 관리 필요성을 느끼기 힘들다. '
    + '환자가 불편할 때만 병원을 찾으면 조기 발견이 어렵다고 볼 수 있다.';
  const restored = restoreSourceSentenceOrdinals(source, output, [2], { maxOutputGroup: 1 });
  assert.equal(restored.applied, true);
  assert.equal(restored.text.includes('관리 필요성을 느끼기 힘들다.'), true);
  assert.equal(restored.text.endsWith('조기에 발견하기 어렵다.'), true);
});

test('a plain 1:1 restoration is unchanged', () => {
  const restored = restoreSourceSentenceOrdinals(
    '첫 문장이다. 환자는 정기적으로 혈압을 확인해야 한다.',
    '첫 문장이다. 환자는 꾸준히 혈압을 살펴야 한다고 볼 수 있다.',
    [2],
    { maxOutputGroup: 1 }
  );
  assert.equal(restored.text, '첫 문장이다. 환자는 정기적으로 혈압을 확인해야 한다.');
});

test('a paragraph break is not treated as a split-arm boundary', () => {
  const source = '앞 문단은 관리 체계를 설명한다.\n\n환자는 정기적으로 혈압을 확인하고 필요한 경우 약물치료와 생활습관 관리를 지속해야 한다.';
  const output = '앞 문단은 혈압 관리와 약물치료 체계를 설명한다.\n\n환자는 혈압을 꾸준히 살피고 필요하면 약물치료와 생활습관 관리를 이어가야 한다고 볼 수 있다.';
  const restored = restoreSourceSentenceOrdinals(source, output, [2], { maxOutputGroup: 1 });
  assert.equal(restored.applied, true);
  assert.equal(restored.text.startsWith('앞 문단은 혈압 관리와 약물치료 체계를 설명한다.\n\n'), true);
});
