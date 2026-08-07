'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const freezeBlocks = require('../engine/freezeblocks');
const documentProfile = require('../engine-gpt-prod/documentProfile');
const endingStyle = require('../engine-gpt-prod/endingStyleAudit');
const fingerprint = require('../engine-gpt-prod/fingerprintAudit');
const humanizationDepth = require('../engine-gpt-prod/humanizationDepth');
const layoutStructure = require('../engine-gpt-prod/layoutStructure');
const resumeCoverage = require('../engine-gpt-prod/resumeCoverage');
const sourcePreflight = require('../engine-gpt-prod/sourcePreflight');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const voiceProfile = require('../engine-gpt-prod/voiceProfile');
const deliveryPolicy = require('../lib/humanizeDeliveryPolicy');
const engine = require('../engine-gpt-prod');

test('v2.5.33: 번호·괄호가 붙은 참고문헌 제목을 모든 계층이 같은 헤딩으로 본다', () => {
  assert.equal(freezeBlocks.isRefHeadingLine('[참고문헌]'), true);
  assert.equal(freezeBlocks.isRefHeadingLine('4. 참고문헌'), true);
  assert.equal(freezeBlocks.isRefHeadingLine('— 5) References:'), true);
  assert.equal(freezeBlocks.isAppendixHeadingLine('[부록 A]'), true);

  const eligible = humanizationDepth.eligibleProseSentences([
    '본문은 사람이 자연스럽게 읽을 수 있도록 구성했다.',
    '[4. 참고문헌]',
    '홍길동. (2025). 연구 제목. 학술지, 1(2), 115-140.',
    '[부록 A]',
    '부록의 설명 문장은 다시 편집 대상이 된다.'
  ].join('\n'));
  assert.equal(eligible.some(sentence => /홍길동/u.test(sentence)), false);
  assert.equal(eligible.some(sentence => /부록의 설명/u.test(sentence)), true);
});

test('v2.5.33: 꼬리가 잘린 참고문헌 잠금 블록을 순서·유사도 폴백으로 원문 복원한다', () => {
  const source = [
    '1. 서론',
    '이 글은 참고문헌 보존을 확인한다.',
    '',
    '참고문헌',
    '홍길동. (2025). 긴 연구 제목과 세부 분석. 한국연구학회지, 18(2), pp. 115-140.'
  ].join('\n');
  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  const damaged = source.replace('pp. 115-140.', 'pp. 115-14');
  const restored = structureChunk.restoreLockedStructureLayout({ source, outputText: damaged, chunks: plan.chunks });
  assert.equal(restored.pass, true, JSON.stringify(restored));
  assert.ok(restored.approximateRestoredCount >= 1, JSON.stringify(restored));
  assert.equal(restored.text, source);
  const audit = structureChunk.buildStructureAudit({
    source,
    integritySource: source,
    outputText: restored.text,
    chunks: plan.chunks,
    plan
  });
  assert.equal(audit.protectedBlockChangedCount, 0);
  assert.equal(audit.pass, true, JSON.stringify(audit));
});

test('v2.5.33: 단독 탭 다열 행을 표로 잠그고 셀 순서 붕괴를 구조 감사가 잡는다', () => {
  const source = '비교 항목\t기준\t결과';
  const report = layoutStructure.analyzeLineStructure(source);
  assert.equal(report.tableLineCount, 1);
  assert.deepEqual(report.tableCellSequence, [3]);
  const profile = documentProfile.detectDocumentProfile(`${source}\n표 아래의 일반 설명 문장입니다.`);
  assert.ok(profile.formatProfile.flags.includes('compressed_multicolumn'));
  const comparison = structureChunk.compareStructuralRoleSignatures(source, '비교 항목 기준 결과');
  assert.equal(comparison.tableColumnOwnershipPass, false);
  assert.ok(comparison.losses.some(item => item.code === 'table_column_ownership_lost'));
  assert.equal(layoutStructure.tableColumnCount('A\t\tC'), 3);
  assert.equal(layoutStructure.tableColumnCount('| A | | C |'), 3);
});

test('v2.5.33: 보호 블록·표 열 경고는 현행 정책대로 전달 검토이며 기술 차단이 아니다', () => {
  const result = deliveryPolicy.applyDeliveryPolicy({
    status: 'needs_review',
    criticals: [
      { gate: 'protected_block_changed' },
      { gate: 'table_column_ownership_lost' }
    ],
    warnings: []
  }, { mode: 'blog' });
  assert.equal(result.decision, 'deliver_review');
  assert.equal(result.report.status, 'needs_review');
  assert.equal(result.report.criticals.length, 0);
});

test('v2.5.33: 라벨 뒤의 완결 직접 인용은 본문 편집 청크가 아니라 quote 잠금 블록이다', () => {
  const source = '소감: “저는 이 활동에서 협업의 중요성을 배웠습니다.”';
  const plan = structureChunk.splitChunksForGpt(source);
  assert.ok(plan.chunks.some(chunk => chunk.lockType === 'label_prefix' && chunk.locked));
  assert.ok(plan.chunks.some(chunk => chunk.lockType === 'quote' && chunk.locked));
  assert.equal(plan.chunks.some(chunk => !chunk.locked && /협업의 중요성/u.test(chunk.text)), false);
});

test('v2.5.33: 사라진 직접 인용 구분자는 내용이 유일할 때만 원문 인용으로 복원한다', () => {
  const source = '교사는 “자발적으로 참여”라고 기록했습니다.';
  const output = '교사는 자발적으로 참여라고 기록했습니다.';
  const before = voiceProfile.auditDirectQuoteIntegrity(source, output);
  assert.equal(before.pass, false);
  assert.equal(before.punctuationOnlyChange, false);
  const restored = voiceProfile.restoreDirectQuoteContents(source, output);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.equal(restored.text, source);
  assert.equal(restored.auditAfter.pass, true);
});

test('v2.5.33: 본문 중간 편집 지시는 제거하되 인용·코드 안의 같은 문구는 보존한다', () => {
  const source = [
    '첫 문단의 실제 본문입니다.',
    '',
    '4번째 문단 뒤에 새 문단을 추가해 주세요.',
    '',
    '```text',
    '4번째 문단 뒤에 새 문단을 추가해 주세요.',
    '```',
    '',
    '마지막 실제 본문입니다.'
  ].join('\n');
  const result = sourcePreflight.auditAndSanitizeSource(source);
  assert.equal(result.issueCodes.includes('source_edit_instruction_artifact'), true);
  assert.equal((result.text.match(/4번째 문단 뒤에 새 문단을 추가해 주세요\./gu) || []).length, 1);
  assert.match(result.text, /```text[\s\S]*추가해 주세요\.[\s\S]*```/u);
});

test('v2.5.33: 대학 학업·진로 계획서는 보고서가 아니라 지원서로 우선 분류한다', () => {
  const source = [
    '지원 동기',
    '저는 귀 대학의 시각디자인학과에 지원하고자 합니다.',
    '입학 후에는 1학년 수강 계획부터 전공 탐색을 차근차근 진행하겠습니다.',
    '2학년에는 교수님의 연구 지도를 바탕으로 전공 심화 계획을 세우겠습니다.',
    '졸업 후 진로 계획도 재학 중 경험을 토대로 구체화하겠습니다.'
  ].join('\n');
  const profile = documentProfile.detectDocumentProfile(source);
  assert.equal(profile.profile, 'resume_application', JSON.stringify(profile.candidateProfiles));
  assert.ok(profile.signals.universityApplicationSignals >= 2);
});

test('v2.5.33: 짧은 절로 나뉜 지원서도 문서 전체의 습니다체 이탈을 감지한다', () => {
  const source = [
    '1. 지원 동기',
    '저는 문제를 직접 확인했습니다. 자료도 함께 정리했습니다.',
    '2. 학업 계획',
    '입학 후 기초 과목을 이수하겠습니다. 전공 수업에도 성실히 참여하겠습니다.',
    '3. 진로 계획',
    '현장 경험을 꾸준히 쌓겠습니다. 배운 내용도 기록하겠습니다.'
  ].join('\n');
  const output = source
    .replace('저는 문제를 직접 확인했습니다.', '저는 문제를 직접 확인했다.')
    .replace('자료도 함께 정리했습니다.', '자료도 함께 정리했다.');
  const audit = endingStyle.auditEndingStyle(source, output, { profile: 'resume_application' });
  assert.equal(audit.pass, false, JSON.stringify(audit));
  assert.equal(audit.documentFallback?.issue, true);
  assert.ok(audit.issueCodes.includes('ending_style_mixed'));
});

test('v2.5.33: 학습 경험을 보유 역량으로 강화하거나 대응 문장의 화자를 지우면 의미 이동이다', () => {
  const source = '저는 현장 점검에 참여하며 안전 관리의 중요성을 배웠습니다.';
  const output = '현장 점검에 참여하며 안전 관리 역량을 갖추었습니다.';
  const audit = fingerprint.detectSemanticRelationShifts(source, output);
  const families = new Set(audit.shifts.map(item => item.family));
  assert.ok(families.has('learning_changed_to_possession'), JSON.stringify(audit));
  assert.ok(families.has('speaker_evidence_removed'), JSON.stringify(audit));
});

test('v2.5.33: 자소서 커버리지는 배웠다를 갖추었다로 바꾼 결과를 별도 강도 이동으로 기록한다', () => {
  const source = '저는 현장 점검에 참여하며 안전 관리의 중요성을 배웠습니다.';
  const output = '저는 현장 점검에 참여하며 안전 관리 역량을 갖추었습니다.';
  const audit = resumeCoverage.auditResumeCoverage(source, output, { profile: 'resume_application' });
  assert.equal(audit.pass, false, JSON.stringify(audit));
  assert.equal(audit.strengthShiftCount, 1);
  assert.ok(audit.issueCodes.includes('resume_claim_strength_shift'));
  assert.equal(audit.repairTargets[0].strengthShift, true);
});

test('v2.5.33: 강도 이동은 누락 문장처럼 삽입해 중복시키지 않고 모델 수리 실패 시 경고로 남긴다', () => {
  const source = [
    '저는 현장 자료를 정리했습니다.',
    '저는 점검에 참여하며 안전 관리의 중요성을 배웠습니다.',
    '이후 확인 결과를 보고서로 작성했습니다.'
  ].join(' ');
  const output = source.replace(
    '저는 점검에 참여하며 안전 관리의 중요성을 배웠습니다.',
    '저는 점검에 참여하며 안전 관리 역량을 갖추었습니다.'
  );
  const audit = resumeCoverage.auditResumeCoverage(source, output, { profile: 'resume_application' });
  assert.equal(audit.strengthShiftCount, 1, JSON.stringify(audit));
  const restored = resumeCoverage.restoreMissingClaimsLocally({ source, currentOutput: output, audit });
  assert.equal(restored.applied, false);
  assert.equal(restored.text, output);
});

test('v2.5.33: 순수 산문의 보수적 문단 병합은 기본 OFF이고 플래그에서만 작동한다', () => {
  const source = [
    '저는 현장 자료를 먼저 정리했습니다.',
    '',
    '이를 통해 반복되는 오류의 원인을 확인했습니다.',
    '',
    '또한 팀원과 확인 결과를 공유했습니다.',
    '',
    '그 결과 다음 시험의 기준을 명확히 세웠습니다.'
  ].join('\n');
  const chunks = structureChunk.splitChunksForGpt(source, { coalesceEditable: true }).chunks;
  const previous = process.env.PARAGRAPH_MERGE_PROSE;
  try {
    delete process.env.PARAGRAPH_MERGE_PROSE;
    const disabled = structureChunk.restoreParagraphLayout({
      source,
      outputText: source,
      chunks,
      mode: 'blog',
      requestStrength: 'basic',
      documentProfile: { profile: 'personal_essay', confidence: 0.9, formatProfile: { flags: [] } }
    });
    assert.notEqual(disabled.policy, 'cohesive_prose_merge');

    process.env.PARAGRAPH_MERGE_PROSE = '1';
    const enabled = structureChunk.restoreParagraphLayout({
      source,
      outputText: source,
      chunks,
      mode: 'blog',
      requestStrength: 'basic',
      documentProfile: { profile: 'personal_essay', confidence: 0.9, formatProfile: { flags: [] } }
    });
    assert.equal(enabled.policy, 'cohesive_prose_merge', JSON.stringify(enabled));
    assert.equal(enabled.afterCount, 3);
  } finally {
    if (previous == null) delete process.env.PARAGRAPH_MERGE_PROSE;
    else process.env.PARAGRAPH_MERGE_PROSE = previous;
  }
});

test('v2.5.33: 오프라인 깊이 쌍도 잠긴 표를 운영과 같은 분모 토큰으로 제외한다', () => {
  const source = ['항목\t기준\t결과', '', '일반 산문 문장은 편집 대상입니다.'].join('\n');
  const chunks = structureChunk.splitChunksForGpt(source, { coalesceEditable: true }).chunks;
  const pair = engine.buildHumanizationDepthPair({
    source,
    outputText: source.replace('항목\t기준\t결과', '항목\t기준'),
    chunks
  });
  assert.equal(pair.denominatorVersion, 'locked-prose-v1');
  assert.equal(pair.missCount, 0, JSON.stringify(pair));
  assert.ok(pair.frozenLockedCount >= 1);
  assert.match(pair.source, /ZXQLOCK/u);
  assert.match(pair.output, /ZXQLOCK/u);
  assert.equal(pair.sourceHash.length, 12);
});
