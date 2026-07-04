'use strict';

function preservationBlock(lengthPolicy) {
  const lp = lengthPolicy || { min: 0.9, max: 1.12 };
  return [
    '[하네스 계약]',
    '엔진이 숫자, 고유명사, 참고문헌, URL, 화자, 구조, 분량을 별도 게이트로 검수한다.',
    `출력 분량은 원문 공백 제외 길이의 ${lp.min}~${lp.max}배 범위를 우선한다.`,
    '검수 대상 요소는 유지하되, 이를 이유로 일반 본문 문장을 원문과 거의 같게 두지 않는다.',
    '사실·구조 보존은 하네스 기준이고, 너의 주 작업은 보존 가능한 일반 문장의 재서술이다.'
  ].join('\n');
}

module.exports = { preservationBlock };
