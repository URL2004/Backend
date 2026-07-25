'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSentences } = require('../engine/koreanText');
const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');
const korean = require('../engine-gpt-prod/koreanRefinement');
const fingerprint = require('../engine-gpt-prod/fingerprintAudit');
const endingStyle = require('../engine-gpt-prod/endingStyleAudit');
const prompts = require('../engine-gpt-prod/prompts');
const { restoreSourceSentenceOrdinals } = require('../engine-gpt-prod/sourceSentenceRestore');

test('문장 분리기는 CRLF 한 번을 빈 줄로 오인하지 않고 LF와 동일하게 처리한다', () => {
  const lf = '제목\n첫 문장은 설명을 이어 간다.\n둘째 문장은 근거를 제시한다.\n\n새 문단은 결론을 정리한다.';
  const crlf = lf.replace(/\n/gu, '\r\n');
  assert.deepEqual(
    splitSentences(crlf).map(sentence => sentence.replace(/\r\n?/gu, '\n')),
    splitSentences(lf)
  );
  assert.equal(splitSentences(crlf).length, 3);
});

test('제목이 잘린 짧은 전문 문서를 내용 신호로 안전 장르에 라우팅한다', () => {
  const normative = [
    '생명 윤리는 인간 생명과 존엄성을 보호하고 미래 세대의 권리를 고려하기 위해 필요한 기준이다.',
    '국제 사회는 과학적 검증과 사회적 합의를 바탕으로 윤리적 기준을 마련해야 한다.',
    '기술 발전의 공공성을 확보하려면 기본권을 침해하지 않는 규제와 제도를 유지해야 한다.'
  ].join(' ');
  const normativeProfile = detectDocumentProfile(normative, { basicStyle: 'blog' });
  assert.equal(normativeProfile.profile, 'report_assignment', JSON.stringify(normativeProfile.candidateProfiles));
  assert.equal(normativeProfile.targetRegister, 'academic_formal');

  const application = [
    '저는 연구실 인턴 과정에서 실험 데이터를 수집하고 조건별 결과를 분석했습니다.',
    '공정 변수를 조정하고 반복 실험으로 재현성을 검증해 측정 편차 문제를 개선했습니다.',
    '그 결과 분석 절차의 신뢰성을 확보했으며, 이 경험을 연구 개발 업무에 활용해 조직의 성과에 기여하겠습니다.'
  ].join(' ');
  const applicationProfile = detectDocumentProfile(application, { basicStyle: 'blog' });
  assert.equal(applicationProfile.profile, 'resume_application', JSON.stringify(applicationProfile.candidateProfiles));
  assert.equal(applicationProfile.targetRegister, 'professional');

  const clinical = [
    'Denver II 평가에서 미세 운동과 시지각 영역의 저하가 관찰됨.',
    '감각 처리와 고유 수용성 반응에서 어려움이 확인됨.',
    '일상생활동작과 자세 조절에는 부분적인 도움 필요.'
  ].join('\n');
  const clinicalProfile = detectDocumentProfile(clinical, { basicStyle: 'blog' });
  assert.equal(clinicalProfile.profile, 'clinical_record', JSON.stringify(clinicalProfile.candidateProfiles));
  assert.equal(clinicalProfile.targetRegister, 'clinical_formal');
});

test('단일 일반 주장이나 임상 낱말 하나는 전문 단편으로 과분류하지 않는다', () => {
  const policyOpinion = '새 제도는 시민이 이해하기 쉬워야 한다. 충분한 안내가 필요하다.';
  assert.notEqual(detectDocumentProfile(policyOpinion, { basicStyle: 'blog' }).profile, 'report_assignment');

  const generalMedical = '건강 기사에서 Denver II라는 검사를 소개했다. 부모가 읽기 쉽게 핵심 개념을 설명했다.';
  assert.notEqual(detectDocumentProfile(generalMedical, { basicStyle: 'blog' }).profile, 'clinical_record');
});

test('기술 경력서의 역할 중복·목적어 왜곡·전문 기능어 약화를 문장 단위로 잡는다', () => {
  const source = [
    '회로 설계와 부품 선정 등 하드웨어 개발 전반을 담당하고 있습니다.',
    '설계검토회의를 통해 접수된 고객 요구사항을 분석했습니다.',
    '설정된 시간에 신호를 전송하면 지정된 음성 안내가 출력되도록 구현했습니다.'
  ].join(' ');
  const output = [
    '하드웨어 개발 전반을 맡고 있으며 회로 설계와 부품 선정까지 담당하고 있습니다.',
    '고객 요구사항은 설계검토회의에서 접수된 내용을 바탕으로 분석했습니다.',
    '설정된 시간에 신호를 보내면 지정한 음성 안내가 출력되도록 구현했습니다.'
  ].join(' ');
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'resume_application', targetRegister: 'professional' },
    mode: 'assignment'
  });
  assert.equal(audit.pass, false);
  assert.ok(audit.issueCodes.includes('role_predicate_redundancy'));
  assert.ok(audit.issueCodes.includes('analytic_object_recast'));
  assert.ok(audit.issueCodes.includes('professional_register_downgrade'));
  const concepts = audit.issues.find(item => item.code === 'professional_register_downgrade')?.details?.concepts || [];
  assert.ok(concepts.includes('technical_signal_transfer'));
  assert.ok(concepts.includes('configured_output_state'));

  const restored = korean.restoreIntroducedIntegritySentences({ source, outputText: output, audit });
  assert.equal(restored.applied, true);
  assert.equal(korean.analyzeKoreanRefinement({
    source,
    outputText: restored.text,
    documentProfile: { profile: 'resume_application', targetRegister: 'professional' }
  }).pass, true);
});

test('원인 서술 중첩·명사 연어·조사 틀·메타 명사화를 특정 주제와 무관하게 잡는다', () => {
  const source = [
    '실점의 가장 큰 원인은 수비 조직력 부족이었다.',
    '가치사슬을 분석하면 기업의 경쟁력이 드러난다.',
    '공급망은 부품에서 완제품에 이르는 과정을 포괄한다.',
    '현장에서 협업의 중요성을 느꼈다.',
    '기업은 세계 시장에서 독보적인 입지를 확고히 할 수 있다.'
  ].join(' ');
  const output = [
    '실점은 수비 조직력 부족에서 비롯된 가장 큰 원인이었다.',
    '가치사슬 분석을 살펴보면 기업의 경쟁력이 드러난다.',
    '공급망은 부품에서 완제품에 이르기까지를 포괄한다.',
    '현장에서 느낀 것은 협업이 중요하다는 점이었다.',
    '기업은 세계 시장에서 독보적인 위치를 더욱 분명히 할 수 있다.'
  ].join(' ');
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'report_assignment', targetRegister: 'academic_formal' }
  });
  for (const code of ['causal_predicate_stack', 'nominal_predicate_collocation', 'case_frame_corruption', 'meta_nominalization_injection']) {
    assert.ok(audit.issueCodes.includes(code), `${code}: ${JSON.stringify(audit.issues)}`);
  }
  assert.ok((audit.issues.find(item => item.code === 'nominal_predicate_collocation')?.afterCount || 0) >= 2);
});

test('역할 범위·대조 조사·모달 강도·연구 질문 범위 변화를 의미 관계 위반으로 잡고 복원한다', () => {
  const source = [
    'MCU 교체가 적용된 제품의 세부 회로를 검토했습니다.',
    '3인 팀에서 회로 설계에 참여했습니다.',
    '이 정책을 시행하려면 사회적 합의가 필요하다.',
    '규제 강화를 검토해야 할 것이다.',
    '연구 질문은 효과가 있는지 여부를 확인하는 것이다.'
  ].join(' ');
  const output = [
    'MCU를 교체하고 제품의 세부 회로를 검토했습니다.',
    '3인 팀에서는 회로 설계를 완료했습니다.',
    '이 정책은 사회적 합의 없이는 시행할 수 없다.',
    '규제 강화를 검토해야 한다.',
    '연구 질문은 효과가 얼마나 큰지 확인하는 것이다.'
  ].join(' ');
  const audit = fingerprint.auditFingerprint(source, output, 'resume_application');
  const families = audit.semanticRelations.shifts.map(item => item.family);
  for (const family of [
    'applied_change_changed_to_direct_action',
    'team_context_changed_to_contrast',
    'participation_changed_to_ownership',
    'necessity_strengthened_to_impossibility',
    'tentative_norm_hardened',
    'question_scope_changed_from_whether_to_degree'
  ]) {
    assert.ok(families.includes(family), `${family}: ${JSON.stringify(audit.semanticRelations)}`);
  }
  const restored = fingerprint.restoreUnsafeRelationSentences(source, output, audit);
  assert.equal(restored.applied, true);
  assert.equal(fingerprint.auditFingerprint(source, restored.text, 'resume_application').pass, true);
});

test('필요 표현을 조건절 없이 불가능으로 단정하는 직접 양태 강화도 잡는다', () => {
  const source = '이 계획을 실행하려면 추가 검토가 필요하다.';
  const output = '이 계획을 실행하려면 추가 검토를 해도 불가능하다.';
  const audit = fingerprint.auditFingerprint(source, output, 'report_assignment');
  assert.ok(
    audit.semanticRelations.shifts.some(
      item => item.family === 'necessity_strengthened_to_impossibility'
    ),
    JSON.stringify(audit.semanticRelations)
  );
});

test('전문 장르는 엔진 상투구 한 번의 신규 주입도 수리하고 일반 글 허용치는 유지한다', () => {
  const source = '자료를 검토하고 적용 범위를 확인했다.';
  const output = '자료 검토에 머무르지 않고 적용 범위까지 확인했다.';
  const professional = fingerprint.auditFingerprint(source, output, 'report_assignment');
  assert.equal(professional.pass, false);
  assert.equal(professional.families[0].allowedIntroducedCount, 0);
  assert.ok(professional.issueCodes.includes('engine_phrase_fingerprint'));
  const restored = fingerprint.restoreUnsafeRelationSentences(source, output, professional);
  assert.equal(restored.applied, true);
  assert.equal(fingerprint.auditFingerprint(source, restored.text, 'report_assignment').pass, true);

  const general = fingerprint.auditFingerprint(source, output, 'general');
  assert.equal(general.pass, true);
  assert.equal(general.families[0].allowedIntroducedCount, 1);
});

test('원문 번호 수리와 결과 번호 수리가 함께 있어도 문장 번호가 밀리지 않는다', () => {
  const source = [
    '연구의 초점은 새로운 도구 개발 자체보다 자료와 인간 판단을 구조화하는 데 있다.',
    '자료를 검토하고 적용 범위를 확인했다.',
    '마지막 문장은 그대로 둔다.'
  ].join(' ');
  const output = [
    '연구는 새로운 도구를 개발하는 데서 나아간다.',
    '자료와 인간 판단을 구조화하는 데 초점을 둔다.',
    '자료 검토에 머무르지 않고 적용 범위까지 확인했다.',
    '마지막 문장은 조금 다듬어 둔다.'
  ].join(' ');
  const audit = fingerprint.auditFingerprint(source, output, 'report_assignment');
  assert.ok(audit.issueCodes.includes('engine_phrase_fingerprint'), JSON.stringify(audit));
  const mixedOrdinalAudit = {
    ...audit,
    violations: [
      ...audit.violations,
      // 의미 관계 감사는 원문 문장 번호, 상투구 감사는 결과 문장 번호를
      // 사용한다. 두 번호 공간이 한 수리 요청에 함께 오는 상황을 고정한다.
      { code: 'semantic_relation_shift', sentenceOrdinals: [1] }
    ]
  };

  const restored = fingerprint.restoreUnsafeRelationSentences(source, output, mixedOrdinalAudit);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.match(restored.text, /개발 자체보다 자료와 인간 판단을 구조화/u);
  assert.match(restored.text, /자료를 검토하고 적용 범위를 확인했다/u);
  assert.match(restored.text, /마지막 문장은 조금 다듬어 둔다/u);
  assert.equal(fingerprint.auditFingerprint(source, restored.text, 'report_assignment').pass, true);
});

test('임상 기록은 짧은 명사형 기록 중 한 문장의 설명체 변환도 감지한다', () => {
  const source = '감각 처리 저하가 관찰됨. 미세 운동의 어려움이 확인됨. 일상생활동작에는 도움 필요함.';
  const output = '감각 처리 저하가 관찰됐습니다. 미세 운동의 어려움이 확인됨. 일상생활동작에는 도움 필요함.';
  const audit = endingStyle.auditEndingStyle(source, output, 'clinical_record');
  assert.equal(audit.pass, false, JSON.stringify(audit));
  assert.equal(audit.introducedOtherCount, 1);
});

test('괄호 영문명이 붙은 형제 라벨의 공백을 원문 다수 형식으로 통일한다', () => {
  const source = [
    '• 물류 투입 (Inbound Logistics):본문',
    '• 운영 (Operations):본문',
    '• 서비스 (Service):본문'
  ].join('\n');
  const output = [
    '• 물류 투입(Inbound Logistics): 본문',
    '• 운영 (Operations):본문',
    '• 서비스(Service): 본문'
  ].join('\n');
  const repaired = korean.applySafeFormattingRepairs({ source, outputText: output });
  assert.equal(repaired.text, [
    '• 물류 투입 (Inbound Logistics): 본문',
    '• 운영 (Operations): 본문',
    '• 서비스 (Service): 본문'
  ].join('\n'));
  assert.equal(repaired.changeCounts.sibling_label_spacing, 3);
});

test('문장 복원은 대응 가능한 대상 문장만 바꾸고 기존 줄 구분자를 보존한다', () => {
  const source = '첫 문장은 원래 의미를 유지한다.\r\n둘째 문장은 역할 범위를 제한한다.\r\n\r\n셋째 문장은 그대로 둔다.';
  const output = '첫 문장은 자연스럽게 다듬었다.\r\n둘째 문장은 역할 범위를 크게 넓혔다.\r\n\r\n셋째 문장은 조금 바꾸었다.';
  const restored = restoreSourceSentenceOrdinals(source, output, [2]);
  assert.equal(restored.applied, true);
  assert.match(restored.text, /\r\n\r\n/u);
  assert.match(restored.text, /첫 문장은 자연스럽게 다듬었다/u);
  assert.match(restored.text, /둘째 문장은 역할 범위를 제한한다/u);
  assert.match(restored.text, /셋째 문장은 조금 바꾸었다/u);
});

test('문장 복원은 모델이 한 원문 문장을 둘로 나눈 경우에도 공통 1:N 정렬을 사용한다', () => {
  const source = [
    '첫 문장은 그대로 둔다.',
    '연구의 초점은 새로운 도구 개발 자체보다 자료와 인간 판단을 함께 구조화하는 데 있다.',
    '마지막 문장은 그대로 둔다.'
  ].join(' ');
  const output = [
    '첫 문장은 조금 다듬어 둔다.',
    '연구는 새로운 도구를 개발하는 데서 나아간다.',
    '자료와 인간 판단을 함께 구조화하는 데 초점을 둔다.',
    '마지막 문장은 조금 다듬어 둔다.'
  ].join(' ');
  const restored = restoreSourceSentenceOrdinals(source, output, [2], {
    ordinalSpace: 'source'
  });
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.match(restored.text, /개발 자체보다 자료와 인간 판단을 함께 구조화/u);
  assert.doesNotMatch(restored.text, /개발하는 데서 나아간다/u);
  assert.match(restored.text, /첫 문장은 조금 다듬어 둔다/u);
  assert.match(restored.text, /마지막 문장은 조금 다듬어 둔다/u);
});

test('출력 문장 번호 기반 한국어 복원도 문장 분할 뒤 원문 문장에 역정렬한다', () => {
  const source = [
    '첫 문장은 그대로 둔다.',
    '가치사슬을 분석하면 기업의 경쟁력이 드러난다.',
    '마지막 문장은 그대로 둔다.'
  ].join(' ');
  const output = [
    '첫 문장은 조금 다듬어 둔다.',
    '가치사슬 분석을 살펴본다.',
    '그러면 기업의 경쟁력이 드러난다.',
    '마지막 문장은 조금 다듬어 둔다.'
  ].join(' ');
  const restored = restoreSourceSentenceOrdinals(source, output, [2], {
    ordinalSpace: 'output'
  });
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.match(restored.text, /가치사슬을 분석하면 기업의 경쟁력이 드러난다/u);
  assert.doesNotMatch(restored.text, /가치사슬 분석을 살펴본다/u);
});

test('장르 프롬프트는 기술 경력의 역할 범위와 전문 기능어를 명시적으로 보호한다', () => {
  const profile = {
    profile: 'resume_application',
    group: 'essay_application',
    targetRegister: 'professional'
  };
  const prompt = prompts.buildHumanizePrompt('assignment', 'ko', {
    register: 'polite',
    requestStrength: 'advanced',
    documentProfile: profile
  }).stable;
  assert.match(prompt, /적용된 설계 변경/u);
  assert.match(prompt, /참여·지원·협업·검토/u);
  assert.match(prompt, /통신의 전송/u);
});
