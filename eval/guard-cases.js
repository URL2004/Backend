// [eval/guard-cases.js] FLOOR 가드 결정론 라벨 케이스 (LLM 없음)
// ────────────────────────────────────────────────────────────────
// 각 케이스: { name, mode, input, output, expect }
//   expect.noveltyHas   : output에서 검출돼야 하는 신규사실 토큰들(부분 포함 검사)
//   expect.noveltyCount0: true면 novelty 0이어야 함(오탐 검사 — FP)
//   expect.povDrift     : true=화자 드리프트여야, false=보존이어야
//   expect.fakeRefHas   : thesis 허위참조로 검출돼야 하는 토큰들
//   expect.fakeRefCount0: true면 허위참조 0이어야 함
//   expect.lengthStatus : 'ok' | 'overSoft' | 'overHard' | 'short'
// recall = 잡아야 할 위반을 잡았나, FP = 안 잡아야 할 걸 잡았나(오탐).

module.exports = [
  // ── novelty: 양성(잡아야) ──
  {
    name: 'novelty/연도·%·기관명 주입',
    mode: 'assignment',
    input: '오래된 건물이 많고 상당수가 노후화됐다.',
    output: '1931년 엠파이어스테이트가 세워졌고, EPA에 따르면 70%가 노후화됐으며 대한상공회의소가 조사했다.',
    expect: { noveltyHas: ['1931', '70%', '대한상공회의소'] }
  },
  {
    name: 'novelty/숫자+단위·약어·인명 주입(thesis baseline형)',
    mode: 'thesis',
    input: '소셜미디어 사용이 학업 집중도에 미치는 영향을 살펴본다.',
    output: 'Twenge 연구는 하루 96회 알림과 300분 사용을 보고했고 ESM 측정이 필요하다.',
    expect: { noveltyHas: ['96회', '300분', 'ESM', 'Twenge'] }
  },
  // ── novelty: 음성(오탐 금지 = FP 검사) ──
  {
    name: 'novelty/한국어만·하나를·문제가 오탐 금지',
    mode: 'assignment',
    input: '관계의 깊이가 얕아질 수 있다.',
    output: '두 방식 중 하나를 골라야 하는 문제가 언제가 될지 모른다.',
    expect: { noveltyCount0: true }
  },
  {
    name: 'novelty/입력에 있던 수치는 유지해도 신규 아님',
    mode: 'assignment',
    input: '2020년에 시작한 프로젝트로 30% 성장했다.',
    output: '2020년 시작한 그 프로젝트는 30% 성장을 이뤘다.',
    expect: { noveltyCount0: true }
  },

  {
    name: 'novelty/영어 문장 첫 대문자 오탐 금지',
    mode: 'assignment',
    input: 'Most people call it an art. We reverse-engineered a method.',
    output: 'Finding it feels like art. But we built a method. So the odds improve.',
    expect: { noveltyCount0: true }
  },
  {
    name: 'novelty/영어 신규 ALLCAPS 약어 검출',
    mode: 'thesis',
    input: 'We backed many companies early.',
    output: 'We backed many companies and later filed with the SEC after an NDA.',
    expect: { noveltyHas: ['SEC', 'NDA'] }
  },

  // ── pov: 양성(드리프트 잡아야) ──
  {
    name: 'pov/비인칭 원문 → 1인칭 일화 주입',
    mode: 'assignment',
    input: '디지털 기술은 관계의 깊이를 얕게 만들 수 있다.',
    output: '지난 학기에 저는 단톡방에서 수십 건을 주고받았지만 룸메이트와는 말을 안 했다.',
    expect: { povDrift: true }
  },
  // ── pov: 음성(보존이어야) ──
  {
    name: 'pov/비인칭 유지 — 하나를 오탐 금지',
    mode: 'assignment',
    input: '디지털 기술은 관계의 깊이를 얕게 만들 수 있다.',
    output: '디지털 기술은 두 방식 중 하나를 고르게 만들며 관계의 밀도를 바꾼다.',
    expect: { povDrift: false }
  },

  // ── thesis 허위 내부참조: 양성 ──
  {
    name: 'fakeRef/Table·Eq·인용·p값 주입',
    mode: 'thesis',
    input: '사용 맥락에 따라 효과가 달라질 수 있다.',
    output: '결과는 Table 1과 Eq. 4에 제시되며 (Smith, 2023) p < .05 수준에서 유의했다.',
    expect: { fakeRefHas: ['table 1', 'eq. 4'] }
  },
  // ── thesis 허위 내부참조: 음성(입력에 있던 참조는 유지 OK) ──
  {
    name: 'fakeRef/입력에 있던 Table 1은 유지해도 위반 아님',
    mode: 'thesis',
    input: '분석 결과는 Table 1에 정리했다.',
    output: 'Table 1에 정리한 분석 결과를 보면 경향이 뚜렷하다.',
    expect: { fakeRefCount0: true }
  },

  // ── soft drift (cheap risk detector): 양성 ──
  {
    name: 'soft/미래전망+불확실 추가(보고서 예시)',
    mode: 'assignment',
    input: '꾸준히 기록하고 싶다.',
    output: '6개월 후 몸이 어떻게 반응할지 모르겠다.',
    expect: { softFlagged: true, softHas: ['future', 'uncertainty'] }
  },
  {
    name: 'soft/영어 reaction+future+uncertainty',
    mode: 'assignment',
    input: 'Keep a record of the process.',
    output: 'Honestly, in the future who knows how it turns out.',
    expect: { softFlagged: true }
  },
  // ── soft drift: 음성(오탐 금지) ──
  {
    name: 'soft/마커 추가 없음 → flag 안 함',
    mode: 'assignment',
    input: '기술이 사회를 바꾼다. 사람들은 적응한다.',
    output: '기술은 사회를 빠르게 바꾼다. 사람들은 그에 적응해 간다.',
    expect: { softFlagged: false }
  },
  {
    name: 'soft/원문에 이미 있던 감정은 추가 아님',
    mode: 'blog',
    input: '솔직히 그때 좀 무서웠다.',
    output: '솔직히 그 순간이 꽤 무서웠다.',
    expect: { softFlagged: false }
  },

  // ── length: 모드별 상태 ──
  {
    name: 'length/thesis 과확장 hard',
    mode: 'thesis',
    input: '가나다라마바사아자차카타파하가나다라마바사아자차카타파하', // 28자
    output: '가나다라마바사아자차카타파하'.repeat(5),                  // ~140자 → ~5x
    expect: { lengthStatus: 'overHard' }
  },
  {
    name: 'length/정상 범위',
    mode: 'thesis',
    input: '가나다라마바사아자차카타파하가나다라마바사아자차카타파하',
    output: '가나다라마바사아자차카타파하가나다라마바사아자차카타파하나',
    expect: { lengthStatus: 'ok' }
  }
];
