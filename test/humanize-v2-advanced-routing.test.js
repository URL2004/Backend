'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const inputRouting = require('../engine/inputrouting');
const { resolveAdvancedRouting } = require('../engine-gpt-prod/advancedRouting');
const diagnoseRouter = require('../routes/diagnose');

const academicInquiry = [
  'Ⅰ. 서론',
  '1. 문제 제기와 연구 목적',
  '본 연구는 디지털 자료를 활용한 고전시 감상의 탐구 주제와 교수설계 원리를 분석한다.',
  '연구 목적은 원문 검증과 해석을 연결하는 탐구 과정을 구체화하는 데 있다.',
  'Ⅱ. 선행 연구와 이론적 배경',
  '2. 연구 방법론',
  '선행 연구에서는 자료 탐색, 문헌 검증, 심미적 판단을 복합 수행으로 설명하였다(김연구, 2023).',
  '본 연구에서는 1,954건의 문헌을 분류하고 155건을 수동 검토하였다.',
  '표 1. 문헌 분류 결과',
  '구분 | 분석 건수 | 검토 기준',
  '교육방법 | 1,816건 | 제목과 초록',
  '감상론 | 205건 | 원문과 주석',
  'Ⅲ. 연구 결과',
  '3. 탐색·검증·해석·환류 모형',
  '탐구 활동은 일방향 절차가 아니라 검증 결과에 따라 질문과 자료 범위를 수정하는 순환으로 나타났다.',
  '인용 자료와 작품 원문을 대조한 결과, 외부 정보의 설명 범위를 제한할 필요가 확인되었다.',
  'Ⅳ. 결론',
  '본 연구는 탐구 과정의 근거와 수정 기록을 평가 준거로 제안한다.',
  '참고 문헌',
  '김연구. (2023). 디지털 문학지도와 고전시 교육. https://example.org/a',
  '이문헌. (2024). 문헌 검증 기반 감상 교육. https://example.org/b',
  '박설계. (2025). 복합 수행 교수설계 연구. https://example.org/c'
].join('\n');

test('학술 논문의 탐구 표현은 구형 자소서 오탐을 해제하고 고급을 추천한다', () => {
  assert.equal(inputRouting.looksLikeResume(academicInquiry), true, '회귀 표본은 구형 탐구 휴리스틱의 오탐을 재현해야 한다');
  const route = resolveAdvancedRouting(academicInquiry, { grade: 'A', abstractRiskRatio: 0 }, { v2Enabled: true });
  assert.equal(route.legacyUnfit.kind, 'resume');
  assert.equal(route.effectiveUnfit.unfit, false);
  assert.equal(route.advancedEligible, true);
  assert.equal(route.recommendedMode, 'formal');
  assert.equal(route.recommendationCode, 'complex_academic_document');
  assert.equal(route.routingOverride, 'legacy_inquiry_false_positive');
  assert.ok(['academic_paper', 'report_assignment'].includes(route.profile));
  assert.ok(route.confidence >= 0.75);
  assert.equal(route.formalStructure, true);
});

test('실제 자소서·개인 경험 문서는 v2에서도 고급 잠금을 유지한다', () => {
  const source = [
    '자기소개서',
    '1. 지원 동기',
    '저는 데이터 분석 프로젝트에서 팀원과 협업하며 문제를 해결했습니다.',
    '지원하게 된 이유는 이 경험을 실무에 활용하고 싶었기 때문입니다.',
    '2. 직무 역량',
    '저의 강점은 자료를 정리하고 발표 흐름을 설계하는 능력입니다.',
    '입사 후에는 운영 개선에 기여하고 성장하는 인재가 되겠습니다.'
  ].join('\n');
  const route = resolveAdvancedRouting(source, { grade: 'B', abstractRiskRatio: 0.2 }, { v2Enabled: true });
  assert.equal(route.effectiveUnfit.unfit, true);
  assert.equal(route.effectiveUnfit.kind, 'resume');
  assert.equal(route.advancedEligible, false);
  assert.equal(route.recommendedMode, 'blog');
  assert.equal(route.routingOverride, '');
});

test('짧고 추상적인 글과 영어 글의 안전 잠금은 유지한다', () => {
  const thin = '혁신은 중요하며 체계적인 접근이 필요하다. 다양한 관점에서 의미를 살펴보고 바람직한 방향을 찾아야 한다.'.repeat(2);
  const thinRoute = resolveAdvancedRouting(thin, { grade: 'C', abstractRiskRatio: 0.8 }, { v2Enabled: true });
  assert.equal(thinRoute.effectiveUnfit.kind, 'thin');
  assert.equal(thinRoute.advancedEligible, false);

  const english = 'This document explains a research process and presents a structured discussion of the findings in English only.';
  const englishRoute = resolveAdvancedRouting(english, { grade: 'B', abstractRiskRatio: 0 }, { v2Enabled: true });
  assert.equal(englishRoute.effectiveUnfit.kind, 'english');
  assert.equal(englishRoute.advancedEligible, false);
});

test('v2가 꺼지면 구형 재구성 부적합 판정을 그대로 유지한다', () => {
  const route = resolveAdvancedRouting(academicInquiry, { grade: 'A', abstractRiskRatio: 0 }, { v2Enabled: false });
  assert.equal(route.effectiveUnfit.unfit, true);
  assert.equal(route.effectiveUnfit.kind, 'resume');
  assert.equal(route.routingOverride, '');
  assert.equal(route.documentProfile, null);
});

test('/diagnose는 프론트가 사용할 최종 고급 적합성과 추천 메타를 반환한다', () => {
  const layer = diagnoseRouter.stack.find(item => item.route?.path === '/diagnose');
  const handler = layer?.route?.stack?.[0]?.handle;
  assert.equal(typeof handler, 'function');
  const previous = process.env.HUMANIZE_ENGINE_V2_ENABLED;
  process.env.HUMANIZE_ENGINE_V2_ENABLED = '1';
  let statusCode = 200;
  let responseBody = null;
  try {
    handler(
      { body: { text: academicInquiry } },
      {
        status(code) { statusCode = code; return this; },
        json(value) { responseBody = value; return this; }
      }
    );
  } finally {
    if (previous === undefined) delete process.env.HUMANIZE_ENGINE_V2_ENABLED;
    else process.env.HUMANIZE_ENGINE_V2_ENABLED = previous;
  }
  assert.equal(statusCode, 200);
  assert.equal(responseBody?.resumeLike, true, '구형 관측값은 호환을 위해 남긴다');
  assert.equal(responseBody?.restructureUnfit, false, '프론트 잠금은 조정된 최종 판정을 사용한다');
  assert.equal(responseBody?.advancedEligible, true);
  assert.equal(responseBody?.recommendedMode, 'formal');
  assert.equal(responseBody?.recommendationCode, 'complex_academic_document');
  assert.equal(responseBody?.routingOverride, 'legacy_inquiry_false_positive');
  assert.ok(['normal', 'limited'].includes(responseBody?.effectExpectation));
  assert.equal(typeof responseBody?.requiresEffectConfirmation, 'boolean');
  assert.ok(Object.prototype.hasOwnProperty.call(responseBody, 'effectNoticeCode'));
  assert.ok(Number(responseBody?.profileConfidence) >= 0.75);
  assert.equal(responseBody?.advancedTimeEstimate?.basis, 'v2_editable_chunk_range');
  assert.ok(responseBody?.advancedTimeEstimate?.highSec > responseBody?.advancedTimeEstimate?.lowSec);
  assert.equal(responseBody?.advancedTimeEstimate?.sourceBareLength, academicInquiry.replace(/\s+/gu, '').length);
});
