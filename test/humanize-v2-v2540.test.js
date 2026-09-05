'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../engine-gpt-prod');
const {
  VERSION,
  createCandidateLedger,
  buildCandidateAssessment
} = require('../engine-gpt-prod/candidateLedger');

const SEMANTIC_PASS = Object.freeze({ ran: true, pass: true, violations: [] });

function assessment({ hard = [], languageRisk = 0, score = 0.5, target = true, transformed = true } = {}) {
  return {
    hardViolationCodes: hard,
    languageViolationCodes: languageRisk > 0 ? ['language_risk'] : [],
    languageRisk,
    minimumEffectPass: true,
    transformed,
    depthSnapshot: {
      pass: target,
      minimumEffectPass: true,
      targetDepthMet: target,
      score,
      substantiveEditRatio: score / 2
    }
  };
}

function createScenario(rows) {
  return createCandidateLedger({
    assess: ({ stage }) => rows[stage]
  });
}

test('v2.5.40: 엔진과 후보 원장 버전이 분리되어 노출된다', () => {
  assert.equal(engine.VERSION, 'gpt-prod-v2.5.46');
  assert.equal(VERSION, 'candidate-ledger-v1');
});

test('v2.5.40: 후단 후보에 1순위 위반이 생기면 의미 통과 안전 후보로 롤백한다', () => {
  const ledger = createScenario({
    post_layout_restore: assessment({ score: 0.64 }),
    delivery_final: assessment({ hard: ['speaker_injected'], score: 0.82 })
  });
  ledger.record({ stage: 'source', text: '원문', semanticReport: SEMANTIC_PASS, baseline: true });
  const safe = ledger.record({
    stage: 'post_layout_restore',
    text: '안전하게 바뀐 결과',
    semanticReport: SEMANTIC_PASS
  });
  const final = ledger.record({
    stage: 'delivery_final',
    text: '화자가 새로 생긴 결과',
    semanticReport: SEMANTIC_PASS
  });
  const choice = ledger.chooseFinal(final.id);

  assert.equal(safe.eligible, true);
  assert.equal(choice.applied, true);
  assert.equal(choice.selectedStage, 'post_layout_restore');
  assert.equal(choice.reason, 'priority_1_hard_safety');
  assert.equal(choice.entry.text, '안전하게 바뀐 결과');
});

test('v2.5.40: 안전 후보끼리는 한국어·장르 비퇴행을 깊이보다 먼저 비교한다', () => {
  const ledger = createScenario({
    post_localized_repairs: assessment({ languageRisk: 0, score: 0.58 }),
    delivery_final: assessment({ languageRisk: 2, score: 0.88 })
  });
  const earlier = ledger.record({
    stage: 'post_localized_repairs',
    text: '자연스러운 안전 후보',
    semanticReport: SEMANTIC_PASS
  });
  const final = ledger.record({
    stage: 'delivery_final',
    text: '깊지만 어색한 후보',
    semanticReport: SEMANTIC_PASS
  });
  const choice = ledger.chooseFinal(final.id);

  assert.equal(earlier.eligible, true);
  assert.equal(choice.selectedStage, 'post_localized_repairs');
  assert.equal(choice.reason, 'priority_2_language_non_regression');
});

test('v2.5.40: 안전성과 언어 위험이 같으면 가장 깊은 감사 통과 후보를 고른다', () => {
  const ledger = createScenario({
    post_semantic_materialized: assessment({ score: 0.61 }),
    post_layout_restore: assessment({ score: 0.69 }),
    delivery_final: assessment({ score: 0.63 })
  });
  for (const [stage, text] of [
    ['post_semantic_materialized', '후보 하나'],
    ['post_layout_restore', '후보 둘'],
    ['delivery_final', '후보 셋']
  ]) {
    ledger.record({ stage, text, semanticReport: SEMANTIC_PASS });
  }
  const choice = ledger.chooseFinal('delivery_final:3');

  assert.equal(choice.applied, true);
  assert.equal(choice.selectedStage, 'post_layout_restore');
  assert.equal(choice.reason, 'priority_3_deepest_safe_candidate');
});

test('v2.5.40: 의미 재심사 없는 늦은 모델 후보와 무변환 원문은 롤백 풀에 들어가지 않는다', () => {
  const ledger = createScenario({
    post_layout_restore: assessment({ transformed: false, score: 0 }),
    delivery_final: assessment({ score: 0.8 })
  });
  const sourceLike = ledger.record({
    stage: 'post_layout_restore',
    text: '원문과 같은 결과',
    semanticReport: SEMANTIC_PASS
  });
  const unjudged = ledger.record({
    stage: 'delivery_final',
    text: '재심사하지 않은 결과',
    semanticReport: { ran: false, pass: null }
  });
  const choice = ledger.chooseFinal(unjudged.id);

  assert.equal(sourceLike.eligible, false);
  assert.equal(unjudged.eligible, false);
  assert.equal(choice.applied, false);
  assert.equal(choice.reason, 'no_safe_transformed_candidate');
});

test('v2.5.40: 절대 감사는 화자·구조를 1순위, 등록체·한국어를 2순위로 분류한다', () => {
  const built = buildCandidateAssessment({
    gate: { hardFail: false, violations: [] },
    deterministicAudit: {
      warnings: [
        { code: 'speaker_injected' },
        { code: 'register_shift' }
      ]
    },
    structureAudit: { pass: true },
    quoteAudit: { pass: true },
    inlineCodeAudit: { pass: true, orderPass: true },
    inlineMathAudit: { pass: true, orderPass: true },
    fingerprintAudit: {
      violations: [
        { code: 'engine_phrase_fingerprint', count: 2 },
        { code: 'semantic_relation_shift', count: 1 }
      ]
    },
    resumeAudit: { applicable: false, pass: true },
    koreanAudit: {
      weightedRisk: 1,
      issues: [{ code: 'connector_inflation', introducedCount: 1, weight: 1 }]
    },
    endingAudit: { pass: true },
    depthSnapshot: {
      pass: true,
      minimumEffectPass: true,
      targetDepthMet: true,
      score: 0.7,
      substantiveEditRatio: 0.3
    },
    transformed: true
  });

  assert.deepEqual(built.hardViolationCodes.sort(), [
    'semantic_relation_shift',
    'speaker_injected'
  ]);
  assert.ok(built.languageViolationCodes.includes('register_shift'));
  assert.ok(built.languageViolationCodes.includes('engine_phrase_fingerprint'));
  assert.ok(built.languageViolationCodes.includes('korean_connector_inflation'));
  assert.ok(built.languageRisk >= 4);
});

test('v2.5.40: 운영 텔레메트리는 후보 본문을 노출하지 않는다', () => {
  const ledger = createScenario({
    delivery_final: assessment({ score: 0.7 })
  });
  const final = ledger.record({
    stage: 'delivery_final',
    text: '외부로 노출되면 안 되는 후보 본문',
    semanticReport: SEMANTIC_PASS
  });
  ledger.chooseFinal(final.id);
  const serialized = JSON.stringify(ledger.snapshot());

  assert.doesNotMatch(serialized, /외부로 노출되면 안 되는 후보 본문/u);
  assert.equal(ledger.snapshot().checkpoints[0].eligible, true);
});
