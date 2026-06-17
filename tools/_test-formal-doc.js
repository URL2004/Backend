// [tools/_test-formal-doc.js] 격식문서 감지 회귀(2026-06-17, #21·#83·#72·#90): 보고서·계약서·실험·논문은
//   기본 피하기에서 고급으로 안내(true), 캐주얼 블로그·일반 칼럼은 오탐 없이 통과(false).
const { isFormalDocument } = require('../engine/inputrouting');

let fail = 0;
const ok = (cond, m) => { if (!cond) { fail++; console.log('  ❌ ' + m); } else console.log('  ✅ ' + m); };

console.log('=== 격식문서 → true ===');
ok(isFormalDocument('제1조 (목적) 본 계약은 갑과 을 사이의... 제2조 (정의) ...') === true, '계약서(제N조·갑과 을)');
ok(isFormalDocument('연구 가설: A는 B에 영향을 준다. 실험 방법은 다음과 같다. 대조군과 비교한 측정 결과를 표 1에 정리했다.') === true, '실험보고서(가설·실험방법·표)');
ok(isFormalDocument('Ⅰ. 서론\n본 연구는... Ⅱ. 본론\n... 참고문헌\n홍길동(2021), 김철수(2020) 참조 (홍길동, 2021)') === true, '논문(로마목차·참고문헌·인용)');
ok(isFormalDocument('합의서\n본 협약서는 양측의 합의에 따라 작성한다. 갑은 을에게...') === true, '합의서/협약서');

console.log('\n=== 캐주얼/일반 → false(오탐 없음) ===');
ok(isFormalDocument('오늘 영화를 봤어요. 정말 재밌었거든요. 결론은 꼭 보세요! 표정이 인상적이었어요.') === false, '영화 후기 블로그');
ok(isFormalDocument('정부 부동산 대책은 공급 확대에 방점을 찍었다. 결국 시장이 묻는 것은 입지다.') === false, '일반 시사 칼럼');
ok(isFormalDocument('여행 다녀왔어요. 김작가, 2023년에 추천한 카페가 정말 좋더라고요.') === false, '인용 1개 캐주얼(임계값 미만)');

console.log('\n' + (fail === 0 ? '── 전체 통과 ──' : `── ${fail}건 실패 ──`));
process.exit(fail === 0 ? 0 : 1);
