'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');
const { effectiveModeForProfile } = require('../engine-gpt-prod');
const layoutStructure = require('../engine-gpt-prod/layoutStructure');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const refinement = require('../engine-gpt-prod/koreanRefinement');
const fingerprint = require('../engine-gpt-prod/fingerprintAudit');
const prompts = require('../engine-gpt-prod/prompts');
const { auditRepeatability } = require('../tools/eval/repeatabilityAudit');

test('사진이 반복되는 디지털 사진 보고서는 후기 블로그로 오인하지 않는다', () => {
  const source = [
    '# 디지털 사진의 원리',
    '사진은 빛을 센서에 기록하는 과정에서 만들어진다. 디지털 사진의 노출은 조리개와 셔터 속도, 감도의 관계로 설명할 수 있다.',
    '## 촬영 원리',
    '사진 촬영에서는 렌즈를 통과한 빛이 이미지 센서에 도달한다. 사진의 밝기와 심도는 각 설정값에 따라 달라진다.',
    '## 분석 결과',
    '본 보고서는 같은 장면의 사진을 조건별로 비교 분석하고 디지털 사진의 특성을 정리한다.'
  ].join('\n\n');
  const profile = detectDocumentProfile(source, { basicStyle: 'blog' });
  assert.notEqual(profile.profile, 'review_blog', JSON.stringify(profile.candidateProfiles));
  assert.equal(profile.group, 'academic_report_explainer');
  assert.equal(effectiveModeForProfile('blog', 'blog', profile), 'assignment');
});

test('분산된 연구 설계 단서는 장르군에서 합산되어 보고서로 판정된다', () => {
  const source = '연구 질문을 정한 뒤 질문지법과 문헌 연구법을 함께 사용한다. 자료의 범위는 공식 통계와 법령, 판결문으로 제한한다. 상관관계와 인과관계를 구분해 분석 틀을 세우고 최종 답을 도출한다.';
  const profile = detectDocumentProfile(source);
  assert.equal(profile.profile, 'report_assignment', JSON.stringify(profile));
  assert.equal(profile.group, 'academic_report_explainer');
  assert.ok(profile.candidateGroups[0].score > profile.candidateGroups[1].score);
  assert.ok(profile.profileGroupMargin > 0);
});

test('일반적인 성장 과정이 들어간 설명문은 지원서로 오인하지 않는다', () => {
  const paragraph = '청소년의 성장 과정에서 수면은 기억의 구조와 학습 기능에 영향을 준다. 연구원들은 수면 시간과 인지 능력의 관계를 조사하고 결과를 분석했다. 이 과정은 뇌의 기능과 정서 조절 원리를 설명하는 중요한 사례이다.';
  const profile = detectDocumentProfile(Array.from({ length: 10 }, () => paragraph).join('\n'));
  assert.equal(profile.profile, 'long_explainer', JSON.stringify(profile.candidateProfiles));
  assert.notEqual(profile.profile, 'resume_application');
});

test('제목 없는 직무 경험·포부와 항목형 학습 소감은 각각 안전 장르로 라우팅한다', () => {
  const career = '학과 과대표를 맡아 구성원 의견을 조율하는 역할을 수행했습니다. 요구사항을 정리해 공유했습니다. 가능한 대안을 제시해 행사를 차질 없이 진행했습니다. 앞으로 원무과에서 환자와 의료진을 응대하며 병원 운영에 기여하겠습니다.';
  assert.equal(detectDocumentProfile(career).profile, 'resume_application');

  const reflection = [
    '느낀 점',
    '에너지 보존 원리를 이해하게 되었다.',
    '본인이 잘했던 것',
    '여러 상황의 에너지 변환을 분석했다.',
    '관심이 갔던 내용',
    '반도체에서 전자의 에너지를 조절하는 과정이 인상 깊었다.'
  ].join('\n');
  assert.equal(detectDocumentProfile(reflection).profile, 'student_self_assessment');
});

test('SOAP 기록은 임상 프로필과 전용 보존 프롬프트를 사용한다', () => {
  const source = [
    '## SOAP Note',
    '**대상자:** 김아동 (2022.11.07 출생)',
    '**평가일:** 2026.07.21',
    '**평가도구:** Child Sensory Profile 2, Denver II',
    '### S',
    '보호자는 소음에 민감하다고 보고함.',
    '### O',
    '치료실에서 양손 과제를 관찰함.',
    '### A',
    '감각 조절의 어려움이 관찰됨.',
    '### P',
    '작업 치료 중재 계획을 수립함.'
  ].join('\n');
  const profile = detectDocumentProfile(source);
  assert.equal(profile.profile, 'clinical_record', JSON.stringify(profile.candidateProfiles));
  assert.equal(profile.targetRegister, 'clinical_formal');
  assert.ok(profile.safetyProfiles.includes('clinical_record'));
  assert.equal(effectiveModeForProfile('blog', 'blog', profile), 'assignment');
  const prompt = prompts.buildHumanizePrompt('assignment', 'ko', {
    register: 'nominal',
    requestStrength: 'advanced',
    documentProfile: profile
  }).stable;
  assert.match(prompt, /S의 주관적 보고/u);
  assert.match(prompt, /진단·증상·원인·예후/u);
});

test('공식 공지의 날짜·기관·직책 서명 꼬리는 원문 행 단위로 잠긴다', () => {
  const source = [
    '학우 여러분, 안녕하십니까.',
    '새 운영위원장으로 인사드립니다. 앞으로의 운영 방향을 안내드립니다.',
    '',
    '2026년 7월 22일',
    '한국대학교 총학생회 운영위원회',
    '위원장 홍길동 올림'
  ].join('\n');
  const profile = detectDocumentProfile(source);
  assert.equal(profile.profile, 'mail_notice', JSON.stringify(profile.candidateProfiles));
  const records = layoutStructure.buildLineRecords(source);
  assert.deepEqual(records.filter(row => row.role === 'signature').map(row => row.text), [
    '2026년 7월 22일',
    '한국대학교 총학생회 운영위원회',
    '위원장 홍길동 올림'
  ]);
  const chunks = structureChunk.splitChunksForGpt(source).chunks;
  assert.ok(chunks.some(chunk => chunk.locked && chunk.lockType === 'signature'));
});

test('하이픈 장 제목과 공백 없는 번호 제목·참고문헌을 독립 구조로 보존한다', () => {
  const source = [
    '-서론',
    '오페라와 조명 기술의 관계를 살펴본다.',
    '-본론',
    '1.1900년대 초 오페라의 발전',
    '공연 양식과 무대 기술이 함께 변화하였다.',
    '2.조명 기술의 발전과 무대 변화',
    '전기 조명은 무대 표현의 범위를 넓혔다.',
    '-결론',
    '두 변화는 미용 문화에도 영향을 주었다.',
    '-참고문헌',
    '1. 김민자. (2020). 서양 복식문화사.',
    '2. 정흥숙. (2021). 무대 예술의 이해.',
    '3. 홍길동. (2022). 조명과 공연.'
  ].join('\n');
  const records = layoutStructure.buildLineRecords(source);
  for (const heading of ['-서론', '-본론', '1.1900년대 초 오페라의 발전', '2.조명 기술의 발전과 무대 변화', '-결론']) {
    assert.equal(records.find(row => row.text === heading)?.role, 'heading', heading);
  }
  const chunks = structureChunk.splitChunksForGpt(source).chunks;
  for (const heading of ['-본론', '1.1900년대 초 오페라의 발전', '2.조명 기술의 발전과 무대 변화']) {
    assert.ok(chunks.some(chunk => chunk.locked && chunk.text.split(/\r?\n/u).map(line => line.trim()).includes(heading)), heading);
  }
  assert.ok(chunks.some(chunk => chunk.locked && chunk.lockType === 'reference_item' && chunk.text.includes('-참고문헌')));
});

test('제목 없는 장문 전문 설명도 구어체 일반 글로 내려가지 않는다', () => {
  const paragraph = '사회복지실천에서 비밀보장은 클라이언트의 자기결정권과 인격권에 연결되는 핵심 원리이다. 현장에서는 비밀보장과 생명 보호의 가치가 충돌하는 사례가 나타난다. 이 관계를 이해하려면 윤리 원칙의 구조와 적용 과정을 함께 살펴야 한다. 제도의 역사적 배경과 기능, 예외 조건의 의미도 구분해야 한다.';
  const source = Array.from({ length: 7 }, () => paragraph).join('\n\n');
  const profile = detectDocumentProfile(source, { basicStyle: 'blog' });
  assert.equal(profile.profile, 'long_explainer', JSON.stringify(profile.candidateProfiles));
  assert.equal(profile.targetRegister, 'academic_formal');
  assert.equal(effectiveModeForProfile('blog', 'blog', profile), 'assignment');
});

test('중간 신뢰도의 전문 장르도 기본 강도만 유지하고 블로그 문체로 실행하지 않는다', () => {
  assert.equal(effectiveModeForProfile('blog', 'blog', {
    profile: 'long_explainer',
    confidence: 0.68,
    basicStyle: 'blog'
  }), 'assignment');
  assert.equal(effectiveModeForProfile('blog', 'blog', {
    profile: 'student_self_assessment',
    confidence: 0.6,
    basicStyle: 'blog'
  }), 'assignment');
  assert.equal(effectiveModeForProfile('blog', 'blog', {
    profile: 'personal_essay',
    confidence: 0.7,
    basicStyle: 'blog'
  }), 'blog');
});

test('일반 낱말만 잡힌 중간 신뢰도 보고서는 블로그 요청을 학술 문체로 강제하지 않는다', () => {
  assert.equal(effectiveModeForProfile('blog', 'blog', {
    profile: 'report_assignment',
    confidence: 0.65,
    basicStyle: 'blog'
  }), 'blog');
  assert.equal(effectiveModeForProfile('blog', 'blog', {
    profile: 'report_assignment',
    confidence: 0.65,
    basicStyle: 'report'
  }), 'assignment');
});

test('닫는 따옴표의 서술격과 메시지 표기는 결정론적으로 안전 교정한다', () => {
  const source = '핵심은 ‘학생들의 인식’ 이지 단순한 점수가 아니다. 메세지를 정확히 전달한다.';
  const repaired = refinement.applySafeDeterministicRepairs({ source, outputText: source });
  assert.equal(repaired.text, '핵심은 ‘학생들의 인식’이지 단순한 점수가 아니다. 메시지를 정확히 전달한다.');
  assert.ok(repaired.changeCodes.includes('closed_quote_particle_spacing'));
  assert.ok(repaired.changeCodes.includes('message_spelling'));

  const quotedSpeech = '그는 “다시 확인하겠습니다.” 하고 답했다.';
  assert.equal(refinement.applySafeDeterministicRepairs({
    source: quotedSpeech,
    outputText: quotedSpeech
  }).text, quotedSpeech);
});

test('원문 반복음절은 정상 어휘를 오탐하지 않고 실제 비교 어절이 있을 때만 알린다', () => {
  const typo = refinement.analyzeKoreanRefinement({
    source: '지역 복복지 정책을 살핀 뒤 복지 전달 체계를 비교했다.',
    outputText: '지역 복복지 정책을 살핀 뒤 복지 전달 체계를 비교했다.'
  });
  assert.ok(typo.sourceReviewWarnings.some(item => item.code === 'source_token_repetition_review'));

  const normal = refinement.analyzeKoreanRefinement({
    source: '자료를 꼼꼼하게 검토하고 사사로운 감정을 배제했다.',
    outputText: '자료를 꼼꼼하게 검토하고 사사로운 감정을 배제했다.'
  });
  assert.equal(normal.sourceReviewWarnings.some(item => item.code === 'source_token_repetition_review'), false);
});

test('세특 명사형 조각·공식문 중복 인사·방향성 성장 연어를 국소 수리 대상으로 잡는다', () => {
  const recordSource = '여러 인공지능 활용 사례를 비교하고 사례별 특징과 차이를 조사하여 발표함.';
  const recordOutput = '여러 인공지능 활용 사례를 비교함. 사례별로 조사함.';
  const recordAudit = refinement.analyzeKoreanRefinement({
    source: recordSource,
    outputText: recordOutput,
    documentProfile: { profile: 'student_record_teacher', targetRegister: 'record_formal' }
  });
  assert.ok(recordAudit.issueCodes.includes('student_record_fragment'), JSON.stringify(recordAudit));

  const noticeAudit = refinement.analyzeKoreanRefinement({
    source: '학우 여러분께 인사드립니다. 운영 방향을 안내드립니다.',
    outputText: '학우 여러분께 인사드립니다. 안녕하십니까. 운영 방향을 안내드립니다.',
    documentProfile: { profile: 'mail_notice', targetRegister: 'functional_formal' }
  });
  assert.ok(noticeAudit.issueCodes.includes('functional_greeting_duplication'));

  const growthAudit = refinement.analyzeKoreanRefinement({
    source: '연구 태도가 구체적으로 바뀌었다.',
    outputText: '연구 태도는 분석하는 쪽으로 성장했다.',
    documentProfile: { profile: 'report_assignment', targetRegister: 'academic_formal' }
  });
  assert.ok(growthAudit.issueCodes.includes('directional_growth_collocation'));
});

test('반복 어휘 치환은 shadow 관측만 하고 전달 위반으로 만들지 않는다', () => {
  const audit = fingerprint.auditFingerprint(
    '이러한 다양한 문제는 따라서 분석이 필요하다. 그러나 조직 내에서 발생한다.',
    '이런 여러 문제는 그래서 분석이 필요하다. 다만 조직 안에서 생긴다.'
  );
  assert.equal(audit.pass, true);
  assert.equal(audit.lexicalTransitionCount, 6);
  assert.equal(audit.issueCodes.length, 0);
});

test('같은 원문의 반복 실행에서 휴머나이징 깊이 편차가 크면 평가가 실패한다', () => {
  const source = '첫 문장은 같은 주제를 설명합니다. 두 번째 문장은 근거를 구체적으로 제시합니다. 세 번째 문장은 사례의 차이를 비교합니다. 네 번째 문장은 앞선 내용을 정리합니다. 다섯 번째 문장은 이후의 과제를 덧붙입니다.';
  const report = auditRepeatability({
    source,
    outputs: [
      source.replace('설명합니다', '설명해 줍니다'),
      '같은 주제를 첫 문장에서 제시합니다. 구체적인 근거는 두 번째 문장에서 확인할 수 있습니다. 이어지는 세 번째 문장은 사례 사이의 차이를 대조합니다. 앞의 논의는 네 번째 문장에서 정리됩니다. 마지막 문장에는 이후 살펴볼 과제가 남습니다.'
    ],
    documentProfile: 'report_assignment',
    mode: 'assignment'
  });
  assert.equal(report.variance.applicable, true);
  assert.equal(report.pass, false);
  assert.ok(report.failureCodes.includes('repeatability_edit_depth_variance_high'));
});
