'use strict';

const { paragraphPromptLine, resolveHumanizeContract } = require('../../humanizeContract');

function preservationBlock(lengthPolicy, documentProfile = null, requestStrength = '', humanizeContract = null) {
  const lp = lengthPolicy || { min: 0.9, max: 1.12 };
  const flags = new Set(documentProfile?.formatProfile?.flags || []);
  const resolvedContract = resolveHumanizeContract({
    humanizeContract,
    requestStrength,
    documentProfile
  });
  return [
    '[불변 계약]',
    '숫자·단위·기관·고유명사·참고문헌·URL·직접 인용·화자·제목·목록·문단 역할·순서를 보존한다. 한글 순번(첫째·여덟째)도 지킨다.',
    paragraphPromptLine(resolvedContract),
    flags.has('compressed_multicolumn')
      ? '탭·파이프로 구분된 표와 다열 행은 각 행의 셀 개수·열 구분·셀 소유권을 그대로 유지하고 산문으로 합치지 않는다.'
      : '',
    `출력 분량은 원문 공백 제외 길이의 ${lp.min}~${lp.max}배 범위를 우선한다.`,
    '경험·감정·성과·평가·인과를 만들거나 불확실성을 확정 사실로 바꾸지 않는다.',
    '필요조건(-어야/-해야)을 일반 조건(-면)으로 바꾸지 않는다. 시기·시대·기간을 나타내는 배경 명칭을 행위 주체로 확정하지 않는다. 선택 관계(이나/또는)를 양쪽 모두의 주장(과/및)으로 바꾸지 않는다. 같은 관계를 유지하는 의역과 문장 분리는 허용한다.'
  ].filter(Boolean).join('\n');
}

module.exports = { preservationBlock };
