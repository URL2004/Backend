'use strict';
// 2026-09-29: 중복 입력 차단 로그에 비율만 있어 오탐 판단이 안 됐다 → 판정 경로와 반복 규모를 함께 돌려준다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectInputDuplication } = require('../engine/inputrouting');

const paragraph = (n) => `이 문단은 실험 보고서의 ${n}번째 단락으로 온도 변화가 반응 속도에 미치는 영향을 세 차례 반복 측정한 결과를 정리한 것이다.`;

test('문단 반복은 paragraph_repeat와 블록 수를 함께 돌려준다', () => {
  const body = [paragraph(1), paragraph(2), paragraph(3)].join('\n\n');
  const result = detectInputDuplication(body + '\n\n' + body);
  assert.equal(result.duplicated, true);
  assert.equal(result.method, 'paragraph_repeat');
  assert.equal(result.blocks, 6);
  assert.equal(result.repeatedBlocks, 3);
  assert.ok(result.ratio >= 0.35);
});

test('경계가 달라진 통짜 반복은 half_window와 창 수를 돌려준다', () => {
  const base = Array.from({ length: 6 }, (_, i) => paragraph(i + 1)).join(' ');
  // 두 번째 사본은 줄바꿈 위치를 바꿔 문단 키 반복(①)을 피한다.
  const shuffled = base.replace(/ /g, (m, offset) => (offset % 97 === 0 ? '\n' : m));
  const result = detectInputDuplication(base + '\n' + shuffled);
  assert.equal(result.duplicated, true);
  assert.equal(result.method, 'half_window');
  assert.ok(result.windows >= 3);
  assert.ok(result.matchedWindows / result.windows >= 0.6);
});

test('정상 글은 세부 필드 없이 duplicated:false다', () => {
  const body = Array.from({ length: 8 }, (_, i) => paragraph(i + 1) + ` 추가 관찰 ${i}: 결과는 매번 달랐다.`).join('\n\n');
  assert.deepEqual(detectInputDuplication(body), { duplicated: false, ratio: 0 });
});
