// [eval/judge-cases.js] semanticJudge held-out 라벨 세트 (LLM 평가용)
// ────────────────────────────────────────────────────────────────
// ★ 튜닝에 쓴 예시(만자·essay·judge-test)와 겹치지 않는 새 글들 — 과적합 측정용.
// 각 케이스: { name, mode, lang, source, output, expectPass }
//   expectPass=true  : 충실한 의역 → judge가 통과시켜야(통과 못하면 FP=오탐)
//   expectPass=false : 날조/왜곡 → judge가 잡아야(못 잡으면 FN=놓침)

module.exports = [
  // ── 충실한 출력 (expect pass) — 동의어·어순·hedge 유지 의역 ──
  {
    name: 'faithful/assignment 복습',
    mode: 'assignment', lang: 'ko',
    source: '꾸준한 복습은 기억을 오래 유지하는 데 도움이 된다. 한 번에 몰아서 공부하는 것보다 나눠서 반복하는 편이 효과적이다.',
    output: '복습을 꾸준히 하면 배운 것을 더 오래 기억할 수 있다. 한꺼번에 몰아 공부하기보다 여러 번 나눠 반복하는 쪽이 효과가 좋다.',
    expectPass: true
  },
  {
    name: 'faithful/blog 카페',
    mode: 'blog', lang: 'ko',
    source: '동네에 새로 생긴 카페에 다녀왔다. 커피는 평범했지만 분위기가 차분해서 좋았다.',
    output: '집 근처에 새로 문 연 카페에 가봤어요. 커피 맛은 그냥 무난했는데, 공간이 차분해서 마음에 들었어요.',
    expectPass: true
  },
  {
    name: 'faithful/thesis 수면',
    mode: 'thesis', lang: 'ko',
    source: '수면 부족은 집중력 저하와 연관될 수 있다. 다만 개인차가 크다는 점을 고려해야 한다.',
    output: '수면이 부족하면 집중력이 떨어지는 것과 관련될 수 있다. 단, 개인별 편차가 크다는 점은 함께 고려되어야 한다.',
    expectPass: true
  },

  // ── 날조/왜곡 출력 (expect fail) ──
  {
    name: 'fab/외부 통계·기관 날조',
    mode: 'assignment', lang: 'ko',
    source: '운동은 건강에 도움이 된다. 많은 사람들이 운동을 시작하지만 꾸준히 이어가기는 어렵다.',
    output: '운동은 건강에 도움이 된다. 2021년 보건복지부 조사에 따르면 성인의 68퍼센트가 한 달 안에 운동을 그만둔다.',
    expectPass: false
  },
  {
    name: 'fab/의도 역전(긍정→포기)',
    mode: 'assignment', lang: 'ko',
    source: '나는 이 일을 끝까지 해내고 싶다. 어렵더라도 포기하지 않을 생각이다.',
    output: '나는 이 일을 끝까지 해낼 수 있을지 모르겠다. 너무 어려워서 곧 포기하게 될 것 같다.',
    expectPass: false
  },
  {
    name: 'fab/감정+미래전망 주입',
    mode: 'thesis', lang: 'ko',
    source: '인공지능 기술은 여러 산업에 활용되고 있다. 그 영향은 분야마다 다르게 나타난다.',
    output: '인공지능 기술은 여러 산업에 활용되고 있다. 솔직히 나는 이 변화가 두렵다. 머지않아 대부분의 일자리가 사라질 것이다.',
    expectPass: false
  }
];
