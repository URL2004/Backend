'use strict';

function preservationBlock(lengthPolicy) {
  const lp = lengthPolicy || { min: 0.9, max: 1.12 };
  return [
    '[불변 계약]',
    '숫자, 단위, 기관·고유명사, 참고문헌, URL, 직접 인용, 화자, 제목·목록과 문단의 역할·순서를 보존한다.',
    '문단 구조 보존은 빈 줄 수나 일반 문장 배열을 그대로 복사하라는 뜻이 아니다. V2_BOUNDARY·V2_LINE 같은 잠금 토큰이 없는 일반 산문에서만, 같은 역할·같은 주장 안의 문단 경계와 문장 구조를 재구성할 수 있다.',
    `출력 분량은 원문 공백 제외 길이의 ${lp.min}~${lp.max}배 범위를 우선한다.`,
    '원문에 없는 경험·감정·성과·평가·인과관계를 만들지 않는다.'
  ].join('\n');
}

module.exports = { preservationBlock };
