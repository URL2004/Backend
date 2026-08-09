'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../engine-gpt-prod');
const dedupe = require('../engine/dedupe');
const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const layoutStructure = require('../engine-gpt-prod/layoutStructure');
const resumeCoverage = require('../engine-gpt-prod/resumeCoverage');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const voiceProfile = require('../engine-gpt-prod/voiceProfile');
const fingerprintAudit = require('../engine-gpt-prod/fingerprintAudit');

test('v2.5.34: 일반 output_text 거절문을 청크 승인 전에 잡고 원문 인용은 오탐하지 않는다', () => {
  const source = '저는 매일 마감 자료를 확인하며 차이가 생긴 원인을 기록했습니다. 반복되는 오류를 줄이기 위해 확인 순서를 정리했고, 동료와 결과를 공유했습니다.';
  const refused = engine.evaluateChunkGate({
    outputText: '도와드릴 수 없습니다. 요청을 처리할 수 없는 작업입니다.',
    original: source,
    contract: { povSeed: null, lengthPolicy: null },
    mode: 'blog',
    protectedTerms: [],
    documentProfile: { profile: 'resume_application' }
  });
  assert.equal(refused.hardFail, true);
  assert.equal(refused.reason, 'textual_refusal');

  const quotedSource = '모델이 “도와드릴 수 없습니다”라고 답한 사례를 분석했다. 이후 같은 질문을 다시 검토했다.';
  const quotedOutput = '모델이 “도와드릴 수 없습니다”라고 답한 사례를 살펴봤다. 이어 같은 질문을 다시 검토했다.';
  const quoted = engine.evaluateChunkGate({
    outputText: quotedOutput,
    original: quotedSource,
    contract: { povSeed: null, lengthPolicy: null },
    mode: 'blog',
    protectedTerms: [],
    documentProfile: { profile: 'report_assignment' }
  });
  assert.notEqual(quoted.reason, 'textual_refusal');
});

test('v2.5.34: 괄호형 번호 소제목은 다음 본문과 합쳐지지 않고 원래 행으로 복원된다', () => {
  const source = [
    '2. 본론',
    '(1) 경영학의 현대적 정의',
    '경영학은 조직의 의사결정과 자원 배분을 연구하는 학문이다.',
    '(2) 경영학의 핵심 특징',
    '여러 이해관계와 시장 조건을 함께 분석한다.'
  ].join('\n');
  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  assert.ok(plan.chunks.some(chunk => chunk.locked && chunk.text === '(1) 경영학의 현대적 정의'));
  assert.ok(plan.chunks.some(chunk => chunk.locked && chunk.text === '(2) 경영학의 핵심 특징'));

  const merged = source
    .replace('(1) 경영학의 현대적 정의\n', '(1) 경영학의 현대적 정의 ')
    .replace('(2) 경영학의 핵심 특징\n', '(2) 경영학의 핵심 특징 ');
  const restored = structureChunk.restoreLockedStructureLayout({
    source,
    outputText: merged,
    chunks: plan.chunks
  });
  assert.equal(restored.pass, true, JSON.stringify(restored));
  assert.equal(restored.text, source);
});

test('v2.5.34: 굵은 마크다운 목록 라벨 전체를 잠그고 불릿 별표를 굵게 표시 안에서 찾지 않는다', () => {
  const source = [
    '### 학습 포인트',
    '* **해석의 출발점과 한계**',
    '  * **문리해석**은 법해석의 출발점이다.',
    '  * 가능한 문언의 의미 범위를 확인해야 한다.',
    '* **실제 판례의 해석 방식**',
    '  * 판례는 여러 해석 기준을 함께 검토한다.'
  ].join('\n');
  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  const labelChunks = plan.chunks.filter(chunk => /해석의 출발점과 한계|실제 판례의 해석 방식/u.test(chunk.text));
  assert.equal(labelChunks.length, 2);
  assert.ok(labelChunks.every(chunk => chunk.locked && chunk.lockType === 'heading'));

  for (const chunk of plan.chunks) chunk.outputText = chunk.text;
  const merged = structureChunk.mergeChunks(plan.chunks);
  const restored = structureChunk.restoreLockedStructureLayout({ source, outputText: merged, chunks: plan.chunks });
  assert.equal(restored.text, source);
  assert.equal((restored.text.match(/^\s*\*\s*$/gmu) || []).length, 0);
});

test('v2.5.34: 길이 청크 경계가 마크다운 제목 한가운데를 자르지 않는다', () => {
  const before = `${'가'.repeat(1390)}다.\n${'나'.repeat(180)}\n`;
  const heading = '### 5. 목적해석 (Teleological Interpretation)';
  const source = `${before}${heading}\n${'법해석의 목적과 적용 범위를 설명한다. '.repeat(90)}`;
  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  assert.ok(plan.chunks.some(chunk => (
    chunk.locked === true
      && chunk.lockType === 'heading'
      && chunk.text === heading
  )), JSON.stringify(plan.chunks.map(chunk => ({ text: chunk.text.slice(0, 80), locked: chunk.locked, lockType: chunk.lockType }))));
  assert.equal(plan.chunks.some(chunk => chunk.text === '### 5.'), false);
});

test('v2.5.34: 독립 마크다운 제어 행과 갈라진 제목을 원래 구조로 복원한다', () => {
  const source = [
    '# 보고서',
    '**수강 과목 :** 법학개론',
    '**',
    '**학과 /',
    '**',
    '**제출 일자 :** 2026년 8월 9일',
    '### 5. 목적해석 (Teleological Interpretation)',
    '목적해석은 규범의 목적과 취지를 기준으로 의미를 확정한다.'
  ].join('\n');
  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  assert.equal(layoutStructure.buildLineRecords(source).filter(row => row.role === 'code').length, 2);
  const damaged = source
    .replace(/\n\*\*\n/gu, '\n')
    .replace('### 5. 목적해석', '### 5.\n목적해석');
  const restored = structureChunk.restoreLockedStructureLayout({
    source,
    outputText: damaged,
    chunks: plan.chunks
  });
  assert.equal(restored.pass, true, JSON.stringify(restored));
  assert.equal(restored.text, source);
});

test('v2.5.34: 닫는 인용부호와 라도 조사를 붙이고 정상 인용 내부는 보존한다', () => {
  const source = '같은 ‘자리 맡기’라도 상황과 조건은 달랐다.';
  const output = '같은 ‘자리 맡기’ 라도 상황과 조건은 달랐다.';
  const profile = { profile: 'report_assignment', targetRegister: 'academic_formal' };
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: profile,
    mode: 'assignment'
  });
  assert.ok(audit.issueCodes.includes('closed_quote_particle_spacing'), JSON.stringify(audit));
  const repaired = koreanRefinement.applySafeFormattingRepairs({ source, outputText: output, documentProfile: profile });
  assert.equal(repaired.text, source);
  assert.equal(repaired.changeCounts.closed_quote_particle_spacing, 1);
});

test('v2.5.34: 개인 성찰문의 나에게라는 의미 주체가 빠지면 감정 앵커 누락으로 잡는다', () => {
  const source = '이 책은 나에게 사람의 마음을 이해하는 방법을 알려 준 뜻깊은 책이었다.';
  const output = '이 책은 사람의 마음을 이해하는 방법을 보여 준 뜻깊은 책이었다.';
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'personal_essay' },
    mode: 'blog'
  });
  const issue = audit.issues.find(item => item.code === 'affective_anchor_omission');
  assert.ok(issue, JSON.stringify(audit));
  assert.deepEqual(issue.details.omissions[0].families, ['personal_significance']);

  const honorificAudit = koreanRefinement.analyzeKoreanRefinement({
    source: '이 경험은 제게 오래 기억에 남을 소중한 계기였습니다.',
    outputText: '이 경험은 오래 기억에 남을 소중한 계기였습니다.',
    documentProfile: { profile: 'personal_essay' },
    mode: 'blog'
  });
  assert.ok(honorificAudit.issueCodes.includes('affective_anchor_omission'), JSON.stringify(honorificAudit));
});

test('v2.5.34: 학술·보고서의 대화형 서술은 인용 밖에서만 문체 수리 대상으로 잡는다', () => {
  const profile = { profile: 'report_assignment', targetRegister: 'academic_formal' };
  const source = '평가라는 게 결국 비교 기준을 정하는 과정이라는 건데, 이게 바로 연구의 핵심이다. 나중에 보니까 자료의 차이도 컸다.';
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: source,
    documentProfile: profile,
    mode: 'assignment'
  });
  const formal = audit.issues.find(item => item.code === 'formal_register_residual');
  assert.ok(formal?.details?.families.includes('academic_colloquial_narration'), JSON.stringify(audit));

  const quoted = '참여자는 “이게 바로 핵심이고 나중에 보니까 차이도 컸다”라고 말했다.';
  const quotedAudit = koreanRefinement.analyzeKoreanRefinement({
    source: quoted,
    outputText: quoted,
    documentProfile: profile,
    mode: 'assignment'
  });
  assert.equal(quotedAudit.issueCodes.includes('formal_register_residual'), false, JSON.stringify(quotedAudit));
});

test('v2.5.34: 의미가 보존된 자소서 의역을 핵심 주장 누락으로 오인하지 않는다', () => {
  const firstSource = '저의 장점은 책임감과 성실함입니다. 맡은 일은 계획적으로 수행하며 작은 부분도 놓치지 않도록 꼼꼼히 확인합니다.';
  const firstOutput = '저는 책임감과 성실함을 바탕으로 맡은 일을 계획에 따라 수행합니다. 작은 부분도 빠뜨리지 않으려고 꼼꼼히 확인합니다.';
  const secondSource = '여행사 근무 당시, 고객들이 여행에 필요한 물품을 하나하나 찾아보고 준비하는 것을 번거로워한다는 점을 알게 되었습니다.';
  const secondOutput = '여행사에서 근무할 때, 고객들이 여행에 필요한 물품을 직접 하나씩 찾아 챙기는 과정을 번거롭게 여긴다는 사실을 확인했습니다.';
  assert.equal(resumeCoverage.auditResumeCoverage(firstSource, firstOutput, { profile: 'resume_application' }).pass, true);
  assert.equal(resumeCoverage.auditResumeCoverage(secondSource, secondOutput, { profile: 'resume_application' }).pass, true);
});

test('v2.5.34: 1:1 비율과 시각의 콜론은 라벨 구조로 오인하지 않는다', () => {
  const source = [
    '저는 지난 17년 동안 유아 및 초등학생을 대상으로 1:1 방문학습을 지도해 왔습니다.',
    '실습생의 공식 출근 시각은 08:30이었습니다.',
    '지원 동기: 아이와 가정을 연결하는 돌봄을 실천하고 싶습니다.'
  ].join('\n');
  const records = layoutStructure.buildLineRecords(source).filter(row => !row.blank);
  assert.equal(records[0].role, 'prose');
  assert.equal(records[1].role, 'prose');
  assert.equal(records[2].role, 'label_inline');
});

test('v2.5.34: 접속어를 붙여 한 원문 주장을 연속 복제한 짧은 문장만 제거한다', () => {
  const source = '앞으로 저는 감정에 의존하기보다 경영학에서 배운 논리적인 기획과 자원 관리 방식을 적극적으로 활용하겠습니다.';
  const output = [
    '앞으로 저는 이러한 감정에 의존하기보다 경영학에서 배운 논리적인 기획과 자원 관리 방식을 적극적으로 활용하겠습니다.',
    '대신 경영학에서 배운 논리적 기획과 자원 관리 방식을 적극적으로 활용하겠습니다.'
  ].join(' ');
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'personal_essay' },
    mode: 'blog'
  });
  assert.ok(audit.issueCodes.includes('adjacent_semantic_repetition'), JSON.stringify(audit));

  const cleaned = dedupe.removeGeneratedLocalOverlapDuplicates(source, output);
  assert.equal(cleaned.applied, true, JSON.stringify(cleaned));
  assert.equal(cleaned.text, output.slice(0, output.lastIndexOf(' 대신')));
  assert.ok(cleaned.reasons.includes('connector_subset_restatement'));
});

test('v2.5.34: 원문에 실제로 있는 대조 문장은 접속어가 있어도 중복으로 삭제하지 않는다', () => {
  const source = [
    '초기에는 감정에 의존해 경영학에서 배운 기획과 자원 관리 방식을 실제 업무에 충분히 활용하지 못했습니다.',
    '대신 이후에는 경영학에서 배운 논리적 기획과 자원 관리 방식을 일정 수립과 업무 배분에 적극적으로 활용했습니다.'
  ].join(' ');
  const cleaned = dedupe.removeGeneratedLocalOverlapDuplicates(source, source);
  assert.equal(cleaned.applied, false, JSON.stringify(cleaned));
  assert.equal(cleaned.text, source);
});

test('v2.5.34: 기존 직접 인용을 보존한 채 원문 용어에 인용부호만 더한 변화는 오탐하지 않는다', () => {
  const source = '참여자는 “직접 확인했다”고 말했다. 이어 열등감의 의미를 설명했다.';
  const output = '참여자는 “직접 확인했다”고 말했다. 이어 ‘열등감’의 의미를 설명했다.';
  const audit = voiceProfile.auditDirectQuoteIntegrity(source, output);
  assert.equal(audit.countChanged, true);
  assert.equal(audit.punctuationOnlyChange, true);
  assert.equal(audit.pass, true);

  const changed = '참여자는 “간접 확인했다”고 말했다. 이어 ‘열등감’의 의미를 설명했다.';
  assert.equal(voiceProfile.auditDirectQuoteIntegrity(source, changed).pass, false);
});

test('v2.5.34: 보편 명제의 우리는 화자 집단으로 강제 보존하지 않되 실제 팀 화자는 보존한다', () => {
  const genericSource = '저는 주변 사람에게 도움을 청했습니다. 우리는 혼자 사는 게 아니니까 서로 의지할 필요가 있다고 생각했습니다.';
  const genericOutput = '저는 주변 사람에게 도움을 청했습니다. 사람은 혼자 살아가는 존재가 아니므로 서로 의지할 필요가 있다고 생각했습니다.';
  const genericAudit = voiceProfile.auditVoice(
    voiceProfile.buildVoiceProfile(genericSource, { documentProfile: 'personal_essay', mode: 'blog' }),
    genericOutput,
    { sourceText: genericSource, documentProfile: 'personal_essay', mode: 'blog' }
  );
  assert.equal(genericAudit.warnings.some(item => item.code === 'speaker_removed'), false, JSON.stringify(genericAudit));

  const teamSource = '우리 팀은 고객 문의를 분석하고 일정을 조정했습니다.';
  const teamOutput = '고객 문의를 분석하고 일정을 조정했습니다.';
  const teamAudit = voiceProfile.auditVoice(
    voiceProfile.buildVoiceProfile(teamSource, { documentProfile: 'resume_application', mode: 'assignment' }),
    teamOutput,
    { sourceText: teamSource, documentProfile: 'resume_application', mode: 'assignment' }
  );
  assert.ok(teamAudit.warnings.some(item => item.code === 'speaker_removed'), JSON.stringify(teamAudit));
});

test('v2.5.34: 정의·선호·연결 관계를 출발점·가산 관계·지시어 주어로 바꾸지 않는다', () => {
  const source = [
    '좋은 광고는 브랜드를 자연스럽게 기억하게 만드는 것이라고 생각합니다.',
    '광고는 소비자를 설득하려 하기보다 브랜드를 긍정적으로 인식하게 하는 과정입니다.',
    '성공적인 광고는 소비자의 일상과 자연스럽게 연결될 수 있어야 합니다.'
  ].join(' ');
  const output = [
    '좋은 광고는 브랜드를 자연스럽게 기억하게 하는 데서 출발합니다.',
    '광고의 역할은 소비자를 설득하는 데만 있는 것이 아니라 브랜드를 긍정적으로 인식하게 하는 과정에 있습니다.',
    '여기에 소비자의 일상이 자연스럽게 이어져야 성공적인 광고라고 할 수 있습니다.'
  ].join(' ');
  const audit = fingerprintAudit.auditFingerprint(source, output, { profile: 'personal_essay' });
  const families = audit.semanticRelations.shifts.map(item => item.family);
  assert.ok(families.includes('definition_changed_to_starting_point'), JSON.stringify(audit));
  assert.ok(families.includes('preference_changed_to_additive_scope'), JSON.stringify(audit));
  assert.ok(families.includes('relation_subject_replaced_by_deictic'), JSON.stringify(audit));
});

test('v2.5.34: 여러 정형 접속어를 새로 쌓은 결과만 수리하고 한 번의 자연스러운 연결은 허용한다', () => {
  const source = '자료를 검토했다. 기준을 정리했다. 사례를 비교했다. 결론을 작성했다.';
  const stacked = '또한 자료를 검토했다. 이러한 기준을 정리했다. 이를 통해 사례를 비교했다. 한편 결론을 작성했다.';
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: stacked,
    documentProfile: { profile: 'report_assignment', targetRegister: 'academic_formal' },
    mode: 'assignment'
  });
  assert.ok(audit.issueCodes.includes('discourse_connector_inflation'), JSON.stringify(audit));

  const single = '자료를 검토했다. 이어 기준을 정리했다. 또한 사례를 비교했다. 결론을 작성했다.';
  const singleAudit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText: single,
    documentProfile: { profile: 'report_assignment', targetRegister: 'academic_formal' },
    mode: 'assignment'
  });
  assert.equal(singleAudit.issueCodes.includes('discourse_connector_inflation'), false, JSON.stringify(singleAudit));
});
