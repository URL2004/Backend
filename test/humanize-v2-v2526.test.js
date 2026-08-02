'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const candidateIntegrity = require('../engine-gpt-prod/candidateIntegrity');
const documentProfile = require('../engine-gpt-prod/documentProfile');
const layoutStructure = require('../engine-gpt-prod/layoutStructure');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const voiceProfile = require('../engine-gpt-prod/voiceProfile');
const dedupe = require('../engine/dedupe');

test('빈 줄 없는 제목·부제·반복 소제목을 같은 구조 판정기로 잠근다', () => {
  const longBody = '인공지능 기술은 사회의 생산 방식과 판단 구조를 바꾸고 있으며, 인간은 이 변화가 가져오는 기회와 위험을 함께 검토해야 한다. '.repeat(2).trim();
  const source = [
    'AI와 인류의 미래: 공존을 위한 윤리와 주체적 인간의 길',
    '인공지능 시대의 도래와 인간의 실존적 질문',
    longBody,
    'AI가 가져올 생산성의 혁명',
    longBody,
    'AI 시대의 위기와 윤리적 딜레마',
    longBody,
    '기술을 넘어서는 공존의 윤리',
    longBody
  ].join('\n');
  const roles = layoutStructure.buildLineRecords(source)
    .filter(record => !record.blank)
    .map(record => record.role);
  assert.deepEqual(roles, [
    'title', 'title', 'prose',
    'heading', 'prose',
    'heading', 'prose',
    'heading', 'prose'
  ]);

  const merged = source.replace('\nAI 시대의 위기와 윤리적 딜레마\n', ' AI 시대의 위기와 윤리적 딜레마\n');
  const audit = structureChunk.compareLineAnchorLayout(source, merged);
  assert.equal(audit.pass, false);
  assert.ok(audit.boundaryChanges.some(item => item.kind === 'heading'));
});

test('이모지 라벨·날짜 메타데이터·대시 번호 제목은 행과 접두부를 보존한다', () => {
  const source = [
    '🕑 시간: 오전 10시부터 오후 1시까지 운영합니다.',
    '* 제출일자: 2026. 07. 05',
    '',
    '가장 공감되는 것 — 2. 고객 가치에 대한 집착',
    '고객이 말하기 전에 필요한 것을 먼저 살피는 태도가 중요합니다.'
  ].join('\n');
  const records = layoutStructure.buildLineRecords(source).filter(record => !record.blank);
  assert.equal(records[0].role, 'label_inline');
  assert.equal(records[1].role, 'signature');
  assert.equal(records[2].role, 'heading');

  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  assert.equal(structureChunk.mergeChunks(plan.chunks), source);
  assert.ok(plan.chunks.some(chunk => chunk.lockType === 'label_prefix' && /🕑\s*시간/u.test(chunk.text)));
  assert.ok(plan.chunks.some(chunk => chunk.locked && /제출일자/u.test(chunk.text)));

  const broken = source
    .replace('🕑 시간:', '🕑\n시간:')
    .replace('2026. 07. 05', '2026.\n07. 05');
  const audit = structureChunk.compareLineAnchorLayout(source, broken);
  assert.equal(audit.pass, false);
  assert.ok(audit.losses.length + audit.boundaryChanges.length >= 2);

  const fullwidthTime = '🕑 시간： 오전 10:30부터 운영합니다.';
  const editedTime = '🕑 시간： 오전 10:30부터 문을 엽니다.';
  assert.equal(structureChunk.compareLineAnchorLayout(fullwidthTime, editedTime).pass, true);
});

test('창작문 행 병합은 후보 단계와 최종 행 감사에서 모두 거부한다', () => {
  const source = [
    '비가 그친 자리',
    '젖은 돌 위로',
    '작은 빛이 번지고',
    '나는 한참 서 있었다'
  ].join('\n');
  const collapsed = [
    '비가 그친 자리',
    '젖은 돌 위로 작은 빛이 번지고',
    '나는 한참 서 있었다'
  ].join('\n');
  const exact = structureChunk.auditExactLineStructure(source, collapsed);
  assert.equal(exact.pass, false);
  const integrity = candidateIntegrity.auditCandidateIntegrity({
    source,
    before: source,
    candidate: collapsed,
    documentProfile: 'creative',
    mode: 'assignment'
  });
  assert.equal(integrity.pass, false, JSON.stringify(integrity));
  assert.ok(integrity.reasons.includes('structure_integrity_worsened'));
});

test('주차별 개인 적용 일지는 교사 세특이 아니라 학생 자기성찰로 라우팅한다', () => {
  const source = [
    '운동학습 및 심리 수업일지와 적용 과제',
    '제 2주: 스포츠심리학의 이해',
    '수업 내용 요약: 심리적 요인이 경기력에 미치는 영향을 학습함.',
    '내 시합/일상 적용: 내 경기에서 불안이 커질 때 집중력이 흔들렸음을 돌아봄.',
    '활용 방안: 제 훈련 일지에 불안 시점을 기록하겠음.',
    '제 3주: 성격과 운동수행',
    '수업 내용 요약: 성격과 환경의 상호작용을 학습함.',
    '내 시합/일상 적용: 내향적인 성향이 강해 경기 전 대화가 길면 집중이 흐트러짐.',
    '활용 방안: 나의 경기 전 루틴을 점검하겠음.'
  ].join('\n');
  const detected = documentProfile.detectDocumentProfile(source);
  assert.equal(detected.profile, 'student_self_assessment', JSON.stringify(detected.candidates));
  assert.ok(detected.confidence >= 0.75);
});

test('개인 적용을 일반적인 경우로 바꾼 행은 검출하고 해당 원문 행만 복원한다', () => {
  const source = [
    '제 3주: 성격과 운동수행',
    '수업 내용 요약: 성격과 환경의 관계를 학습함.',
    '내 시합/일상 적용: 내향적인 성향이 강해 경기 전 대화가 길면 집중력이 분산됨.',
    '활용 방안: 나만의 대기 루틴을 정립하겠음.'
  ].join('\n');
  const output = source.replace(
    '내향적인 성향이 강해 경기 전 대화가 길면 집중력이 분산됨.',
    '내향적인 성향이 강한 경우, 경기 전 대화가 길면 집중력이 분산됨.'
  );
  const audit = voiceProfile.auditPersonalScopeGeneralization(source, output);
  assert.equal(audit.introducedCount, 1, JSON.stringify(audit));
  const restored = voiceProfile.restorePersonalScopeGeneralizations(source, output);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.equal(restored.text, source);

  const sourceVoice = voiceProfile.buildVoiceProfile(source, {
    documentProfile: 'student_self_assessment'
  });
  const voiceAudit = voiceProfile.auditVoice(sourceVoice, output, {
    documentProfile: 'student_self_assessment',
    sourceText: source
  });
  assert.ok(voiceAudit.warnings.some(item => item.code === 'personal_scope_generalized'));
});

test('같은 원문 결론을 두 번 성찰한 인접 문장만 원문 한 문장으로 복원한다', () => {
  const source = "이번 토론을 통해 마케팅이 단순한 홍보 수단을 넘어, 기업과 소비자가 '신뢰와 취향'을 매개로 관계를 맺는 마케팅의 본질에 대해 다시 한번 깊이 생각해 보는 계기가 되었습니다.";
  const output = "이번 토론을 통해 마케팅을 단순한 홍보 수단으로만 보지 않고, 마케팅의 본질을 다시 한번 깊이 생각해 보는 계기가 되었습니다. 기업과 소비자가 '신뢰와 취향'을 매개로 어떻게 관계를 맺어야 하는지, 마케팅의 본질을 다시 한번 깊이 생각해 보게 되었습니다.";
  const repaired = dedupe.removeGeneratedAdjacentRestatements(source, output);
  assert.equal(repaired.applied, true, JSON.stringify(repaired));
  assert.equal(repaired.text, source);
  assert.deepEqual(repaired.families, ['reflection']);

  const authoredPair = `${output} 두 관점은 서로 다른 근거를 사용합니다.`;
  const preserved = dedupe.removeGeneratedAdjacentRestatements(authoredPair, authoredPair);
  assert.equal(preserved.applied, false);

  const opposite = '규제가 강화되어 참여가 줄었습니다. 규제가 완화되어 참여가 늘었습니다.';
  assert.equal(dedupe.removeGeneratedAdjacentRestatements(source, opposite).applied, false);
});
