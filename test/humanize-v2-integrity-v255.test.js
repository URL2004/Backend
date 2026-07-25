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
  buildVoiceProfile,
  auditVoice,
  auditDirectQuoteIntegrity,
  restoreDirectQuoteContents
} = require('../engine-gpt-prod/voiceProfile');
const {
  CONTENT_GENRES,
  PROFILE_GROUPS,
  detectDocumentProfile,
  resolveRegisterPolicy
} = require('../engine-gpt-prod/documentProfile');
const prompts = require('../engine-gpt-prod/prompts');
const naturalness = require('../engine/koreanQuality/naturalnessShadow');
const styleConsistency = require('../engine/koreanQuality/styleConsistency');
const floor = require('../engine/floor');
const surfaceguard = require('../engine/surfaceguard');
const sectionRecovery = require('../engine-gpt-prod/sectionRecovery');
const experienceAudit = require('../engine-gpt-prod/experienceAudit');
const qualityPatternShadow = require('../labs/qualityPatternAudit');
const { findAnchorLeaks } = require('../engine/anchorLeakAudit');
const pov = require('../engine/pov');
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
    'quality_pattern_lab',
    'sentence_distribution_shift'
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

test('최종 품질 경고와 engineMeta 전달 결정은 한 정책에서 같은 상태로 확정된다', () => {
  const clean = deliveryPolicy.reconcileFinalDelivery({
    blocked: false,
    baseReasonCodes: [],
    qualityWarnings: []
  });
  assert.deepEqual(clean, { decision: 'deliver_clean', reasonCodes: [] });

  const review = deliveryPolicy.reconcileFinalDelivery({
    blocked: false,
    baseReasonCodes: [],
    qualityWarnings: [{ code: 'structural_line_loss' }]
  });
  assert.equal(review.decision, 'deliver_review');
  assert.deepEqual(review.reasonCodes, ['structural_line_loss']);

  const blocked = deliveryPolicy.reconcileFinalDelivery({
    blocked: true,
    baseReasonCodes: ['openai_schema_error'],
    qualityWarnings: [{ code: 'semantic_omission' }]
  });
  assert.equal(blocked.decision, 'block_technical');
  assert.deepEqual(blocked.reasonCodes, ['openai_schema_error']);
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

test('향이 나는·냄새 나는의 동사형 나는을 1인칭 화자로 세지 않는다', () => {
  const source = '비를 피해 들어선 곳은 고서점 같은 향이 나는 아늑한 공간이었다.';
  const output = '비를 피해 들어선 곳은 고서점 같은 향이 감도는 아늑한 공간이었다.';
  assert.equal(pov.computePovSeed(source).fp_singular, 0);
  assert.equal(experienceAudit.signalCounts(source).firstPerson, 0);
  assert.equal(styleConsistency.analyzeStyle(source).firstPersonCount, 0);
  assert.equal(surfaceguard.isLivedScene('향이 나는 공간을 방문했었다.'), false);
  assert.equal(detectDocumentProfile(source).riskFlags.includes('pov_sensitive'), false);
  const profile = buildVoiceProfile(source, { documentProfile: 'report_assignment' });
  assert.equal(profile.pov.firstSingular, 0);
  assert.equal(
    auditVoice(profile, output, {
      documentProfile: 'report_assignment',
      sourceText: source
    }).warnings.some(item => item.code === 'speaker_removed'),
    false
  );
  assert.equal(pov.computePovSeed('나는 자료를 검토했다.').fp_singular, 1);
  assert.equal(pov.computePovSeed('어제 나는 자료를 검토했다.').fp_singular, 1);
  assert.equal(surfaceguard.isLivedScene('어제 나는 자료를 검토했었다.'), true);
  assert.ok(pov.computePovSeed('팀 활동을 돌아보면 나는 설명을 맡았고 나도 끝까지 참여했다.').fp_singular >= 2);
});

test('사회 내·시장 내의 범위 명사 내를 1인칭 소유격으로 세지 않는다', () => {
  const source = '사회 내 안전망과 시장 내 경쟁 구조를 함께 분석한다.';
  const output = '사회 내 안전망과 시장 내 경쟁 구조를 차례로 분석한다.';
  assert.equal(pov.computePovSeed(source).fp_singular, 0);
  assert.equal(pov.computePovSeed('내 목표와 내 경험을 정리했다.').fp_singular, 2);
  const profile = buildVoiceProfile(source, { documentProfile: 'report_assignment' });
  assert.equal(
    auditVoice(profile, output, {
      documentProfile: 'report_assignment',
      sourceText: source
    }).warnings.some(item => item.code === 'speaker_injected'),
    false
  );
});

test('구형 격식 환경변수가 켜져도 원문에 없는 1인칭 화자를 허용하지 않는다', () => {
  const previousFormal = process.env.FORMAL_HUMAN;
  const previousAssignment = process.env.ASSIGNMENT_B7;
  process.env.FORMAL_HUMAN = '1';
  process.env.ASSIGNMENT_B7 = '1';
  try {
    const source = '이 연구는 자료를 비교하고 결과를 설명한다.';
    const output = '저는 이 연구에서 자료를 비교하고 결과를 설명한다고 본다.';
    const violations = floor.collectFloorViolations({
      result: { outputText: output },
      rawText: source,
      povSeed: floor.computePovSeed(source),
      optIn: false,
      mode: 'assignment',
      chunkLevel: true
    });
    assert.ok(violations.some(item => item.type === 'pov'), JSON.stringify(violations));
  } finally {
    if (previousFormal == null) delete process.env.FORMAL_HUMAN;
    else process.env.FORMAL_HUMAN = previousFormal;
    if (previousAssignment == null) delete process.env.ASSIGNMENT_B7;
    else process.env.ASSIGNMENT_B7 = previousAssignment;
  }
});

test('문서·voice·shadow 종결체 판정은 명사 끝 요를 해요체로 세지 않는다', () => {
  const source = '주요.\n수요.\n필요.\n개요.';
  const profile = buildVoiceProfile(source, { documentProfile: 'report_assignment' });
  const shadow = styleConsistency.analyzeStyle(source);
  assert.equal(profile.register, 'unknown');
  assert.equal(profile.endings.haeyo, 0);
  assert.equal(profile.endings.other, 4);
  assert.equal(shadow.endings.haeyo, 0);
  assert.equal(shadow.dominantRegister, 'unknown');
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

test('구조 모듈이 승인한 원문 역할·읽기 단위 문단 수를 voice 감사가 다시 오류로 뒤집지 않는다', () => {
  const source = [
    '첫 문단은 문제를 설명한다. 이어서 배경을 덧붙인다.',
    '둘째 문단은 자료를 설명한다. 이어서 방법을 밝힌다.',
    '셋째 문단은 결과를 설명한다. 이어서 한계를 밝힌다.',
    '마지막 문단은 결론을 정리한다. 이어서 후속 방향을 제시한다.'
  ].join('\n\n');
  const output = [
    '첫 문단은 문제를 설명한다.',
    '이어서 배경을 덧붙인다.',
    '둘째 문단은 자료를 설명한다.',
    '이어서 방법을 밝힌다.',
    '셋째 문단은 결과를 설명하고 한계도 밝힌다.',
    '마지막 문단은 결론을 정리한다.',
    '이어서 후속 방향을 제시한다.'
  ].join('\n\n');
  const profile = { profile: 'report_assignment', group: 'academic_report_explainer' };
  const voice = buildVoiceProfile(source, { documentProfile: profile, mode: 'assignment' });
  const unmarked = auditVoice(voice, output, {
    documentProfile: profile,
    mode: 'assignment',
    sourceText: source
  });
  assert.ok(unmarked.warnings.some(item => item.code === 'paragraph_structure_changed'));
  for (const policy of [
    'source_paragraph_roles',
    'source_readable_units',
    'readability_cap',
    'bounded_sensitive_report',
    'bounded_source_paragraphs',
    'structural_visual_gaps'
  ]) {
    const audited = auditVoice(voice, output, {
      documentProfile: profile,
      mode: 'assignment',
      sourceText: source,
      layoutPolicy: policy,
      layoutTargetCount: 7
    });
    assert.equal(
      audited.warnings.some(item => item.code === 'paragraph_structure_changed'),
      false,
      `${policy}: ${JSON.stringify(audited.warnings)}`
    );
  }
});

test('사과·자료 전달 메일과 서사형 창작 산문을 각각 올바른 장르로 분리한다', () => {
  const mail = '안녕하세요, 담당자님. 답장이 늦어 죄송합니다. 요청하신 자료를 첨부하오니 확인 부탁드립니다. 감사합니다.';
  assert.equal(detectDocumentProfile(mail, { basicStyle: 'blog' }).profile, 'mail_notice');

  const creative = '비가 그친 골목에서 민수는 젖은 우산을 접었다. “이제 돌아갈까?” 지연이 묻자 그는 가로등 아래 고인 물만 바라보았다. 오래전 떠난 사람의 발자국이 거기 남아 있는 듯했다.';
  assert.equal(detectDocumentProfile(creative, { basicStyle: 'report' }).profile, 'creative');
});

test('등장인물과 장면을 설명하는 문학 분석문을 창작문으로 오인하지 않는다', () => {
  const literaryAnalysis = [
    '이 작품은 한 소년이 두 세계를 오가며 자아를 형성하는 과정을 다룬 소설이다.',
    '소설에서 주인공은 가족이 상징하는 밝은 세계와 골목의 어두운 세계를 차례로 경험한다.',
    '작가는 등장인물의 선택을 통해 선과 악을 단순히 나누는 관점의 한계를 보여 준다.',
    '작품 속 인물의 갈등은 외부 사건의 요약에 그치지 않고 내면 변화의 계기로 기능한다.',
    '주인공이 친구를 다시 만나는 장면은 기존 질서에서 벗어나는 전환을 상징한다.',
    '이 구절의 의미는 인물이 두려움을 없앴다는 데 있지 않고 두려움을 자기 일부로 받아들였다는 데 있다.',
    '따라서 작품의 서사는 성장 과정을 영웅의 승리로 정리하기보다 모순된 자아를 통합하는 과정으로 제시한다.',
    '이러한 해석은 소설의 결말과 앞선 장면을 함께 대조할 때 더 분명하게 드러난다.'
  ].join(' ');
  const detected = detectDocumentProfile(literaryAnalysis, { basicStyle: 'blog' });
  assert.notEqual(detected.profile, 'creative', JSON.stringify(detected.candidateProfiles));
  assert.equal(detected.profile, 'report_assignment', JSON.stringify(detected.candidateProfiles));
  assert.equal(detected.signals.literaryAnalysisFrame, true);
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

test('늦은 수리가 같은 개수의 다른 한국어 오류로 바꿔치기해도 공통 감사가 거부한다', () => {
  const source = [
    '실점의 가장 큰 원인은 수비 조직력 부족이었다.',
    '가치사슬을 분석하면 기업의 경쟁력이 드러난다.'
  ].join(' ');
  const before = [
    '실점은 수비 조직력 부족에서 비롯된 가장 큰 원인이었다.',
    '가치사슬을 분석하면 기업의 경쟁력이 드러난다.'
  ].join(' ');
  const candidate = [
    '실점의 가장 큰 원인은 수비 조직력 부족이었다.',
    '가치사슬 분석을 살펴보면 기업의 경쟁력이 드러난다.'
  ].join(' ');
  const audit = candidateIntegrity.auditCandidateIntegrity({
    source,
    before,
    candidate,
    documentProfile: { profile: 'report_assignment', targetRegister: 'academic_formal' },
    mode: 'assignment'
  });
  assert.equal(audit.pass, false, JSON.stringify(audit));
  assert.ok(audit.reasons.includes('korean_integrity_worsened'), JSON.stringify(audit));
});

test('늦은 수리가 목록·잠금 토큰의 행 경계를 합치면 공통 감사가 거부한다', () => {
  const source = [
    '결론',
    '● 첫 번째 결과는 수치 변화와 관련된다.',
    '● 두 번째 결과는 조건 간 차이와 관련된다.'
  ].join('\n');
  const mergedList = '결론\n● 첫 번째 결과는 수치 변화와 관련된다. ● 두 번째 결과는 조건 간 차이와 관련된다.';
  const listAudit = candidateIntegrity.auditCandidateIntegrity({
    source,
    before: source,
    candidate: mergedList,
    documentProfile: {
      profile: 'report_assignment',
      formatProfile: { flags: ['list_heavy'] }
    },
    mode: 'assignment'
  });
  assert.equal(listAudit.pass, false, JSON.stringify(listAudit));
  assert.ok(listAudit.reasons.includes('structure_integrity_worsened'));

  const frozenSource = '첫 설명이다.\nZXQLOCK0000QXZ둘째 설명이다.';
  const tokenAudit = candidateIntegrity.auditCandidateIntegrity({
    source: frozenSource,
    before: frozenSource,
    candidate: '첫 설명이다. ZXQLOCK0000QXZ둘째 설명이다.',
    documentProfile: {
      profile: 'report_assignment',
      formatProfile: { flags: ['sectioned'] }
    },
    mode: 'assignment'
  });
  assert.equal(tokenAudit.pass, false, JSON.stringify(tokenAudit));
  assert.ok(tokenAudit.reasons.includes('structure_integrity_worsened'));
  assert.ok(tokenAudit.candidate.tokenBoundaryRisk > tokenAudit.before.tokenBoundaryRisk);
});

test('목록 여러 행은 가독성 문단 분할 과정에서도 한 줄로 합쳐지지 않는다', () => {
  const longBody = '검사값의 평균과 표준편차를 함께 비교했다. 조건별 신뢰구간도 확인했다. ';
  const source = [
    `4. ${longBody.repeat(4)}`,
    `5. ${longBody.repeat(4)}`,
    `6. ${longBody.repeat(4)}`
  ].join('\n');
  const plan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveLineBoundaries: 'structural'
  });
  const repaired = structure.restorePostSemanticLayout({
    source,
    outputText: source,
    chunks: plan.chunks,
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: {
      profile: 'report_assignment',
      confidence: 0.95,
      formatProfile: { flags: ['list_heavy'] }
    },
    profileConfidence: 0.95
  });
  assert.equal(repaired.pass, true, JSON.stringify(repaired.paragraphs));
  assert.match(repaired.text, /^4\.[^\n]+\n+5\.[^\n]+\n+6\./mu);
});

test('창작문 레이아웃을 의도적으로 보존한 결과는 긴 문단 때문에 구조 실패가 되지 않는다', () => {
  const source = Array.from(
    { length: 14 },
    (_, index) => `장면 ${index + 1}에서 인물은 창밖을 바라보며 오래된 기억을 떠올렸다.`
  ).join(' ');
  const repaired = structure.restorePostSemanticLayout({
    source,
    outputText: source,
    chunks: [],
    mode: 'assignment',
    requestStrength: 'basic',
    documentProfile: { profile: 'creative', confidence: 0.95 },
    profileConfidence: 0.95
  });
  assert.equal(repaired.paragraphs.policy, 'creative_preserve');
  assert.equal(repaired.pass, true, JSON.stringify(repaired.paragraphs));
});

test('직접 인용 복원은 따옴표 내용을 중복하지 않고 검증 실패 시 원문 후보를 버린다', () => {
  const source = '그는 ‘밝은 세계’를 떠나며 “새는 알에서 나오려고 투쟁한다.”라고 말했다.';
  const output = '그는 ‘안전한 세계’를 떠나며 “새는 껍질을 깨고 나온다.”라고 말했다.';
  const restored = restoreDirectQuoteContents(source, output);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.equal(restored.text, source);
  assert.equal(auditDirectQuoteIntegrity(source, restored.text).pass, true);
  assert.equal((restored.text.match(/밝은 세계/gu) || []).length, 1);
  assert.equal((restored.text.match(/새는 알에서 나오려고 투쟁한다/gu) || []).length, 1);

  const mismatched = restoreDirectQuoteContents(
    '그는 ‘첫 인용’과 ‘둘째 인용’을 말했다.',
    '그는 ‘바뀐 인용’을 말했다.'
  );
  assert.equal(mismatched.applied, false);
  assert.equal(mismatched.text, '그는 ‘바뀐 인용’을 말했다.');
});

test('닫는 따옴표 뒤의 인·였다면·였다는·이었던은 정상 조사·서술 결합이다', () => {
  const text = [
    '흔히 ‘골목대장’인 인물을 만났다.',
    '그가 ‘악마’였다면 친구는 조력자였다.',
    '그 선택이 ‘전환점’이었다는 해석도 가능하다.',
    '그는 결국 ‘완성된 자기 자신’이었던 셈이다.',
    '그는 「밝은 세계」에서 벗어났다.'
  ].join(' ');
  const audit = korean.analyzeKoreanRefinement({
    source: text,
    outputText: text,
    documentProfile: { profile: 'report_assignment', targetRegister: 'academic_formal' },
    mode: 'assignment'
  });
  assert.equal(audit.issueCodes.includes('closed_quote_spacing'), false, JSON.stringify(audit));
  assert.equal(audit.issueCodes.includes('closed_quote_particle_spacing'), false, JSON.stringify(audit));
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

  const dimension = discourse.compareDiscourse(
    '가격 경쟁력을 확보하는 차원을 넘어 고유 역량을 극대화해야 한다.',
    '가격 경쟁력을 확보하는 데 그치지 않고 고유 역량을 극대화해야 한다.'
  );
  assert.equal(dimension.codes.includes('scope_expansion'), false, dimension.codes.join(','));

  const tool = discourse.compareDiscourse(
    '이 기술은 더 이상 검색 도구가 아니라 관계적 상호작용을 제공하는 매체로 확장되고 있다.',
    '이 기술은 검색 도구에 그치지 않고 관계적 상호작용을 제공하는 매체로 확장되고 있다.'
  );
  assert.equal(tool.codes.includes('scope_expansion'), false, tool.codes.join(','));

  const character = discourse.compareDiscourse(
    '이 제도는 임시적 성격을 벗어나 보편적 성격을 띠어야 한다.',
    '이 제도는 임시적 성격에 머무르지 않고 보편적 성격을 띠어야 한다.'
  );
  assert.equal(character.codes.includes('scope_expansion'), false, character.codes.join(','));

  const pairedTransitions = discourse.compareDiscourse(
    [
      '생성형 AI는 더 이상 단순한 검색 도구가 아니라 대화형 응답을 통해 관계적 상호작용을 제공하는 매체로 확장되고 있다.',
      '생성형 AI는 단순히 결과물을 생성하는 도구를 넘어 사용자의 인지적 부담을 줄이고 즉각적인 반응을 제공한다.'
    ].join(' '),
    [
      '생성형 AI는 이제 단순한 검색 도구를 넘어 대화형 응답을 매개로 관계적 상호작용을 제공하는 매체로까지 확장되고 있다.',
      '생성형 AI는 결과물을 생성하는 도구에 그치지 않고 사용자의 인지적 부담을 줄이며 즉각적인 반응을 제공한다.'
    ].join(' ')
  );
  assert.equal(
    pairedTransitions.codes.includes('scope_expansion'),
    false,
    pairedTransitions.codes.join(',')
  );

  const realExpansion = discourse.compareDiscourse(
    '기후 자료에서 연도별 평균 기온 변화를 비교했다.',
    '기후 자료에서 연도별 평균 기온 변화를 비교했다. 나아가 세계 시민, 기후 난민, 식량 안보와 인권 문제로까지 범위를 확장했다.'
  );
  assert.equal(realExpansion.codes.includes('scope_expansion'), true, JSON.stringify(realExpansion.metrics));
});

test('연구 문헌을 살펴본다는 정상 표현은 명사·서술어 오류로 오인하지 않는다', () => {
  const source = '국내 연구를 살펴보면 청소년의 생성형 AI 사용은 빠르게 확산되고 있다.';
  const audit = korean.analyzeKoreanRefinement({
    source,
    outputText: source,
    documentProfile: { profile: 'report_assignment', targetRegister: 'academic_formal' },
    mode: 'assignment'
  });
  assert.equal(audit.issueCodes.includes('nominal_predicate_collocation'), false, JSON.stringify(audit));
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
