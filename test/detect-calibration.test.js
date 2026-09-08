'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const calibration = require('../lib/detectCalibration');
const historyIntegrity = require('../lib/historyLinkIntegrity');

const HISTORY_TEST_SECRET = 'history-test-secret-at-least-32-bytes';
process.env.OPENAI_SAFETY_SALT = HISTORY_TEST_SECRET;

function eligibleHistory(data) {
  return data?.type === 'humanize' ? {
    savedBy: 'server',
    qualityStatus: 'clean',
    billingDisposition: 'charged',
    engineMeta: {
      deliveryDecision: 'deliver_clean',
      effectStatus: 'normal',
      approvedModelChunkCount: 1,
      modelFailureChunkCount: 0,
      substantiveEditRatio: 0.12,
      structureSignaturePass: true
    },
    ...data
  } : data;
}

function reviewHistory(data) {
  const eligible = eligibleHistory(data);
  return {
    ...eligible,
    qualityStatus: 'needs_review',
    engineMeta: {
      ...eligible.engineMeta,
      deliveryDecision: 'deliver_review'
    }
  };
}

function historyDoc(id, data) {
  const eligible = eligibleHistory(data);
  const secured = eligible?.type === 'humanize' && eligible?.outputText
    ? { ...eligible, historyLinkIntegrity: historyIntegrity.sign('same-user', eligible.outputText, eligible, HISTORY_TEST_SECRET) }
    : eligible;
  return {
    id,
    data() {
      return secured;
    }
  };
}

function fakeDb(historyRows, storedConfig = null, state = {}, transformJobs = {}) {
  return {
    collection(name) {
      if (name === calibration.SETTINGS_COLLECTION) {
        return {
          doc(id) {
            assert.equal(id, calibration.SETTINGS_DOC);
            return {
              async get() {
                return {
                  exists: !!storedConfig,
                  data: () => storedConfig || {}
                };
              }
            };
          }
        };
      }
      if (name === 'transformJobs') {
        return {
          doc(id) {
            state.transformJobId = id;
            return {
              async get() {
                return {
                  exists: Object.hasOwn(transformJobs, id),
                  data: () => transformJobs[id]
                };
              }
            };
          }
        };
      }
      assert.equal(name, 'users');
      return {
        doc(uid) {
          state.uid = uid;
          return {
            collection(subcollection) {
              assert.equal(subcollection, 'history');
              const query = {
                orderBy(field, direction) {
                  state.orderBy = [field, direction];
                  return this;
                },
                limit(value) {
                  state.limit = value;
                  return this;
                },
                select(...fields) {
                  state.selectedFields = fields;
                  return this;
                },
                async get() {
                  return {
                    docs: historyRows.slice(0, state.limit || historyRows.length)
                  };
                }
              };
              return query;
            }
          };
        }
      };
    }
  };
}

function longDocument(prefix = '원문') {
  return Array.from({ length: 150 }, (_, index) => (
    `${index + 1}번째 ${prefix} 문장은 교육 현장의 구체적인 관찰과 실행 과정을 설명한다. `
    + `담당자는 자료 ${index + 11}건을 확인하고 다음 활동의 기준을 기록했다.`
  )).join('\n');
}

test('숫자·부정·직접 인용이 바뀌거나 긴 문장 순서를 바꾸면 유사도만으로 보정하지 않는다', () => {
  const original = longDocument('근거') + '최종 인원은 30명이며 실패하지 않았다. “원문 보존”을 확인했다.';
  for (const changed of [
    original.replace('30명', '31명'),
    original.replace('실패하지 않았다', '실패했다'),
    original.replace('“원문 보존”', '“결과 보존”'),
    original.split('\n').reverse().join('\n')
  ]) {
    assert.equal(calibration.approximateMatchMetrics(calibration.normalizeText(original), calibration.normalizeText(changed), calibration.sanitizeConfig({})).matched, false);
  }
});

test('보정 전후 비교는 원점수 상승과 서비스 조정을 나눠 보존하고 0점·동률을 개선으로 꾸미지 않는다', () => {
  const base = { reason: 'own_humanized_history_match', match: 'exact_normalized', sourceProbability: 72, rawProbability: 80, calibratedProbability: 68, applied: true };
  const comparison = calibration.buildHistoryComparison(base);
  assert.equal(comparison.rawDelta, 8);
  assert.equal(comparison.adjustedDelta, -4);
  assert.equal(comparison.adjustment, -12);
  assert.equal(comparison.status, 'improved');
  assert.equal(calibration.buildHistoryComparison({ ...base, calibratedProbability: 72 }).status, 'unchanged');
  assert.equal(calibration.buildHistoryComparison({ ...base, sourceProbability: 0, calibratedProbability: 0 }).status, 'unchanged');
  assert.equal(calibration.buildHistoryComparison({ ...base, sourceProbability: null }).status, 'unavailable');
});

test('보정 설정 캐시를 다른 데이터베이스에 공유하지 않으며 조회 장애는 무보정 성공으로 숨기지 않는다', async () => {
  calibration.clearRuntimeConfigCache();
  assert.equal((await calibration.getRuntimeConfig({ db: fakeDb([], { enabled: true }) })).enabled, true);
  assert.equal((await calibration.getRuntimeConfig({ db: fakeDb([], { enabled: false }) })).enabled, false);
  const unavailable = { collection() { throw new Error('synthetic unavailable'); } };
  await assert.rejects(calibration.applyHistoryCalibration({ db: unavailable, uid: 'same-user', text: longDocument(), probability: 80 }), { code: 'DETECT_CALIBRATION_UNAVAILABLE' });
  calibration.clearRuntimeConfigCache();
});

test('색인으로 오래된 결과를 찾되 해시는 출처 서명을 대체하지 않는다', async () => {
  const output = longDocument('색인');
  const signed = historyDoc('older-than-200', { type: 'humanize', mode: 'blog', outputText: output });
  const db = fakeDb([]);
  const originalCollection = db.collection.bind(db);
  db.collection = name => name !== 'users' ? originalCollection(name) : { doc: () => ({ collection: () => {
    const query = {
      where(field, op, hash) { assert.deepEqual([field, op, hash], ['calibrationTextHash', '==', calibration.lookupHash(output)]); this.indexed = true; return this; },
      orderBy() { return this; }, limit() { return this; }, select() { return this; },
      async get() { assert.equal(this.indexed, true); return { docs: [signed] }; }
    };
    return query;
  } }) };
  const match = await calibration.findOwnHumanizedHistoryMatch({ db, uid: 'same-user', text: output });
  assert.equal(match.id, 'older-than-200');
  assert.equal(match.trust, 'history_hmac');
});

test('공백·호환문자만 다른 기존 결과는 짧은 글에서도 정확 일치로 보정한다', async () => {
  const output = (`Ａ 과정에서는 학생의 관찰 기록을 차례로 확인했습니다. `
    + `그 결과를 바탕으로 다음 활동의 순서를 조정했습니다. `).repeat(3);
  const input = output.normalize('NFKC').replace(/ /g, '\n');
  const state = {};
  const match = await calibration.findOwnHumanizedHistoryMatch({
    db: fakeDb([historyDoc('h1', { type: 'humanize', mode: 'blog', outputText: output })], null, state),
    uid: 'same-user',
    text: input,
    limit: 50
  });

  assert.equal(match.match, 'exact_normalized');
  assert.equal(match.similarity, 1);
  assert.equal(match.lengthRatio, 1);
  assert.equal(state.uid, 'same-user');
  assert.deepEqual(state.orderBy, ['createdAt', 'desc']);
  assert.ok(state.selectedFields.includes('outputText'));
});

test('원문 100자면 내부 공백 제거 후 100자 미만이어도 검증된 정확 이력을 보정한다', async () => {
  const output = '관찰 기록을 차례로 확인하고 다음 활동을 준비했다. '.repeat(4).slice(0, 100);
  assert.equal(output.trim().length, 100);
  assert(calibration.normalizeText(output).length < 100);
  assert.equal(calibration.approximateEligible(calibration.normalizeText(output), calibration.sanitizeConfig({})), false);
  const signed = historyDoc('short-exact', { type: 'humanize', mode: 'blog', outputText: output });
  calibration.clearRuntimeConfigCache();
  const result = await calibration.applyHistoryCalibration({
    db: fakeDb([signed], { enabled: true }), uid: 'same-user', text: ` \n${output}\n `, probability: 80
  });
  assert.equal(result.applied, true);
  assert.equal(result.rawProbability, 80);
  assert.equal(result.probability, 68);
  assert.equal(result.meta.match, 'exact_normalized');
  calibration.clearRuntimeConfigCache();

  const forged = { ...signed.data(), historyLinkIntegrity: { version: historyIntegrity.VERSION, signature: 'forged' } };
  const rejected = await calibration.applyHistoryCalibration({
    db: fakeDb([{ id: 'short-forged', data: () => forged }], { enabled: true }), uid: 'same-user', text: output, probability: 80
  });
  assert.equal(rejected.applied, false);
  assert.equal(rejected.probability, 80);
  calibration.clearRuntimeConfigCache();
});

test('실제 100자 미만·빈 정규화 본문·비문자열은 서명 여부와 관계없이 조회하지 않는다', async () => {
  const output = '관찰 기록을 차례로 확인하고 다음 활동을 준비했다. '.repeat(4).slice(0, 99);
  const state = {};
  const signed = historyDoc('too-short-exact', { type: 'humanize', mode: 'blog', outputText: output });
  const db = fakeDb([signed], null, state);
  for (const text of [output, `   ${output}   `, '', ' '.repeat(120), '\u200B'.repeat(120), null, undefined, 100, [], { toString: () => 'x'.repeat(120) }]) {
    assert.equal(await calibration.findOwnHumanizedHistoryMatch({ db, uid: 'same-user', text }), null);
  }
  assert.equal(state.uid, undefined, 'ineligible input must return before history lookup');
});

test('서명 없는 과거 기록과 다른 UID로 서명된 기록은 점수 보정 근거로 신뢰하지 않는다', async () => {
  const output = longDocument('서명 경계');
  const unsigned = historyDoc('legacy', { type: 'humanize', outputText: output });
  unsigned.data = () => ({ type: 'humanize', outputText: output });
  const wrongUid = historyDoc('wrong-uid', { type: 'humanize', outputText: output });
  wrongUid.data = () => ({
    type: 'humanize',
    outputText: output,
    historyLinkIntegrity: historyIntegrity.sign(
      'different-user',
      output,
      eligibleHistory({ type: 'humanize', mode: 'blog', outputText: output }),
      HISTORY_TEST_SECRET
    )
  });
  const match = await calibration.findOwnHumanizedHistoryMatch({
    db: fakeDb([unsigned, wrongUid]),
    uid: 'same-user',
    text: output,
    limit: 50
  });
  assert.equal(match, null);
});

test('검토 필요로 전달된 서버 결과도 정확히 같으면 출처 서명으로 보정한다', async () => {
  const output = longDocument('검토 결과');
  const record = reviewHistory({
    type: 'humanize',
    mode: 'blog',
    outputText: output
  });
  const signed = historyIntegrity.sign('same-user', output, record, HISTORY_TEST_SECRET);
  assert.equal(signed.version, 'history-link-hmac-v3');
  assert.equal(historyIntegrity.isEligible(record), false);
  assert.equal(historyIntegrity.isExactCalibrationEligible(record), true);

  const match = await calibration.findOwnHumanizedHistoryMatch({
    db: fakeDb([historyDoc('job_review-signed', record)]),
    uid: 'same-user',
    text: output,
    limit: 50
  });

  assert.equal(match.match, 'exact_normalized');
  assert.equal(match.trust, 'history_hmac');
});

test('검토 필요 결과는 서명이 있어도 수정된 유사 본문까지 보정하지 않는다', async () => {
  const output = longDocument('검토 유사');
  const input = output.replace('자료 87건', '관련 자료 87건');
  const match = await calibration.findOwnHumanizedHistoryMatch({
    db: fakeDb([historyDoc('job_review-near', reviewHistory({
      type: 'humanize',
      mode: 'blog',
      outputText: output
    }))]),
    uid: 'same-user',
    text: input,
    limit: 50
  });

  assert.equal(match, null);
});

test('보안 변경 직후 서명되지 않은 정확 결과는 서버 transform 작업으로 복구한다', async () => {
  const output = longDocument('운영 복구');
  const record = reviewHistory({
    type: 'humanize',
    mode: 'blog',
    outputText: output
  });
  const unsigned = {
    id: 'job_live-review',
    data: () => record
  };
  const state = {};
  const match = await calibration.findOwnHumanizedHistoryMatch({
    db: fakeDb([unsigned], null, state, {
      'live-review': {
        uid: 'same-user',
        status: 'done',
        mode: 'blog',
        billingDisposition: 'charged',
        result: {
          outputText: output,
          qualityStatus: record.qualityStatus,
          billingDisposition: record.billingDisposition,
          engineMeta: record.engineMeta
        }
      }
    }),
    uid: 'same-user',
    text: output,
    limit: 50
  });

  assert.equal(state.transformJobId, 'live-review');
  assert.equal(match.match, 'exact_normalized');
  assert.equal(match.trust, 'transform_job_exact');
});

test('서명 없는 이력은 transform 작업의 UID·완료 상태·최종 출력이 모두 같아야 한다', async () => {
  const output = longDocument('복구 경계');
  const record = reviewHistory({ type: 'humanize', mode: 'blog', outputText: output });
  for (const [name, job] of [
    ['wrong_uid', { uid: 'other-user', status: 'done', outputText: output }],
    ['not_done', { uid: 'same-user', status: 'running', outputText: output }],
    ['wrong_output', { uid: 'same-user', status: 'done', outputText: `${output} 변조` }]
  ]) {
    const match = await calibration.findOwnHumanizedHistoryMatch({
      db: fakeDb([{ id: `job_${name}`, data: () => record }], null, {}, {
        [name]: {
          uid: job.uid,
          status: job.status,
          mode: 'blog',
          billingDisposition: 'charged',
          result: {
            outputText: job.outputText,
            qualityStatus: record.qualityStatus,
            billingDisposition: record.billingDisposition,
            engineMeta: record.engineMeta
          }
        }
      }),
      uid: 'same-user',
      text: output,
      limit: 50
    });
    assert.equal(match, null, name);
  }
});

test('기존 v2 clean 서명은 배포 뒤에도 계속 검증한다', () => {
  const output = longDocument('v2 호환');
  const record = eligibleHistory({ type: 'humanize', mode: 'formal', outputText: output });
  const legacy = {
    version: historyIntegrity.LEGACY_V2_VERSION,
    signature: crypto.createHmac('sha256', HISTORY_TEST_SECRET)
      .update(historyIntegrity.message(
        'same-user',
        output,
        record,
        historyIntegrity.LEGACY_V2_VERSION
      ))
      .digest('base64url')
  };

  assert.equal(historyIntegrity.verify('same-user', output, record, legacy, HISTORY_TEST_SECRET), true);
  assert.equal(historyIntegrity.verify('other-user', output, record, legacy, HISTORY_TEST_SECRET), false);
});

test('같은 사용자의 장문 휴머나이징 결과를 소폭 수정해도 보수적 유사 일치로 찾는다', async () => {
  const output = longDocument('휴머나이징');
  const input = output
    .replace('교육 현장의 구체적인 관찰과 실행 과정', '교육 현장의 관찰 및 실행 과정')
    .replace('담당자는 자료 87건을 확인하고', '담당자는 관련 자료 87건을 확인하고')
    .replace('다음 활동의 기준을 기록했다.', '후속 활동의 기준을 기록했다.');
  const match = await calibration.findOwnHumanizedHistoryMatch({
    db: fakeDb([historyDoc('near-1', { type: 'humanize', mode: 'formal', outputText: output })]),
    uid: 'same-user',
    text: input,
    limit: 50
  });

  assert.equal(match.match, 'near_normalized');
  assert.ok(match.similarity >= 0.88, `similarity=${match.similarity}`);
  assert.ok(match.lengthRatio >= 0.97, `lengthRatio=${match.lengthRatio}`);
});

test('짧은 글의 부분 유사와 길이가 크게 달라진 장문은 유사 보정하지 않는다', async () => {
  const shortOutput = '관찰 기록을 확인하고 다음 활동을 준비했습니다. '.repeat(6);
  const shortInput = shortOutput.replace('준비했습니다', '계획했습니다');
  const shortMatch = await calibration.findOwnHumanizedHistoryMatch({
    db: fakeDb([historyDoc('short', { type: 'humanize', outputText: shortOutput })]),
    uid: 'same-user',
    text: shortInput,
    limit: 50
  });
  assert.equal(shortMatch, null);

  const longOutput = longDocument('기준');
  const expandedInput = `${longOutput}\n${longDocument('새 주장')}`;
  const longMatch = await calibration.findOwnHumanizedHistoryMatch({
    db: fakeDb([historyDoc('expanded', { type: 'humanize', outputText: longOutput })]),
    uid: 'same-user',
    text: expandedInput,
    limit: 50
  });
  assert.equal(longMatch, null);
});

test('비슷한 길이지만 내용이 다른 장문은 같은 사용자의 기록이어도 보정하지 않는다', async () => {
  const output = longDocument('교육');
  const unrelated = Array.from({ length: 150 }, (_, index) => (
    `${index + 1}번째 계약 조항은 임대인의 의무와 해지 조건을 규정한다. `
    + `당사자는 날짜 ${index + 11}일을 기준으로 손해배상 범위를 협의한다.`
  )).join('\n');
  const similarity = calibration.normalizedShingleSimilarity(output, unrelated);
  const match = await calibration.findOwnHumanizedHistoryMatch({
    db: fakeDb([historyDoc('other', { type: 'humanize', outputText: output })]),
    uid: 'same-user',
    text: unrelated,
    limit: 50
  });

  assert.ok(similarity < 0.88, `similarity=${similarity}`);
  assert.equal(match, null);
});

test('최근 감지 기록이 많아도 최근 휴머나이징 결과 50개 범위를 따로 확보한다', async () => {
  const output = longDocument('보정 대상');
  const input = output.replace('자료 87건', '관련 자료 87건');
  const rows = [
    ...Array.from({ length: 80 }, (_, index) => historyDoc(`d${index}`, {
      type: 'detect',
      probability: 80
    })),
    historyDoc('humanized-after-detects', {
      type: 'humanize',
      mode: 'formal',
      outputText: output
    })
  ];
  const state = {};
  const match = await calibration.findOwnHumanizedHistoryMatch({
    db: fakeDb(rows, null, state),
    uid: 'same-user',
    text: input,
    limit: 50
  });

  assert.equal(state.limit, 200);
  assert.equal(match.id, 'humanized-after-detects');
  assert.equal(match.match, 'near_normalized');
});

test('운영 보정은 유사 매칭 메타와 원점수를 남기고 88점을 58점으로 조정한다', async () => {
  const output = longDocument('운영 결과');
  const input = output.replace('자료 93건', '관련 자료 93건');
  const storedConfig = {
    enabled: true,
    limit: 50,
    factor: 0.4,
    maxReduction: 30,
    floor: 20,
    approximateMatchEnabled: true,
    similarityThreshold: 0.88,
    maxLengthDeltaRatio: 0.03,
    minApproximateChars: 500
  };
  calibration.clearRuntimeConfigCache();
  const result = await calibration.applyHistoryCalibration({
    db: fakeDb([historyDoc('calibrated', {
      type: 'humanize',
      mode: 'formal',
      outputText: output
    })], storedConfig),
    uid: 'same-user',
    text: input,
    probability: 88,
    route: 'detect_report'
  });
  calibration.clearRuntimeConfigCache();

  assert.equal(result.rawProbability, 88);
  assert.equal(result.probability, 58);
  assert.equal(result.applied, true);
  assert.equal(result.meta.version, calibration.VERSION);
  assert.equal(result.meta.match, 'near_normalized');
  assert.ok(result.meta.matchSimilarity >= 0.88);
  assert.ok(result.meta.matchLengthRatio >= 0.97);
});

test('유사 일치는 명시적으로 끌 수 있고 새 안전 기본값은 누락 설정에도 유지된다', async () => {
  const defaults = calibration.sanitizeConfig({ enabled: true });
  assert.equal(defaults.approximateMatchEnabled, true);
  assert.equal(defaults.similarityThreshold, 0.88);
  assert.equal(defaults.maxLengthDeltaRatio, 0.03);
  // 2026-09-02: 500 → 300 (자소서 한 문항의 수정본도 보정되게). 문장 수 기준과 원점수 상한이 함께 켜진다.
  assert.equal(defaults.minApproximateChars, 300);
  assert.equal(defaults.minApproximateSentences, 5);
  assert.equal(defaults.sourceCapEnabled, true);

  const output = longDocument('유사 일치 비활성');
  const input = output.replace('자료 55건', '관련 자료 55건');
  const match = await calibration.findOwnHumanizedHistoryMatch({
    db: fakeDb([historyDoc('disabled', { type: 'humanize', outputText: output })]),
    uid: 'same-user',
    text: input,
    limit: 50,
    config: {
      ...defaults,
      approximateMatchEnabled: false
    }
  });
  assert.equal(match, null);
});
