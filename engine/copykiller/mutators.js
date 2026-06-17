'use strict';
// [engine/copykiller/mutators.js] 무API 결정론 변형기 (P1).
//   카피킬러 "AI형 문체" 태그를 줄이는 표면 변형. 사실/수치/출처를 절대 추가·삭제하지 않는다(rephrase only).
//   ※ 각 변형은 "후보 생성기"일 뿐이다 — 채택은 프록시 재랭킹 + 무날조 가드가 한다(Goodhart 방지).
//   ※ 보수적으로: 명백한 템플릿형 회피 표현만 건드린다. 의미 불확실성이 진짜인 문장은 보존.

// 회피성 헤지 종결 → 단정. (무견해·판단회피 태그 대응)
function hedgeReducer(text) {
  return String(text || '')
    .replace(/다고 볼 수 있다/g, '다')          // 가진다고 볼 수 있다 → 가진다
    .replace(/다고 할 수 있다/g, '다')          // 있다고 할 수 있다 → 있다
    .replace(/것으로 전망된다/g, '것이다')
    .replace(/것으로 예상된다/g, '것이다')
    .replace(/것으로 보인다/g, '것이다')
    .replace(/할 필요가 있다/g, '해야 한다')    // 고려할 필요가 있다 → 고려해야 한다
    .replace(/  +/g, ' ');
}

// 비인칭·간접 서술 완화. (간접화법·비인칭 태그 대응)
function impersonalReducer(text) {
  return String(text || '')
    .replace(/하고자 한다/g, '한다')            // 분석하고자 한다 → 분석한다
    .replace(/하고자 하였다/g, '했다')
    .replace(/보고자 한다/g, '본다')            // 분석해 보고자 한다 → 분석해 본다
    .replace(/본 연구에서는/g, '이 연구에서는')
    .replace(/본 보고서에서는/g, '이 보고서에서는')
    .replace(/본 연구는/g, '이 연구는')
    .replace(/본 보고서는/g, '이 보고서는')
    .replace(/  +/g, ' ');
}

// 등록된 변형기 목록(라벨 → 함수). 래티스가 이걸 조합해 후보를 만든다.
const MUTATORS = {
  hedge: hedgeReducer,
  impersonal: impersonalReducer,
};

module.exports = { hedgeReducer, impersonalReducer, MUTATORS };
