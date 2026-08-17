'use strict';

function structuredOutputBlock() {
  return [
    '[출력 형식]',
    '구조화된 응답의 outputText에는 최종 본문만 넣는다. 설명, 라벨, 코드블록, 작업 과정이나 자체 위험 평가는 넣지 않는다.'
  ].join('\n');
}

module.exports = { structuredOutputBlock };
