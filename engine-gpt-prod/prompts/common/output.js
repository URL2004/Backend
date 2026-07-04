'use strict';

function structuredOutputBlock() {
  return [
    '[출력 형식]',
    '구조화된 응답만 반환한다. 최종 본문 외 설명, 라벨, 코드블록, 작업 과정은 넣지 않는다.'
  ].join('\n');
}

module.exports = { structuredOutputBlock };
