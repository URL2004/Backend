'use strict';

function buildEscalationInstruction() {
  return [
    '[재시도 지시]',
    '1차 결과가 품질 게이트에 걸렸다. 현재 입력 청크에 실제로 포함된 구조와 제목·번호 항목을 누락 없이 유지해서 다시 작성한다.',
    '현재 입력에 Ⅰ/Ⅱ/Ⅲ, 1./2./3. 같은 제목 줄이 있으면 그대로 포함한다. 입력에 없는 문서의 다른 제목을 새로 만들지 않는다.',
    '문단이나 항목을 요약해 합치지 않는다. 각 항목의 핵심 설명량을 원문과 비슷하게 유지한다.'
  ].join('\n');
}

module.exports = { buildEscalationInstruction };
