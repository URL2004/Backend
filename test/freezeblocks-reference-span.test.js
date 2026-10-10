'use strict';

// 2026-10-09 운영 점검 F-02 회귀: 참고문헌 표제 뒤를 문서 끝까지 통째로 잠그던 문제.
// 아래 글은 모두 사고 원문과 구조만 같게 지어낸 것이다(사용자 글 아님).

const test = require('node:test');
const assert = require('node:assert/strict');

const freezeBlocks = require('../engine/freezeblocks');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const transform = require('../routes/transform');

function paragraph(topic, n) {
  return `${topic}에 관한 지어낸 본문 ${n}번 문단이다. 먼저 배경을 설명하고 이어서 쟁점을 정리한다. `
    + '관련 기관의 발표와 시민 반응을 차례로 살펴본 뒤, 이 글이 무엇을 다루는지 밝힌다. '
    + '마지막 문장에서는 다음 절로 넘어가는 까닭을 적는다.';
}

function referencesOf(source) {
  return freezeBlocks.detectAcademicSpans(source).filter(span => span.type === 'references');
}

function lineStart(source, line) {
  const at = source.indexOf(line);
  assert.notEqual(at, -1, `줄을 찾지 못함: ${line}`);
  return at;
}

function chunkAt(plan, source, needle) {
  const at = lineStart(source, needle);
  return plan.chunks.find(chunk => chunk.start <= at && at < chunk.end);
}

const MARKDOWN_REPORT = [
  '# 가상 도시의 공유 자전거 요금 개편 논란과 시의 대응',
  '',
  '## 목차',
  '',
  'Ⅰ. 서론',
  '',
  'Ⅱ. 본론',
  '　1. 사례 개요',
  '　2. 진행 과정과 주요 쟁점',
  '　　1) 발생 배경',
  '　　2) 입장 차이',
  '　3. 시민에게 미치는 영향',
  '',
  'Ⅲ. 결론',
  '',
  '참고문헌',
  '',
  '---',
  '',
  '# Ⅰ. 서론',
  '',
  paragraph('공유 자전거 요금', 1),
  '',
  paragraph('공유 자전거 요금', 2),
  '',
  '# Ⅱ. 본론',
  '',
  '## 1. 사례 개요',
  '',
  paragraph('요금 개편안', 3),
  '',
  '## 2. 진행 과정과 주요 쟁점',
  '',
  paragraph('요금 개편안', 4),
  '',
  paragraph('요금 개편안', 5),
  '',
  '# Ⅲ. 결론',
  '',
  paragraph('시의 대응', 6),
  '',
  '---',
  '',
  '## 참고문헌',
  '',
  '[1] 가상시청. (2031. 3. 2.). 「공유 자전거 요금 개편안 설명 자료」.',
  'https://example.invalid/bike/notice-1',
  '',
  '[2] 가상교통연구원. (2031. 5. 11.). 「공유 이동수단 이용 실태」.',
  'https://example.invalid/bike/report-2',
  ''
].join('\n');

test('F-02 표제 없는 목차 안의 참고문헌 한 줄은 문서 끝까지 잠그지 않고, 끝의 실제 목록만 잠근다', () => {
  const source = MARKDOWN_REPORT;
  const spans = referencesOf(source);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, lineStart(source, '## 참고문헌'));
  assert.equal(spans[0].end, source.length);
  assert.ok((spans[0].end - spans[0].start) / source.length < 0.2);

  const bodyAt = lineStart(source, '공유 자전거 요금에 관한 지어낸 본문 1번');
  assert.equal(freezeBlocks.academicSpanAt(freezeBlocks.detectAcademicSpans(source), bodyAt, bodyAt + 20), null);

  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  // 고치기 전에는 19번째 줄부터 문서 끝까지가 reference_item이라 편집 가능한 청크가 0개였다.
  for (let n = 1; n <= 6; n += 1) {
    const body = chunkAt(plan, source, `지어낸 본문 ${n}번 문단이다`);
    assert.ok(body && !body.locked, `본문 ${n}번 문단은 편집 대상이어야 한다: ${body?.lockType}`);
  }
  const editableChars = plan.chunks.filter(chunk => !chunk.locked).reduce((sum, chunk) => sum + chunk.text.length, 0);
  assert.ok(editableChars / source.length > 0.6, `편집 가능 비율 ${editableChars / source.length}`);
  assert.equal(chunkAt(plan, source, '[1] 가상시청')?.lockType, 'reference_item');
  assert.equal(chunkAt(plan, source, 'https://example.invalid/bike/report-2')?.lockType, 'reference_item');
  assert.equal(structureChunk.mergeChunks(plan.chunks), source);

  const assessed = transform.assessEditableContent(source, { mode: 'formal' });
  assert.ok(assessed.editableChunkCount > 0);
});

const ENTRIES = [
  '한가람. (2031). 종이접기를 활용한 아동 놀이 프로그램 기초연구. 가상문화연구, 12(3), 45-68.',
  '한가람. (2033). 종이접기 놀이 프로그램 제안. 가상대학교 석사학위논문.',
  'Dorim, T., & Maru, O. (2025). The joint folding procedure for families: A pilot description. Imaginary Journal of Play, 40(1), 1-12.',
  'Dorim, T., & Maru, O. (2028). Creating together with paper. Imaginary Journal of Play, 43(2), 20-33.'
];

for (const [label, gap] of [['빈 줄 없이', []], ['빈 줄을 두고', ['']]]) {
  test(`F-02 문서 중간 참고문헌 뒤의 본문 절은 잠그지 않는다(${label} 이어지는 경우)`, () => {
    const source = [
      '1. 지원 동기',
      paragraph('지원 동기', 1),
      '',
      '2. 연구 주제',
      paragraph('연구 주제', 2),
      '',
      '참고문헌',
      ...ENTRIES,
      ...gap,
      '3. 졸업 후 계획',
      ...gap,
      paragraph('졸업 후 계획', 3),
      '',
      paragraph('졸업 후 계획', 4),
      '',
      '4. 기타',
      paragraph('그 밖의 사항', 5)
    ].join('\n');
    const spans = referencesOf(source);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].start, lineStart(source, '참고문헌'));
    assert.equal(spans[0].end, lineStart(source, '3. 졸업 후 계획'));

    const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
    for (const entry of ENTRIES) assert.equal(chunkAt(plan, source, entry)?.lockType, 'reference_item');
    assert.equal(chunkAt(plan, source, '3. 졸업 후 계획')?.lockType, 'heading');
    assert.equal(chunkAt(plan, source, '4. 기타')?.lockType, 'heading');
    for (const needle of ['졸업 후 계획에 관한 지어낸 본문 3번', '졸업 후 계획에 관한 지어낸 본문 4번', '그 밖의 사항에 관한 지어낸 본문 5번']) {
      const chunk = chunkAt(plan, source, needle);
      assert.ok(chunk && !chunk.locked, `${needle} 은 편집 대상이어야 한다: ${chunk?.lockType}`);
    }
    assert.equal(structureChunk.mergeChunks(plan.chunks), source);
  });
}

test('F-02 참고문헌 뒤에 붙은 작성 도우미 안내 문단은 서지가 아니므로 구간에 넣지 않는다', () => {
  const source = [
    'Ⅰ. 서론',
    paragraph('보호 연령', 1),
    '',
    'Ⅱ. 본론',
    paragraph('보호 연령', 2),
    paragraph('보호 연령', 3),
    '참고문헌',
    '1. 나도윤, 『가상 범죄심리학』, 가상사, 2034.',
    '2. 서하늘 외, 『청소년 보호의 이해』, 가상사, 2032.',
    '3. 가상국 소년보호법 (가상법령정보센터).',
    '4. 가상복지학회 등, "보호 연령 조정 반대 공동성명서", 2036.',
    '5. 가상신문, "\'보호 연령 조정 논의\'…해결될까", 2036. 3. 16.',
    '💡 분량을 채우기 위한 팁 (가독성 기준 포함):',
    '1. 글자 크기 및 줄 간격: 본문 글자 크기와 줄 간격을 기준에 맞추어 가독성을 높이십시오.',
    '2. 분량 확장: 위 뼈대에 구체적인 사례를 한두 쪽 덧붙이시면 분량을 정확히 채우실 수 있습니다.',
    '3. 그림 추가: 연도별 현황 그래프를 한두 개 넣어 적절한 크기로 배치하세요.'
  ].join('\n');
  const spans = referencesOf(source);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, lineStart(source, '참고문헌'));
  assert.equal(spans[0].end, lineStart(source, '💡 분량을 채우기 위한 팁'));
  const inside = source.slice(spans[0].start, spans[0].end);
  assert.match(inside, /3\. 가상국 소년보호법/u);   // 연도 없는 항목도 목록에 남는다
  assert.doesNotMatch(inside, /가독성을 높이십시오/u);
});

const TAIL_LISTS = {
  '저자(연도) 한국어 목록': [
    '참고문헌',
    '모하람 (2015). 『사람과 장소』. 가상시: 가상과지성사.',
    '',
    '가상대학교 출판문화원 (2021). 『인간과 사회』 교재.',
    '',
    '보르디, 피에르 (1995). 『실천의 이유: 행동의 이론에 관하여』. 임가상 역. 가상시: 동가상.'
  ],
  '대괄호 번호와 확인일 메모': [
    '참고문헌',
    '[1] Imaginary Market Research. Global Puzzle Game Market Size And Forecast. 시장 규모 추정과 전망 범위를 확인하는 데 사용.',
    '[2] Fiction Works, Inc. · Maru Dorim. The Folding of Paper: Rebirth 공식 소개 페이지.',
    '[3] Dorim Maru. Enter Paperland - The Folding Story. 제작 배경 인터뷰.',
    '웹 자료 확인일 2036년 10월 9일  각 출처의 원문 링크로 이동할 수 있음'
  ],
  '로마 숫자 표제와 항목 하나': [
    'Ⅳ. 참고문헌',
    '윤가상 외(2021). 『문화와 배움』(1개정판). 가상방송대학교출판문화원.'
  ],
  '번호 붙은 표제와 괄호 번호 항목': [
    '3. 참고 문헌',
    '1) 권가상 (2010). 균형 능력 예측을 위한 네 칸 걷기 검사의 타당도. 가상물리치료학회지, 22(1), 15-22.',
    '',
    '2) 이가상, 황가상, 류가상 (2023). 골반 동작 촉진이 몸통 조절에 미치는 영향. 가상재활과학, 8(2), 30-41.'
  ],
  '불릿 항목과 줄이 넘어간 권호': [
    '5. 참고문헌',
    '• 이가람, 유도윤 (2024). 영유아 교수 방법론. 가상방송대학교 출판문화원.',
    '• 가상교육부 (2019). 2019 개정 놀이 과정 해설서. 가상교육부.',
    '• 임나래 (2022). 유아 주도 놀이 중심 과정의 현장 적용 연구. 가상유아교육연구,',
    '26(3), 45-68.'
  ],
  '쉼표로 잇는 목록': [
    '참고문헌',
    '1. 김가상. (2023). "요인 보호의 문제점과 개선 방안". 가상경호학회지, 14(2), 1-20.',
    '2. 이가상. (2021). 『현대 경호학 개론』. 가상시: 가상사.',
    '3. 가상경찰대학. (2020). 『경호 실무와 전술』. 가상경찰대학 출판부.'
  ]
};

for (const [label, list] of Object.entries(TAIL_LISTS)) {
  test(`F-02 문서 끝의 실제 참고문헌 목록은 종전처럼 끝까지 보존한다: ${label}`, () => {
    const source = [
      '1. 서론',
      paragraph('연구 배경', 1),
      '',
      '2. 본론',
      paragraph('연구 내용', 2),
      paragraph('연구 내용', 3),
      '',
      '3. 결론',
      paragraph('연구 결과', 4),
      '',
      ...list
    ].join('\n');
    const spans = referencesOf(source);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].start, lineStart(source, list[0]));
    assert.equal(spans[0].end, source.length);
    const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
    for (const line of list.filter(Boolean)) {
      assert.equal(chunkAt(plan, source, line)?.lockType, 'reference_item', line);
    }
    assert.equal(structureChunk.mergeChunks(plan.chunks), source);
  });
}

test('F-02 표제가 둘이면 서지가 뒤따르는 마지막 목록을 고르고, 앞 목록 뒤 본문은 잠그지 않는다', () => {
  const tail = ['3. 참고 문헌', '1) 권가상 (2010). 네 칸 걷기 검사의 타당도. 가상물리치료학회지, 22(1), 15-22.'];
  const source = [
    '<사례 정리>',
    paragraph('사례', 1),
    ' 참고 문헌 :',
    '1) 권가상 (2010). 네 칸 걷기 검사의 타당도. 가상물리치료학회지, 22(1), 15-22.',
    '',
    '3. 우선순위 중재 및 이론적 근거',
    `- 중재: ${paragraph('중재', 2)}`,
    `- 이론적 근거: ${paragraph('근거', 3)}`,
    '',
    '<비교 및 성찰>',
    paragraph('성찰', 4),
    '',
    ...tail
  ].join('\n');
  const spans = referencesOf(source);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, source.lastIndexOf('3. 참고 문헌'));
  assert.equal(spans[0].end, source.length);
  const bodyAt = lineStart(source, '- 중재:');
  assert.equal(freezeBlocks.academicSpanAt(spans, bodyAt, bodyAt + 10), null);
});

test('F-02 서지가 뒤따른 목록을 서지 없는 꼬리 표제 한 줄로 바꾸지 않는다', () => {
  const source = [
    paragraph('도입', 1),
    paragraph('도입', 2),
    '',
    '참고문헌',
    ...ENTRIES,
    '',
    '출처'
  ].join('\n');
  const spans = referencesOf(source);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, lineStart(source, '참고문헌'));
  assert.equal(spans[0].end, source.length);
});

test('F-02 참고문헌 안의 분류 소제목·짧은 주석·안내 문장은 목록에 남긴다', () => {
  const list = [
    '참고문헌',
    '이 보고서를 쓰면서 아래 자료를 참고하였다.',
    '1. 국내 문헌',
    '김가람 (2030). 도시 텃밭 연구. 가상출판.',
    '→ 텃밭 운영 사례를 다룬다.',
    '이나래 (2031). 마을 배움터 연구. 가상출판.',
    '참고 자료',
    'https://example.invalid/garden/a',
    '2. 국외 문헌',
    'Garam, K. (2029). Imaginary gardens. Fiction Press.'
  ];
  const source = [paragraph('텃밭', 1), paragraph('텃밭', 2), paragraph('텃밭', 3), '', ...list].join('\n');
  const spans = referencesOf(source);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, lineStart(source, '참고문헌'));
  assert.equal(spans[0].end, source.length);
});

test('F-02 제목이 문장으로 된 문헌 항목을 본문으로 오인하지 않는다', () => {
  const list = [
    '참고문헌',
    '김가람, 「우리는 그렇게 배웠다. 그리고 잊었다」, 가상출판, 2015.',
    '이나래 (2031). 나는 왜 쓰는가를 다시 물었다. 가상출판.',
    '가상일보, "아이들은 어디로 갔을까?", 2034. 3. 1.'
  ];
  const source = [paragraph('글쓰기', 1), paragraph('글쓰기', 2), paragraph('글쓰기', 3), '', ...list].join('\n');
  const spans = referencesOf(source);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].end, source.length);
});

test('F-02 연도 없는 항목뿐인 꼬리 목록과 맺음말 한 줄은 종전처럼 끝까지 잠근다', () => {
  for (const closing of [[], ['', '이상으로 보고서를 마칩니다. 읽어 주셔서 감사합니다.']]) {
    const source = [
      paragraph('수업', 1), paragraph('수업', 2), paragraph('수업', 3), '',
      '참고 자료', '가상대학교 교양 교재', '강의 자료 3주차', '가상 지식백과, 지어낸 항목',
      ...closing
    ].join('\n');
    const spans = referencesOf(source);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].start, lineStart(source, '참고 자료'));
    assert.equal(spans[0].end, source.length);
  }
});

test('F-02 본문 속 소제목 "출처" 뒤에 산문이 길게 오면 참고문헌으로 보지 않는다', () => {
  for (const before of [1, 6]) {   // 표제가 문서 앞쪽에 있을 때와 뒤쪽(40% 이후)에 있을 때
    const source = [
      ...Array.from({ length: before }, (_, index) => paragraph('도입', index + 1)), '',
      '출처',
      ...Array.from({ length: 5 }, (_, index) => paragraph('사진', index + 11))
    ].join('\n');
    assert.deepEqual(referencesOf(source), [], `앞 문단 ${before}개`);
    const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
    assert.ok(plan.chunks.some(chunk => !chunk.locked && /사진에 관한 지어낸 본문 15번/u.test(chunk.text)));
  }
});

test('F-02 출처를 문장으로 적은 짧은 꼬리 목록은 종전처럼 끝까지 잠근다', () => {
  const lists = [
    ['참고자료', '- 가상통계포털: 인구 통계를 확인하였다.', '- 가상교육부 보도자료: 정책 방향을 참고하였다.', '- 가상 지식백과: 용어 정의를 참고하였다.'],
    ['참고자료',
      '- 가상통계포털(https://example.invalid/stat): 인구 통계를 확인하였다.',
      '- 가상교육부 보도자료 https://example.invalid/news 를 참고하였다.',
      '- 가상 지식백과 www.example.invalid/wiki 에서 용어 정의를 확인하였다.',
      '- 가상신문, "아이들은 어디로 갔다." (2034. 3. 1.)']
  ];
  for (const list of lists) {
    const source = [paragraph('조사', 1), paragraph('조사', 2), paragraph('조사', 3), '', ...list].join('\n');
    const spans = referencesOf(source);
    assert.equal(spans.length, 1, list[1]);
    assert.equal(spans[0].start, lineStart(source, '참고자료'));
    assert.equal(spans[0].end, source.length);
  }
});

test('F-02 문서 앞쪽의 표제는 서지가 구간의 절반 이상일 때만 인정한다', () => {
  const body = Array.from({ length: 8 }, (_, index) => paragraph('일정', index + 1));
  // 표제 없는 목차의 한 줄 뒤에 개조식 목록이 오고 그중 한 줄이 연도로 끝나도 참고문헌이 아니다.
  const outline = [
    '보고서 제목', '1. 개요', '2. 일정', '참고문헌', '',
    '# 1. 개요', '- 조사 대상 선정', '- 1차 조사, 2031.', '- 결과 정리', '- 발표 준비', '',
    '# 2. 일정', ...body
  ].join('\n');
  assert.deepEqual(referencesOf(outline), []);

  // 문서 앞쪽에 놓인 실제 목록은 잠그되 뒤따르는 본문 앞에서 끝낸다.
  const early = ['읽기 자료', '참고문헌', ENTRIES[0], ENTRIES[1], '', '1. 감상', ...body].join('\n');
  const spans = referencesOf(early);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, lineStart(early, '참고문헌'));
  assert.equal(spans[0].end, lineStart(early, '1. 감상'));
});

test('F-02 본문이 "저자(연도)에 따르면"으로 시작해도 목차의 참고문헌 줄을 표제로 인정하지 않는다', () => {
  const source = [
    '보고서 제목', '1. 서론', '2. 본론', '참고문헌', '',
    '1. 서론',
    '김가람(2030)에 따르면 도시 텃밭은 이웃 관계를 되살린다. 이 글은 그 주장을 지어낸 사례로 검토한다.',
    paragraph('텃밭', 2),
    paragraph('텃밭', 3)
  ].join('\n');
  assert.deepEqual(referencesOf(source), []);
});

test('F-02 부록 표제에서 끊는 동작과 목차 안 표제 제외는 그대로다', () => {
  const withAppendix = [
    paragraph('조사', 1), paragraph('조사', 2), paragraph('조사', 3), '',
    '참고문헌', ENTRIES[0], '', '부록 A', paragraph('부록', 4)
  ].join('\n');
  const appendixSpans = referencesOf(withAppendix);
  assert.equal(appendixSpans.length, 1);
  assert.equal(appendixSpans[0].end, lineStart(withAppendix, '부록 A'));

  const withToc = [
    '목차', '1. 서론', '2. 본론', '3. 참고문헌', '',
    '1. 서론', paragraph('조사', 1), '', '2. 본론', paragraph('조사', 2), '',
    '3. 참고문헌', ENTRIES[0], ENTRIES[1]
  ].join('\n');
  const spans = freezeBlocks.detectAcademicSpans(withToc);
  assert.deepEqual(spans.map(span => span.type), ['toc', 'references']);
  assert.equal(spans[1].start, withToc.lastIndexOf('3. 참고문헌'));
  assert.equal(spans[1].end, withToc.length);
});

test('F-02 Markdown·굵은 표제는 구간 탐지에서만 받아들이고 isRefHeadingLine 판정은 바꾸지 않는다', () => {
  assert.equal(freezeBlocks.isRefHeadingLine('## 참고문헌'), false);
  assert.equal(freezeBlocks.isRefHeadingLine('**참고문헌**'), false);
  for (const heading of ['## 참고문헌', '**참고문헌**', '### References']) {
    const source = [paragraph('표제', 1), paragraph('표제', 2), paragraph('표제', 3), '', heading, '', ...ENTRIES].join('\n');
    const spans = referencesOf(source);
    assert.equal(spans.length, 1, heading);
    assert.equal(spans[0].start, lineStart(source, heading), heading);
    assert.equal(spans[0].end, source.length, heading);
  }
});

test('F-02 CRLF 원문에서도 구간 끝이 줄 머리에 놓이고 청크를 합치면 원문이 된다', () => {
  const source = [
    '1. 지원 동기', paragraph('지원 동기', 1), '',
    '참고문헌', ...ENTRIES, '',
    '3. 졸업 후 계획', paragraph('졸업 후 계획', 2), paragraph('졸업 후 계획', 3)
  ].join('\r\n');
  const spans = referencesOf(source);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].end, lineStart(source, '3. 졸업 후 계획'));
  const plan = structureChunk.splitChunksForGpt(source, { coalesceEditable: true });
  const body = chunkAt(plan, source, '졸업 후 계획에 관한 지어낸 본문 2번');
  assert.ok(body && !body.locked);
  assert.equal(structureChunk.mergeChunks(plan.chunks), source);
});

test('F-02 referenceLineFlags는 줄 단위로 구간 탐지와 같은 판정을 돌려준다', () => {
  const lines = [
    '보고서 제목', '1. 서론', '참고문헌', '',                 // 표제 없는 목차 안의 한 줄: 구간 아님
    '1. 서론', paragraph('조사', 1), paragraph('조사', 2), '',
    '참고문헌', ENTRIES[0], ENTRIES[1], '',
    '2. 덧붙임', paragraph('덧붙임', 3), paragraph('덧붙임', 4)
  ];
  const source = lines.join('\n');
  const flags = freezeBlocks.referenceLineFlags(source);
  assert.equal(flags.length, lines.length);
  const inside = lines.map((line, index) => (flags[index] ? index : -1)).filter(index => index >= 0);
  // 실제 목록의 표제·항목 두 줄·뒤따르는 빈 줄만 구간 안이다.
  assert.deepEqual(inside, [8, 9, 10, 11]);
  assert.deepEqual(freezeBlocks.referenceLineFlags('참고문헌 없이 끝나는 짧은 글이다.'), [false]);
});

test('F-02 참고문헌 목록만 붙여 넣은 글은 여전히 변환할 본문이 없고, 잠금이 차지한 글자 비율이 남는다', () => {
  const source = ['참고문헌', ...ENTRIES, ...ENTRIES.map(line => line.replace('(20', '(21'))].join('\n');
  const assessed = transform.assessEditableContent(source, { mode: 'formal' });
  assert.equal(assessed.editableChunkCount, 0);
  assert.equal(assessed.dominantLockType, 'reference_item');
  assert.ok(assessed.dominantLockShare > 0.9, String(assessed.dominantLockShare));
  assert.equal(assessed.lockCharShare.reference_item, assessed.dominantLockShare);

  const mixed = transform.assessEditableContent(MARKDOWN_REPORT, { mode: 'formal' });
  assert.ok(mixed.editableChunkCount > 0);
  assert.ok(mixed.lockCharShare.reference_item < 0.2, JSON.stringify(mixed.lockCharShare));
  const total = Object.values(mixed.lockCharShare).reduce((sum, value) => sum + value, 0);
  assert.ok(total < 0.5, `잠금 비율 합 ${total}`);
});
