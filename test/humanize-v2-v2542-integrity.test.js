'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const korean = require('../engine-gpt-prod/koreanRefinement');
const fs = require('node:fs');
const path = require('node:path');

const RESUME_PROFILE = { profile: 'resume_application', targetRegister: 'formal' };

test('v2.5.42: 같은 원문 결론을 두 문장으로 반복한 신규 문장만 제거한다', () => {
  const source = '실습에서 익힌 현장 대응 능력과 환자를 향한 진심 어린 공감 역량을 바탕으로, 현장에서도 환자의 신체와 마음 모두를 든든하게 지켜내는 준비된 간호사로 성장하겠습니다.';
  const output = `${source} 현장에서도 이상 신호에 신속히 대처하고 환자의 마음을 다독이며, 신체와 마음을 함께 지키는 간호사로 성장하겠습니다.`;
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: RESUME_PROFILE,
    mode: 'assignment'
  });
  const issue = audit.issues.find(item => item.code === 'adjacent_semantic_repetition');
  assert.equal(issue?.introducedCount, 1, JSON.stringify(issue));
  assert.deepEqual(issue?.details?.safeRemovalOrdinals, [2]);

  const repaired = korean.restoreIntroducedIntegritySentences({ source, outputText: output, audit });
  assert.equal(repaired.applied, true, JSON.stringify(repaired));
  assert.equal(repaired.duplicateRepair.removedCount, 1);
  assert.equal(repaired.text.trim(), source);
});

test('v2.5.42: 기존 반복이 사라지고 다른 위치에 새 반복이 생겨도 개수 상쇄로 놓치지 않는다', () => {
  const source = [
    '첫 활동에서 익힌 기획 역량과 협업 태도를 바탕으로 조직의 목표를 책임 있게 달성하는 구성원으로 성장하겠습니다.',
    '기획 역량과 협업 태도로 조직 목표를 책임 있게 달성하는 구성원으로 성장하겠습니다.',
    '현장 대응 능력과 공감 역량을 바탕으로 고객의 안전과 마음을 함께 지키는 담당자로 성장하겠습니다.'
  ].join(' ');
  const output = [
    '첫 활동의 기획 경험과 협업 태도로 조직 목표를 책임 있게 달성하는 구성원으로 성장하겠습니다.',
    '현장 대응 능력과 진심 어린 공감 역량을 바탕으로 고객의 안전과 마음 모두를 세심하게 지키는 담당자로 성장하겠습니다.',
    '현장에서도 안전과 마음을 함께 지키는 담당자로 성장하겠습니다.'
  ].join(' ');
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: RESUME_PROFILE,
    mode: 'assignment'
  });
  const issue = audit.issues.find(item => item.code === 'adjacent_semantic_repetition');
  assert.ok(Number(issue?.introducedCount || 0) >= 1, JSON.stringify(issue));
});

test('v2.5.42: 서로 다른 수치·부정·목표를 가진 결론 문장은 자동 제거하지 않는다', () => {
  const source = '첫째, 오류율을 10% 줄이겠습니다. 둘째, 검토 시간을 20% 줄이지 않고 정확도를 높이겠습니다.';
  const output = source;
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: RESUME_PROFILE,
    mode: 'assignment'
  });
  const repaired = korean.removeIntroducedGroundedDuplicateSentences({ source, outputText: output });
  assert.equal(repaired.applied, false, JSON.stringify(audit));
  assert.equal(repaired.text, output);
});

test('v2.5.42: 최종 구조 롤백은 전달 직전 수리 checkpoint 이후에 실행된다', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'engine-gpt-prod', 'index.js'), 'utf8');
  const rollback = source.indexOf("addUniqueCode(structureIntegrityRollbackCodes, 'final_structure_safe_candidate_restore')");
  assert.ok(rollback > 0);
  for (const stage of [
    'delivery_korean_source_restore',
    'unsupported_specificity_restore',
    'delivery_generated_dedupe',
    'delivery_integrity_layout',
    'delivery_statistical_atom_restore',
    'delivery_quote_restore'
  ]) {
    const checkpoint = source.indexOf(`rememberStructureSafeOutput(outputText, '${stage}')`);
    assert.ok(checkpoint > 0, `${stage} checkpoint가 없다`);
    assert.ok(checkpoint < rollback, `${stage} checkpoint가 최종 구조 롤백 뒤에 있다`);
  }
});
