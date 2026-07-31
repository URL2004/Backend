'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const layoutStructure = require('../engine-gpt-prod/layoutStructure');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const voiceProfile = require('../engine-gpt-prod/voiceProfile');
const {
  effectStatusForNotices,
  conservativeRecoveryMaximumAttempts
} = require('../engine-gpt-prod');

test('v2.5.21: 대괄호 소제목은 행 전체를 잠그고 항목 라벨은 접두부만 잠근다', () => {
  const source = [
    '[소제목] 현장에서 다진 유통 감각에 데이터 오퍼레이션을 더하다',
    '[지원동기 및 이직사유] 현장 유통과 백오피스 경험을 연결해 지원했습니다.',
    '[직무상 장점] 상품 등록부터 정산까지 앞뒤 흐름을 함께 봅니다.'
  ].join('\n');

  assert.equal(
    layoutStructure.classifyLine('[소제목] 현장에서 다진 유통 감각에 데이터 오퍼레이션을 더하다'),
    'heading'
  );
  assert.equal(
    layoutStructure.classifyLine('[지원동기 및 이직사유] 현장 유통과 백오피스 경험을 연결했습니다.'),
    'label_inline'
  );

  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  const subtitle = plan.chunks.find(chunk => chunk.lockType === 'heading');
  const prefixes = plan.chunks.filter(chunk => chunk.lockType === 'label_prefix');
  assert.ok(subtitle);
  assert.equal(
    subtitle.text.trim(),
    '[소제목] 현장에서 다진 유통 감각에 데이터 오퍼레이션을 더하다'
  );
  assert.deepEqual(
    prefixes.map(chunk => chunk.text.trim()),
    ['[지원동기 및 이직사유]', '[직무상 장점]']
  );
  assert.ok(plan.chunks.some(chunk => (
    !chunk.locked && chunk.text.includes('현장 유통과 백오피스 경험')
  )));

  const citationPlan = structureChunk.splitChunksForGpt(
    '[1] 이 연구는 표본 120명을 분석했다.',
    { coalesceEditable: true }
  );
  assert.equal(
    citationPlan.chunks.some(chunk => chunk.lockType === 'label_prefix'),
    false
  );
});

test('v2.5.21: 같은 행에 합쳐진 소제목·항목 라벨을 구조 감사가 거부하고 원래 행으로 복원한다', () => {
  const source = [
    '[소제목] <주토피아> 주디처럼: 작은 임무도 완벽하게',
    '맡은 업무를 끝까지 책임지는 태도로 성과를 만들었습니다.',
    '',
    '[소제목] 현장에서 다진 유통 감각에 데이터 오퍼레이션을 더하다',
    '[지원동기 및 이직사유] 현장 유통과 백오피스 경험을 연결해 지원했습니다.',
    '[직무상 장점] 상품 등록부터 정산까지 앞뒤 흐름을 함께 봅니다.'
  ].join('\n');
  const broken = [
    '[소제목] <주토피아> 주디처럼: 작은 임무도 완벽하게 맡은 업무를 끝까지 책임지는 태도로 성과를 만들었습니다.',
    '',
    '[소제목] 현장에서 다진 유통 감각에 데이터 오퍼레이션을 더하다 [지원동기 및 이직사유] 현장 유통과 백오피스 경험을 연결해 지원했습니다.',
    '[직무상 장점] 상품 등록부터 정산까지 앞뒤 흐름을 함께 봅니다.'
  ].join('\n');
  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  const before = structureChunk.buildStructureAudit({
    source,
    outputText: broken,
    chunks: plan.chunks,
    plan
  });
  assert.equal(before.pass, false);
  assert.equal(before.bracketedLabelLayoutPass, false);

  const restored = structureChunk.restoreLockedStructureLayout({
    source,
    outputText: broken,
    chunks: plan.chunks
  });
  assert.equal(restored.pass, true);
  assert.match(
    restored.text,
    /\[소제목\] <주토피아> 주디처럼: 작은 임무도 완벽하게\n맡은 업무/u
  );
  assert.match(
    restored.text,
    /\[소제목\] 현장에서 다진 유통 감각에 데이터 오퍼레이션을 더하다\n\[지원동기 및 이직사유\] 현장 유통/u
  );
  const after = structureChunk.buildStructureAudit({
    source,
    outputText: restored.text,
    chunks: plan.chunks,
    plan
  });
  assert.equal(after.pass, true, JSON.stringify(after));
  assert.equal(after.bracketedLabelLayoutPass, true);
});

test('v2.5.21: 신규 접속어 위치·추상명사 수량화·서술어 호응·조건절 연어를 수리 대상으로 잡는다', () => {
  const source = [
    '그러나 현장에서는 요양보호사를 비롯한 돌봄 인력이 부족하다.',
    '금융기관은 많은 사람들의 신용을 바탕으로 운영된다.',
    '현재 제도의 실질적인 소득 재분배 기능은 매우 취약하다.',
    '시각디자인 분야에서 성장하기 위해 새로운 프로젝트에 계속 도전하겠습니다.',
    '다양한 경험과 배움에 열린 자세로 참여하겠습니다.'
  ].join(' ');
  const outputText = [
    '현장에서는 그러나 요양보호사를 비롯한 돌봄 인력이 부족하다.',
    '금융기관은 다수의 신용을 바탕으로 운영된다.',
    '현재 제도는 실질적인 소득 재분배 기능을 매우 취약한 수준으로 수행하고 있다.',
    '시각디자인 분야에서 성장하려면 새로운 프로젝트에 계속 도전하겠습니다.',
    '다양한 경험과 배움을 두려워하지 않고 참여하겠습니다.'
  ].join(' ');
  const audit = koreanRefinement.analyzeKoreanRefinement({
    source,
    outputText,
    documentProfile: {
      profile: 'resume_application',
      targetRegister: 'professional'
    },
    mode: 'assignment'
  });
  const codes = new Set(audit.repairableCodes);
  assert.equal(codes.has('misplaced_clause_connector'), true);
  assert.equal(codes.has('abstract_mass_quantifier'), true);
  assert.equal(codes.has('weak_function_predicate'), true);
  assert.equal(codes.has('condition_commitment_mismatch'), true);
  assert.equal(codes.has('fear_object_collocation'), true);
  assert.ok(audit.introducedIssueCount >= 5, JSON.stringify(audit.issues));

  const restored = koreanRefinement.restoreIntroducedIntegritySentences({
    source,
    outputText,
    audit
  });
  assert.equal(restored.applied, true);
  assert.equal(restored.text, source);
});

test('v2.5.21: 구조 토큰 없는 일반 산문의 문장별 개행은 재문단화해도 품질 경고로 올리지 않는다', () => {
  const source = [
    '사회 구성원 사이의 출발선 격차는 청소년기 교육 단계에서 가장 먼저 나타나며 이후의 고용 기회에도 장기적인 영향을 미친다.',
    '교육 기회를 보장하는 정책은 청장년기 고용 불평등을 완화하는 첫 발판이 되므로 학습 지원과 진로 지원을 함께 마련해야 한다.',
    '청장년기에는 노동시장의 안정성을 높이는 구체적인 고용 정책과 공정한 채용 기준을 확립해 진입장벽을 낮출 필요가 있다.',
    '노년기에는 앞선 생애 단계에서 누적된 사회경제적 격차가 건강 자산의 격차로 이어질 수 있어 예방적 지원이 중요하다.',
    '따라서 생애주기별 복지정책과 소득 재분배 정책을 함께 추진하고 각 단계의 지원이 실제로 연결되는지 지속적으로 점검해야 한다.'
  ].join('\n');
  const output = [
    '사회 구성원 사이의 출발선 격차는 청소년기 교육 단계에서 가장 먼저 나타나며 이후의 고용 기회에도 장기적인 영향을 미친다. 교육 기회를 보장하는 정책은 청장년기 고용 불평등을 완화하는 첫 발판이 되므로 학습 지원과 진로 지원을 함께 마련해야 한다.',
    '',
    '청장년기에는 노동시장의 안정성을 높이는 구체적인 고용 정책과 공정한 채용 기준을 확립해 진입장벽을 낮출 필요가 있다. 노년기에는 앞선 생애 단계에서 누적된 사회경제적 격차가 건강 자산의 격차로 이어질 수 있어 예방적 지원이 중요하다.',
    '',
    '따라서 생애주기별 복지정책과 소득 재분배 정책을 함께 추진하고 각 단계의 지원이 실제로 연결되는지 지속적으로 점검해야 한다.'
  ].join('\n');
  const documentProfile = {
    profile: 'long_explainer',
    confidence: 0.92,
    formatProfile: { flags: [] }
  };
  const profile = voiceProfile.buildVoiceProfile(source, {
    documentProfile,
    mode: 'assignment'
  });
  assert.equal(profile.lineBoundaryPolicy, 'none');
  const audit = voiceProfile.auditVoice(profile, output, {
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

test('v2.5.21: 충분한 실질 편집은 수사 알림만으로 효과 제한이 되지 않는다', () => {
  const strongReport = {
    applicable: true,
    minimumEffectPass: true,
    userReviewRequired: true,
    reasons: ['rhetorical_remediation_low', 'structural_rewrite_coverage_low'],
    metrics: {
      substantiveEditRatio: 0.297,
      substantiveChangedSentenceRatio: 0.67
    },
    plan: {
      hardMinimumSubstantiveEditRatio: 0.10,
      hardMinimumChangedSentenceRatio: 0.25
    }
  };
  assert.equal(effectStatusForNotices([
    { code: 'rhetorical_remediation_incomplete' },
    { code: 'humanization_depth_below_target' }
  ], { humanizationDepthReport: strongReport }), 'normal');

  assert.equal(effectStatusForNotices([
    { code: 'humanization_depth_below_minimum' }
  ], {
    humanizationDepthReport: {
      ...strongReport,
      minimumEffectPass: false,
      metrics: { substantiveEditRatio: 0.03, substantiveChangedSentenceRatio: 0.08 }
    }
  }), 'limited');
});

test('v2.5.21: 문장별 효과 회복은 전체 재시도와 합쳐 최대 여섯 번 이내로 제한한다', () => {
  assert.equal(conservativeRecoveryMaximumAttempts({
    sourceSentenceCount: 20,
    requestStrength: 'advanced',
    preferredOrdinalCount: 12,
    hardRequiredChangedSentenceCount: 8
  }), 4);
  assert.equal(conservativeRecoveryMaximumAttempts({
    sourceSentenceCount: 20,
    requestStrength: 'basic',
    preferredOrdinalCount: 12,
    hardRequiredChangedSentenceCount: 8
  }), 3);
});
