'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const deliveryPolicy = require('../lib/humanizeDeliveryPolicy');
const alignment = require('../engine-gpt-prod/sentenceAlignment');
const fingerprint = require('../engine-gpt-prod/fingerprintAudit');
const korean = require('../engine-gpt-prod/koreanRefinement');
const candidateIntegrity = require('../engine-gpt-prod/candidateIntegrity');
const endingStyle = require('../engine-gpt-prod/endingStyleAudit');
const quality = require('../engine-gpt-prod/finalQualityV2');
const structure = require('../engine-gpt-prod/structureChunk');
const discourse = require('../engine-gpt-prod/discourseAudit');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const {
  CONTENT_GENRES,
  PROFILE_GROUPS,
  detectDocumentProfile,
  resolveRegisterPolicy
} = require('../engine-gpt-prod/documentProfile');
const prompts = require('../engine-gpt-prod/prompts');
const naturalness = require('../engine/koreanQuality/naturalnessShadow');
const sectionRecovery = require('../engine-gpt-prod/sectionRecovery');
const qualityPatternShadow = require('../labs/qualityPatternAudit');
const { findAnchorLeaks } = require('../engine/anchorLeakAudit');
const { spanInSource } = require('../engine-gpt-prod/judge');
const {
  classifyModelFailure,
  isNonEscalatableModelFailureCode
} = require('../engine-gpt-prod/modelFailure');

test('과거 한국어·표면·shadow 게이트는 품질 경고가 아니라 효과 관측으로만 남는다', () => {
  for (const gate of [
    'surface_risk_regression',
    'korean_quality_final',
    'nikl_quality',
    'quality_pattern_lab'
  ]) {
    const result = deliveryPolicy.applyDeliveryPolicy({
      status: 'blocked',
      criticals: [{ gate }],
      warnings: []
    }, { mode: 'formal' });
    assert.equal(result.decision, 'deliver_clean', gate);
    assert.equal(result.report.status, 'clean', gate);
    assert.deepEqual(result.reasonCodes, [], gate);
    assert.equal(result.effectItems[0].gate, gate);
  }
});

test('공통 문장 정렬은 한 문장을 두 문장으로 나눈 후보를 함께 비교한다', () => {
  const source = '정책을 시행하려면 사회적 합의가 필요하며 효과는 추가로 검토해야 할 것이다.';
  const output = '정책 시행에는 사회적 합의가 필요하다. 효과는 추가로 검토해야 할 것이다.';
  const sourceSentences = alignment.normalizeSentenceList(source);
  const outputSentences = alignment.normalizeSentenceList(output);
  const matched = alignment.alignSourceSentence(
    sourceSentences[0],
    0,
    sourceSentences.length,
    outputSentences
  );
  assert.ok(matched);
  assert.equal(matched.sentences.length, 2);
  assert.doesNotThrow(() => fingerprint.auditFingerprint(source, output, 'report_assignment'));
  assert.equal(
    fingerprint.auditFingerprint(source, output, 'report_assignment').semanticRelations.count,
    0
  );
});

test('전문 개념을 두 문장으로 나눠 보존한 결과를 격식 하락으로 오인하지 않는다', () => {
  const source = '설정된 시간에 신호를 전송하면 지정된 음성 안내가 출력되도록 구현했습니다.';
  const output = '설정된 시간에 신호를 전송했습니다. 지정된 음성 안내가 출력되도록 구현했습니다.';
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'resume_application', targetRegister: 'professional' }
  });
  assert.equal(audit.issueCodes.includes('professional_register_downgrade'), false);
});

test('늘어나는 같은 동사 내부의 나는을 이중 주제로 오인하지 않는다', () => {
  const source = '이용자가 늘어나는 현상을 분석했다.';
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: source,
    documentProfile: { profile: 'report_assignment', targetRegister: 'academic_formal' }
  });
  assert.equal(audit.issueCodes.includes('double_topic_chain'), false);
});

test('누락 조사·반복 절 표지·목적 조사 틀을 공통 한국어 감사가 잡고 안전 항목을 고친다', () => {
  const source = '협업 태도가 중요하다고 생각합니다. 생식을 목적으로 두지만 생존도 고려합니다.';
  const output = '협업 태도 중요하다고 생각합니다. 그 과정에서 기준을 확인했고 그 과정에서 계획을 세웠습니다. 생식을 목적에 두지만 생존도 고려합니다.';
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'resume_application', targetRegister: 'professional' }
  });
  for (const code of ['missing_subject_particle', 'repeated_clause_anchor', 'purpose_case_frame']) {
    assert.ok(audit.issueCodes.includes(code), `${code}: ${JSON.stringify(audit.issues)}`);
  }
  const repaired = korean.applySafeDeterministicRepairs({
    source,
    outputText: output,
    documentProfile: { profile: 'resume_application', targetRegister: 'professional' }
  });
  assert.match(repaired.text, /협업 태도가 중요/u);
  assert.match(repaired.text, /생식을 목적으로 두지만/u);
  assert.ok(repaired.changeCodes.includes('missing_subject_particle'));
  assert.ok(repaired.changeCodes.includes('purpose_case_frame'));
});

test('연속 제목 뒤 본문은 마지막 제목 경로를 사용하고 앞 절로 밀리지 않는다', () => {
  const source = [
    'Ⅰ. 서론',
    '1. 연구 배경',
    '서론 본문이다.',
    'Ⅱ. 본론',
    '2. 분석 방법',
    '본론 내용이다.'
  ].join('\n');
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
  const intro = plan.chunks.find(chunk => !chunk.locked && chunk.text.includes('서론 본문'));
  const body = plan.chunks.find(chunk => !chunk.locked && chunk.text.includes('본론 내용'));
  assert.match(intro.sectionPath, /1\. 연구 배경/u);
  assert.doesNotMatch(intro.sectionPath, /Ⅱ\. 본론/u);
  assert.match(body.sectionPath, /2\. 분석 방법/u);
  const audit = structure.buildStructureAudit({
    source,
    outputText: source,
    chunks: plan.chunks,
    plan
  });
  assert.equal(audit.sectionPathErrorCount, 0, JSON.stringify(audit.sectionPathErrors));
});

test('화면 폭 때문에 생긴 단일 줄바꿈은 자연성 문장·리듬 지표를 바꾸지 않는다', () => {
  const wrapped = '첫 문장은 화면 폭 때문에\n중간에서 줄만 바뀌었다. 둘째 문장은 짧다. 셋째 문장은 조금 더 길게 설명한다. 넷째 문장은 결론이다.';
  const unwrapped = wrapped.replace('\n', ' ');
  const before = naturalness.measureNaturalnessShadow(wrapped);
  const after = naturalness.measureNaturalnessShadow(unwrapped);
  assert.equal(before.version, 5);
  assert.equal(before.sentenceCount, after.sentenceCount);
  assert.equal(before.sentenceCv, after.sentenceCv);
  assert.equal(before.metrics.uniformSentenceRhythm, after.metrics.uniformSentenceRhythm);
});

test('사과·자료 전달 메일과 서사형 창작 산문을 각각 올바른 장르로 분리한다', () => {
  const mail = '안녕하세요, 담당자님. 답장이 늦어 죄송합니다. 요청하신 자료를 첨부하오니 확인 부탁드립니다. 감사합니다.';
  assert.equal(detectDocumentProfile(mail, { basicStyle: 'blog' }).profile, 'mail_notice');

  const creative = '비가 그친 골목에서 민수는 젖은 우산을 접었다. “이제 돌아갈까?” 지연이 묻자 그는 가로등 아래 고인 물만 바라보았다. 오래전 떠난 사람의 발자국이 거기 남아 있는 듯했다.';
  assert.equal(detectDocumentProfile(creative, { basicStyle: 'report' }).profile, 'creative');
});

test('고급 강도는 격식 상승과 분리되고 프롬프트 우선순위가 한 방향으로 조립된다', () => {
  const built = prompts.buildHumanizePrompt('assignment', 'ko', {
    requestStrength: 'advanced',
    documentProfile: {
      profile: 'resume_application',
      targetRegister: 'professional'
    }
  });
  const validation = prompts.validateHumanizePrompt(built.stable);
  assert.equal(validation.pass, true, JSON.stringify(validation.errors));
  assert.doesNotMatch(built.stable, /전문\s*표현으로\s*높이면서/u);
  assert.match(built.stable, /격식.*(?:유지|보존)/u);
});

test('모든 장르×요청 강도×기본 스타일 프롬프트가 한 개 정책으로 충돌 없이 조립된다', () => {
  const strengths = [
    { requestStrength: 'basic', mode: 'blog' },
    { requestStrength: 'advanced', mode: 'assignment' },
    { requestStrength: 'polish', mode: 'polish' }
  ];
  for (const profile of CONTENT_GENRES) {
    for (const basicStyle of ['blog', 'report']) {
      for (const { requestStrength, mode } of strengths) {
        const registerPolicy = resolveRegisterPolicy({ profile, basicStyle, requestStrength });
        const formal = registerPolicy.tonePolicy === 'formal';
        const register = formal
          ? 'polite'
          : (registerPolicy.targetRegister === 'conversational' ? 'haeyo' : 'mixed');
        const built = prompts.buildHumanizePrompt(mode, 'ko', {
          register,
          requestStrength,
          documentProfile: {
            profile,
            group: PROFILE_GROUPS[profile],
            targetRegister: registerPolicy.targetRegister,
            tonePolicy: registerPolicy.tonePolicy
          }
        });
        const validation = prompts.validateHumanizePrompt(built.stable);
        const label = `${profile}/${basicStyle}/${requestStrength}`;
        assert.equal(validation.pass, true, `${label}: ${JSON.stringify(validation.errors)}`);
        assert.equal((built.stable.match(/^\[요청 강도:/gmu) || []).length, 1, label);
        assert.equal((built.stable.match(/^\[원문 장르:/gmu) || []).length, 1, label);
        assert.doesNotMatch(built.stable, /전문\s*표현으로\s*높이면서/u, label);
        if (profile === 'legal_contract') {
          assert.match(built.stable, /“할 수 있다”를 “한다”로[^.\n]*바꾸지 않는다/u, label);
        }
        if (profile === 'creative') {
          assert.match(built.stable, /각 행을 합치거나 설명문으로 풀지 않고/u, label);
        }
      }
    }
  }
});

test('원문에 이미 있는 내용은 added_claim으로 오인하지 않고 구형 앵커 소재만 누출로 잡는다', () => {
  const source = '미래에는 인공지능과 메타버스가 인간관계의 방식을 크게 바꿀 수 있다.';
  assert.equal(
    spanInSource('인공지능과 메타버스가 인간관계의 방식을 크게 바꿀 수 있다', source),
    true
  );
  assert.equal(
    spanInSource('EPA가 2024년에 위험 건물 비율을 발표했다', source),
    false
  );
  assert.equal(
    spanInSource(
      '인공지능이 메타버스를 통해 인간관계를 파괴했다',
      '인공지능의 원리를 설명했다. 메타버스의 활용 사례도 정리했다. 마지막으로 인간관계를 별도 주제로 검토했다.'
    ),
    false
  );
  assert.deepEqual(
    findAnchorLeaks('학습은 갭투자처럼 설계해야 한다.', '학습 방법에 관한 글'),
    ['갭투자']
  );
  assert.deepEqual(
    findAnchorLeaks('전세 시장이 흔들린다.', '전세 시장이 흔들린다는 원문'),
    []
  );
});

test('원문의 닫히지 않은 인용부호와 완결 문장 부호 누락을 수정 없이 알린다', () => {
  const unclosed = preflight.auditAndSanitizeSource('연구자는 “자료의 의미를 분석했다.');
  assert.equal(unclosed.changed, false);
  assert.ok(unclosed.issueCodes.includes('source_unclosed_delimiter'));

  const punctuation = preflight.auditAndSanitizeSource('연구자는 자료의 의미를 분석했다');
  assert.equal(punctuation.changed, false);
  assert.ok(punctuation.issueCodes.includes('source_missing_terminal_punctuation'));
});

test('다듬기는 원문에 있던 맞춤법·종결체 문제를 실제로 해결해야 통과한다', () => {
  const source = [
    '안내 메세지를 확인했습니다.',
    '첫 기준을 정했습니다.',
    '둘째 기준을 정했습니다.',
    '셋째 기준을 정했습니다.',
    '넷째 기준을 정했습니다.',
    '마지막 기준은 다시 확인해요.'
  ].join(' ');
  const unchanged = quality.polishEditPolicy(source, source, {
    documentProfile: { profile: 'general_essay', targetRegister: 'professional' }
  });
  assert.equal(unchanged.needsIssueRecovery, true);
  assert.ok(unchanged.unresolvedSourceIssueCodes.includes('message_spelling'));
  assert.ok(unchanged.unresolvedSourceIssueCodes.includes('ending_style_mixed'));

  const repairedText = source
    .replace('메세지', '메시지')
    .replace('다시 확인해요.', '다시 확인했습니다.');
  const repaired = quality.polishEditPolicy(source, repairedText, {
    documentProfile: { profile: 'general_essay', targetRegister: 'professional' }
  });
  assert.equal(repaired.needsIssueRecovery, false, JSON.stringify(repaired));
  assert.equal(repaired.remainingSourceIssueCount, 0);
  assert.ok(repaired.fixedSourceIssueCount >= 2);
  assert.equal(endingStyle.auditPolishEndingConsistency(source, repairedText).pass, true);
});

test('늦은 수리 후보가 새 한국어 비문을 만들면 다른 개선이 있어도 공통 감사가 거부한다', () => {
  const source = '협업 태도가 중요하다고 생각합니다. 안내 메시지를 확인했습니다.';
  const before = '협업 태도가 중요하다고 생각합니다. 안내 메세지를 확인했습니다.';
  const candidate = '협업 태도 중요하다고 생각합니다. 안내 메시지를 확인했습니다.';
  const audit = candidateIntegrity.auditCandidateIntegrity({
    source,
    before,
    candidate,
    documentProfile: { profile: 'resume_application', targetRegister: 'professional' },
    mode: 'assignment'
  });
  assert.equal(audit.pass, false, JSON.stringify(audit));
  assert.ok(audit.reasons.includes('korean_integrity_worsened'));
});

test('기능이 같은 확장 표현과 원래 한계 표현은 범위 확장으로 오인하지 않는다', () => {
  const equivalent = discourse.compareDiscourse(
    '자료 검토에 그치지 않고 적용 범위도 확인했다.',
    '자료 검토에서 나아가 적용 범위까지 확인했다.'
  );
  assert.equal(equivalent.codes.includes('scope_expansion'), false, equivalent.codes.join(','));

  const limit = discourse.compareDiscourse(
    '기존 한계를 넘어선 해결책을 검토했다.',
    '기존 한계를 넘어선 해결책을 구체적으로 살펴봤다.'
  );
  assert.equal(limit.codes.includes('scope_expansion'), false, limit.codes.join(','));
});

test('모델 호출 실패를 원인별로 기록하고 전송·refusal·schema 오류는 품질 승격에 쓰지 않는다', () => {
  const cases = [
    [Object.assign(new Error('too many requests'), { status: 429 }), 'openai_rate_limited'],
    [Object.assign(new Error('upstream unavailable'), { status: 503 }), 'openai_server_error'],
    [Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), 'openai_timeout'],
    [Object.assign(new Error('invalid json schema'), { code: 'OPENAI_SCHEMA_VALIDATION' }), 'openai_schema_error'],
    [Object.assign(new Error('refusal'), { code: 'OPENAI_REFUSAL' }), 'openai_refusal'],
    [new Error('fetch failed'), 'openai_network_error']
  ];
  for (const [error, expected] of cases) {
    const code = classifyModelFailure(error);
    assert.equal(code, expected);
    assert.equal(isNonEscalatableModelFailureCode(code), true);
  }
});

test('섹션 mini 호출이 transport 오류로 끝나면 상위 모델로 재승격하지 않는다', async () => {
  const paragraph = '자료를 검토하고 기준을 정리했으며 결과를 같은 방식으로 기록했습니다. ';
  let source = '';
  while (source.length < 2100) source += paragraph;
  const chunks = [{
    text: source,
    outputText: source,
    locked: false,
    sectionPath: 'Ⅰ. 본문'
  }];
  let calls = 0;
  const result = await sectionRecovery.recoverSections({
    chunks,
    sourceLength: source.length,
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: { profile: 'report_assignment' },
    retrySection: async () => {
      calls += 1;
      const error = new Error('OpenAI response refused the request');
      error.code = 'OPENAI_REFUSAL';
      throw error;
    }
  });
  assert.equal(result.metrics.selectedSectionCount, 1);
  assert.equal(calls, 1);
  assert.equal(result.metrics.escalationAttemptCount, 0);
  assert.equal(result.metrics.modelFailureCount, 1);
  assert.deepEqual(result.metrics.modelFailureCodes, ['openai_refusal']);
});

test('품질 패턴 도구는 관리자 shadow 감사만 붙이고 운영 결과와 전달 상태를 바꾸지 않는다', () => {
  const source = '자료를 검토하고 결과를 정리했습니다.';
  const outputText = '자료를 검토한 뒤 결과를 정리했습니다.';
  const out = {
    result: {
      outputText,
      qualityStatus: 'clean',
      records: [{ protectedTerms: ['자료'] }]
    },
    floorReport: { status: 'clean', criticals: [], warnings: [] }
  };
  const audited = qualityPatternShadow.attachQualityPatternAudit(out, source, { mode: 'assignment' });
  assert.equal(audited.result.outputText, outputText);
  assert.equal(audited.result.qualityStatus, 'clean');
  assert.equal(audited.floorReport.status, 'clean');
  assert.equal(audited.result.qualityPatternLab.auditOnly, true);
  assert.equal(typeof audited.result.patternDelta, 'object');
});
