'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const korean = require('../engine-gpt-prod/koreanRefinement');
const { computePovSeed } = require('../engine/pov');
const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');
const depth = require('../engine-gpt-prod/humanizationDepth');
const sourceRedundancy = require('../engine-gpt-prod/sourceRedundancy');
const resumeCoverage = require('../engine-gpt-prod/resumeCoverage');
const voiceProfile = require('../engine-gpt-prod/voiceProfile');
const endingStyle = require('../engine-gpt-prod/endingStyleAudit');
const engine = require('../engine-gpt-prod');

test('아니다·아니었다를 존댓말 니다로 오인하지 않고 평서 종결로 판정한다', () => {
  assert.equal(endingStyle.endingStyle('계획형 창업이 아니다.'), 'plain');
  assert.equal(endingStyle.endingStyle('계획형 창업은 아니었다.'), 'plain');
  assert.equal(endingStyle.endingStyle('계획형 창업이 아닙니다.'), 'polite');
  assert.equal(endingStyle.endingStyle('계획형 창업이 아님.'), 'nominal');
  assert.equal(endingStyle.endingStyle('담당 선생님.'), 'other');
});

test('수정 문장 뒤에 남은 인용 서술 꼬리와 동일 절 꼬리를 원문 대조로 제거한다', () => {
  const source = [
    '한 학생이 “어떤 잎은 노랗고 어떤 잎은 초록색이에요?”라고 질문하였다.',
    '교사는 “더 궁금한 것은 무엇이니?”라고 질문하며 관찰 프로젝트를 시작한다.',
    '여러 활동을 이어 가며 “잘 자라려면 무엇이 필요할까?”와 같은 발문으로 탐구를 확장한다.'
  ].join(' ');
  const outputText = [
    '한 학생이 “어떤 잎은 노랗고 어떤 잎은 초록색이에요?”라고 물었다.',
    '라고 질문하였다.',
    '교사는 “더 궁금한 것은 무엇이니?”라고 묻고 관찰 프로젝트를 시작한다.',
    '라고 질문하며 관찰 프로젝트를 시작한다.',
    '여러 활동을 이어 가며 “잘 자라려면 무엇이 필요할까?”와 같은 발문으로 탐구를 확장한다.',
    '와 같은 발문으로 탐구를 확장한다.'
  ].join(' ');
  const before = korean.analyzeKoreanRefinement({
    source,
    outputText,
    documentProfile: { profile: 'report_assignment' },
    mode: 'assignment'
  });
  assert.equal(
    before.issues.find(item => item.code === 'introduced_residual_clause_duplication')?.introducedCount,
    3
  );
  const repaired = korean.applySafeDeterministicRepairs({
    source,
    outputText,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.equal(repaired.changeCodes.includes('introduced_residual_clause_duplication'), true);
  assert.equal(repaired.changeCount >= 3, true);
  assert.equal(repaired.text.includes('라고 질문하였다. 라고'), false);
  assert.equal((repaired.text.match(/관찰 프로젝트를 시작한다/gu) || []).length, 1);
  assert.equal((repaired.text.match(/와 같은 발문으로 탐구를 확장한다/gu) || []).length, 1);
});

test('원문에서는 붙어 있던 인용 명사구와 조사가 결과에서만 줄바꿈되면 다시 붙인다', () => {
  const source = "① 선택한 전략: '과정 목표'의 '숙달 목표' 전환 전략 및 예방 훈련";
  const outputText = [
    '① 선택한 전략:',
    "'과정 목표'",
    "의 '숙달 목표' 전환 전략 및 예방 훈련"
  ].join('\n');
  const repaired = korean.applySafeFormattingRepairs({
    source,
    outputText,
    documentProfile: {
      profile: 'clinical_record',
      formatProfile: { flags: ['questionnaire', 'line_sensitive', 'quote_sensitive'] }
    }
  });
  assert.equal(
    repaired.text,
    "① 선택한 전략: '과정 목표'의 '숙달 목표' 전환 전략 및 예방 훈련"
  );
  assert.equal(repaired.changeCounts.label_body_linebreak_join, 1);
  assert.equal(repaired.changeCounts.particle_linebreak_join, 1);
  assert.equal(repaired.brokenLineBreakRepairCount, 2);
});

test('원문 자체가 분리한 조사 행은 임의로 결합하지 않는다', () => {
  const source = ["'과정 목표'", "의 의미를 다음 절에서 설명한다."].join('\n');
  const repaired = korean.applySafeFormattingRepairs({
    source,
    outputText: source,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.equal(repaired.text, source);
  assert.equal(repaired.changeCounts.particle_linebreak_join || 0, 0);
});

test('잠긴 첫 제목도 글자를 바꾸지 않는 고신뢰 띄어쓰기만 교정한다', () => {
  const source = [
    '국제적인정을 받은 한국무용수가 해낼수 있는 역할과 동료 외1명',
    '',
    '본문은 제목에 제시된 활동의 범위와 참여 인원을 설명합니다.'
  ].join('\n');
  const repaired = korean.applySafeFormattingRepairs({
    source,
    outputText: source,
    documentProfile: {
      profile: 'report_assignment',
      formatProfile: { flags: ['sectioned'] }
    }
  });
  assert.equal(
    repaired.text.split('\n')[0],
    '국제적 인정을 받은 한국 무용수가 해낼 수 있는 역할과 동료 외 1명'
  );
  assert.equal(repaired.changeCounts.international_recognition_spacing, 1);
  assert.equal(repaired.changeCounts.korean_dancer_spacing, 1);
  assert.equal(repaired.changeCounts.dependent_noun_su_spacing, 1);
  assert.equal(repaired.changeCounts.other_people_count_spacing, 1);
});

test('지역 내 일자리를 1인칭 내 일로 세지 않는다', () => {
  const seed = computePovSeed('지역 내 일자리 부족이 이어지면서 청년 유출이 늘었다.');
  assert.equal(seed.ko_fp_singular, 0);
  assert.equal(seed.fp_singular, 0);
});

test('설문 항목 사이 빈 줄 정리는 행 구조 손실로 경고하지 않는다', () => {
  const source = [
    '1. 가장 기억에 남는 활동은 무엇입니까?',
    '',
    '2. 활동에서 맡은 역할을 설명해 주세요.',
    '',
    '3. 다음 계획은 무엇입니까?'
  ].join('\n');
  const output = source.replace(/\n\n/gu, '\n');
  const documentProfile = {
    profile: 'student_self_assessment',
    formatProfile: { flags: ['questionnaire'] }
  };
  const sourceVoice = voiceProfile.buildVoiceProfile(source, {
    documentProfile,
    mode: 'assignment'
  });
  assert.equal(sourceVoice.lineBoundaryPolicy, 'structural');
  const audit = voiceProfile.auditVoice(sourceVoice, output, {
    documentProfile,
    mode: 'assignment',
    sourceText: source
  });
  assert.equal(
    audit.warnings.some(item => item.code === 'line_structure_changed'),
    false,
    JSON.stringify(audit.warnings)
  );
});

test('설문에서 비어 있지 않은 항목 행이 합쳐지면 계속 경고한다', () => {
  const source = [
    '1. 가장 기억에 남는 활동은 무엇입니까?',
    '2. 활동에서 맡은 역할을 설명해 주세요.',
    '3. 다음 계획은 무엇입니까?'
  ].join('\n');
  const output = [
    '1. 가장 기억에 남는 활동은 무엇입니까?',
    '2. 활동에서 맡은 역할과 다음 계획을 설명해 주세요.'
  ].join('\n');
  const documentProfile = {
    profile: 'student_self_assessment',
    formatProfile: { flags: ['questionnaire'] }
  };
  const sourceVoice = voiceProfile.buildVoiceProfile(source, {
    documentProfile,
    mode: 'assignment'
  });
  const audit = voiceProfile.auditVoice(sourceVoice, output, {
    documentProfile,
    mode: 'assignment',
    sourceText: source
  });
  assert.equal(
    audit.warnings.some(item => item.code === 'questionnaire_structure_changed'),
    true,
    JSON.stringify(audit.warnings)
  );
});

test('문답형 문서는 질문을 잠그되 답변 내부 문장·문단 재구성을 허용한다', () => {
  const source = [
    '1. 자료를 어떻게 정리했습니까?',
    '자료를 수집한 뒤 정한 기준에 따라 분류하고 결과를 표에 정리했습니다.',
    '2. 다음 계획은 무엇입니까?',
    '분류 기준을 다시 검토하고 남은 자료에도 같은 절차를 적용하겠습니다.'
  ].join('\n');
  const candidate = [
    '1. 자료를 어떻게 정리했습니까?',
    '먼저 자료를 모았습니다.',
    '',
    '정한 기준으로 나눈 결과는 표에 정리했습니다.',
    '2. 다음 계획은 무엇입니까?',
    '분류 기준부터 다시 살핀 뒤 남은 자료에도 같은 절차를 적용하겠습니다.'
  ].join('\n');
  const profile = {
    profile: 'student_self_assessment',
    formatProfile: {
      primary: 'questionnaire',
      flags: ['questionnaire', 'line_sensitive']
    }
  };
  const plan = depth.buildHumanizationPlan(source, {
    requestStrength: 'advanced',
    documentProfile: profile
  });
  const audit = engine.auditGeneralSurfaceCandidate(
    source,
    candidate,
    null,
    profile,
    'assignment',
    source,
    plan
  );
  assert.equal(audit.pass, true, JSON.stringify(audit));
  assert.equal(audit.codes.includes('structure_loss'), false, JSON.stringify(audit));
});

test('무료 서비스를 논증하는 공식 글을 광고 문안으로 오인하지 않는다', () => {
  const source = [
    '디지털 무료 서비스의 정보 비대칭과 소비자 권리',
    '무료 서비스도 데이터라는 대가를 요구하며 계약 관계를 형성한다.',
    '플랫폼의 설계는 이용자의 기본권과 선택권에 영향을 미치므로 제도와 규제가 필요하다.',
    '따라서 권리 보호와 공공성을 우선하는 기준을 마련해야 한다.',
    '이 문제는 사적 자치와 소비자 보호의 관계에서 분석할 필요가 있다.'
  ].join('\n');
  const profile = detectDocumentProfile(source);
  assert.equal(profile.profile, 'report_assignment');
  assert.notEqual(profile.profile, 'marketing');
});

test('인사말로 시작해도 명시적 지원 의도와 직무 기여가 있으면 지원서로 판정한다', () => {
  const source = [
    '안녕하세요. 브랜드의 방향을 오래 지켜본 지원자입니다.',
    '저는 매장에서 고객을 응대하며 요구를 정리하고 판매 흐름을 개선했습니다.',
    '그 경험을 바탕으로 온라인 운영 직무에 기여하고 싶어 지원하였습니다.',
    '제가 맡은 업무를 끝까지 관리하며 조직의 구성원으로 성장하겠습니다.',
    '감사합니다.'
  ].join('\n');
  const profile = detectDocumentProfile(source);
  assert.equal(profile.profile, 'resume_application');
  assert.equal(profile.signals.applicationLetterFrame, true);
});

test('BMC·마케팅 제안 구조는 후기나 세특·창작문이 아니라 보고서로 판정한다', () => {
  const source = [
    '1. 고객(Customer)',
    '가족 단위 방문객과 교육 단체를 핵심 고객으로 설정한다.',
    '2. 가치 제안(Value Proposition)',
    '체험과 교육을 결합해 차별화된 가치를 제공한다.',
    '3. 가치 사슬(Value Chain)',
    '- 생산과 체험 운영을 연결함',
    '- 지역 유통망을 확보함',
    '4. 마케팅 전략',
    '시장 분석을 바탕으로 실행 방안과 기대 효과를 제안한다.'
  ].join('\n');
  const profile = detectDocumentProfile(source);
  assert.equal(profile.profile, 'report_assignment');
  assert.equal(profile.signals.structuredProposalFrame, true);
  assert.notEqual(profile.profile, 'review_blog');
  assert.notEqual(profile.profile, 'student_record_teacher');
});

test('명사형 종결이 많은 기획안도 학생 관찰 주체가 없으면 세특으로 판정하지 않는다', () => {
  const source = [
    '1. 기획의 기대 효과',
    '개인적 측면: 참여 장벽을 낮추는 계기가 됨.',
    '사회적 측면: 관련 주제의 자발적 확산을 이끌어 냄.',
    '- 짧은 영상 콘텐츠를 제작함',
    '- 참여 결과를 공유하도록 구성함',
    '- 운영 지표를 정기적으로 점검함'
  ].join('\n');
  const profile = detectDocumentProfile(source);
  assert.equal(profile.profile, 'report_assignment');
  assert.notEqual(profile.profile, 'student_record_teacher');
});

test('원작 영상화와 서사 재구성을 비교하는 탐구는 창작문으로 판정하지 않는다', () => {
  const source = [
    '웹소설 원작의 영상화 과정에서 서사가 어떻게 재구성되는지 비교하는 탐구이다.',
    '첫 작품은 원작의 인물 갈등을 영상 매체에서 축소하고 사건 순서를 바꾸었다.',
    '두 번째 작품은 웹툰과 드라마로 매체가 확장되면서 주제와 장면을 다르게 강조했다.',
    '이처럼 OSMU 과정의 각색이 원작의 의미와 서사 구조에 미치는 영향을 분석했다.'
  ].join('\n');
  const profile = detectDocumentProfile(source);
  assert.equal(profile.profile, 'report_assignment');
  assert.notEqual(profile.profile, 'creative');
});

test('학교 학습 포트폴리오는 취업 지원서가 아닌 학생 자기평가로 판정한다', () => {
  const source = [
    '진로와 관련된 영어 공부 방향',
    '공통영어 수업에서 듣기와 읽기 활동에 참여했습니다.',
    '1. 교과서 발표 및 분석',
    '지문을 선택한 이유와 지문 분석 내용을 정리했습니다.',
    '발표 후 변화 또는 발전',
    '핵심 내용을 설명하는 자신감이 생겼습니다.',
    '수행평가 소개',
    '수행평가에서 조언하는 편지글을 작성했습니다.'
  ].join('\n');
  const profile = detectDocumentProfile(source);
  assert.equal(profile.profile, 'student_self_assessment');
  assert.notEqual(profile.profile, 'resume_application');
});

test('MMPI·SCT 척도 해석과 상담 개입 문서는 임상 기록으로 판정한다', () => {
  const source = [
    'MMPI-2와 SCT 결과 해석',
    '수검자의 K척도와 억압 척도가 상승해 방어적인 수검 태도가 시사된다.',
    'SCT 반응과 연결하면 수행 불안과 감정 억제가 두 검사에서 공통으로 나타난다.',
    '내담자의 대인 불안을 낮추기 위해 감정 수용을 다루는 상담 개입이 필요하다.'
  ].join('\n');
  const profile = detectDocumentProfile(source);
  assert.equal(profile.profile, 'clinical_record');
  assert.ok(profile.signals.psychologicalAssessmentSignals >= 3);
});

test('책 선택 이유와 독서 경험을 풀어 쓴 글을 학술 논문으로 합산하지 않는다', () => {
  const source = [
    '작은 습관의 힘',
    '홍길동 지음',
    '이 책을 선택한 이유는 학기 중 생활 습관을 돌아보고 싶었기 때문이다.',
    '이 책은 저자가 여러 사례를 통해 반복의 중요성을 설명한다.',
    '책을 읽으며 가장 인상 깊었던 내용은 작은 행동을 매일 이어 가는 방법이었다.',
    '읽고 난 뒤 나의 계획을 무리하게 세우기보다 실천 가능한 단위로 나누게 되었다.'
  ].join('\n');
  const profile = detectDocumentProfile(source);
  assert.equal(profile.profile, 'personal_essay');
  assert.notEqual(profile.profile, 'academic_paper');
});

test('원문에 연속 반복된 설명 블록은 삭제하지 않고 후반 문장만 재구성 대상으로 표시한다', () => {
  const first = [
    '첫 단계에서는 시료의 온도를 일정하게 유지하고 변화 값을 매분 기록해 실험 조건을 통제하였으며 장비의 초기 상태도 함께 확인하였다.',
    '두 번째 단계에서는 반응 시간이 결과에 미치는 영향을 비교하기 위해 같은 장비로 세 차례 측정하고 각 측정의 시작 시각을 기록하였다.',
    '마지막 단계에서는 측정값을 표에 정리하고 오차 범위를 계산해 두 조건의 차이를 확인한 뒤 관찰 과정에서 생긴 예외도 따로 표시하였다.'
  ];
  const source = [...first, ...first].join(' ');
  const plan = sourceRedundancy.buildSourceRedundancyPlan(source, { profile: 'report_assignment' });
  assert.equal(plan.applicable, true);
  assert.equal(plan.repeatedRunCount, 1);
  assert.deepEqual(plan.targetIndices, [3, 4, 5]);
  assert.equal(source.split(' ').length > 0, true);

  const humanizationPlan = depth.buildHumanizationPlan(source, {
    requestStrength: 'basic',
    documentProfile: { profile: 'report_assignment' }
  });
  assert.equal(humanizationPlan.sourceRedundancyPlan.applicable, true);
  assert.ok(humanizationPlan.targetReasonCounts.source_semantic_redundancy >= 3);
  assert.match(depth.buildHumanizationPromptBlock(humanizationPlan), /동의어만 바꿔 다시 쓰지 말고/u);
});

test('형식만 비슷하고 숫자·인용·부정 관계가 다른 병렬 블록은 원문 중복으로 합치지 않는다', () => {
  const first = [
    '2024년 조사에서는 응답자 35%가 제도 확대에 동의했으며 “절차가 간단하다”는 의견을 주요 근거로 제시하였다.',
    '첫 조건에서는 처리 시간을 20분으로 제한하지 않았고 참여자가 자유롭게 과제를 수행하도록 설계하였다.',
    'A 기관 사례는 지원 대상을 120명으로 정하고 신청자의 접근성을 중심으로 운영 성과를 평가하였다.'
  ];
  const second = [
    '2025년 조사에서는 응답자 65%가 제도 축소에 동의했으며 “절차가 복잡하다”는 의견을 주요 근거로 제시하였다.',
    '둘째 조건에서는 처리 시간을 10분으로 제한했고 참여자가 정해진 순서에 따라 과제를 수행하도록 설계하였다.',
    'B 기관 사례는 지원 대상을 80명으로 정하고 담당자의 처리 효율을 중심으로 운영 성과를 평가하였다.'
  ];
  const plan = sourceRedundancy.buildSourceRedundancyPlan(
    [...first, ...second].join(' '),
    { profile: 'report_assignment' }
  );
  assert.equal(plan.applicable, false);
  assert.equal(plan.duplicateSentenceCount, 0);
});

test('한 원문 문장을 결과가 두 문장으로 나눈 경우 자소서 주장 누락으로 오인하지 않는다', () => {
  const source = '저는 도면 해독 능력과 역학 지식을 실제 정비에 적용하며 실무 노하우를 익혀 기본기가 탄탄한 정비사가 되겠습니다.';
  const output = '저는 도면 해독 능력과 역학 지식을 실제 정비에 적용하겠습니다. 현장의 실무 노하우도 익혀 기본기가 탄탄한 정비사가 되겠습니다.';
  const audit = resumeCoverage.auditResumeCoverage(
    source,
    output,
    { profile: 'resume_application', confidence: 0.95 }
  );
  assert.equal(audit.pass, true);
  assert.equal(audit.omissions.length, 0);
});

test('모델 수리 뒤에도 빠진 자소서 직무 연결 문장을 앞뒤 앵커 사이에 원문 그대로 복원한다', () => {
  const source = [
    '팀 프로젝트에서 서로의 작업을 교차 점검하는 원칙을 배웠습니다.',
    '항공 정비 현장에서도 이 원칙은 동일하게 적용된다고 믿습니다.',
    '교대 작업에서는 특이사항을 다음 근무자에게 정확히 인계해야 합니다.'
  ].join(' ');
  const output = [
    '팀 프로젝트를 통해 서로의 작업을 교차 점검해야 한다는 원칙을 배웠습니다.',
    '교대 작업에서는 작은 특이사항도 다음 근무자에게 정확히 인계해야 합니다.'
  ].join('\n\n');
  const profile = { profile: 'resume_application', confidence: 0.95 };
  const before = resumeCoverage.auditResumeCoverage(source, output, profile);
  assert.equal(before.pass, false);
  const restored = resumeCoverage.restoreMissingClaimsLocally({
    source,
    currentOutput: output,
    audit: before
  });
  assert.equal(restored.applied, true);
  assert.match(restored.text, /항공 정비 현장에서도 이 원칙은 동일하게 적용된다고 믿습니다/u);
  assert.equal(resumeCoverage.auditResumeCoverage(source, restored.text, profile).pass, true);
  assert.equal(resumeCoverage.isSafeRestorationShape(source, output, restored.text, 1), true);
});

test('라벨 중심의 짧은 보고서에서 명사형 종결 일부가 평서문으로 바뀌면 국소 복원한다', () => {
  const source = [
    '1. 창업 배경',
    '창업 계기: 처음부터 거창한 계획을 세운 창업이 아님.',
    '시장 변화: 현장에서 새로운 성장 가능성을 인식함.',
    '핵심 태도: 주변 의견에 흔들리지 않는 실행력이 중요함.',
    '2. 운영 전략',
    '인력 관리: 핵심 인력이 안정적으로 유지되는 형태가 필수적임.',
    '위기 대응: 공공 지원 사업을 활용해 공간을 확보함.',
    '성과 관리: 작품의 흥행을 계기로 재무 구조가 안정화됨.'
  ].join('\n');
  const output = [
    '1. 창업 배경',
    '창업 계기: 처음부터 거창한 계획을 세운 창업은 아니었다.',
    '시장 변화: 현장에서 새로운 성장 가능성을 인식했다.',
    '핵심 태도: 주변 의견에 흔들리지 않는 실행력이 중요함.',
    '2. 운영 전략',
    '인력 관리: 핵심 인력이 안정적으로 유지되는 형태가 필수적임.',
    '위기 대응: 공공 지원 사업을 활용해 공간을 확보함.',
    '성과 관리: 작품의 흥행을 계기로 재무 구조가 안정화됨.'
  ].join('\n');
  const profile = {
    profile: 'report_assignment',
    formatProfile: {
      primary: 'label_heavy',
      flags: ['sectioned', 'label_heavy']
    }
  };
  const before = endingStyle.auditEndingStyle(source, output, profile);
  assert.equal(before.pass, false, JSON.stringify(before));
  assert.equal(before.issues[0].structuredNominalMemo, true);
  const restored = endingStyle.restoreIntroducedEndingSentences(source, output, before, profile);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.equal(restored.audit.pass, true, JSON.stringify(restored.audit));
  assert.equal(restored.text, source);
});

test('라벨 보고서라도 원문 자체가 혼합 종결이면 명사형으로 강제 통일하지 않는다', () => {
  const source = [
    '1. 검토 결과',
    '현황: 첫 번째 자료를 확인함.',
    '해석: 두 번째 자료는 별도로 검토했다.',
    '결론: 두 결과의 차이를 기록함.'
  ].join('\n');
  const profile = {
    profile: 'report_assignment',
    formatProfile: {
      primary: 'label_heavy',
      flags: ['sectioned', 'label_heavy']
    }
  };
  const report = endingStyle.auditEndingStyle(source, source, profile);
  assert.equal(report.pass, true, JSON.stringify(report));
  assert.equal(report.issueCount, 0);
});
