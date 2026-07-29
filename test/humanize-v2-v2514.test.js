'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const korean = require('../engine-gpt-prod/koreanRefinement');
const fingerprint = require('../engine-gpt-prod/fingerprintAudit');
const sourcePreflight = require('../engine-gpt-prod/sourcePreflight');
const structure = require('../engine-gpt-prod/structureChunk');
const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');

const resumeProfile = {
  profile: 'resume_application',
  targetRegister: 'professional'
};

test('기술 경력서의 확정 오타·띄어쓰기·감소율 괄호만 결정론적으로 고친다', () => {
  const source = '자극 모드와 착,유 모드를 비교하고 결과를 내부성적서로 문서화했습니다. 감소율은 1200-800/1200*100=33.3퍼센트입니다.';
  const repaired = korean.applySafeDeterministicRepairs({
    source,
    outputText: source,
    documentProfile: resumeProfile
  });
  assert.equal(
    repaired.text,
    '자극 모드와 착유 모드를 비교하고 결과를 내부 성적서로 문서화했습니다. 감소율은 (1200-800)/1200*100=33.3퍼센트입니다.'
  );
  assert.deepEqual(
    new Set(repaired.changeCodes),
    new Set(['lactation_mode_spelling', 'internal_report_spacing', 'percentage_formula_parentheses'])
  );
});

test('계산 결과가 괄호식과 일치하지 않거나 이미 괄호가 있으면 수식을 추측 교정하지 않는다', () => {
  const ambiguous = '비율은 1200-800/1200*100=20퍼센트로 기록했습니다.';
  const correct = '비율은 (1200-800)/1200*100=33.3퍼센트로 기록했습니다.';
  const quoted = '보고서에는 “1200-800/1200*100=33.3퍼센트”라고 적혀 있습니다.';
  assert.equal(korean.applySafeDeterministicRepairs({ source: ambiguous, outputText: ambiguous }).text, ambiguous);
  assert.equal(korean.applySafeDeterministicRepairs({ source: correct, outputText: correct }).text, correct);
  assert.equal(korean.applySafeDeterministicRepairs({ source: quoted, outputText: quoted }).text, quoted);
});

test('유속·유량과 구현 범위는 임의 통일하지 않고 원문 확인 항목으로 분리한다', () => {
  const source = [
    '후보 펌프의 유속을 확인한 뒤 상위 유량 펌프를 비교했습니다.',
    'Trade-off를 검토한 뒤 다른 trade-off 조건도 기록했습니다.',
    '실제 사용 조건에서 부품의 노화가 가능하도록 시험용 F/W를 작성했습니다.',
    '119에 문자 및 전화 신고가 이루어지도록 연동했습니다.'
  ].join(' ');
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: source,
    documentProfile: resumeProfile,
    mode: 'assignment'
  });
  const reviewCodes = new Set(audit.sourceReviewWarnings.map(item => item.code));
  assert.equal(reviewCodes.has('technical_term_consistency_review'), true);
  assert.equal(reviewCodes.has('technical_notation_consistency_review'), true);
  assert.equal(reviewCodes.has('technical_scope_ambiguity_review'), true);
  assert.equal(audit.repairableCodes.includes('technical_term_consistency_review'), false);
  assert.equal(audit.repairableCodes.includes('technical_scope_ambiguity_review'), false);
});

test('구어적 전문 문체 계열이 서로 교체돼 총개수가 같아도 신규 격하를 놓치지 않는다', () => {
  const source = '진짜 중요한 과제였습니다. 1차 후보 펌프로 실현 가능성을 시험한 결과 기준을 충족했습니다.';
  const outputText = '중요한 과제였습니다. 1차 후보 펌프로 실현 가능성을 시험해 보니 기준을 충족했습니다.';
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText,
    documentProfile: resumeProfile,
    mode: 'assignment'
  });
  const issue = audit.issues.find(item => item.code === 'formal_register_residual');
  assert.equal(issue.beforeCount, 1);
  assert.equal(issue.afterCount, 1);
  assert.equal(issue.introducedCount, 1);
  assert.equal(issue.details.comparison.introducedFamilies.colloquial_validation_result, 1);
  assert.equal(issue.details.comparison.resolvedFamilies.casual_emphasis, 1);
  assert.equal(audit.residualWarnings.some(item => item.code === 'korean_formal_register_residual'), true);
});

test('시험해 보니·함께 놓고 비교와 기관-역할 도치를 전문 문서 수리 대상으로 잡는다', () => {
  const source = '두 방식을 검토하며 성능을 비교했습니다. 이 업무는 체납관리단이 수행하는 중요한 역할이라고 생각합니다.';
  const outputText = '두 방식을 함께 놓고 비교했습니다. 중요한 역할이 국세외수입 체납관리단이라고 생각합니다.';
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText,
    documentProfile: resumeProfile,
    mode: 'assignment'
  });
  assert.equal(audit.repairableCodes.includes('formal_register_residual'), true);
  assert.equal(audit.repairableCodes.includes('role_definition_inversion'), true);
  assert.equal(audit.introducedIssueCount >= 2, true);
});

test('요구를 사양으로 구체화한 방향을 기존 사양에 요구를 반영한 관계로 바꾸면 복원한다', () => {
  const source = '임상적 요구를 성능 사양과 시스템 전원 구조로 구체화하는 역할을 맡았습니다.';
  const outputText = '성능 사양과 시스템 전원 구조에 임상적 요구를 구체적으로 반영하는 역할을 맡았습니다.';
  const audit = fingerprint.auditFingerprint(source, outputText, resumeProfile);
  assert.equal(audit.pass, false);
  assert.ok(
    audit.semanticRelations.shifts.some(item => item.family === 'requirement_translation_changed_to_insertion'),
    JSON.stringify(audit.semanticRelations)
  );
  const restored = fingerprint.restoreUnsafeRelationSentences(source, outputText, audit);
  assert.equal(restored.applied, true);
  assert.equal(restored.text, source);
});

test('중요성 판단을 의무로 강화하거나 직무 역량을 추상적 기반으로 약화하면 검출한다', () => {
  const importanceSource = '아이의 존재 자체를 인정하는 것이 중요함.';
  const importanceOutput = '아이의 존재 자체를 인정해야 함.';
  const importance = fingerprint.auditFingerprint(importanceSource, importanceOutput, 'general_essay');
  assert.ok(
    importance.semanticRelations.shifts.some(item => item.family === 'importance_hardened_to_obligation'),
    JSON.stringify(importance.semanticRelations)
  );

  const competencySource = '고객 요구사항을 설계 산출물에 일관되게 반영하는 역량을 길렀습니다.';
  const competencyOutput = '고객 요구사항을 이해했고, 이를 구현하는 기반도 다졌습니다.';
  const competency = fingerprint.auditFingerprint(competencySource, competencyOutput, resumeProfile);
  assert.ok(
    competency.semanticRelations.shifts.some(item => item.family === 'competency_claim_weakened_to_foundation'),
    JSON.stringify(competency.semanticRelations)
  );
});

test('소설의 인물과 질문을 해석하는 1인칭 감상문을 창작문으로 오인하지 않는다', () => {
  const source = [
    '이 소설을 읽으면서 작가가 왜 이런 질문을 던졌는지 오래 생각했다.',
    '작품 속 주인공은 용서와 고통 사이에서 계속 흔들리고, 등장인물의 선택은 당시 사회의 분위기와도 맞닿아 있다.',
    '나는 이 장면이 개인의 믿음만 다루는 것이 아니라 타인의 고통을 이해하는 태도를 보여 준다고 생각한다.',
    '이 작품에서 반복되는 침묵은 인물들이 쉽게 말하지 못한 감정을 드러낸다.',
    '작품 속 갈등이 해결되지 않은 채 남는 이유도 작가가 독자에게 판단을 넘기기 위한 장치로 해석할 수 있다.',
    '주인공의 마지막 선택은 앞부분의 행동과 대조되며 이 소설의 질문을 다시 떠올리게 한다.',
    '다만 한 가지는 분명해진 것 같다. 작가는 정답을 제시하기보다 독자가 자신의 판단을 돌아보게 한다.'
  ].join(' ');
  const profile = detectDocumentProfile(source, { basicStyle: 'blog' });
  assert.equal(profile.profile, 'personal_essay', JSON.stringify(profile.candidateProfiles));
  assert.equal(profile.signals.literaryReflectionFrame, true);
  assert.ok((profile.candidateProfiles.find(item => item.profile === 'creative')?.score || 0) <= 0.95);
});

test('실제 대화와 장면이 이어지는 소설 본문은 계속 창작문으로 판정한다', () => {
  const source = [
    '소년은 어두운 골목에서 젖은 발자국을 바라보았다.',
    '“여기서 기다린 거야?” 소녀가 물었다.',
    '그는 창문 너머의 달빛을 한 번 보고는 조용히 문을 열었다.',
    '“아무에게도 말하지 마.” 그가 속삭였다.',
    '방 안의 숨소리가 가까워지자 두 사람은 서로를 바라보며 천천히 웃었다.'
  ].join(' ');
  const profile = detectDocumentProfile(source, { basicStyle: 'blog' });
  assert.equal(profile.profile, 'creative', JSON.stringify(profile.candidateProfiles));
});

test('추정 표현을 확정 결론으로 강화하면 원문 문장을 복원한다', () => {
  const source = '다만 한 가지는 분명해진 것 같다. 이 질문은 독자의 판단을 돌아보게 한다.';
  const outputText = '다만 한 가지는 분명해졌다. 이 질문은 독자의 판단을 돌아보게 한다.';
  const audit = fingerprint.auditFingerprint(source, outputText, 'personal_essay');
  assert.ok(
    audit.semanticRelations.shifts.some(item => item.family === 'epistemic_hedge_hardened'),
    JSON.stringify(audit.semanticRelations)
  );
  const restored = fingerprint.restoreUnsafeRelationSentences(source, outputText, audit);
  assert.equal(restored.applied, true);
  assert.equal(restored.text, source);
});

test('장르 판정 전에도 시의 짧은 행갈이는 PDF 강제 줄바꿈으로 합치지 않는다', () => {
  const poem = [
    '캡처된 순간',
    '',
    '내가 찍은 노을이',
    '누군가의 피드에서 웃고 있다',
    '이름 석 자만 지운 채',
    '',
    '손끝으로 눌렀던 셔터 소리는 사라지고',
    '클릭 세 번이면 내 하루는 남의 것이 된다',
    '',
    '나는 다시 셔터를 누른다',
    '이번엔 아무도 모르게',
    '내 이름을 사진 속에 새겨 넣듯'
  ].join('\n');
  assert.equal(sourcePreflight.looksLikeCreativeLineLayout(poem), true);
  const repaired = sourcePreflight.repairSourceLayoutArtifacts(poem);
  assert.equal(repaired.text, poem);
  assert.equal(repaired.changes.some(item => item.code === 'source_forced_linewrap_repaired'), false);
  const audited = sourcePreflight.auditAndSanitizeSource(poem);
  assert.equal(audited.text, poem);
  assert.equal(audited.changed, false);
});

test('짧게 강제 개행된 일반 산문은 창작문으로 오인하지 않고 계속 복원한다', () => {
  const prose = [
    '기업의 책임 의식을',
    '변화시킬 수 있다는 사실은 중요합니다.',
    '',
    '자료의 결과를',
    '검토할 필요가 있습니다.',
    '',
    '따라서 다음 단계의',
    '검증을 진행해야 합니다.',
    '',
    '마지막으로 결과를',
    '내부 문서에 기록합니다.'
  ].join('\n');
  assert.equal(sourcePreflight.looksLikeCreativeLineLayout(prose), false);
  const repaired = sourcePreflight.repairSourceLayoutArtifacts(prose);
  assert.match(repaired.text, /기업의 책임 의식을 변화시킬 수 있다는/u);
});

test('참고문헌 잠금 블록 안에 생긴 빈 줄은 원문의 정확한 행갈이로 복원한다', () => {
  const source = [
    'References',
    '[1] Kim, M. (2024). Technical design study. Journal of Engineering.',
    '[2] Lee, S. (2023). Clinical requirements. Medical Device Review.'
  ].join('\n');
  const outputText = [
    'References',
    '[1] Kim, M.',
    '',
    '(2024). Technical design study. Journal of Engineering.',
    '[2] Lee, S. (2023). Clinical requirements. Medical Device Review.'
  ].join('\n');
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
  assert.ok(plan.chunks.some(chunk => chunk.locked && chunk.lockType === 'reference_item'));
  const restored = structure.restoreLockedStructureLayout({
    source,
    outputText,
    chunks: plan.chunks
  });
  assert.equal(restored.pass, true);
  assert.equal(restored.blocks.restoredCount, 1);
  assert.equal(restored.text, source);
});
