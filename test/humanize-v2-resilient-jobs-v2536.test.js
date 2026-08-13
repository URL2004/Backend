'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const recovery = require('../lib/transformRestartRecovery');
const transformRouter = require('../routes/transform');

function runningJob(overrides = {}) {
  return {
    id: 'job-restart-1',
    status: 'running',
    stage: '문장 다듬는 중',
    text: '서버 교체 뒤에도 자동으로 이어서 처리해야 하는 충분한 길이의 원문입니다.',
    createdAt: 1000,
    queuedAt: 1000,
    startedAt: 1500,
    deducted: false,
    error: null,
    ...overrides
  };
}

test('실행 중 작업은 서버 종료 시 오류가 아니라 동일 job ID의 대기 작업으로 전환한다', () => {
  const job = runningJob();
  const result = recovery.prepareRunningJobForRestart(job, {
    now: 2000,
    maxRecoveries: 8,
    reason: 'graceful_shutdown'
  });

  assert.equal(result.recovered, true);
  assert.equal(job.id, 'job-restart-1');
  assert.equal(job.status, 'queued');
  assert.match(job.stage, /자동 재개/u);
  assert.equal(job.restartRecoveryCount, 1);
  assert.equal(job.restartRecoveryReason, 'graceful_shutdown');
  assert.equal(job.startedAt, null);
  assert.equal(job.terminalAtMs, null);
  assert.equal(job.deducted, false);
});

test('자동 재개된 실행도 다시 종료되면 횟수를 누적하되 과금 상태를 바꾸지 않는다', () => {
  const job = runningJob({ restartRecoveryCount: 3, deducted: false });
  const result = recovery.prepareRunningJobForRestart(job, { now: 3000, maxRecoveries: 8 });

  assert.equal(result.recovered, true);
  assert.equal(job.restartRecoveryCount, 4);
  assert.equal(job.deducted, false);
  assert.equal(job.error, null);
});

test('새 인스턴스는 이전 인스턴스 상태 재확인 전 복원 작업을 실행하지 않는다', () => {
  const job = runningJob();
  const held = recovery.holdRestoredRunningJob(job, { now: 5000, delayMs: 30000 });

  assert.equal(held.held, true);
  assert.equal(job.status, 'queued');
  assert.equal(recovery.isRestartRecoveryHeld(job, 10000), true);
  recovery.releaseRestartRecoveryHold(job);
  assert.equal(recovery.isRestartRecoveryHeld(job, 10000), false);
});

test('원문이 없거나 자동 재개 상한에 도달한 작업은 무한 재실행하지 않는다', () => {
  const missing = recovery.prepareRunningJobForRestart(runningJob({ text: '' }), { maxRecoveries: 8 });
  const exhaustedJob = runningJob({ restartRecoveryCount: 8 });
  const exhausted = recovery.prepareRunningJobForRestart(exhaustedJob, { maxRecoveries: 8 });

  assert.equal(missing.recovered, false);
  assert.equal(missing.reason, 'missing_source_text');
  assert.equal(exhausted.recovered, false);
  assert.equal(exhausted.reason, 'restart_recovery_limit');
  recovery.markRestartRecoveryExhausted(exhaustedJob, { now: 9000 });
  assert.equal(exhaustedJob.status, 'error');
  assert.match(exhaustedJob.error, /중복 차감되지 않았/u);
});

test('승인 편집 0건의 일시적 모델 실패는 사용자 차단 전에 자동 재처리 대상으로 분류한다', () => {
  const reason = transformRouter.recoverableTechnicalBlockReason({
    floorReport: {
      status: 'blocked',
      criticals: [{ gate: 'no_approved_model_chunks' }]
    },
    engineMeta: {
      chunkFailureCodes: ['openai_truncated_output'],
      approvedModelChunkCount: 0,
      modelFailureChunkCount: 1
    }
  });
  assert.equal(reason, 'openai_truncated_output');

  const semanticOnly = transformRouter.recoverableTechnicalBlockReason({
    floorReport: { status: 'needs_review', criticals: [{ gate: 'semantic_omission' }] },
    engineMeta: { chunkFailureCodes: [] }
  });
  assert.equal(semanticOnly, '');

  const refusal = transformRouter.recoverableTechnicalBlockReason({
    floorReport: { status: 'blocked', criticals: [{ gate: 'no_approved_model_chunks' }] },
    engineMeta: { chunkFailureCodes: ['openai_refusal'] }
  });
  assert.equal(refusal, '', 'refusal은 같은 문서 전체를 반복 호출하는 근거로 쓰지 않는다');
});
