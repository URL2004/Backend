'use strict';

const { priorityPromptLines } = require('../../humanizeContract');

function gateSummaryBlock(humanizeContract = null) {
  return [
    '[작업 우선순위]',
    ...priorityPromptLines(humanizeContract),
    '확실하지 않은 사실·수치·전문 용어만 새로 추정하지 말고 그 표현을 유지한다. 그 주변의 안전한 절 배치·주어 위치·연결·호흡까지 원문대로 복사하지는 않는다.',
    '메타 설명이나 작업 과정 없이 최종 본문만 만든다.'
  ].join('\n');
}

module.exports = { gateSummaryBlock };
