'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calibration = require('../lib/detectCalibration');

function historyDoc(id, data) {
  return {
    id,
    data() {
      return data;
    }
  };
}

function fakeDb(historyRows, storedConfig = null, state = {}) {
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
  assert.equal(result.meta.version, 'history-calibration-v2');
  assert.equal(result.meta.match, 'near_normalized');
  assert.ok(result.meta.matchSimilarity >= 0.88);
  assert.ok(result.meta.matchLengthRatio >= 0.97);
});

test('유사 일치는 명시적으로 끌 수 있고 새 안전 기본값은 누락 설정에도 유지된다', async () => {
  const defaults = calibration.sanitizeConfig({ enabled: true });
  assert.equal(defaults.approximateMatchEnabled, true);
  assert.equal(defaults.similarityThreshold, 0.88);
  assert.equal(defaults.maxLengthDeltaRatio, 0.03);
  assert.equal(defaults.minApproximateChars, 500);

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
