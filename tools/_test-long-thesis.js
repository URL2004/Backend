// [tools/_test-long-thesis.js] 장문 논문 라우팅 검증(무LLM): 초장문 구조화 논문은 재구성 차단→보존형 유도,
//   구조 없는 장문/짧은 글은 통과(오탐 없음)인지 결정론으로 확인.
const { isLongStructuredThesis, restructureUnfit } = require('../engine/inputrouting');

const filler = '항공 서비스에서 서비스 커뮤니케이션은 고객 만족과 직결되는 핵심 요소로 작용한다. 중국 항공사는 2023년 이후 급격한 노선 확장과 함께 서비스 품질 개선에 투자해 왔으며, 한국 항공사와의 경쟁 구도에서 가격과 정시성 양면의 우위를 확보하려 한다. '.repeat(40);

// 실측 케이스형: 로마숫자 대제목 + 학술 섹션 + 초장문(공백제외 14,000자+)
const thesis = `중국 항공사의 서비스 커뮤니케이션 전략과 한국 항공사의 경쟁력 강화 방안
항공서비스학과 20240224 홍길동

국문 초록
본 연구는 항공 서비스 커뮤니케이션을 중심으로 한·중 항공사를 비교 분석한다.

Ⅰ. 서론
${filler}
Ⅱ. 항공 서비스와 서비스 커뮤니케이션 개념
${filler}
Ⅲ. 중국 항공사 전략 분석
${filler}
Ⅳ. 한국 항공사의 현황 및 중국 항공사 대비 비교 분석
${filler}
Ⅴ. 한국 항공사의 경쟁력 강화 방안
${filler}
Ⅵ. 결론
${filler}
참고문헌
김철수(2023), 항공서비스론.`;

// 구조 없는 장문(로마숫자·목차 표지 없음) — 사실밀집 글도 막지 않는다는 결정 존중 → 통과
const longPlain = ('디지털 전환이 가속되면서 기업의 경영 환경은 빠르게 바뀌고 있다. 데이터 기반 의사결정이 보편화되고, 고객 경험의 중요성이 커졌다. ' .repeat(160));

const cases = [
  { name: '초장문 구조화 논문(로마숫자·초록·참고문헌)', text: thesis, expect: true },
  { name: '구조 없는 장문 칼럼(목차·로마숫자 없음)', text: longPlain, expect: false },
  { name: '짧은 구조화 글(14,000자 미만)', text: 'Ⅰ. 서론\n짧은 글입니다.\nⅡ. 결론\n끝.', expect: false },
];

// ※ 장문 논문은 restructureUnfit(보존형 막다른 길)으로 막지 않는다 — 우회(피하기) 유지를 위해 transform이
//   청크 기반 격식 회피로 라우팅. 따라서 isLongStructuredThesis=true 이지만 restructureUnfit unfit=false 여야 한다.
let fail = 0;
for (const c of cases) {
  const noSp = c.text.replace(/\s+/g, '').length;
  const isThesis = isLongStructuredThesis(c.text);
  const ru = restructureUnfit(c.text, {});
  const ok = isThesis === c.expect && ru.unfit === false;   // 논문이어도 보존형으로 안 막힘(피하기 유지)
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'} ${c.name} (공백제외 ${noSp}자)`);
  console.log(`   isLongStructuredThesis=${isThesis} → ${isThesis ? '청크 회피 라우팅' : '일반 경로'}  ·  restructureUnfit=${ru.unfit}`);
}
console.log(fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`);
process.exit(fail === 0 ? 0 : 1);
