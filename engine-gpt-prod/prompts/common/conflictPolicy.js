'use strict';

function gateSummaryBlock() {
  return [
    '[작업 우선순위]',
    '지시가 충돌하면 불변 계약(의미·사실·구조·화자), 원문 장르·리듬, 요청 강도 순으로 적용한다.',
    '확실하지 않은 부분은 새 내용을 추정하지 말고 원문 표현을 유지한다.',
    '메타 설명이나 작업 과정 없이 최종 본문만 만든다.'
  ].join('\n');
}

module.exports = { gateSummaryBlock };
