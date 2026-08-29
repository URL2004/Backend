'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const inputrouting = require('../engine/inputrouting');
const diagnose = require('../routes/diagnose');
const detectreport = require('../routes/detectreport');
const analyze = require('../routes/analyze');
const transform = require('../routes/transform');

const jamoMash = 'ㅁㄴㅇㄴㅁㅇㄴㅁㅇㅁ'.repeat(24);

test('입력 가독성 판정은 자모 난타·짧은 패턴 반복만 좁게 차단한다', () => {
  const normal = '이번 보고서에서는 설문 응답 128건을 분류하고 결과가 달라진 원인을 비교했다. 표에 나온 수치는 원자료와 다시 대조했고, 확인되지 않은 내용은 결론에서 제외했다.';
  const jamoLesson = '한글 자모 ㄱ, ㄴ, ㄷ은 각각 다른 소리를 나타낸다. 수업에서는 자모의 모양과 실제 단어 속 발음을 함께 비교했다.';

  assert.deepEqual(inputrouting.assessInputReadability(jamoMash), {
    readable: false,
    reason: 'standalone_hangul_jamo'
  });
  assert.equal(inputrouting.assessInputReadability('asdfgh'.repeat(14)).reason, 'repeated_pattern');
  assert.equal(inputrouting.assessInputReadability(normal).readable, true);
  assert.equal(inputrouting.assessInputReadability(jamoLesson).readable, true);
});

test('진단·감지·변환 API는 의미 없는 반복 입력을 인증·과금 전에 같은 422로 거부한다', { concurrency: false }, async t => {
  const app = express();
  app.use(express.json());
  app.use('/', diagnose);
  app.use('/', detectreport);
  app.use('/', analyze);
  app.use('/', transform);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}`;
  const cases = [
    ['/diagnose', { text: jamoMash }],
    ['/detect-report', { text: jamoMash }],
    ['/analyze', { text: jamoMash, mode: 'detect' }],
    ['/transform', { text: jamoMash, mode: 'formal' }],
    ['/coach-suggest', { text: jamoMash }]
  ];

  for (const [route, body] of cases) {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    assert.equal(response.status, 422, route);
    assert.equal(payload.code, 'UNREADABLE_INPUT', route);
    assert.equal(payload.reason, 'standalone_hangul_jamo', route);
    assert.equal(payload.error, inputrouting.UNREADABLE_INPUT_MESSAGE, route);
  }
});
