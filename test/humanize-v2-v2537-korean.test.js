'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../engine-gpt-prod/finalQualityV2');
const korean = require('../engine-gpt-prod/koreanRefinement');
const discourse = require('../engine-gpt-prod/discourseAudit');
const profile = require('../engine-gpt-prod/documentProfile');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const voice = require('../engine-gpt-prod/voiceProfile');
const depth = require('../engine-gpt-prod/humanizationDepth');

const REPORT_PROFILE = {
  profile: 'report_assignment',
  targetRegister: 'academic_formal'
};

test('v2.5.37: 용언 관형형 뒤의 반면을 잘못 놓인 절 접속어로 오인하지 않는다', () => {
  const text = '26주 이후에는 TTTS 발생이 드물어지는 반면 sGR 감시의 중요성이 커지므로, 분만 시까지 2주 간격의 초음파를 계속 시행한다.';
  const audit = korean.analyzeKoreanRefinement({
    source: text,
    outputText: text,
    documentProfile: REPORT_PROFILE,
    mode: 'assignment'
  });

  assert.equal(
    audit.issueCodes.includes('misplaced_clause_connector'),
    false,
    JSON.stringify(audit)
  );
});

test('v2.5.37: 저는 뒤의 관형형은 이중 주제로 세지 않고 실제 조사 중복은 탐지한다', () => {
  const naturalCases = [
    '이 경험을 통해 저는 모르는 부분을 내 일이 아니라는 이유로 구분하기보다, 필요한 지식을 직접 찾아 익혔습니다.',
    '활동하면서 저는 살펴보는 부분을 자세히 기록했습니다.',
    '활동하면서 저는 만드는 과정을 직접 확인했습니다.',
    '활동하면서 저는 고르는 기준을 정리했습니다.',
    '활동하면서 저는 다루는 주제를 비교했습니다.'
  ];
  for (const natural of naturalCases) {
    const naturalAudit = korean.analyzeKoreanRefinement({
      source: natural,
      outputText: natural,
      documentProfile: { profile: 'resume_application', targetRegister: 'professional' },
      mode: 'assignment'
    });
    assert.equal(
      naturalAudit.issueCodes.includes('double_topic_chain'),
      false,
      JSON.stringify(naturalAudit)
    );
  }

  const directSource = '저는 연구를 중요하게 생각합니다.';
  const directBroken = '저는 연구는 중요하다고 생각합니다.';
  const directAudit = korean.analyzeKoreanRefinement({
    source: directSource,
    outputText: directBroken,
    documentProfile: { profile: 'resume_application', targetRegister: 'professional' },
    mode: 'assignment'
  });
  assert.equal(
    Number(directAudit.issues.find(item => item.code === 'double_topic_chain')?.introducedCount || 0),
    1,
    JSON.stringify(directAudit)
  );

  const source = '이번 활동을 하면서 나는 예술 작품을 새롭게 바라보았습니다.';
  const broken = '이번 활동을 하면서 나는 예술 작품은 새롭게 바라보았습니다.';
  const brokenAudit = korean.analyzeKoreanRefinement({
    source,
    outputText: broken,
    documentProfile: { profile: 'resume_application', targetRegister: 'professional' },
    mode: 'assignment'
  });
  const issue = brokenAudit.issues.find(item => item.code === 'double_topic_chain');
  assert.equal(Number(issue?.introducedCount || 0), 1, JSON.stringify(brokenAudit));
  assert.ok(brokenAudit.repairableCodes.includes('double_topic_chain'));
});

test('v2.5.37: 닫는 인용부호 뒤 관형형은 붙이고 완결 발화 뒤 하고는 띄운다', () => {
  const attached = '연구는 “자발적으로 참여”하는 활동과 “핵심 가치”라는 표현을 구분한다.';
  const attachedAudit = korean.analyzeKoreanRefinement({
    source: attached,
    outputText: attached,
    documentProfile: REPORT_PROFILE,
    mode: 'assignment'
  });
  assert.equal(
    attachedAudit.issueCodes.includes('closed_quote_spacing'),
    false,
    JSON.stringify(attachedAudit)
  );
  assert.equal(
    korean.applySafeDeterministicRepairs({
      source: attached,
      outputText: attached,
      documentProfile: REPORT_PROFILE
    }).text,
    attached
  );

  const speech = '담당자는 “위험하다.”하고 경고했다.';
  const expected = '담당자는 “위험하다.” 하고 경고했다.';
  assert.equal(
    korean.applySafeDeterministicRepairs({
      source: speech,
      outputText: speech,
      documentProfile: REPORT_PROFILE
    }).text,
    expected
  );
  assert.equal(
    korean.applySafeFormattingRepairs({
      source: speech,
      outputText: speech,
      documentProfile: REPORT_PROFILE
    }).text,
    expected
  );
  const polishPolicy = quality.polishEditPolicy(speech, expected, {
    documentProfile: REPORT_PROFILE
  });
  assert.equal(polishPolicy.needsIssueRecovery, false, JSON.stringify(polishPolicy));
  assert.equal(polishPolicy.pass, true, JSON.stringify(polishPolicy));

  const unpunctuatedSpeech = '그는 ‘가자’하는 말을 남겼다.';
  const unpunctuatedExpected = '그는 ‘가자’ 하는 말을 남겼다.';
  assert.equal(
    korean.applySafeDeterministicRepairs({
      source: unpunctuatedSpeech,
      outputText: unpunctuatedSpeech,
      documentProfile: REPORT_PROFILE
    }).text,
    unpunctuatedExpected
  );
});

test('v2.5.37: 구두점 없는 제목·명사 인용 뒤 하고를 직접 발화로 오인해 띄우지 않는다', () => {
  for (const text of ['「바다」하고 산을 비교했다.', '‘의자’하고 책상을 옮겼다.', '“나라”하고 사회를 함께 배웠다.']) {
    const repaired = korean.applySafeDeterministicRepairs({
      source: text,
      outputText: text,
      documentProfile: REPORT_PROFILE
    });
    const audit = korean.analyzeKoreanRefinement({
      source: text,
      outputText: text,
      documentProfile: REPORT_PROFILE,
      mode: 'polish'
    });
    assert.equal(repaired.text, text);
    assert.equal(audit.issueCodes.includes('closed_quote_spacing'), false, JSON.stringify(audit));
    assert.equal(quality.polishEditPolicy(text, text, { documentProfile: REPORT_PROFILE })
      .unresolvedSourceIssueCodes.includes('closed_quote_spacing'), false);
  }
});

test('v2.5.37: 장문 접속어 증가는 실제 신규 주입 문장을 가리키되 문장 전체를 원문 복원하지 않는다', () => {
  const source = [
    '장비 요구사항을 검토했다.',
    '전원 예산을 계산했다.',
    '회로 구성을 확정했다.',
    '시험 절차를 준비했다.',
    '이후, 승인 자료를 정리했다.',
    '그다음, 양산 일정을 검토했다.',
    '검증한 뒤, 결과를 문서화했다.'
  ].join(' ');
  const output = [
    '이후, 장비 요구사항을 검토했다.',
    '그다음, 전원 예산을 계산했다.',
    '회로 구성을 확정했다.',
    '시험 절차를 준비했다.',
    '이후, 승인 자료를 정리했다.',
    '그다음, 양산 일정을 검토했다.',
    '검증한 뒤, 결과를 문서화했다.'
  ].join(' ');
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: REPORT_PROFILE,
    mode: 'assignment'
  });
  const issue = audit.issues.find(item => item.code === 'sequential_connector_inflation');

  assert.deepEqual(issue?.sentenceOrdinals, [1, 2], JSON.stringify(issue));
  const restored = korean.restoreIntroducedIntegritySentences({ source, outputText: output, audit });
  assert.equal(restored.applied, false, JSON.stringify(restored));
  assert.equal(restored.text, output);
  assert.equal(restored.restoredCodes.includes('sequential_connector_inflation'), false);
});

test('v2.5.37: 문장 첫 순차 접속어 주입은 실질 편집률을 올리지 않는다', () => {
  const source = '장비 요구사항을 검토했다. 전원 예산을 계산했다.';
  const output = '이후, 장비 요구사항을 검토했다. 그다음, 전원 예산을 계산했다.';
  const metrics = depth.measureSubstantiveEdit(source, output);

  assert.equal(metrics.substantiveEditRatio, 0, JSON.stringify(metrics));
  assert.equal(metrics.substantiveChangedSentenceCount, 0, JSON.stringify(metrics));
});

test('v2.5.37: 일반 글의 결과 도출 중복을 점 확인으로 푼 정상 의역은 전문성 하락이 아니다', () => {
  const source = '기획과 영상의 문제를 찾기 위해 시청 지속시간 데이터와 클릭 수를 분석한 결과, 화면 초반 3초 안에 시선을 끄는 요소가 부족하다는 결과를 도출했습니다.';
  const output = '기획과 영상의 문제를 찾기 위해 시청 지속시간 데이터와 클릭 수를 분석했고, 그 결과 화면 초반 3초 안에 시선을 끄는 요소가 부족하다는 점을 확인했습니다.';
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'general', targetRegister: 'plain' },
    mode: 'blog'
  });

  const issue = audit.issues.find(item => item.code === 'professional_register_downgrade');
  assert.equal(Number(issue?.introducedCount || 0), 0, JSON.stringify(issue));
  assert.equal(
    audit.residualWarnings.some(item => item.code === 'korean_professional_register_downgrade'),
    false,
    JSON.stringify(audit)
  );
});

test('v2.5.37: 보고서도 결과 도출을 같은 주장인 점 확인으로 의역하면 문장 복원 대상이 아니다', () => {
  const source = '자료를 분석한 결과 이용 시간이 길수록 재방문 비율이 높아지는 경향이 있다는 결과를 도출했다.';
  const output = '자료를 분석한 결과 이용 시간이 길수록 재방문 비율이 높아지는 경향이 반복된다는 점을 확인했다.';
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: REPORT_PROFILE,
    mode: 'assignment'
  });
  const issue = audit.issues.find(item => item.code === 'professional_register_downgrade');

  assert.equal(Number(issue?.introducedCount || 0), 0, JSON.stringify(issue));
  const restored = korean.restoreIntroducedIntegritySentences({ source, outputText: output, audit });
  assert.equal(restored.applied, false, JSON.stringify(restored));
});

test('v2.5.37: 구조 삽입으로 문장 위치가 밀려도 남아 있는 전문어를 손실로 오인하지 않고 실제 삭제는 탐지한다', () => {
  const source = [
    '요구사항을 검토했다.',
    '시험 환경을 준비했다.',
    '측정 조건을 확정했다.',
    '측정 결과를 정량화하여 비교 기준을 마련했다.',
    '검토 내용을 기록했다.',
    '후속 일정을 정리했다.'
  ].join(' ');
  const structuralPrefix = Array.from(
    { length: 10 },
    (_value, index) => `추가 구조 안내 ${index + 1}입니다.`
  ).join(' ');
  const shiftedOutput = `${structuralPrefix} ${source}`;
  const shiftedAudit = korean.analyzeKoreanRefinement({
    source,
    outputText: shiftedOutput,
    documentProfile: REPORT_PROFILE,
    mode: 'assignment'
  });
  assert.equal(
    shiftedAudit.issueCodes.includes('professional_register_downgrade'),
    false,
    JSON.stringify(shiftedAudit)
  );

  const deletedOutput = shiftedOutput.replace('측정 결과를 정량화하여', '측정 결과를 숫자로 정리하여');
  const deletedAudit = korean.analyzeKoreanRefinement({
    source,
    outputText: deletedOutput,
    documentProfile: REPORT_PROFILE,
    mode: 'assignment'
  });
  const issue = deletedAudit.issues.find(item => item.code === 'professional_register_downgrade');
  assert.ok(Number(issue?.introducedCount || 0) >= 1, JSON.stringify(deletedAudit));
  assert.ok(issue?.details?.concepts?.includes('quantitative_analysis'), JSON.stringify(issue));
});

test('v2.5.37: 정상 관형형과 인용 연결은 polish 필수 교정 미통과를 만들지 않는다', () => {
  const source = [
    '이 경험을 통해 저는 모르는 부분을 직접 찾아서 익혔습니다.',
    '연구는 “자발적으로 참여”하는 활동과 “핵심 가치”라는 표현을 구분하였습니다.'
  ].join(' ');
  const output = [
    '이 경험을 통해 저는 모르는 부분을 직접 찾아 익혔습니다.',
    '연구는 “자발적으로 참여”하는 활동과 “핵심 가치”라는 표현을 구분했습니다.'
  ].join(' ');
  const profile = { profile: 'resume_application', targetRegister: 'professional' };
  const policy = quality.polishEditPolicy(source, output, { documentProfile: profile });

  assert.equal(policy.noSafeChange, false, JSON.stringify(policy));
  assert.equal(policy.excessiveChange, false, JSON.stringify(policy));
  assert.equal(policy.needsIssueRecovery, false, JSON.stringify(policy));
  assert.equal(policy.unresolvedSourceIssueCodes.includes('double_topic_chain'), false);
  assert.equal(policy.unresolvedSourceIssueCodes.includes('closed_quote_spacing'), false);
  assert.equal(policy.pass, true, JSON.stringify(policy));
});

test('v2.5.37: 원문의 이해·배움을 알게 되었다로 나눠 써도 새 평가로 세지 않는다', () => {
  const source = '점유율 자체보다 어떤 가격과 조건으로 객실이 판매되었는지가 수익성과 밀접하다는 점을 이해하면서, 수익관리를 전략적 업무로 바라보게 되었습니다.';
  const output = '점유율 자체보다 어떤 가격과 조건으로 객실을 판매했는지가 수익성과 밀접하다는 점을 알게 되었습니다. 이를 계기로 수익관리를 전략적 업무로 바라보게 되었습니다.';
  const audit = discourse.compareDiscourse(source, output);
  assert.equal(audit.codes.includes('new_evaluation'), false, JSON.stringify(audit));
});

test('v2.5.37: 보편적 우리와 원문 공동행위의 우리 명시는 화자 변경이 아니다', () => {
  const genericSource = '영화는 우리 주변에서 쉽게 접할 수 있다. 이번 탐구에서 나는 장면 구성을 분석했다.';
  const genericOutput = '영화는 주변에서 쉽게 접할 수 있다. 이번 탐구에서 나는 장면 구성을 분석했다.';
  const genericVoice = voice.buildVoiceProfile(genericSource, { documentProfile: 'student_self_assessment' });
  const genericAudit = voice.auditVoice(genericVoice, genericOutput, {
    documentProfile: 'student_self_assessment',
    mode: 'assignment',
    sourceText: genericSource
  });
  assert.equal(genericAudit.warnings.some(item => item.code === 'speaker_removed'), false, JSON.stringify(genericAudit));

  const jointSource = '형님과 같이 현장에 가고 싶다고 말했다.';
  const jointOutput = '우리 같이 현장에 가고 싶다고 말했다.';
  const jointVoice = voice.buildVoiceProfile(jointSource, { documentProfile: 'personal_essay' });
  const jointAudit = voice.auditVoice(jointVoice, jointOutput, {
    documentProfile: 'personal_essay',
    mode: 'assignment',
    sourceText: jointSource
  });
  assert.equal(jointAudit.warnings.some(item => item.code === 'speaker_injected'), false, JSON.stringify(jointAudit));
});

test('v2.5.37: 교과 조사·직접 제작·성찰이 결합된 글은 학술 설명문이 아니라 학생 자기평가다', () => {
  const source = [
    '소제목을 모두 제외한 완성본입니다. 바로 복사해서 사용하시면 됩니다!',
    '수학 시간에 배운 대칭이동을 실제로 확인하고자 관련 자료를 조사해 보았다. 내가 직접 수막새 사진을 좌표평면에 놓고 Y축 대칭 공식을 적용해 좌표화했다.',
    '이 활동을 계기로 대칭의 아름다움을 보여 주는 포스터를 직접 제작했다. 건축물 사진과 내가 선과 원으로 디자인한 엠블럼을 배치하고 대칭이동 화살표도 시각화했다.',
    '이번 과정을 통해 수학이 시각 예술과 건축을 이해하는 유연한 언어라는 점을 배울 수 있었다.'
  ].join('\n');
  const clean = preflight.auditAndSanitizeSource(source).text;
  const detected = profile.detectDocumentProfile(clean, { basicStyle: 'report' });
  assert.equal(detected.profile, 'student_self_assessment', JSON.stringify(detected.candidateProfiles));
  assert.ok(detected.confidence >= 0.75, JSON.stringify(detected));
});
