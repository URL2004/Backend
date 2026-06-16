// [tools/_test-dup-input.js] (A) 검증(무LLM): 중복 입력 감지(detectInputDuplication)가 두 번 붙여넣은
//   문서는 잡고, 정상 글·짧은 반복구는 통과시키는지 결정론으로 확인한다.
const { detectInputDuplication } = require('../engine/inputrouting');

// 6개 distinct 문단(각 40~60자)
const base = [
  '약사는 국민 건강을 지키는 중요한 보건의료 전문가로서 의약품 사용의 안전성을 관리하는 역할을 한다.',
  '좋은 약사의 출발점은 약동학과 약력학, 약물 상호작용과 부작용을 이해하는 탄탄한 전문지식이다.',
  '환자 중심 접근은 치료의 중심이 의료진이 아니라 환자에게 있어야 한다는 의미를 담고 있다.',
  '직업윤리와 책임성은 조제 실수가 환자의 피해로 이어질 수 있기 때문에 매우 중요하게 강조된다.',
  '다학제 팀에서 약사는 약물치료의 전문가로서 다른 직종의 관점을 존중하며 협업해야 한다.',
  '미래 사회에서는 디지털 헬스케어와 인공지능의 발전으로 약사의 역할이 더욱 중요해질 것이다.'
].join('\n\n');

const duplicated = base + '\n\n' + base;                 // 통째 2회 반복(=실측 약사 리포트 케이스)
const normal = base;                                     // 정상(중복 없음)
const refrain = base + '\n\n약사는 국민 건강을 지킨다.';   // 짧은 한 줄만 추가(중복 아님)

const cases = [
  { name: '중복 입력(문서 2회 붙여넣기)', text: duplicated, expect: true },
  { name: '정상 입력(중복 없음)', text: normal, expect: false },
  { name: '짧은 추가 한 줄(중복 아님)', text: refrain, expect: false },
];

let fail = 0;
for (const c of cases) {
  const r = detectInputDuplication(c.text);
  const ok = r.duplicated === c.expect;
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'} ${c.name} → duplicated=${r.duplicated} ratio=${r.ratio}`);
}
console.log(fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`);
process.exit(fail === 0 ? 0 : 1);
