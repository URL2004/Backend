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

  // ── novelty: % 표기 정규화(60%↔60퍼센트 오탐 금지) ──
  {
    name: 'novelty/퍼센트 표기 차이 오탐 금지',
    mode: 'blog',
    input: '쾌적한 습도는 60% 정도다.',
    output: '쾌적한 습도는 60퍼센트 정도예요.',
    expect: { noveltyCount0: true }
  },
  // ── novelty 확장: 브랜드·한글수사·천원·URL·소수 (blind spot 해소) ──
  {
    name: 'novelty/한국 브랜드 주입',
    mode: 'blog',
    input: '여러 회사가 경쟁한다.',
    output: '카카오와 네이버가 경쟁한다.',
    expect: { noveltyHas: ['카카오', '네이버'] }
  },
  {
    name: 'novelty/한글 수사 주입',
    mode: 'assignment',
    input: '효과가 늘었고 사람이 왔다.',
    output: '효과가 세 배 늘고 열 명이 왔다.',
    expect: { noveltyHas: ['세 배', '열 명'] }
  },
  {
    name: 'novelty/천원 단위 금액 주입',
    mode: 'blog',
    input: '가격이 적당하다.',
    output: '가격은 4천~5천원이다.',
    expect: { noveltyHas: ['5천원'] }
  },
  {
    name: 'novelty/URL·소수 주입',
    mode: 'thesis',
    input: '자료를 참고했다. 값이 나왔다.',
    output: 'https://example.com/data 를 참고했고 값은 0.42였다.',
    expect: { noveltyHas: ['example.com', '0.42'] }
  },

  // ── pov: 동사 나다('냄새가 나는')는 1인칭 아님 + 진짜 1인칭 주입은 검출 ──
  {
    name: 'pov/동사 나다 오탐 금지 + 실제 1인칭 주입 검출',
    mode: 'blog',
    input: '냄새가 나는 빨래는 잘 안 마른 것이다. 곰팡이가 생기기도 한다.',
    output: '냄새가 나는 빨래는 잘 안 말랐다는 뜻이에요. 제가 어제 그래서 다시 빨았어요.',
    expect: { povDrift: true }
  },
  {
    name: 'pov/비격식 1인칭(난·내) 주입 검출',
    mode: 'blog',
    input: '습한 날에는 환기가 중요하다. 빨래는 잘 안 마른다.',
    output: '습한 날엔 환기가 중요해요. 난 그래서 늘 창문을 열어두고, 내 방은 항상 건조하게 유지해요.',
    expect: { povDrift: true }
  },
  // ── 손실 가드 (숫자 증발) ──
  {
    name: 'lost/입력 수치 증발 검출',
    mode: 'blog',
    input: '하루 30분 환기하고 습도 60%를 유지하며 수건 3개를 쓴다.',
    output: '환기를 자주 하고 습도를 적당히 유지하세요.',
    expect: { lostHas: ['30분', '60%', '3개'] }
  },
  {
    name: 'lost/수치 보존 시 손실 0',
    mode: 'blog',
    input: '하루 30분 환기하고 습도 60%.',
    output: '하루 30분 정도 환기하고 습도는 60%로 유지해요.',
    expect: { lostCount0: true }
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
