'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const fingerprintAudit = require('../engine-gpt-prod/fingerprintAudit');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const voiceProfile = require('../engine-gpt-prod/voiceProfile');
const { transformStrengthBlock } = require('../engine-gpt-prod/prompts/humanize/stableCore');

test('닫는 인용부호 뒤 복합 조사와 인용구의 관형형 하다를 붙인다', () => {
  const source = [
    '법률 정의 검토',
    '「청소년기본법」에서는 청소년의 권리를 설명하고, 「청소년활동 진흥법」에서도 참여를 규정한다.',
    '이는 ‘자발적으로 참여’하는 활동을 뜻한다.',
    '그는 “참여하겠습니다.” 하고 말했다.',
    '그는 ‘가자’ 하는 말을 남겼다.'
  ].join('\n');
  const output = source
    .replace('」에서는', '」 에서는')
    .replace('」에서도', '」 에서도')
    .replace('’하는 활동', '’ 하는 활동');
  const repaired = koreanRefinement.applySafeFormattingRepairs({
    source,
    outputText: output,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.equal(repaired.text, source);
  assert.equal(repaired.changeCounts.closed_quote_particle_spacing, 3);
  assert.match(repaired.text, /“참여하겠습니다\.” 하고/u);
  assert.match(repaired.text, /‘가자’ 하는/u);
});

test('원문에 없던 만의·만으로 초점 조사 중복만 국소 제거한다', () => {
  const source = '청소년시설이나 청소년지도자만의 노력으로는 충분하지 않다.';
  const output = '청소년시설이나 청소년지도자만의 노력만으로는 충분하지 않다.';
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'report_assignment' },
    mode: 'polish'
  });
  const issue = audit.issues.find(item => item.code === 'focus_particle_redundancy');
  assert.equal(issue?.introducedCount, 1);
  const repaired = koreanRefinement.applySafeDeterministicRepairs({
    source,
    outputText: output,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.equal(repaired.text, source);
  assert.ok(repaired.changeCodes.includes('focus_particle_redundancy'));
});

test('상황 주어와 느낀 경험의 잘못된 격틀은 검출하고 원문 문장으로 복원한다', () => {
  const source = '낯선 사람들과 관계를 맺는 일이 부담스럽게 느껴졌던 경험이 있다.';
  const output = '낯선 사람들과 관계를 맺는 일이 부담스럽게 느낀 경험이 있다.';
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'general_essay' },
    mode: 'assignment'
  });
  const issue = audit.issues.find(item => item.code === 'subject_experiencer_case_frame');
  assert.equal(issue?.introducedCount, 1);
  const restored = koreanRefinement.restoreIntroducedIntegritySentences({ source, outputText: output, audit });
  assert.equal(restored.applied, true);
  assert.equal(restored.text, source);

  const valid = koreanRefinement.detectTextIssues('나는 그 일을 부담스럽게 느낀 경험이 있다.');
  assert.equal(valid.some(item => item.code === 'subject_experiencer_case_frame'), false);
});

test('긴 무띄어쓰기 한글 구간은 원문부터 있더라도 모델 교정 대상으로 올린다', () => {
  const source = '그러나변수를정의하고비용함수를설정하며각조건의차이를비교하는과정에서는충분한검토와반복적인확인이필요하다고판단하였다.';
  const issues = koreanRefinement.detectTextIssues(source, {
    profile: 'report_assignment',
    includeSourceNotation: true
  });
  assert.ok(issues.some(item => item.code === 'collapsed_korean_spacing_run'));
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: source,
    documentProfile: { profile: 'report_assignment' },
    mode: 'blog'
  });
  assert.ok(audit.repairableCodes.includes('collapsed_korean_spacing_run'));
  assert.match(
    koreanRefinement.buildSourcePromptHints(source, {
      documentProfile: { profile: 'report_assignment' },
      mode: 'blog'
    }),
    /collapsed_korean_spacing_run/u
  );
});

test('다듬기에서 삭제된 결론·논리 연결어만 대응 문장에 복원한다', () => {
  const source = [
    '이러한 내용을 종합하면 청소년 육성은 사회 전체의 공동 책임이다.',
    '결국 제도의 목적은 자발적인 참여를 돕는 데 있다.',
    '이처럼 지역사회의 협력이 함께 이루어져야 한다.'
  ].join(' ');
  const output = [
    '청소년 육성은 사회 구성원 모두의 공동 책임이다.',
    '제도의 목적은 자발적인 참여를 돕는 데 있다.',
    '지역사회의 협력도 함께 이루어져야 한다.'
  ].join(' ');
  const restored = koreanRefinement.restorePolishDiscourseOpeners({ source, outputText: output });
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.equal(restored.restoredCount, 3);
  assert.match(restored.text, /^이러한 내용을 종합하면/u);
  assert.match(restored.text, /\. 결국 제도의 목적/u);
  assert.match(restored.text, /\. 이처럼 지역사회의 협력/u);
});

test('다듬기는 원문의 단일 줄바꿈과 빈 줄 경계를 그대로 복원한다', () => {
  const source = [
    '첫 문장은 지원 동기를 설명합니다.',
    '둘째 문장은 준비 과정을 설명합니다.',
    '',
    '셋째 문장은 활동 계획을 설명합니다.',
    '넷째 문장은 이후 계획을 정리합니다.'
  ].join('\n');
  const output = [
    '첫 문장은 지원 이유를 설명합니다.',
    '',
    '둘째 문장은 준비한 과정을 설명합니다.',
    '',
    '셋째 문장은 활동할 계획을 설명합니다.',
    '',
    '넷째 문장은 이후의 계획을 정리합니다.'
  ].join('\n');
  const restored = structureChunk.restoreParagraphLayout({
    source,
    outputText: output,
    chunks: structureChunk.splitChunksForGpt(source, { coalesceEditable: true }).chunks,
    mode: 'polish',
    requestStrength: 'polish',
    documentProfile: { profile: 'resume_application', confidence: 0.92 },
    profileConfidence: 0.92
  });
  assert.equal(restored.policy, 'exact_polish_line_separators');
  assert.equal(restored.text, [
    '첫 문장은 지원 이유를 설명합니다.',
    '둘째 문장은 준비한 과정을 설명합니다.',
    '',
    '셋째 문장은 활동할 계획을 설명합니다.',
    '넷째 문장은 이후의 계획을 정리합니다.'
  ].join('\n'));
  assert.equal(restored.pass, true);
});

test('원문보다 늘어난 짧은 또한 꼬리 문단은 앞 실행 계획 문단에 결합한다', () => {
  const source = [
    '통신 장비를 점검하며 장애 원인을 기록했고 현장 대응 절차를 익혔습니다.',
    '장비별 점검 결과를 정리해 팀원들과 공유하면서 협업의 중요성도 배웠습니다.',
    '예상하지 못한 장애가 발생했을 때는 매뉴얼과 이력을 함께 확인했습니다.',
    '이 경험을 바탕으로 입사 후에도 장비 상태와 작업 이력을 꼼꼼히 점검하겠습니다.',
    '고객이 안정적으로 서비스를 이용할 수 있도록 맡은 업무를 책임 있게 수행하겠습니다.',
    '부족한 기술은 교육과 실습을 통해 보완하겠습니다.',
    '또한 꾸준히 기술을 익혀 안정적인 통신 서비스를 만드는 데 기여하겠습니다.'
  ].join(' ');
  const output = [
    [
      '통신 장비를 점검하며 장애 원인을 기록했고 현장 대응 절차를 익혔습니다.',
      '장비별 점검 결과를 정리해 팀원들과 공유하면서 협업의 중요성도 배웠습니다.',
      '예상하지 못한 장애가 발생했을 때는 매뉴얼과 이력을 함께 확인했습니다.'
    ].join(' '),
    [
      '이 경험을 바탕으로 입사 후에도 장비 상태와 작업 이력을 꼼꼼히 점검하겠습니다.',
      '고객이 안정적으로 서비스를 이용할 수 있도록 맡은 업무를 책임 있게 수행하겠습니다.',
      '부족한 기술은 교육과 실습을 통해 보완하겠습니다.'
    ].join(' '),
    '또한 꾸준히 기술을 익혀 안정적인 통신 서비스를 만드는 데 기여하겠습니다.'
  ].join('\n\n');
  const restored = structureChunk.restoreParagraphLayout({
    source,
    outputText: output,
    chunks: structureChunk.splitChunksForGpt(source, { coalesceEditable: true }).chunks,
    mode: 'blog',
    requestStrength: 'basic',
    documentProfile: { profile: 'resume_application', confidence: 0.93 },
    profileConfidence: 0.93
  });
  assert.equal(restored.policy, 'semantic_prose_roles');
  assert.equal(restored.additiveTailMergeCount, 1);
  assert.doesNotMatch(restored.text, /\n\n또한 꾸준히/u);
  assert.equal(restored.text.replace(/\s+/gu, ''), source.replace(/\s+/gu, ''));
  assert.equal(restored.pass, true);
});

test('다듬기 프롬프트는 원문의 기능성 연결어 보존을 명시한다', () => {
  const block = transformStrengthBlock('polish', 'report_assignment', 'polish');
  assert.match(block, /문장 첫 연결어/u);
  assert.match(block, /삭제하거나 바꾸지 않는다/u);
});

test('비다듬기 자소서의 자연스러운 한국어 주어 생략을 화자 삭제로 오인하지 않는다', () => {
  const source = [
    '저는 장비 점검 임무를 맡았습니다.',
    '고장 이력을 확인하고 우선순위를 정했습니다.',
    '점검 결과를 공유했고 일정을 마쳤습니다.'
  ].join(' ');
  const output = [
    '장비 점검 임무를 맡았습니다.',
    '고장 이력을 확인해 우선순위를 정했습니다.',
    '점검 결과를 공유하며 일정을 마쳤습니다.'
  ].join(' ');
  const sourceVoice = voiceProfile.buildVoiceProfile(source, {
    documentProfile: 'resume_application',
    mode: 'assignment'
  });
  const audit = voiceProfile.auditVoice(sourceVoice, output, {
    documentProfile: 'resume_application',
    sourceText: source,
    mode: 'assignment'
  });
  assert.equal(audit.warnings.some(item => item.code === 'speaker_removed'), false);

  const polishAudit = voiceProfile.auditVoice(sourceVoice, output, {
    documentProfile: 'resume_application',
    sourceText: source,
    mode: 'polish'
  });
  assert.equal(polishAudit.warnings.some(item => item.code === 'speaker_removed'), true);
});

test('의미 관계 수리는 같은 주제의 주변 문장을 함께 덮지 않고 대응 문장부터 복원한다', () => {
  const source = [
    '학력부진의 원인을 살펴보았다.',
    '학력부진 학생은 같은 낮은 성취를 보이더라도 원인은 다를 수 있다.',
    '학생별 상황에 맞춘 지원이 필요하다.'
  ].join('\n\n');
  const output = [
    '학력부진의 원인을 검토했다.',
    '학력부진 학생들이 같은 낮은 성취를 보인다면 원인도 같다.',
    '학생마다 학습 수준과 상황을 살펴야 한다.',
    '지원 방법도 각자 다르게 정해야 한다.'
  ].join('\n\n');
  const restored = fingerprintAudit.restoreUnsafeRelationSentences(source, output, {
    violations: [{
      code: 'semantic_relation_shift',
      family: 'possibility_hardened_to_certainty',
      sentenceOrdinals: [2]
    }]
  });
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.match(restored.text, /원인은 다를 수 있다/u);
  assert.match(restored.text, /학생마다 학습 수준과 상황을 살펴야 한다/u);
  assert.match(restored.text, /지원 방법도 각자 다르게 정해야 한다/u);
});
