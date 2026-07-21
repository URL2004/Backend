'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BASIS, estimateAdvancedTime } = require('../engine-gpt-prod/timeEstimate');
const { shouldCallModel } = require('../engine-gpt-prod/chunkPolicy');

function longAcademicDocument(sectionCount = 18) {
  const sections = [];
  for (let i = 1; i <= sectionCount; i += 1) {
    sections.push([
      `${i}. 분석 항목 ${i}`,
      `본 연구는 ${2020 + (i % 6)}년 자료 ${100 + i}건을 바탕으로 정보 비대칭의 작동 과정을 분석한다. 자료의 출처와 범위를 구분하고, 관찰된 결과가 어떤 조건에서 달라지는지 순서대로 검토하였다.`,
      `분석 결과, 선택 구조와 설명 방식은 참여자의 판단에 서로 다른 영향을 주었다. 다만 이 결과를 모든 상황에 일반화할 수는 없으므로 표본 구성과 측정 기준을 함께 확인해야 한다.`,
      `이 절에서는 앞선 결과를 다음 절의 비교 기준과 연결하되, 원문에 없는 사례나 수치를 추가하지 않는다.`
    ].join('\n'));
  }
  return [
    'Ⅰ. 서론',
    '1. 문제 제기와 연구 목적',
    '본 연구는 디지털 환경의 정보 비대칭이 이용자 판단에 미치는 영향을 검토한다.',
    'Ⅱ. 연구 방법과 결과',
    ...sections,
    'Ⅲ. 결론',
    '분석 범위와 한계를 함께 제시함으로써 결과의 적용 조건을 분명히 한다.',
    '참고 문헌',
    '김연구. (2023). 디지털 환경과 소비자 판단.',
    '이분석. (2024). 정보 구조의 실증 분석.',
    '박검토. (2025). 플랫폼 연구 방법론.'
  ].join('\n');
}

test('고급 시간은 실제 편집 청크 기반의 5분 단위 범위로 계산한다', () => {
  const source = longAcademicDocument();
  const estimate = estimateAdvancedTime(source);

  assert.equal(estimate.version, 2);
  assert.equal(estimate.basis, BASIS);
  assert.ok(estimate.editableChunkCount > 1);
  assert.ok(estimate.totalChunkCount >= estimate.editableChunkCount);
  assert.ok(estimate.editableBareLength <= estimate.sourceBareLength);
  assert.ok(estimate.lowSec >= 300);
  assert.ok(estimate.highSec > estimate.lowSec);
  assert.ok(estimate.highSec <= 5400);
  assert.equal(estimate.lowSec % 300, 0);
  assert.equal(estimate.highSec % 300, 0);
});

test('근거 검색은 같은 문서의 예상 범위를 늘리고 입력 본문을 메타에 복제하지 않는다', () => {
  const source = longAcademicDocument(10);
  const plain = estimateAdvancedTime(source);
  const evidence = estimateAdvancedTime(source, { evidence: true });

  assert.equal(evidence.evidenceIncluded, true);
  assert.ok(evidence.lowSec > plain.lowSec);
  assert.ok(evidence.highSec > plain.highSec);
  assert.equal(evidence.editableChunkCount, plain.editableChunkCount);
  assert.equal(evidence.sourceBareLength, plain.sourceBareLength);
  assert.doesNotMatch(JSON.stringify(evidence), /정보 비대칭의 작동 과정/u);
});

test('잠긴 구조와 짧은 표제는 모델 호출 청크에서 제외한다', () => {
  assert.equal(shouldCallModel({ locked: true, text: '긴 본문 문장입니다. '.repeat(10) }), false);
  assert.equal(shouldCallModel({ locked: false, text: 'Ⅰ. 서론' }), false);
  assert.equal(shouldCallModel({ locked: false, text: '이 문장은 실제로 변환할 수 있을 만큼 충분한 길이와 완결된 의미를 갖고 있습니다.' }), true);
});
