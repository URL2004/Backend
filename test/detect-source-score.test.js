'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const source = require('../lib/detectSourceScore');
const KEY = 'source-score-test-secret-longer-than-32-bytes';

function database(records, observe = {}) {
  const query = {
    orderBy(field, direction) { observe.order = [field, direction]; return query; },
    limit(count) { observe.limit = count; return query; },
    select(...fields) { observe.fields = fields; return query; },
    async get() { observe.reads = (observe.reads || 0) + 1; return { docs: records.map(record => ({ data: () => record })) }; }
  };
  return { collection(name) { assert.equal(name, 'users'); return { doc(uid) {
    observe.uid = uid;
    return { collection(child) { assert.equal(child, 'history'); return query; } };
  } }; } };
}
const record = extra => ({ type: 'detect', savedBy: 'server', probSource: 'llm', inputText: '검증용 원문입니다.', probability: 38, ...extra });

test('선택 점수는 결측·빈 값·불리언·배열을 0으로 강제 변환하지 않는다', () => {
  for (const value of [null, undefined, '', ' ', false, true, [], [0], {}, NaN, Infinity, -1, 101, 'Infinity']) {
    assert.equal(source.optionalScore(value), null);
  }
  assert.equal(source.optionalScore(0), 0);
  assert.equal(source.optionalScore('0'), 0);
  assert.equal(source.optionalScore('48.6'), 49);
});

test('같은 사용자·입력의 최신 서버 감지 점수만 제한된 조회로 확인한다', async () => {
  const observe = {};
  const score = await source.resolveSourceScore({ db: database([record()], observe), uid: 'u1', text: '검증용 원문입니다.', claimedScore: 38 });
  assert.equal(score, 38);
  assert.equal(observe.uid, 'u1');
  assert.equal(observe.limit, source.LOOKUP_LIMIT);
  assert.equal(observe.reads, 1);
  assert.deepEqual(observe.order, ['createdAt', 'desc']);
});

test('클라이언트 점수 위조·다른 입력·백업·보정된 감지 이력은 상한 근거가 아니다', async () => {
  for (const rows of [
    [record({ probability: 60 })],
    [record({ inputText: '다른 원문입니다.' })],
    [record({ savedBy: 'client' })],
    [record({ probSource: 'local_fallback' })],
    [record({ probabilityCalibration: { applied: true } })],
    [record({ probability: 60 }), record({ probability: 38 })]
  ]) {
    assert.equal(await source.resolveSourceScore({ db: database(rows), uid: 'u1', text: '검증용 원문입니다.', claimedScore: 38 }), null);
  }
});

test('원점수가 없으면 데이터베이스 조회도 발생하지 않는다', async () => {
  const observe = {};
  assert.equal(await source.resolveSourceScore({ db: database([], observe), uid: 'u1', text: '원문', claimedScore: null }), null);
  assert.equal(observe.reads, undefined);
});

test('원점수 증명은 사용자·출력·점수에 결합되고 구형 서명과 위조를 거절한다', () => {
  const outputText = '검증한 변환 결과입니다.';
  const proof = source.signSourceScore('u1', outputText, 0, KEY);
  const saved = { outputText, sourceProbability: 0, historySourceScoreIntegrity: proof };
  assert.equal(source.verifiedSourceScore('u1', saved, KEY), 0);
  assert.equal(source.verifiedSourceScore('u2', saved, KEY), null);
  assert.equal(source.verifiedSourceScore('u1', { ...saved, outputText: '다른 결과' }, KEY), null);
  assert.equal(source.verifiedSourceScore('u1', { ...saved, sourceProbability: 1 }, KEY), null);
  assert.equal(source.verifiedSourceScore('u1', { ...saved, historySourceScoreIntegrity: null }, KEY), null);
  assert.equal(source.signSourceScore('u1', outputText, null, KEY), null);
});
