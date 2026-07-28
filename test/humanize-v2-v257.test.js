'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const fingerprintAudit = require('../engine-gpt-prod/fingerprintAudit');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const candidateIntegrity = require('../engine-gpt-prod/candidateIntegrity');
const humanizePrompts = require('../engine-gpt-prod/prompts/humanize');
const humanizeUserBlock = require('../engine-gpt-prod/prompts/humanize/userBlock');

test('독립 항목 제목을 본문 조사와 이어 붙인 신규 비문을 감지하고 안전하게 복원한다', () => {
  const source = [
    '① 교사 중심 설명식 수업',
    '수업의 대부분은 교사가 주도했으며 설명과 시범이 먼저 제시되었다.',
    '',
    '④ 과정 중심 평가',
    '최종 결과에만 초점을 두지 않고 성장 과정을 함께 관찰한다.'
  ].join('\n');
  const output = [
    '① 교사 중심의 설명식 수업',
    '에서는 수업의 대부분을 교사가 주도했으며, 설명과 시범이 먼저 제시되었다.',
    '',
    '④ 과정 중심 평가',
    '는 최종 결과에만 초점을 두지 않고, 성장 과정을 함께 관찰한다.'
  ].join('\n');
  const profile = {
    profile: 'report_assignment',
    targetRegister: 'academic_formal',
    formatProfile: { flags: ['sectioned'] }
  };
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: profile,
    mode: 'assignment'
  });
  const issue = audit.issues.find(item => item.code === 'orphan_structural_particle');
  assert.equal(audit.pass, false, JSON.stringify(audit));
  assert.equal(issue?.introducedCount, 2, JSON.stringify(audit));
  assert.deepEqual(issue?.details?.particles, ['에서는', '는']);

  const repaired = koreanRefinement.applySafeDeterministicRepairs({
    source,
    outputText: output,
    documentProfile: profile
  });
  assert.equal(repaired.changeCodes.includes('orphan_structural_particle'), true);
  assert.match(repaired.text, /① 교사 중심의 설명식 수업\n수업의 대부분/u);
  assert.match(repaired.text, /④ 과정 중심 평가\n최종 결과/u);
  assert.doesNotMatch(repaired.text, /\n(?:에서는|는)\s/u);

  const afterAudit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: repaired.text,
    documentProfile: profile,
    mode: 'assignment'
  });
  assert.equal(afterAudit.issueCodes.includes('orphan_structural_particle'), false, JSON.stringify(afterAudit));
});

test('일반 문장 안의 정상 조사는 구조 제목 뒤 고립 조사로 오인하지 않는다', () => {
  const source = [
    '학교에서는 학생 참여를 중요하게 다룬다.',
    '서울에서는 수업 자료를 먼저 확인했다.'
  ].join('\n');
  const issues = koreanRefinement.detectTextIssues(source, {
    profile: 'report_assignment',
    targetRegister: 'academic_formal'
  });
  assert.equal(issues.some(item => item.code === 'orphan_structural_particle'), false, JSON.stringify(issues));
});

test('늦은 후보가 구조 제목 뒤 조사만 남기면 공통 후보 감사가 거부한다', () => {
  const source = '① 설명식 수업\n수업의 대부분은 교사가 주도했다.';
  const candidate = '① 설명식 수업\n에서는 수업의 대부분을 교사가 주도했다.';
  const audit = candidateIntegrity.auditCandidateIntegrity({
    source,
    before: source,
    candidate,
    documentProfile: {
      profile: 'report_assignment',
      targetRegister: 'academic_formal',
      formatProfile: { flags: ['sectioned'] }
    },
    mode: 'assignment'
  });
  assert.equal(audit.pass, false, JSON.stringify(audit));
  assert.ok(audit.reasons.includes('korean_integrity_worsened'), JSON.stringify(audit));
});

test('외부 책임 제한을 개인 책임 이전으로 강화하고 선택 책임을 결과 책임으로 바꾸면 의미 감사가 복원한다', () => {
  const source = '그래서 상담에서는 외부 요인에 책임을 돌리는 방식에서 벗어나, 내담자가 더 나은 행동을 스스로 선택하고 그 선택에 책임지는 방향으로 이끕니다.';
  const output = '따라서 상담에서는 책임의 방향을 외부 요인에서 내담자 자신의 선택으로 옮기고, 더 나은 행동을 스스로 고르며 그 결과에 책임을 지도록 이끕니다.';
  const audit = fingerprintAudit.auditFingerprint(source, output, {
    profile: 'report_assignment'
  });
  const families = new Set(audit.semanticRelations.shifts.map(item => item.family));
  assert.equal(audit.pass, false, JSON.stringify(audit));
  assert.ok(families.has('responsibility_attribution_shifted_to_person'), JSON.stringify(audit));
  assert.ok(families.has('responsibility_object_changed_to_outcome'), JSON.stringify(audit));

  const restored = fingerprintAudit.restoreUnsafeRelationSentences(source, output, audit);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.equal(restored.text, source);
});

test('외부 요인만 탓하지 않고 현재 선택을 점검한다는 안전한 의역은 책임 전가로 오인하지 않는다', () => {
  const source = '상담에서는 외부 요인에만 책임을 돌리지 않고, 내담자가 현재 선택한 행동을 함께 점검합니다.';
  const output = '상담에서는 환경만 탓하지 않으며, 내담자가 지금 선택하고 있는 행동을 함께 살펴봅니다.';
  const audit = fingerprintAudit.detectSemanticRelationShifts(source, output);
  const families = new Set(audit.shifts.map(item => item.family));
  assert.equal(families.has('responsibility_attribution_shifted_to_person'), false, JSON.stringify(audit));
  assert.equal(families.has('responsibility_object_changed_to_outcome'), false, JSON.stringify(audit));

  const explicitNonTransfer = fingerprintAudit.detectSemanticRelationShifts(
    '상담에서는 외부 요인에 책임을 돌리는 방식에서 벗어나 현재의 선택을 함께 살핍니다.',
    '상담에서는 책임을 개인에게 옮기지 않고 외부 환경과 현재 선택을 함께 살핍니다.'
  );
  assert.equal(
    explicitNonTransfer.shifts.some(item => item.family === 'responsibility_attribution_shifted_to_person'),
    false,
    JSON.stringify(explicitNonTransfer)
  );
});

test('첫 번째와 두 번째 이유로 나뉜 두 문단은 일반 산문 재배치보다 원문 역할 경계를 우선한다', () => {
  const source = [
    '제가 선택이론을 꼽는 첫 번째 이유는 행동 변화의 목표를 분명히 보여 주기 때문입니다. 상담은 현재의 선택을 살핍니다. 이 관점은 내담자의 주체성을 강조합니다.',
    '두 번째 이유는 선택이론이 상담 과정의 길잡이로 작동한다는 점입니다. 현재 행동을 점검한 뒤 스스로 평가합니다. 마지막으로 구체적인 계획을 세웁니다.'
  ].join('\n\n');
  const output = [
    '제가 선택이론을 꼽는 첫 번째 이유는 행동 변화의 목표를 분명히 보여 주기 때문입니다. 상담은 현재의 선택을 살핍니다.',
    '이 관점은 내담자의 주체성을 강조합니다. 두 번째 이유는 선택이론이 상담 과정의 길잡이로 작동한다는 점입니다. 현재 행동을 점검한 뒤 스스로 평가합니다.',
    '마지막으로 구체적인 계획을 세웁니다.'
  ].join('\n\n');
  const restored = structureChunk.restorePostSemanticLayout({
    source,
    outputText: output,
    chunks: [],
    mode: 'blog',
    requestStrength: 'basic',
    documentProfile: {
      profile: 'report_assignment',
      confidence: 0.92,
      formatProfile: { flags: [] }
    }
  });
  const paragraphs = restored.text.split(/\n\s*\n/u).map(item => item.trim()).filter(Boolean);
  assert.equal(restored.paragraphs.policy, 'source_paragraph_roles', JSON.stringify(restored.paragraphs));
  assert.equal(paragraphs.length, 2, restored.text);
  assert.equal(paragraphs[0].includes('두 번째 이유'), false, restored.text);
  assert.match(paragraphs[1], /^두 번째 이유/u);
});

test('열거 역할이 없는 일반 두 문단은 새 예외로 원문 경계에 강제 고정하지 않는다', () => {
  const source = [
    '상담의 목표를 설명한다. 현재 행동을 함께 살핀다. 선택 가능한 대안을 정리한다.',
    '상담 과정도 설명한다. 현재 행동을 평가한다. 마지막으로 계획을 세운다.'
  ].join('\n\n');
  const result = structureChunk.restorePostSemanticLayout({
    source,
    outputText: source,
    chunks: [],
    mode: 'blog',
    requestStrength: 'basic',
    documentProfile: {
      profile: 'general_essay',
      confidence: 0.9,
      formatProfile: { flags: [] }
    }
  });
  assert.notEqual(result.paragraphs.policy, 'source_paragraph_roles', JSON.stringify(result.paragraphs));
});

test('구조 행 경계 프롬프트는 제목과 본문을 조사로 이어 붙이지 못하게 명시한다', () => {
  const instructions = humanizeUserBlock.buildBoundaryMarkerInstructions({
    lineBoundaryPolicy: 'structural',
    lineBoundaryMarkers: [{ marker: '[[[V2_LINE_0001]]]' }]
  });
  assert.match(instructions, /제목·항목명이면 그 행은 독립 구조/u);
  assert.match(instructions, /주어·목적어로 재사용/u);
  assert.match(instructions, /은·는·이·가·을·를·에서는/u);

  const built = humanizePrompts.buildHumanizePrompt('assignment', 'ko', {
    register: 'formal',
    requestStrength: 'advanced',
    documentProfile: { profile: 'report_assignment' }
  });
  assert.match(built.stable, /책임을 개인에게 옮긴다/u);
  assert.match(built.stable, /선택에 대한 책임을 결과·피해 전체에 대한 책임으로 넓히지 않는다/u);
  assert.equal(humanizePrompts.validateHumanizePrompt(built.stable).pass, true);
});
