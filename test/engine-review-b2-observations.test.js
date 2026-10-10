'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const endingStyle = require('../engine-gpt-prod/endingStyleAudit');
const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const discourse = require('../engine-gpt-prod/discourseAudit');
const humanizationDepth = require('../engine-gpt-prod/humanizationDepth');

// 2026-10-09 점검에서 엔진이 못 보던 손상을 재는 관측값. 기록만 하고 경고·재시도·
// 전달 상태에 연결하지 않는다. 모두 원문·결과 두 문자열만 받는 순수 함수다.

const LONG_PAST = [
  '실험 장비를 준비하였다.', '시약을 계량하였다.', '온도를 기록하였다.', '결과를 표로 정리하였다.',
  '오차 원인을 검토하였다.', '보고서 초안을 작성하였다.', '동료와 결과를 비교하였다.', '최종 수치를 확인하였다.',
  '그래프를 다시 그렸으며 축을 수정하였다.', '참고 문헌을 정리하였다.'
];

test('하였다체 원문이 하였다·했다 반반으로 돌아오면 변이형 혼용 순증을 기록한다', () => {
  const source = LONG_PAST.join(' ');
  const output = LONG_PAST.map((sentence, index) => (index % 2 ? sentence.replace('하였다', '했다') : sentence)).join(' ');
  const report = endingStyle.measureEndingVariantMix(source, output);
  assert.equal(report.pastVariant.source.long, 10);
  assert.equal(report.pastVariant.source.short, 0);
  assert.equal(report.pastVariant.output.long, 5);
  assert.equal(report.pastVariant.output.short, 5);
  assert.equal(report.pastVariant.introducedMixShare, 0.5);
  assert.equal(report.register.introducedMixShare, 0);
  assert.equal(report.mixIntroduced, 0.5);

  const same = endingStyle.measureEndingVariantMix(source, source);
  assert.equal(same.mixIntroduced, 0);
  assert.equal(same.pastVariant.dominantFlipped, false);

  // 표본이 넷 미만이면(2:0→1:1) 비율을 내지 않고 개수만 남긴다.
  const tiny = endingStyle.measureEndingVariantMix(
    '장비를 준비하였다. 시약을 계량하였다. 오늘은 날씨가 좋다.',
    '장비를 준비하였다. 시약을 계량했다. 오늘은 날씨가 좋다.'
  );
  assert.equal(tiny.pastVariant.output.short, 1);
  assert.equal(tiny.pastVariant.enoughEvidence, false);
  assert.equal(tiny.mixIntroduced, 0);
});

test('한다체 절 일부만 합니다체로 바뀌면 절 단위 격식 혼용 순증을 기록한다', () => {
  const plain = ['놀이는 유아의 발달을 돕는다.', '교사는 환경을 준비한다.', '관찰 기록은 매일 남긴다.', '평가는 과정 중심으로 한다.', '부모와도 결과를 나눈다.'];
  const polite = ['놀이는 유아의 발달을 돕습니다.', '교사는 환경을 준비합니다.', '관찰 기록은 매일 남깁니다.', '평가는 과정 중심으로 합니다.', '부모와도 결과를 나눕니다.'];
  const source = ['1. 이론', ...plain, '2. 계획안', ...polite].join('\n');
  const output = ['1. 이론', ...plain, '2. 계획안', plain[0], plain[1], ...polite.slice(2)].join('\n');
  const report = endingStyle.measureEndingVariantMix(source, output);
  assert.ok(report.sectionMaxRegisterMixIntroduced >= 0.3, JSON.stringify(report));
  assert.ok(report.mixIntroduced >= 0.3);
  assert.equal(endingStyle.pastVariantOf('모두 준비하였습니다.'), 'long');
  assert.equal(endingStyle.pastVariantOf('모두 준비했습니다.'), 'short');
  assert.equal(endingStyle.pastVariantOf('모두 준비한다.'), '');
});

test('자동사 그치다·머물다에 목적어나 추상명사 주어가 붙은 꼴만 순증으로 센다', () => {
  const source = '정책이 문서상 존재에 그친다. 노력을 기울이는 데 그치지 않고 실행으로 옮겼다. 이 책은 자기계발서가 아니다.';
  const output = [
    '정책이 문서상 존재에 그친다.',
    '노력을 기울이는 데 그치지 않고 실행으로 옮겼다.',
    '조직문화 조사 결과를 보고서 작성에만 그친다면 개선 효과를 기대하기 어렵다.',
    '이 책의 가치는 단순한 자기계발서에 머물지 않고 교양서라는 데 있다.'
  ].join(' ');
  const report = koreanRefinement.countObjectMarkedIntransitive(source, output);
  assert.equal(report.sourceCount, 0, JSON.stringify(report));
  assert.equal(report.outputCount, 2, JSON.stringify(report));
  assert.equal(report.introducedCount, 2);
  assert.equal(report.objectMarked.output, 1);
  assert.equal(report.abstractSubject.output, 1);
  // 원문에 이미 있던 꼴은 순증에서 뺀다.
  const carried = koreanRefinement.countObjectMarkedIntransitive(output, output);
  assert.equal(carried.introducedCount, 0);
});

test('문두 접속·순서 표지가 대응 결과 문장에서 사라진 횟수를 교체·미정렬과 구분해 센다', () => {
  const source = [
    '먼저, 자료를 모아 현황을 정리했다.',
    '또한 설문 결과를 표로 옮겼다.',
    '그러나 응답률은 기대보다 낮았다.',
    '마지막으로 개선안을 세 가지로 정리했다.'
  ].join(' ');
  const output = [
    '자료를 모아 현황을 정리했다.',
    '설문 결과를 표로 옮겼다.',
    '하지만 응답률은 기대보다 낮았다.',
    '개선안을 세 가지로 정리했다.'
  ].join(' ');
  const report = discourse.countLeadingConnectorRemovals(source, output);
  assert.equal(report.sourceMarkedCount, 4);
  assert.equal(report.removedCount, 3, JSON.stringify(report));
  assert.equal(report.replacedCount, 1);
  assert.equal(report.retainedCount, 0);
  assert.deepEqual(report.removedByMarker, { '먼저': 1, '또한': 1, '마지막으로': 1 });
  assert.equal(discourse.countLeadingConnectorRemovals(source, source).removedCount, 0);
  assert.equal(discourse.leadingConnectorOf('예를 들어 이런 경우다.'), '예를 들어');
});

test('어절 편집 비율은 어미·조사 교체는 거의 세지 않고 실제 재작성과 어순 이동을 가른다', () => {
  const source = '우리는 지난달 도서관 이용 자료를 직접 조사하였다. 설문 결과도 표로 정리하였다. 오후 이용 시간이 늘어난 사실을 확인하였다.';
  const endingsOnly = '우리는 지난달 도서관 이용 자료를 직접 조사했다. 설문 결과도 표로 정리했다. 오후 이용 시간이 늘어난 사실을 확인했다.';
  const reordered = '지난달 도서관 이용 자료를 우리는 직접 조사하였다. 표로 설문 결과도 정리하였다. 늘어난 오후 이용 시간이 사실을 확인하였다.';
  const rewritten = '도서관 방문 기록은 한 달 동안 손수 살펴봤고, 질문지 응답은 도표로 묶었다. 그 결과 저녁 무렵 방문이 많아졌다는 점이 드러났다.';

  const same = humanizationDepth.measureWordEditRatio(source, source);
  assert.equal(same.wordEditRatio, 0);
  assert.equal(same.sourceWordRetainedRatio, 1);

  const shallow = humanizationDepth.measureWordEditRatio(source, endingsOnly);
  assert.ok(shallow.wordEditRatio <= 0.05, JSON.stringify(shallow));

  const moved = humanizationDepth.measureWordEditRatio(source, reordered);
  assert.ok(moved.wordEditRatio > moved.wordReplacementRatio, JSON.stringify(moved));
  assert.ok(moved.wordReplacementRatio <= 0.05, JSON.stringify(moved));

  const deep = humanizationDepth.measureWordEditRatio(source, rewritten);
  assert.ok(deep.wordEditRatio >= 0.5, JSON.stringify(deep));
  assert.ok(deep.wordEditRatio > shallow.wordEditRatio);
  assert.equal(humanizationDepth.measureWordEditRatio('', '').wordEditRatio, 0);

  // 문장별 비율: 동의어·어미 교체만 고르게 퍼진 글은 깊게 다시 쓴 문장이 없고,
  // 절 구성을 새로 짠 글은 대부분의 문장이 0.45를 넘는다.
  assert.equal(same.deepRewrittenSentenceRatio, 0);
  assert.equal(shallow.deepRewrittenSentenceRatio, 0, JSON.stringify(shallow));
  const synonyms = '우리는 지난달 도서관 이용 기록을 직접 살펴보았다. 설문 결과도 표로 묶었다. 오후 이용 시간이 늘어난 점을 확인하였다.';
  const swapped = humanizationDepth.measureWordEditRatio(source, synonyms);
  assert.equal(swapped.measuredSentenceCount, 3);
  assert.equal(swapped.deepRewrittenSentenceRatio, 0, JSON.stringify(swapped));
  assert.ok(deep.deepRewrittenSentenceRatio >= 0.6, JSON.stringify(deep));
  assert.ok(deep.sentenceWordEditMedian > swapped.sentenceWordEditMedian);
});
