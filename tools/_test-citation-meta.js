// [tools/_test-citation-meta.js] (A) 검증(무LLM): 인용 날조 감지 + 제출자 메타데이터 제거 회귀(2026-06-17).
//   CSV 100건 감사 실측: genreTransferV2가 근거 빈약 학술글을 부풀리며 가짜 논문·학회지·저자·출처를 주입(#56·#47),
//   제출자 머리말이 가짜 저자 인용으로 둔갑(#97). 둘 다 차단 아닌 재수정/제거로 처리한다.
const ir = require('../engine/inputrouting');

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ❌ ' + m); } else console.log('  ✅ ' + m); };

console.log('=== 인용 날조 감지(원문엔 없고 출력에 주입된 학술인용) ===');
const src = '남강은 남덕유산에서 발원하여 진주시를 지나 낙동강으로 합류하는 하천이다. 남강댐 건설 이후 하류 퇴적 환경이 달라졌을 가능성이 있다.';
const fab = '남강댐은 1969년 준공됐다. 2016년 KISTI 등재 논문에서 유역면적 1,278.30km²를 분석했고, 추태호·채수권(2012)이 한국습지학회지 14권 4호에서 다뤘다(출처: 한국민족문화대백과사전).';
ok(ir.countFabricatedCitations(src, fab) >= 2, `날조 인용 감지 ≥2 (실측 ${ir.countFabricatedCitations(src, fab)}건)`);
// 충실 재작성(인용 없음) → 0
const faithful = '남강은 남덕유산에서 시작해 진주를 거쳐 낙동강으로 흘러든다. 남강댐이 들어선 뒤 하류 퇴적 환경이 바뀌었을 수 있다.';
ok(ir.countFabricatedCitations(src, faithful) === 0, '충실 재작성 → 0');
// 원문에 이미 인용이 있으면(보존) 오탐 0
const citedSrc = '백선희·이승창·이상학, 「항공 마일리지」, 『한국항공운항학회지』, 제22권 제1호, 2014.';
const citedOut = '백선희·이승창·이상학의 『한국항공운항학회지』(2014) 연구가 이를 뒷받침한다.';
ok(ir.countFabricatedCitations(citedSrc, citedOut) === 0, '원문에 있던 인용 보존 → 오탐 0');

console.log('\n=== 고유명사 과반복 감지(#86: 인용 제목 8회 반복) ===');
const repSrc = '지다웨이의 <막>은 1995년, 제17회 롄허보 문학상 중편소설 대상을 받은 작품이다.';
const repOut = '제17회 수상작이다. 제17회 그 작품은. 제17회를 받은. 제17회 위상. 제17회 의미. 제17회 깊이. 제17회 평가. 제17회 가치.';
ok(ir.maxNamedRepeat(repSrc, repOut) >= 5, `과반복 감지 ≥5 (실측 ${ir.maxNamedRepeat(repSrc, repOut)}회)`);
ok(ir.maxNamedRepeat(repSrc, '제17회 롄허보 문학상 대상을 받은 작품이다. 깊은 울림을 준다.') === 0, '정상 1회 언급 → 0(오탐 없음)');

console.log('\n=== 제출자 메타데이터 제거 ===');
const withMeta = "일본 동조압력의 인과관계 제출자:동아시아국제학부 20260423 변정빈\n1. 서론: 일본 사회를 공부하면서...";
const sm = ir.stripSubmitterMeta(withMeta);
ok(sm.changed >= 1 && !sm.text.includes('변정빈') && !sm.text.includes('20260423'), '제출자 머리말 제거(이름·학번 사라짐)');
ok(sm.text.includes('서론') && sm.text.includes('일본 사회를 공부'), '본문 내용은 보존');
// 라벨 없는 학부+학번+이름 삼중
const triple = '환경 보고서 사회학과 20231234 홍길동 오늘날 환경 문제가 심각하다.';
ok(ir.stripSubmitterMeta(triple).changed >= 1, '라벨 없는 학부+학번+이름 제거');
// 연도(4자리)는 학번으로 오인 안 함
const yearOnly = '2024년 환경 보고서를 작성했다. 통계는 2023년 기준이다.';
ok(ir.stripSubmitterMeta(yearOnly).changed === 0, '4자리 연도는 학번 오탐 안 함');

console.log('\n' + (fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`));
process.exit(fail === 0 ? 0 : 1);
