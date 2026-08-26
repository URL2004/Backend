'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../engine-gpt-prod');
const prompts = require('../engine-gpt-prod/prompts/humanize');
const structure = require('../engine-gpt-prod/structureChunk');
const quality = require('../engine-gpt-prod/finalQualityV2');
const discourse = require('../engine-gpt-prod/discourseAudit');
const korean = require('../engine-gpt-prod/koreanRefinement');
const { HUMANIZE_SCHEMA } = require('../engine-gpt-prod/schemas');
const {
  buildHumanizeContract,
  allowsLayoutRecomposition,
  localizedRepairPromptLines,
  validateRepairPrompt
} = require('../engine-gpt-prod/humanizeContract');
const { createRecoveryBudget } = require('../engine-gpt-prod/recoveryBudget');

const ESSAY = {
  profile: 'personal_essay',
  group: 'essay_application',
  confidence: 0.94,
  formatProfile: { flags: [] }
};

test('v2.5.39: 우선순위와 문단 권위는 하나의 불변 계약에서 파생된다', () => {
  const contract = buildHumanizeContract({
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: ESSAY
  });

  assert.equal(engine.VERSION, 'gpt-prod-v2.5.41');
  assert.deepEqual(contract.priorities.map(item => item.rank), [1, 2, 3]);
  assert.equal(contract.paragraph.modelBoundary, 'source_locked');
  assert.equal(contract.paragraph.localizedRepairBoundary, 'source_locked');
  assert.equal(contract.paragraph.layoutAuthority, 'semantic_role');
  assert.equal(allowsLayoutRecomposition(contract), true);
  assert.throws(() => {
    contract.paragraph.layoutAuthority = 'source_role';
  }, TypeError);
});

test('v2.5.39: 조립된 고급 프롬프트와 경계 토큰이 같은 문단 정책을 말한다', () => {
  const contract = buildHumanizeContract({
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: ESSAY
  });
  const built = prompts.buildHumanizePrompt('assignment', 'ko', {
    requestStrength: 'advanced',
    register: 'plain',
    documentProfile: ESSAY,
    humanizeContract: contract
  });
  const plan = structure.splitChunksForGpt(
    '첫 문단에는 사건의 시작을 적었습니다. 판단은 이 문단에 남겼습니다.\n\n둘째 문단에는 다음 사건을 적었습니다. 결론은 아직 쓰지 않았습니다.',
    { coalesceEditable: true, humanizeContract: contract }
  );
  const chunk = plan.chunks.find(item => item.boundaryMarkers?.length);
  const user = prompts.buildHumanizeUser({
    chunk,
    chunks: plan.chunks,
    index: plan.chunks.indexOf(chunk),
    humanizeContract: contract
  });

  assert.equal(prompts.validateHumanizePrompt(built.stable).pass, true);
  assert.match(built.stable, /충돌 시 1순위→2순위→3순위/u);
  assert.match(built.stable, /모델 편집 단계에서는 원문 문단 경계를 그대로 유지/u);
  assert.doesNotMatch(built.stable, /문단 나눔과 결합도 실질 재구성/u);
  assert.match(user, /paragraph-authority-v1이 잠근 원문 문단 경계/u);
  assert.equal(chunk.boundaryMarkers[0].policy, 'source_locked');
});

test('v2.5.39: 모델 출력 스키마는 본문만 받고 보호어·위험·편집량은 서버가 소유한다', () => {
  assert.deepEqual(Object.keys(HUMANIZE_SCHEMA.properties), ['outputText']);
  assert.deepEqual(HUMANIZE_SCHEMA.required, ['outputText']);
  assert.equal(HUMANIZE_SCHEMA.additionalProperties, false);
});

test('v2.5.39: 모든 국소 수리 프롬프트는 공통 계약 검증을 거친다', () => {
  const contract = buildHumanizeContract({
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: ESSAY
  });
  const valid = [
    '너는 한국어 실질 휴머나이징 국소 수리기다.',
    ...localizedRepairPromptLines(contract),
    '수정 대상 문장 번호=2.',
    '새 사실·평가·감정·경험은 만들지 않는다.'
  ].join('\n');
  assert.equal(validateRepairPrompt(valid, {
    family: 'general_surface',
    localized: true
  }).pass, true);

  const conflicting = `${valid}\n같은 문단 역할 안에서는 문단을 나누거나 이어 붙이는 것을 허용한다.`;
  const audit = validateRepairPrompt(conflicting, {
    family: 'general_surface',
    localized: true
  });
  assert.equal(audit.pass, false);
  assert.ok(audit.errors.includes('paragraph_authority_conflict'));
});

test('v2.5.39: 누적 깊이 기준선은 의미 심사 전 후보를 high-water로 쓰지 않는다', () => {
  const best = engine.bestAuditedDepthStageSnapshot([
    { stage: 'post_merge', pass: true, targetDepthMet: true, score: 0.95, substantiveEditRatio: 0.5 },
    { stage: 'post_semantic', pass: true, targetDepthMet: true, score: 0.61, substantiveEditRatio: 0.28 },
    { stage: 'post_layout_restore', pass: true, targetDepthMet: true, score: 0.66, substantiveEditRatio: 0.31 },
    { stage: 'delivery_final', pass: false, targetDepthMet: false, score: 0.52, substantiveEditRatio: 0.19 }
  ]);
  assert.equal(best.stage, 'post_layout_restore');
  assert.equal(best.score, 0.66);
});

test('v2.5.39: 국소 수리는 표적과 이웃 밖의 문장을 바꾸면 서버가 거부한다', () => {
  const before = [
    '첫 문장에서는 연구 목적을 분명하게 설명했습니다.',
    '둘째 문장에는 새로 생긴 조사 오류가 남아 있습니다.',
    '셋째 문장에서는 분석 절차를 구체적으로 정리했습니다.',
    '넷째 문장에서는 결과의 한계를 조심스럽게 밝혔습니다.'
  ].join(' ');
  const safe = before.replace('새로 생긴 조사 오류가', '새로 생긴 조사 오류는');
  const escaped = safe.replace('결과의 한계를 조심스럽게 밝혔습니다', '결과의 한계를 간단히 밝혔습니다');
  const scope = {
    version: 'localized-repair-scope-v1',
    targetSentenceOrdinals: [2],
    neighborRadius: 1
  };

  assert.equal(quality.auditLocalizedRepairScope(before, safe, scope).pass, true);
  const audit = quality.auditLocalizedRepairScope(before, escaped, scope);
  assert.equal(audit.pass, false, JSON.stringify(audit));
  assert.deepEqual(audit.outsideOrdinals, [4]);
});

test('v2.5.39: 초기 회복이 호출 풀을 소진하기 전에 후단 수리 몫을 예약한다', () => {
  const budget = createRecoveryBudget(1, {
    maxCalls: 6,
    reservedLateCalls: 2,
    maxElapsedMs: 30000,
    clock: () => 0
  });
  for (let index = 0; index < 4; index += 1) assert.equal(budget.tryStart(), true);
  assert.equal(budget.tryStart(), false);
  assert.equal(budget.snapshot().lastDeniedReason, 'recovery_late_call_reserve');
  assert.equal(budget.tryStart({ priority: 'late' }), true);
  assert.equal(budget.tryStart({ priority: 'late' }), true);
  assert.equal(budget.tryStart({ priority: 'late' }), false);
  assert.equal(budget.snapshot().lastDeniedReason, 'recovery_call_limit_exhausted');
});

test('v2.5.39: 상시 system 프롬프트는 장르별 상한 안에서 조립된다', () => {
  const cases = [
    [{ profile: 'academic_paper', group: 'academic_report_explainer', formatProfile: { flags: [] } }, 4600, 82],
    [{ profile: 'resume_application', group: 'essay_application', formatProfile: { flags: [] } }, 5200, 90],
    [{ profile: 'general_essay', group: 'essay_application', formatProfile: { flags: [] } }, 3900, 78]
  ];
  for (const [documentProfile, maxChars, maxLines] of cases) {
    const stable = prompts.buildHumanizePrompt('assignment', 'ko', {
      requestStrength: 'advanced',
      register: 'plain',
      documentProfile
    }).stable;
    assert.ok(stable.length <= maxChars, `${documentProfile.profile}: ${stable.length} chars`);
    assert.ok(stable.split(/\n/u).length <= maxLines, `${documentProfile.profile}: line budget`);
  }
});

test('v2.5.39: 원문에 없던 평가 결론은 탐지 좌표의 대응 문장만 원문으로 복원한다', () => {
  const source = '두 자료의 수치를 항목별로 대조했다. 비교 결과는 표에 항목별로 정리했다.';
  const output = '두 자료의 수치를 항목별로 대조했다. 비교 결과를 표에 정리하며 정확한 기록의 중요성을 깨닫게 되었다.';
  const audit = discourse.compareDiscourse(source, output);

  assert.ok(audit.codes.includes('new_evaluation'), JSON.stringify(audit));
  assert.deepEqual(
    audit.violations.find(item => item.code === 'new_evaluation').sentenceOrdinals,
    [2]
  );
  const restored = discourse.restoreIntroducedEvaluationSentences(source, output, audit);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.equal(restored.text, source);
  assert.equal(discourse.compareDiscourse(source, restored.text).pass, true);
});

test('v2.5.39: 새 인접 의미 반복은 공통 원문 문장 복원 대상으로 처리한다', () => {
  const source = '자료를 비교하면서 측정 기준을 이해하게 되었다. 그래서 기준표를 다시 작성하고 수치를 하나씩 대조했다.';
  const output = '자료를 비교하면서 측정 기준을 이해하게 되었다. 기준표를 다시 작성하며 측정 기준을 다시 이해했다.';
  const before = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'general_essay' },
    mode: 'assignment'
  });

  assert.ok(before.issueCodes.includes('adjacent_semantic_repetition'), JSON.stringify(before));
  const restored = korean.restoreIntroducedIntegritySentences({
    source,
    outputText: output,
    audit: before
  });
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.ok(restored.restoredCodes.includes('adjacent_semantic_repetition'));
  const after = korean.analyzeKoreanRefinement({
    source,
    outputText: restored.text,
    documentProfile: { profile: 'general_essay' },
    mode: 'assignment'
  });
  assert.equal(after.issueCodes.includes('adjacent_semantic_repetition'), false, JSON.stringify(after));
});
