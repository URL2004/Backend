'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const structure = require('../engine-gpt-prod/structureChunk');
const korean = require('../engine-gpt-prod/koreanRefinement');
const omission = require('../engine-gpt-prod/omissionRestore');
const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');
const {
  shouldSkipWholeDocumentDepthRetryAfterSectionRecovery,
  needsPerceivedHumanizationRecovery,
  effectStatusForNotices,
  classifyPolishEditKind
} = require('../engine-gpt-prod');

test('원문 절 번호가 쪼개지거나 다른 번호로 바뀌면 역할 개수와 무관하게 실패한다', () => {
  const source = [
    '# 14. 결론 및 나의 생각',
    '11. 느낀 점 및 확장 탐구'
  ].join('\n');
  const outputText = [
    '# 1',
    '4. 결론 및 나의 생각',
    '1',
    '1. 느낀 점 및 확장 탐구'
  ].join('\n');
  const comparison = structure.compareOriginalStructuralMarkers(source, outputText);
  assert.equal(comparison.pass, false);
  assert.deepEqual(
    comparison.losses.map(item => item.marker),
    ['# 14.', '11.']
  );
});

test('원문 대비 새로 생긴 조사 단독 행 경계를 구조 오류로 센다', () => {
  const source = '이 개념은 조직의 실제 사례를 설명하며 분석 결과를 함께 제시한다.';
  const outputText = '이 개념\n은 조직의 실제 사례\n를 설명하며 분석 결과\n를 함께 제시한다.';
  const audit = structure.buildStructureAudit({
    source,
    integritySource: source,
    outputText,
    chunks: [],
    plan: {}
  });
  assert.equal(audit.originalStructurePass, false);
  assert.equal(audit.introducedOrphanParticleBoundaryCount, 3);
  assert.equal(audit.pass, false);
});

test('마크다운 불릿의 굵은 라벨 전체를 잠그고 본문만 편집 대상으로 둔다', () => {
  const text = '* **1. 문제의 정의:** 가치사슬의 범위를 먼저 정리한다.';
  const pieces = structure.splitEditablePrefixPiece({
    text,
    start: 0,
    end: text.length
  });
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].forceLockType, 'bullet_prefix');
  assert.equal(pieces[0].text, '* **1. 문제의 정의:** ');
  assert.equal(pieces[1].forceEditable, true);
  assert.equal(pieces[1].text, '가치사슬의 범위를 먼저 정리한다.');
});

test('반복 어근이 단해·단히처럼 잘린 결과를 감지하고 해당 원문 문장만 복원한다', () => {
  const source = '이 소재는 단단해서 쉽게 흔들리지 않았고, 연결부도 단단하게 고정되어 있었다.';
  const outputText = '이 소재는 단해 쉽게 흔들리지 않았고, 연결부도 단히 고정되어 있었다.';
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText,
    documentProfile: { profile: 'report_assignment' },
    mode: 'assignment'
  });
  const issue = audit.issues.find(item => item.code === 'reduplicative_root_loss');
  assert.equal(issue?.introducedCount, 2);
  assert.deepEqual(
    issue?.details?.alignedLosses.map(item => item.outputToken),
    ['단해', '단히']
  );
  const restored = korean.restoreIntroducedIntegritySentences({ source, outputText, audit });
  assert.equal(restored.applied, true);
  assert.equal(restored.text, source);
  assert.ok(restored.restoredCodes.includes('reduplicative_root_loss'));
});

test('의미 심사기가 확인한 마지막 결론 문단 통누락을 앞 문단 뒤에 원문 그대로 복원한다', () => {
  const previous = '두 사례를 비교하면 연구 방법의 차이가 결과의 차이를 만든다는 점을 알 수 있다. 이 비교는 각 영역의 특성을 구분하는 기준이 된다.';
  const conclusion = '결과적으로 실패의 가치는 오류 자체가 아니라 그것을 해석하고 수정하는 과정에 있다. 실패를 지식의 한계를 드러내는 계기로 받아들일 때 더 나은 판단과 실천으로 나아갈 수 있다.';
  const source = `${previous}\n${conclusion}`;
  const result = omission.restoreConfirmedSemanticOmissions({
    source,
    outputText: previous,
    semanticReport: {
      violations: [{
        type: 'omission',
        span: '',
        detail: '마지막 결론의 핵심 논지가 누락되었습니다.'
      }]
    }
  });
  assert.equal(result.applied, true);
  assert.equal(result.restored[0].paragraphRestore, true);
  assert.equal(result.text, `${previous}\n\n${conclusion}`);
  assert.equal(result.remainingViolations.length, 0);
});

test('저의 경험이 들어간 학습 성찰 보고서를 자소서로 오인하지 않는다', () => {
  const source = [
    '결산수정분개에 대한 이해와 실무적 필요성',
    '서론',
    '회계원리를 처음 배우며 분개라는 용어 앞에서 어려움을 겪었던 나의 경험을 돌아보았다. 본 글에서는 학습자의 시선에서 발생주의가 필요한 이유를 정리하고자 한다.',
    '본론',
    '결산수정분개는 현금의 이동 시점과 경제적 사건의 발생 시점이 다를 때 재무제표를 바로잡는 절차이다. 선급비용과 미지급비용의 사례를 비교하면 그 기능을 이해할 수 있다.',
    '결론',
    '이번 과제를 통해 회계를 단순한 입출금 기록이 아니라 경제적 실질을 표현하는 체계로 이해하게 되었다. 남은 학기에도 관련 개념을 더 공부하고 싶다.'
  ].join('\n');
  const profile = detectDocumentProfile(source, { basicStyle: 'report' });
  assert.notEqual(profile.profile, 'resume_application');
  assert.equal(profile.signals.applicationIntentSignals, 0);
  assert.equal(profile.signals.directApplicationContextSignals, 0);
});

test('명시적 지원 동기와 직무 기여가 있는 자기소개서는 계속 자소서로 판정한다', () => {
  const source = [
    '지원 동기',
    '저의 가장 큰 강점은 실험 데이터를 끝까지 검증하는 태도입니다. 프로젝트에서 측정 오차의 원인을 분석하고 공정을 개선해 재현성을 확보했습니다.',
    '입사 후 포부',
    '이 경험을 바탕으로 귀사의 연구 개발 직무에 기여하겠습니다. 입사 후에는 분석 역량을 더 익혀 신뢰성 높은 제품을 만드는 연구원이 되겠습니다.'
  ].join('\n');
  const profile = detectDocumentProfile(source, { basicStyle: 'report' });
  assert.equal(profile.profile, 'resume_application');
  assert.ok(profile.signals.directApplicationContextSignals >= 1);
});

test('안전한 섹션 회복 뒤에도 체감 최소선이 남으면 후속 회복을 계속한다', () => {
  const mildReport = {
    applicable: true,
    pass: false,
    minimumEffectPass: true,
    userReviewRequired: false,
    metrics: {
      substantiveEditRatio: 0.14,
      substantiveChangedSentenceCount: 5,
      substantiveChangedSentenceRatio: 0.35
    }
  };
  assert.equal(shouldSkipWholeDocumentDepthRetryAfterSectionRecovery({
    longDocument: true,
    sectionRecoveryUniqueAppliedSectionCount: 2,
    humanizationDepthReport: mildReport
  }), false);
  assert.equal(needsPerceivedHumanizationRecovery(mildReport), true);
  assert.equal(shouldSkipWholeDocumentDepthRetryAfterSectionRecovery({
    longDocument: true,
    sectionRecoveryUniqueAppliedSectionCount: 2,
    humanizationDepthReport: { ...mildReport, minimumEffectPass: false }
  }), false);
  assert.equal(shouldSkipWholeDocumentDepthRetryAfterSectionRecovery({
    longDocument: true,
    sectionRecoveryUniqueAppliedSectionCount: 2,
    generalSurfaceRetryPending: true,
    humanizationDepthReport: mildReport
  }), false);
  const completedReport = {
    ...mildReport,
    pass: true,
    metrics: {
      ...mildReport.metrics,
      targetDepthMet: true
    },
    plan: {
      targetSubstantiveEditMin: 0.13
    }
  };
  assert.equal(needsPerceivedHumanizationRecovery(completedReport), false);
  assert.equal(shouldSkipWholeDocumentDepthRetryAfterSectionRecovery({
    longDocument: true,
    sectionRecoveryUniqueAppliedSectionCount: 2,
    humanizationDepthReport: completedReport
  }), true);
});

test('깊이·정형 골격 미달만 효과 제한으로 표시하고 관측성 리듬 알림은 정상으로 둔다', () => {
  assert.equal(effectStatusForNotices([
    { code: 'paragraph_readability' },
    { code: 'sentence_distribution_shift' }
  ]), 'normal');
  assert.equal(effectStatusForNotices([
    { code: 'paragraph_readability' },
    { code: 'humanization_depth_below_target' }
  ]), 'limited');
  assert.equal(effectStatusForNotices([
    { code: 'repeated_reflection_conclusion' }
  ]), 'limited');
});

test('polish의 공백·문장부호 전용 변화와 실제 텍스트 변화를 구분해 기록한다', () => {
  assert.equal(classifyPolishEditKind('보여 주는 글입니다.', '보여주는 글입니다.'), 'spacing_only');
  assert.equal(classifyPolishEditKind('내용을 정리했습니다', '내용을 정리했습니다.'), 'punctuation_only');
  assert.equal(classifyPolishEditKind('내용을 정리했습니다.', '핵심 내용을 정돈했습니다.'), 'textual');
  assert.equal(classifyPolishEditKind('같은 문장입니다.', '같은 문장입니다.'), 'unchanged');
});
