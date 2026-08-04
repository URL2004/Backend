'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const discourseAudit = require('../engine-gpt-prod/discourseAudit');
const fingerprintAudit = require('../engine-gpt-prod/fingerprintAudit');
const humanizationDepth = require('../engine-gpt-prod/humanizationDepth');
const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const layoutStructure = require('../engine-gpt-prod/layoutStructure');
const resumeCoverage = require('../engine-gpt-prod/resumeCoverage');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const voiceProfile = require('../engine-gpt-prod/voiceProfile');

test('영문 apostrophe를 닫는 인용부호로 오인해 공백을 넣지 않는다', () => {
  const text = 'Let’s Grow 캠페인은 함께 성장하자는 뜻이다.';
  const formatting = koreanRefinement.applySafeFormattingRepairs({
    source: text,
    outputText: text,
    documentProfile: { profile: 'marketing_ad' }
  });
  const deterministic = koreanRefinement.applySafeDeterministicRepairs({
    source: text,
    outputText: text,
    documentProfile: { profile: 'marketing_ad' }
  });
  assert.equal(formatting.text, text);
  assert.equal(deterministic.text, text);
  assert.doesNotMatch(deterministic.text, /Let’\s+s/u);
});

test('원문에 붙어 있던 복합 조사가 다음 행으로 밀리면 다시 붙인다', () => {
  const source = '문제는 데이터 처리 방식의 한계에서도 발생한다.';
  const output = '문제는 데이터 처리 방식의 한계\n에서도 발생한다.';
  const repaired = koreanRefinement.applySafeFormattingRepairs({
    source,
    outputText: output,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.equal(repaired.text, source);
  assert.equal(repaired.changeCounts.particle_linebreak_join, 1);
  assert.equal(structureChunk.countOrphanParticleLineBoundaries(repaired.text), 0);
});

test('PDF 복사의 행두 마침표와 마침표 단독 행을 안전하게 복원한다', () => {
  const output = '첫 문장입니다\n. 둘째 문장입니다\n.\n셋째 문장입니다.';
  const repaired = koreanRefinement.applySafeFormattingRepairs({
    source: output,
    outputText: output,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.equal(repaired.text, '첫 문장입니다.\n둘째 문장입니다.\n셋째 문장입니다.');
  assert.equal(repaired.changeCounts.leading_sentence_period_artifact, 2);
});

test('도입문 뒤의 불릿 없는 세로 명사구 목록을 구조 행으로 판정한다', () => {
  const source = [
    '은의커에서 제시한 요소는',
    '중앙 캐릭터',
    '상단 타이틀',
    '영문 이름',
    '세리프 폰트',
    '좌측 정보',
    '배경 영문',
    '정보 박스',
    '입니다. 각 요소를 순서대로 설명하겠습니다.'
  ].join('\n');
  const listRows = layoutStructure.buildLineRecords(source).filter(record => record.role === 'list');
  assert.equal(listRows.length, 7);
  assert.deepEqual(listRows.map(record => record.text).slice(0, 2), ['중앙 캐릭터', '상단 타이틀']);
  const collapsed = source.replace('은의커에서 제시한 요소는\n중앙 캐릭터', '은의커에서 제시한 요소는 중앙 캐릭터');
  assert.equal(structureChunk.compareStructuralRoleSignatures(source, collapsed).pass, false);
});

test('잠긴 복합 제목이 결과에서 여러 행으로 갈리면 원문 한 행을 복원한다', () => {
  const heading = '1.지원동기및진로계획:';
  const source = `${heading}\n저는 현장을 경험하고 싶습니다.`;
  const output = '1.지원동기\n및진로계획:\n저는 현장을 경험하고 싶습니다.';
  const restored = structureChunk.restoreLockedHeadingLayout(source, output, [{
    locked: true,
    lockType: 'heading',
    text: heading
  }]);
  assert.equal(restored.missingCount, 0);
  assert.equal(restored.text, source);
});

test('출산하는 사람과 아이를 같은 출산 주체로 묶은 문장을 결정론적으로 고친다', () => {
  const source = '가족 모두는 언니의 출산과 아이의 건강을 바라고 있다.';
  const output = '가족 모두는 언니와 아이가 건강하게 출산을 맞이하기를 바라고 있다.';
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'general_essay' }
  });
  assert.equal(audit.issues.find(item => item.code === 'coordinated_birth_role_mismatch')?.introducedCount, 1);
  const repaired = koreanRefinement.applySafeDeterministicRepairs({
    source,
    outputText: output,
    documentProfile: { profile: 'general_essay' }
  });
  assert.equal(repaired.text, '가족 모두는 언니가 건강하게 출산하고 아이도 건강하기를 바라고 있다.');
  assert.ok(repaired.changeCodes.includes('coordinated_birth_role_mismatch'));
});

test('전문 개념의 정상 의역은 구어체 강등이 아니며 실제 구어 강등은 잡는다', () => {
  const source = '입사 초기 업무를 수행하면서 기술 역량을 갖추고 싶었습니다.';
  const professional = '입사 초기에는 기술 역량이 필요하다고 판단했습니다.';
  assert.equal(
    koreanRefinement.detectProfessionalDowngrade(source, professional, 'resume_application'),
    null
  );
  const downgraded = koreanRefinement.detectProfessionalDowngrade(
    '자료를 분석하여 설계 흐름을 구성했습니다.',
    '자료를 함께 봐서 흐름부터 짰습니다.',
    'resume_application'
  );
  assert.equal(downgraded?.code, 'professional_register_downgrade');
});

test('내포절 관형형은 이중 주제로 세지 않고 실제 이중 주제는 유지한다', () => {
  const valid = koreanRefinement.detectTextIssues(
    '나는 이 원칙이 경어에만 해당하는 것이 아니라 언어 전반에 적용된다고 생각한다.'
  );
  const validAttributive = koreanRefinement.detectTextIssues(
    '영상을 보는 동안, 우리는 이미 운영체제라는 소프트웨어와 상호작용하고 있었다.'
  );
  const invalid = koreanRefinement.detectTextIssues(
    '이번 활동을 하면서 나는 예술 작품은 새롭게 바라보았습니다.'
  );
  assert.equal(valid.some(item => item.code === 'double_topic_chain'), false);
  assert.equal(validAttributive.some(item => item.code === 'double_topic_chain'), false);
  assert.equal(invalid.some(item => item.code === 'double_topic_chain'), true);
});

test('자소서의 학습 결론 누락을 앞뒤 앵커로 원래 위치에 복원한다', () => {
  const source = [
    '산업안전기사 취득을 다음 목표로 정했습니다.',
    '시간을 나누어 꾸준히 준비한 결과 이번 달 실기 합격이라는 성과를 얻었습니다.',
    '이 과정을 통해 목표 달성은 특별한 재능보다 방향을 정하고 지속하는 힘에서 나온다는 것을 배웠습니다.',
    '현대자동차에서도 새로운 기술과 환경을 적극적으로 배우겠습니다.'
  ].join(' ');
  const output = [
    '산업안전기사 취득을 다음 목표로 정했습니다.',
    '시간을 나누어 꾸준히 준비한 결과 이번 달 실기 합격이라는 성과를 얻었습니다.',
    '현대자동차에서도 새로운 기술과 환경을 적극적으로 배우겠습니다.'
  ].join(' ');
  const profile = { profile: 'resume_application' };
  const audit = resumeCoverage.auditResumeCoverage(source, output, profile);
  assert.equal(audit.pass, false);
  assert.ok(audit.omissions.some(item => item.types.includes('learning')));
  const restored = resumeCoverage.restoreMissingClaimsLocally({
    source,
    currentOutput: output,
    audit,
    maxRestoreCount: 2
  });
  assert.equal(restored.applied, true);
  assert.match(restored.text, /목표 달성은 특별한 재능보다/u);
  assert.equal(resumeCoverage.auditResumeCoverage(source, restored.text, profile).pass, true);
});

test('기능성 표현의 조사 교체와 제한적 대조 의역은 엔진 지문으로 오인하지 않는다', () => {
  const particle = fingerprintAudit.auditFingerprint(
    '이 방식은 공정할 수 있다는 점을 보여 준다.',
    '이 방식은 공정할 수 있다는 점도 보여 준다.',
    { profile: 'long_explainer' }
  );
  assert.equal(particle.issueCodes.includes('engine_phrase_fingerprint'), false);
  const limitative = fingerprintAudit.detectContrastRelationShift(
    '단순히 전공 지식을 가진 학생이 아니라 문제를 해결하는 사람입니다.',
    '전공 지식만 갖춘 학생에 머무르지 않고 문제를 해결하는 사람입니다.'
  );
  const categorical = fingerprintAudit.detectContrastRelationShift(
    '새로운 도구의 개발이 아니라 인간의 판단을 구조화하는 데 초점을 둔다.',
    '새로운 도구의 개발에 머무르지 않고 인간의 판단을 구조화하는 데 초점을 둔다.'
  );
  assert.equal(limitative.detected, false);
  assert.equal(categorical.detected, true);
});

test('기존 성찰의 알 수 있었다를 확인할 수 있었다로 바꿔도 새 평가가 아니다', () => {
  const report = discourseAudit.compareDiscourse(
    '이번 과제를 통해 제도의 한계를 알 수 있었다.',
    '이번 과제를 통해 제도의 한계를 확인할 수 있었다.'
  );
  assert.equal(report.codes.includes('new_evaluation'), false);
  assert.equal(report.codes.includes('rhetorical_role_shift'), false);
});

test('원문의 닫는 인용부호 하나를 보완한 경우 인용 개수 변경 경고를 내지 않는다', () => {
  const source = "책은 '절대경어인 반면 일본어는 '우치-소토'를 쓰고 '상대경어'라고 설명한다.";
  const output = "책은 '절대경어'인 반면 일본어는 '우치-소토'를 쓰고 '상대경어'라고 설명한다.";
  const audit = voiceProfile.auditDirectQuoteIntegrity(source, output);
  assert.equal(audit.countChanged, true);
  assert.equal(audit.punctuationOnlyChange, true);
  assert.equal(audit.pass, true);
});

test('최소 계약을 통과한 target-only 결과는 운영 회복 호출을 시작하지 않는다', () => {
  const report = {
    applicable: true,
    pass: true,
    minimumEffectPass: true,
    plan: { targetSubstantiveEditMin: 0.25 },
    metrics: { targetDepthMet: false, substantiveEditRatio: 0.22 }
  };
  assert.equal(humanizationDepth.needsHumanizationRecovery(report), false);
  assert.equal(humanizationDepth.needsHumanizationRecovery(report, { includeTargetOnly: true }), true);
});
