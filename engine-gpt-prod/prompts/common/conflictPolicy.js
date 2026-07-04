'use strict';

function gateSummaryBlock() {
  return [
    '[작업 우선순위]',
    '변화량은 보호 대상 요소가 아니라 일반 본문의 어순, 절 배치, 접속, 반복 완화에서 만든다.',
    '게이트를 의식해 보존형 교정처럼 약하게 쓰지 않는다.',
    '메타 설명이나 작업 과정 없이 최종 본문만 만든다.'
  ].join('\n');
}

module.exports = { gateSummaryBlock };
