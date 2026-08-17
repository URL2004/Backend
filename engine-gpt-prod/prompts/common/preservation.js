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
    '숫자, 단위, 기관·고유명사, 참고문헌, URL, 직접 인용, 화자, 제목·목록과 문단의 역할·순서를 보존한다.',
    paragraphPromptLine(resolvedContract),
    flags.has('compressed_multicolumn')
      ? '탭·파이프로 구분된 표와 다열 행은 각 행의 셀 개수·열 구분·셀 소유권을 그대로 유지하고 산문으로 합치지 않는다.'
      : '',
    `출력 분량은 원문 공백 제외 길이의 ${lp.min}~${lp.max}배 범위를 우선한다.`,
    '원문에 없는 경험·감정·성과·평가·인과관계를 만들지 않는다.'
  ].filter(Boolean).join('\n');
}

module.exports = { preservationBlock };
