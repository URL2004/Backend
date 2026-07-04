'use strict';

function preservationBlock(lengthPolicy) {
  const lp = lengthPolicy || { min: 0.9, max: 1.12 };
  return [
    '[보존 계약]',
    '1. 숫자, 날짜, 금액, 고유명사, 기관명, 인명, 제품명, 인용, 참고문헌, URL은 바꾸거나 만들지 않는다.',
    `2. 분량은 원문 공백 제외 길이의 ${lp.min}~${lp.max}배 범위를 우선한다. 요약이나 확장은 하지 않는다.`,
    '3. 원문의 1인칭/3인칭/조직/비인칭 화자를 유지한다. 없는 경험, 감정, 판단 주체를 추가하지 않는다.',
    '4. 결론과 주장 방향을 뒤집지 않는다. 서로 다른 기술, 원인, 효과를 임의로 묶지 않는다.',
    '5. 제목, 번호, 참고문헌, 목차, 표기 순서가 있으면 구조를 유지한다. 참고문헌과 URL은 그대로 둔다.'
  ].join('\n');
}

module.exports = { preservationBlock };
