'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let stored = null;
const rows = new Map([
  ['users/history-user', { credits: 100, plan: 'free' }]
]);

function snapshot(target) {
  return {
    exists: rows.has(target.path),
    data: () => rows.get(target.path)
  };
}

function ref(pathname) {
  return {
    path: pathname,
    id: pathname.split('/').at(-1),
    async get() {
      return snapshot(this);
    },
    collection(name) {
      return {
        doc: id => ref(`${pathname}/${name}/${id || 'auto'}`),
        orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => ({
          docs: [...rows.entries()].filter(([key]) => key.startsWith(`${pathname}/${name}/`))
            .map(([, value]) => ({ data: () => value }))
        }) }) }) })
      };
    }
  };
}

const db = {
  collection(name) {
    return { doc: id => ref(`${name}/${id}`) };
  },
  async runTransaction(callback) {
    return callback({
      async get(target) {
        return snapshot(target);
      },
      set(target, value, options) {
        stored = { target, value, options };
        rows.set(target.path, options?.merge
          ? { ...(rows.get(target.path) || {}), ...value }
          : { ...value });
      }
    });
  }
};

const configPath = require.resolve(path.join(ROOT, 'config.js'));
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: {
    db,
    admin: {
      firestore: {
        FieldValue: { serverTimestamp: () => 'server-time' }
      }
    }
  }
};

const history = require('../lib/historyService');

test('server history readback retains the exact analysis interpretation and bounded model evidence', async () => {
  const { buildDetectInterpretation } = require('../lib/detectInterpretation');
  const { locatePublicEvidence } = require('../lib/detectInputDocument');
  const { groundSignals, sourceSentences } = require('../lib/detectGrounding');
  const text = '합성 연구 자료는 검증 방법과 관찰 결과를 구분하여 기록했고 이후 분석에서 확인해야 할 한계를 함께 설명했다. '.repeat(12).trim();
  const signalEvidence = locatePublicEvidence(groundSignals([{ category: 'ending_repetition', strength: 'strong', scope: 'recurring', evidenceSentences: [1, 3] }], text), text);
  const interpretation = buildDetectInterpretation({ probability: 32, probSource: 'llm', confidence: 'high', textLength: text.length, sentenceTotal: sourceSentences(text).length, causeCoverageStatus: 'aligned', signalEvidence });
  assert.equal(interpretation.evidence.level, 'sufficient');
  assert.equal(interpretation.pattern.locationCount, 2);
  const result = { probability: 32, probSource: 'llm', confidence: 'high', interpretation, signalEvidence, summary: interpretation.headline };
  await history.saveAnalyzeHistory({ uid: 'history-user', requestId: 'interpretation-readback', opType: 'detect', text, needed: 3, result });
  const readback = (await ref('users/history-user/history/interpretation-readback').get()).data();
  assert.deepEqual(readback.interpretation, interpretation);
  assert.equal(readback.interpretation.score, readback.probability);
  assert.equal(readback.interpretation.sample.characters, text.length);
  assert.ok(Buffer.byteLength(JSON.stringify(readback.interpretation), 'utf8') < 16000);
});

test('history does not preserve malformed or oversized interpretation descriptors', async () => {
  await history.saveAnalyzeHistory({ uid: 'history-user', requestId: 'interpretation-invalid', opType: 'detect', text: '합성 입력 원문이다.', needed: 3,
    result: { probability: 32, probSource: 'llm', interpretation: { version: 'detect-interpretation-v1', score: 32, headline: 'x'.repeat(17000), extra: 'arbitrary prose' } } });
  const readback = (await ref('users/history-user/history/interpretation-invalid').get()).data();
  assert.equal(readback.interpretation.score, 32);
  assert.equal(readback.interpretation.evidence.level, 'limited');
  assert.equal(Object.hasOwn(readback.interpretation, 'extra'), false);
  assert.ok(readback.interpretation.headline.length < 1000);
});

test('humanization history retains bounded semantic repair diagnostics', () => {
  const compact = history.compactHistoryEngineMeta({ semanticUnchangedRepairCount: 2, semanticRepairStyleWarnings: ['sentence_distribution_worsened', 'sentence_distribution_worsened'] });
  assert.equal(compact.semanticUnchangedRepairCount, 2);
  assert.deepEqual(compact.semanticRepairStyleWarnings, ['sentence_distribution_worsened']);
});

test('휴머나이징 이력 저장은 누락 원점수를 0으로 만들지 않는다', async () => {
  for (const sourceProbability of [null, undefined, '', false, [], 0]) {
    await history.saveAnalyzeHistory({
      uid: 'history-user', requestId: 'missing-source-score', opType: 'humanize',
      text: '감지 이력이 없는 합성 원문', needed: 0, mode: 'blog',
      result: { outputText: '합성 변환 결과' }, sourceProbability
    });
    assert.equal(stored.value.sourceProbability, null);
    assert.equal(stored.value.historySourceScoreIntegrity, null);
  }
});

test('휴머나이징 이력은 같은 원문의 서버 감지 점수를 확인한 뒤 출력과 서명한다', async t => {
  const previous = process.env.OPENAI_SAFETY_SALT;
  process.env.OPENAI_SAFETY_SALT = 'history-source-score-test-secret-longer-than-32-bytes';
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_SAFETY_SALT;
    else process.env.OPENAI_SAFETY_SALT = previous;
  });
  rows.set('users/history-user/history/verified-source-detect', {
    type: 'detect', savedBy: 'server', probSource: 'llm',
    inputText: '서버 감지 점수 검증용 합성 원문', probability: 38
  });
  await history.saveAnalyzeHistory({
    uid: 'history-user', requestId: 'verified-source-humanize', opType: 'humanize',
    text: '서버 감지 점수 검증용 합성 원문', needed: 0, mode: 'blog',
    result: { outputText: '검증을 위한 합성 변환 결과' }, sourceProbability: 38
  });
  assert.equal(stored.value.sourceProbability, 38);
  assert.equal(require('../lib/detectSourceScore').verifiedSourceScore('history-user', stored.value), 38);
  await history.saveAnalyzeHistory({
    uid: 'history-user', requestId: 'verified-source-humanize', opType: 'humanize',
    text: '서버 감지 점수 검증용 합성 원문', needed: 0, mode: 'blog',
    result: { outputText: '재저장한 합성 결과' }, sourceProbability: null
  });
  assert.equal(rows.get('users/history-user/history/verified-source-humanize').sourceProbability, null);
  assert.equal(rows.get('users/history-user/history/verified-source-humanize').historySourceScoreIntegrity, null);
});

test('감지 이력은 공개 점수 provenance만 allowlist로 저장한다', async () => {
  stored = null;
  await history.saveAnalyzeHistory({
    uid: 'history-user',
    requestId: 'detect-history-1',
    opType: 'detect',
    text: '합성 테스트 원문',
    needed: 3,
    mode: 'detect',
    result: {
      probability: 72,
      riskLevel: 'high',
      riskLabel: 'AI 의심 높음',
      probSource: 'llm',
      confidence: 'medium',
      gptMeta: {
        selectedModel: 'gpt-test',
        engine: 'detect-test-v1',
        escalated: true,
        detectPromptVersion: 'detect-prompt-v2',
        detectCacheVariant: 'detect-result-stability-v1:abc',
        detectCacheHit: true,
        detectCacheSource: 'firestore',
        usage: { raw: '저장 금지' },
        providerResponse: '저장 금지'
      },
      rawProbability: 77,
      modelProbability: 81,
      causeScoreAdjusted: true,
      causeScoreCeiling: 74,
      causeScoreAdjustmentCode: 'score_capped_by_cause_evidence',
      documentProfile: 'report_assignment',
      profileConfidence: 0.91,
      profileMargin: 0.32,
      profileAmbiguous: true,
      signalEvidence: [{
        category: 'sentence_uniformity', strength: 'strong', scope: 'recurring',
        description: '저장하지 않을 공개 설명'
      }],
      reportView: {
        causeAnalysis: {
          version: 'cause-coverage-v1', status: 'aligned', coverage: 1,
          codes: []
        }
      },
      summary: '요약',
      detail: '상세'
    }
  });

  assert.equal(stored.target.path, 'users/history-user/history/detect-history-1');
  assert.equal(stored.value.probSource, 'llm');
  assert.equal(stored.value.detectConfidence, 'medium');
  assert.equal(stored.value.detectModel, 'gpt-test');
  assert.equal(stored.value.detectorVersion, 'detect-test-v1');
  assert.equal(stored.value.detectEscalated, true);
  assert.equal(stored.value.detectPromptVersion, 'detect-prompt-v2');
  assert.equal(stored.value.detectCacheVariant, 'detect-result-stability-v1:abc');
  assert.equal(stored.value.detectCacheHit, true);
  assert.equal(stored.value.detectCacheSource, 'firestore');
  assert.equal(stored.value.rawProbability, 77);
  assert.equal(stored.value.modelProbability, 81);
  assert.equal(stored.value.detectCauseScoreAdjusted, true);
  assert.equal(stored.value.detectCauseScoreCeiling, 74);
  assert.equal(stored.value.detectDocumentProfile, 'report_assignment');
  assert.equal(stored.value.detectProfileMargin, 0.32);
  assert.equal(stored.value.detectProfileAmbiguous, true);
  assert.deepEqual(stored.value.detectCauseEvidence, [{
    category: 'sentence_uniformity', strength: 'strong', scope: 'recurring'
  }]);
  assert.deepEqual(stored.value.detectCauseAlignment, {
    version: 'cause-coverage-v1', status: 'aligned', coverage: 1, codes: []
  });
  assert.equal(JSON.stringify(stored.value).includes('저장하지 않을 공개 설명'), false);
  assert.equal(Object.hasOwn(stored.value, 'gptMeta'), false);
  assert.equal(Object.hasOwn(stored.value, 'usage'), false);
  assert.equal(Object.hasOwn(stored.value, 'providerResponse'), false);
});

test('엔진 폴백 출처와 유효하지 않은 confidence는 감지 이력에 저장하지 않는다', async () => {
  stored = null;
  await history.saveAnalyzeHistory({
    uid: 'history-user',
    requestId: 'detect-history-2',
    opType: 'detect',
    text: '합성 테스트 원문',
    needed: 0,
    mode: 'detect',
    result: {
      probability: 22,
      probSource: 'engine',
      confidence: 'certain',
      gptMeta: { detectCacheSource: 'untrusted' },
      summary: '요약',
      detail: '상세'
    }
  });

  assert.equal(Object.hasOwn(stored.value, 'probSource'), false);
  assert.equal(Object.hasOwn(stored.value, 'detectConfidence'), false);
  assert.equal(Object.hasOwn(stored.value, 'detectCacheSource'), false);
});

test('감지 이력 requestId는 payload fingerprint와 비용에 결합되고 최초 응답을 덮어쓰지 않는다', async () => {
  const requestId = 'detect-history-bound-1';
  const fingerprint = 'a'.repeat(64);
  const firstResponse = {
    ok: true,
    probability: 72,
    probSource: 'llm',
    summary: '최초 결과',
    charged: 3,
    remainingCredits: 97
  };
  const first = await history.saveAnalyzeHistory({
    uid: 'history-user',
    requestId,
    opType: 'detect',
    text: '최초 감지 입력',
    needed: 3,
    mode: 'detect',
    requestPayloadFingerprint: fingerprint,
    detectResponseCache: firstResponse,
    result: { probability: 72, probSource: 'llm', summary: '최초 결과', detail: '최초 상세' }
  });
  assert.equal(first.saved, true);

  const ready = await history.getDetectHistoryIdempotency({
    uid: 'history-user',
    requestId,
    needed: 3,
    requestPayloadFingerprint: fingerprint
  });
  assert.equal(ready.state, 'READY');
  assert.deepEqual(ready.response, firstResponse);

  const duplicate = await history.saveAnalyzeHistory({
    uid: 'history-user',
    requestId,
    opType: 'detect',
    text: '최초 감지 입력',
    needed: 3,
    mode: 'detect',
    requestPayloadFingerprint: fingerprint,
    detectResponseCache: { ...firstResponse, probability: 22, summary: '덮어쓰기 금지' },
    result: { probability: 22, probSource: 'llm', summary: '덮어쓰기 금지', detail: '덮어쓰기 금지' }
  });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.response, firstResponse);
  assert.deepEqual(rows.get(`users/history-user/history/${requestId}`).detectResponseCache, firstResponse);

  const mismatch = await history.getDetectHistoryIdempotency({
    uid: 'history-user',
    requestId,
    needed: 4,
    requestPayloadFingerprint: 'b'.repeat(64)
  });
  assert.equal(mismatch.state, 'MISMATCH');
  await assert.rejects(history.saveAnalyzeHistory({
    uid: 'history-user',
    requestId,
    opType: 'detect',
    text: '다른 감지 입력',
    needed: 4,
    mode: 'detect',
    requestPayloadFingerprint: 'b'.repeat(64),
    detectResponseCache: { ...firstResponse, probability: 22 },
    result: { probability: 22, probSource: 'llm', summary: '다름', detail: '다름' }
  }), error => error?.code === 'IDEMPOTENCY_KEY_REUSED' && error?.status === 409);
  assert.equal(rows.get(`users/history-user/history/${requestId}`).probability, 72);
});
