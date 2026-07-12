'use strict';

function preservationBlock(lengthPolicy) {
  const lp = lengthPolicy || { min: 0.9, max: 1.12 };
  return [
    '[불변 계약]',
    '숫자, 단위, 기관·고유명사, 참고문헌, URL, 직접 인용, 화자, 제목·목록·문단 구조를 보존한다.',
    `출력 분량은 원문 공백 제외 길이의 ${lp.min}~${lp.max}배 범위를 우선한다.`,
    '원문에 없는 경험·감정·성과·평가·인과관계를 만들지 않는다.'
  ].join('\n');
}

module.exports = { preservationBlock };
