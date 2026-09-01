'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const payment = require('../routes/payment');

const {
  classifyAdminLedgerTask,
  serializeAdminLedgerTaskLedger,
  serializeAdminLedgerTaskHistory,
  serializeAdminLedgerTaskEngineMeta,
  serializeAdminLedgerTaskArchive,
  serializeAdminLedgerTaskOps,
  loadAdminLedgerTaskOps
} = payment.adminLedgerTaskPolicy;

test('원장의 requestId만으로 transform과 detect를 정확하게 연결한다', () => {
  assert.deepEqual(classifyAdminLedgerTask({ type: 'humanize', requestId: 'job_abc-123' }), {
    available: true,
    kind: 'transform',
    historyId: 'job_abc-123',
    jobId: 'abc-123'
  });
  assert.deepEqual(classifyAdminLedgerTask({ type: 'restructure', requestId: 'job_restructure-1' }), {
    available: true,
    kind: 'transform',
    historyId: 'job_restructure-1',
    jobId: 'restructure-1'
  });
  assert.deepEqual(classifyAdminLedgerTask({ type: 'detect', requestId: '73fb96d4-2841-48b3-bce1-cc1d84166a4e' }), {
    available: true,
    kind: 'detect',
    historyId: '73fb96d4-2841-48b3-bce1-cc1d84166a4e',
    jobId: null
  });
  assert.deepEqual(classifyAdminLedgerTask({ type: 'detect', requestId: 'detect:session_refine2' }), {
    available: true,
    kind: 'detect',
    historyId: 'detect:session_refine2',
    jobId: null
  });
});

test('refine·비작업·legacy·유형 불일치는 연결 불가 이유를 명시한다', () => {
  assert.equal(classifyAdminLedgerTask({ type: 'humanize_refine', requestId: 'job_a_refine2' }).reason, 'refine_result_not_archived');
  assert.equal(classifyAdminLedgerTask({ type: 'humanize', requestId: 'job_a_refine2' }).reason, 'refine_result_not_archived');
  assert.equal(classifyAdminLedgerTask({ type: 'charge', requestId: 'order_1' }).reason, 'non_task_ledger');
  assert.equal(classifyAdminLedgerTask({ type: 'humanize' }).reason, 'legacy_missing_request_id');
  assert.equal(classifyAdminLedgerTask({ type: 'detect', requestId: 'job_a' }).reason, 'detect_request_id_mismatch');
  assert.equal(classifyAdminLedgerTask({ type: 'humanize', requestId: 'detect_a' }).reason, 'transform_request_id_mismatch');
  assert.equal(classifyAdminLedgerTask({ type: 'detect', requestId: '../other-user' }).reason, 'invalid_request_id');
});

test('원장 응답은 작업 연결과 표시용 필드만 허용한다', () => {
  const row = serializeAdminLedgerTaskLedger('req_job_1', 'owner-1', {
    type: 'humanize', mode: 'formal', used: 14, amount: 0, remaining: 90,
    textLength: 1200, requestId: 'job_1', detail: '내부 사유', prompt: '유출 금지',
    createdAt: { toMillis: () => 1234 }
  });
  assert.deepEqual(row, {
    id: 'req_job_1', uid: 'owner-1', type: 'humanize', mode: 'formal', used: 14,
    amount: 0, remaining: 90, textLength: 1200, requestId: 'job_1', createdAtMs: 1234
  });
  assert.equal(Object.hasOwn(row, 'detail'), false);
  assert.equal(Object.hasOwn(row, 'prompt'), false);
});

test('history 상세은 원문·결과를 제공하되 엔진 내부 비밀 필드를 섞지 않는다', () => {
  const item = serializeAdminLedgerTaskHistory('job_1', {
    type: 'humanize', mode: 'formal', inputText: '원문', outputText: '결과',
    qualityWarningCodes: ['semantic_omission', '<script>'],
    sourceReviewWarningCodes: ['register_downgrade'], humanSummary: '요약', humanDetail: '상세',
    prompt: '유출 금지', protectedTerms: ['기관명'], providerResponse: { raw: 'secret' }, stack: 'stack'
  });
  assert.equal(item.inputText, '원문');
  assert.equal(item.outputText, '결과');
  assert.deepEqual(item.qualityWarningCodes, ['semantic_omission']);
  for (const key of ['prompt', 'protectedTerms', 'providerResponse', 'stack']) {
    assert.equal(Object.hasOwn(item, key), false, `${key}는 응답 금지`);
  }
});

test('감지 history 상세은 허용된 점수 출처와 모델 provenance만 반환한다', () => {
  const item = serializeAdminLedgerTaskHistory('detect_1', {
    type: 'detect', mode: 'detect', probability: 72, rawProbability: 72,
    probSource: 'llm', detectConfidence: 'medium', detectModel: 'gpt-test',
    detectorVersion: 'detect-v1', detectEscalated: true,
    providerResponse: { raw: 'secret' }, prompt: 'secret'
  });
  assert.equal(item.probSource, 'llm');
  assert.equal(item.detectConfidence, 'medium');
  assert.equal(item.detectModel, 'gpt-test');
  assert.equal(item.detectorVersion, 'detect-v1');
  assert.equal(item.detectEscalated, true);
  assert.equal(Object.hasOwn(item, 'providerResponse'), false);
  assert.equal(Object.hasOwn(item, 'prompt'), false);

  const rejected = serializeAdminLedgerTaskHistory('detect_2', {
    type: 'detect', probSource: 'engine', detectConfidence: 'certain',
    detectModel: 'x'.repeat(200), detectorVersion: 'y'.repeat(200)
  });
  assert.equal(rejected.probSource, '');
  assert.equal(rejected.detectConfidence, '');
  assert.equal(rejected.detectModel.length, 80);
  assert.equal(rejected.detectorVersion.length, 80);
});

test('engine/archive 메타는 명시적 allowlist만 반환한다', () => {
  const engine = serializeAdminLedgerTaskEngineMeta({
    engineVersion: 'gpt-prod-v2.5.41', requestedMode: 'formal', semanticJudgeRan: true,
    deliveryReasonCodes: ['semantic_omission', '<bad>'], estimatedUsd: 0.12,
    sourceReviewWarningCodes: ['source_truncated_word'],
    unsupportedSpecificityPass: false, unsupportedSpecificityIssueCount: 1,
    unsupportedSpecificityResidualCount: 1, unsupportedSpecificityIntroducedEntities: ['비밀 대상명'],
    prompt: 'system prompt', protectedTerms: ['x'], rawProviderResponse: 'raw', stack: 'trace', apiKey: 'secret'
  });
  const archive = serializeAdminLedgerTaskArchive({
    uid: 'owner-1', status: 'done', stage: 'complete', engineVersion: 'gpt-prod-v2.5.41',
    qualityWarningCodes: ['semantic_omission'], estimatedUsd: 0.12,
    koreanRefinementIssueCodes: ['particle_spacing'],
    sourceReviewWarningCodes: ['source_truncated_word'],
    finalSourceIntegrityRestoreCodes: ['source_quote_restored'],
    unsupportedSpecificityPass: false, unsupportedSpecificityIssueCount: 1,
    unsupportedSpecificityResidualCount: 1, unsupportedSpecificityIntroducedEntities: ['비밀 대상명'],
    text: '원문 복제 금지', result: '결과 복제 금지', prompt: 'prompt', protectedTerms: ['x'],
    rawProviderResponse: 'raw', stack: 'stack', error: 'provider raw error'
  }, 'job-1');
  assert.equal(engine.engineVersion, 'gpt-prod-v2.5.41');
  assert.deepEqual(engine.deliveryReasonCodes, ['semantic_omission']);
  assert.deepEqual(engine.sourceReviewWarningCodes, ['source_truncated_word']);
  assert.equal(engine.unsupportedSpecificityPass, false);
  assert.equal(engine.unsupportedSpecificityIssueCount, 1);
  assert.equal(archive.unsupportedSpecificityPass, false);
  assert.equal(archive.unsupportedSpecificityResidualCount, 1);
  assert.deepEqual(archive.koreanRefinementIssueCodes, ['particle_spacing']);
  assert.deepEqual(archive.sourceReviewWarningCodes, ['source_truncated_word']);
  assert.deepEqual(archive.finalSourceIntegrityRestoreCodes, ['source_quote_restored']);
  assert.equal(archive.jobId, 'job-1');
  assert.equal(archive.status, 'done');
  for (const object of [engine, archive]) {
    for (const key of ['prompt', 'protectedTerms', 'rawProviderResponse', 'stack', 'apiKey', 'text', 'result', 'error', 'uid']) {
      assert.equal(Object.hasOwn(object, key), false, `${key}는 allowlist 밖`);
    }
    assert.equal(Object.hasOwn(object, 'unsupportedSpecificityIntroducedEntities'), false);
  }
});

test('미측정 숫자와 의미 심사 상태를 0 또는 false로 만들지 않는다', () => {
  const unknown = serializeAdminLedgerTaskEngineMeta({
    semanticJudgeRan: null,
    repairCount: null,
    estimatedUsd: '',
    substantiveEditRatio: undefined
  });
  for (const key of ['semanticJudgeRan', 'repairCount', 'estimatedUsd', 'substantiveEditRatio']) {
    assert.equal(Object.hasOwn(unknown, key), false, `${key} 미측정값은 응답에서 생략`);
  }

  const measured = serializeAdminLedgerTaskEngineMeta({ semanticJudgeRan: false, repairCount: 0, estimatedUsd: 0 });
  assert.equal(measured.semanticJudgeRan, false);
  assert.equal(measured.repairCount, 0);
  assert.equal(measured.estimatedUsd, 0);

  const archive = serializeAdminLedgerTaskArchive({ createdAt: null, textLength: null, estimatedUsd: null }, 'job-1');
  for (const key of ['createdAtMs', 'textLength', 'estimatedUsd']) {
    assert.equal(Object.hasOwn(archive, key), false, `${key} null은 0으로 직렬화하지 않음`);
  }
});

test('관련 장애 로그도 원문·스택 없이 운영 판단 필드만 반환한다', () => {
  const item = serializeAdminLedgerTaskOps('ops-1', {
    event: 'transform.humanize_failed', severity: 'SEV2', domain: 'engine',
    message: '작업 실패', code: 'TIMEOUT', stage: 'semantic', createdMs: 1234,
    count: 2, acked: true, uid: 'owner-1', stack: 'secret stack', err: { message: 'raw' },
    prompt: 'secret prompt', inputText: '원문'
  });
  assert.deepEqual(item, {
    id: 'ops-1', event: 'transform.humanize_failed', severity: 'SEV2', domain: 'engine',
    message: '작업 실패', code: 'TIMEOUT', stage: 'semantic', reason: '',
    createdAtMs: 1234, count: 2, acked: true
  });
  for (const key of ['uid', 'stack', 'err', 'prompt', 'inputText']) {
    assert.equal(Object.hasOwn(item, key), false, `${key}는 응답 금지`);
  }
});

function opsSnapshot(rows) {
  return {
    forEach(callback) {
      rows.forEach(({ id, data }) => callback({ id, data: () => data }));
    }
  };
}

test('장애 로그는 Firestore 반환 순서와 무관하게 최신 30건을 보장한다', async () => {
  const rows = Array.from({ length: 35 }, (_, index) => ({
    id: `ops-${index + 1}`,
    data: { uid: 'owner-1', jobId: 'job-1', event: 'transform.audit', createdMs: index + 1 }
  }));
  rows.push({ id: 'other-owner', data: { uid: 'owner-2', jobId: 'job-1', createdMs: 999 } });
  const calls = [];
  const firestore = {
    collection(name) {
      assert.equal(name, 'opsLogs');
      return {
        where(field, operator, value) {
          calls.push([field, operator, value]);
          return { get: async () => opsSnapshot(rows) };
        }
      };
    }
  };

  const result = await loadAdminLedgerTaskOps({ uid: 'owner-1', link: { jobId: 'job-1' }, firestore });
  assert.equal(result.status, 'ok');
  assert.equal(result.items.length, 30);
  assert.equal(result.items[0].id, 'ops-35');
  assert.equal(result.items.at(-1).id, 'ops-6');
  assert.deepEqual(calls, [['jobId', '==', 'job-1']]);
});

test('장애 로그 상태 계약은 ok·empty·error 세 값만 사용한다', async () => {
  const emptyFirestore = {
    collection() {
      return { where: () => ({ get: async () => opsSnapshot([]) }) };
    }
  };
  const failedFirestore = {
    collection() {
      return { where: () => ({ get: async () => { throw new Error('firestore unavailable'); } }) };
    }
  };

  assert.deepEqual(await loadAdminLedgerTaskOps({ uid: 'owner-1', link: {}, firestore: emptyFirestore }), {
    status: 'empty', items: []
  });
  assert.deepEqual(await loadAdminLedgerTaskOps({ uid: 'owner-1', link: { historyId: 'request-1' }, firestore: emptyFirestore }), {
    status: 'empty', items: []
  });
  assert.deepEqual(await loadAdminLedgerTaskOps({ uid: 'owner-1', link: { historyId: 'request-1' }, firestore: failedFirestore }), {
    status: 'error', items: []
  });
});

test('라우트는 uid+creditHistoryId만 받아 원장을 먼저 읽고 소유자·유형을 검증한다', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payment.js'), 'utf8');
  const start = source.indexOf("router.post('/admin/credit-history-item'");
  const end = source.indexOf('// 관리자: 특정 사용자의 작업 기록', start);
  const route = source.slice(start, end);
  assert.ok(start > 0 && end > start, '보안 결합 라우트가 있어야 한다');
  assert.match(route, /req\.body && req\.body\.uid/u);
  assert.match(route, /req\.body && req\.body\.creditHistoryId/u);
  assert.doesNotMatch(route, /req\.body(?: && req\.body)?\.(?:requestId|jobId|historyId)/u);
  const ledgerRead = route.indexOf("collection('creditHistory').doc(creditHistoryId)");
  const historyRead = route.indexOf("collection('history').doc(link.historyId)");
  assert.ok(ledgerRead >= 0 && historyRead > ledgerRead, '원장을 신뢰 기준으로 먼저 읽어야 한다');
  assert.match(route, /String\(archiveData\.uid \|\| ''\) !== uid/u);
  assert.match(route, /TASK_OWNER_MISMATCH/u);
  assert.match(route, /TASK_TYPE_MISMATCH/u);
  assert.match(route, /const adminUid = await requireAdmin\(req, res\)/u);
  assert.match(route, /opsStatus:\s*opsResult\.status/u);
});
