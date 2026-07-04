'use strict';

function buildEscalationInstruction() {
  return [
    '[재시도 지시]',
    '1차 결과가 품질 게이트에 걸렸다. 원문 전체 구조와 모든 제목/번호 항목을 누락 없이 유지해서 다시 작성한다.',
    'Ⅰ/Ⅱ/Ⅲ, 1./2./3. 같은 제목 줄은 모두 출력에 포함한다. 제목을 삭제하거나 본문에 흡수하지 않는다.',
    '문단이나 항목을 요약해 합치지 않는다. 각 항목의 핵심 설명량을 원문과 비슷하게 유지한다.'
  ].join('\n');
}

module.exports = { buildEscalationInstruction };
