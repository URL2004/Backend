'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const documentProfile = require('../engine-gpt-prod/documentProfile');
const koreanRefinement = require('../engine-gpt-prod/koreanRefinement');
const literalSpans = require('../engine-gpt-prod/literalSpans');
const sourcePreflight = require('../engine-gpt-prod/sourcePreflight');
const pov = require('../engine/pov');
const stableCore = require('../engine-gpt-prod/prompts/humanize/stableCore');
const genreBlocks = require('../engine-gpt-prod/prompts/humanize/genreBlocks');

test('v2.5.32: 제목 없는 근거·통계 설명문을 blog 힌트와 무관하게 학술·보고서 그룹으로 보낸다', () => {
  const source = [
    '스마트폰이 보급되면서 온라인 거래 환경도 빠르게 달라졌다.',
    '초기에는 컴퓨터를 이용했지만 모바일 환경이 갖춰진 뒤 접근성이 높아졌다.',
    '중국인터넷정보센터가 발표한 통계 보고서에 따르면 2010년 이용자는 1억 6,100만 명이었다.',
    '2023년에는 이용자가 9억 1,500만 명으로 집계되었다.',
    '13년 사이 약 5.7배 늘어난 수치는 온라인 구매가 일상적인 방식으로 자리 잡았음을 보여 준다.',
    '모바일 결제의 확산은 구매 과정에서 발생하던 절차적 부담을 줄이는 데 기여했다.',
    '기업들은 늘어난 배송 수요에 대응하기 위해 물류센터를 구축하고 배송망을 확충했다.',
    '중소도시와 농촌에서도 상품을 받을 수 있게 되면서 이용 범위가 넓어졌다.',
    '정부는 통신 인프라와 농촌 전자상거래 정책을 보완하며 산업의 성장을 뒷받침했다.',
    '국가통계국 자료에서 2024년 온라인 소매판매액은 15조 5천억 위안으로 집계되었다.',
    '온라인 실물 상품 판매액은 전체 소비재 소매판매액의 26.8%를 차지했다.',
    '지역별 배송 거점이 늘어난 과정은 거래 범위가 대도시 밖으로 넓어진 배경을 설명한다.',
    '결제 수단과 물류 기반의 변화는 서로 다른 시기에 진행됐으므로 각 요인의 범위를 나누어 살펴볼 필요가 있다.',
    '이용자 규모와 판매액은 서로 다른 지표이기 때문에 같은 성장률로 해석해서는 안 된다.',
    '이 자료는 결제·물류·정책 환경의 변화가 시장 성장과 함께 진행됐음을 보여 준다.'
  ].join(' ');

  for (const basicStyle of ['', 'blog', 'report']) {
    const detected = documentProfile.detectDocumentProfile(source, { basicStyle });
    assert.ok(
      ['long_explainer', 'report_assignment'].includes(detected.profile),
      `${basicStyle}: ${JSON.stringify(detected)}`
    );
    assert.equal(detected.group, 'academic_report_explainer');
    assert.equal(detected.signals.evidenceBasedExplainerFrame, true);
  }
});

test('v2.5.32: 시간 관계·전문 동사·보고서 연어를 약화하거나 강화한 결과를 함께 잡고 국소 복원한다', () => {
  const source = [
    '스마트폰이 빠르게 보급되면서 전자상거래 시장도 성장하기 시작했다.',
    '소비자는 스마트폰 하나만으로도 결제할 수 있었다.',
    '기업들은 물류센터를 구축하고 배송망을 확대하였다.',
    '배송망이 확대된 뒤에는 농촌에서도 상품을 빠르게 받아볼 수 있었다.',
    '이 기업들은 이후 시장에서 규모를 키웠다.'
  ].join(' ');
  const output = [
    '스마트폰 보급을 계기로 전자상거래 시장은 성장세를 나타내기 시작했다.',
    '소비자는 스마트폰 하나로 결제를 끝낼 수 있었다.',
    '기업들은 물류센터를 마련하고 배송망을 확장했다.',
    '배송망이 확대되자 농촌에서도 상품을 빠르게 받아볼 수 있었다.',
    '이후 이 기업들은 시장에서 규모를 키웠다.'
  ].join(' ');
  const profile = { profile: 'long_explainer', group: 'academic_report_explainer', targetRegister: 'academic_formal' };
  const audit = koreanRefinement.analyzeKoreanRefinement({ source, outputText: output, documentProfile: profile });
  assert.deepEqual(
    new Set(audit.issueCodes),
    new Set([
      'bureaucratic_growth_aspect_stack',
      'formal_register_residual',
      'infrastructure_action_weakened',
      'causal_connector_strengthening',
      'temporal_anchor_detachment'
    ])
  );

  const restored = koreanRefinement.restoreIntroducedIntegritySentences({ source, outputText: output, audit });
  assert.equal(restored.applied, true);
  assert.deepEqual(
    koreanRefinement.analyzeKoreanRefinement({ source, outputText: restored.text, documentProfile: profile }).issueCodes,
    []
  );
});

test('v2.5.32: 원문부터 사라진 수식·행렬 흔적은 보충하지 않고 확인 알림만 남긴다', () => {
  const source = [
    '실수에서 덧셈에 대한 역원인 , 곱셈에 대한 역원인  (단, )을 설명한다.',
    '다음과 같은 선형연립방정식을 예로 들어 풀어보겠다.',
    '',
    '이 연립방정식은 다음 첨가행렬로 나타낼 수 있다.',
    '1. (첫 번째 행으로 다른 행의 첫 원소를 0으로 만든다):',
    '따라서 이라는 해를 구할 수 있다.'
  ].join('\n');
  const result = sourcePreflight.auditAndSanitizeSource(source);
  assert.equal(result.version, 14);
  assert.ok(result.issueCodes.includes('source_math_content_gap'), JSON.stringify(result));
  assert.match(result.text, /역원인 ,/u);
  assert.doesNotMatch(result.text, /x\s*=|R_?\d+\s*(?:←|<-)/u);
});

test('v2.5.32: LaTeX 수식은 토큰 왕복과 마지막 순서 감사에서 원문 그대로 복원한다', () => {
  const source = '식 $x=1$과 \\(y=-3\\)을 구하고, 다음 행렬 \\[A^{-1}=I\\]를 확인했다.';
  const frozen = literalSpans.freezeMath(source);
  assert.equal(frozen.count, 3);
  assert.equal(literalSpans.restoreMath(frozen.text, frozen).text, source);

  const changed = '식 $x = 1$과 \\(y = -3\\)을 구하고, 다음 행렬 \\[A^-1 = I\\]를 확인했다.';
  const restored = literalSpans.restoreMathByOrder(changed, frozen);
  assert.equal(restored.pass, true);
  assert.equal(restored.applied, true);
  assert.equal(restored.text, source);

  const missing = literalSpans.restoreMathByOrder('식 $x=1$만 남았다.', frozen);
  assert.equal(missing.pass, false);
  assert.equal(missing.applied, false);

  const swappedTokens = `${frozen.blocks[1].token} 다음 ${frozen.blocks[0].token} 다음 ${frozen.blocks[2].token}`;
  const swapped = literalSpans.restoreMath(swappedTokens, frozen);
  assert.equal(swapped.pass, false);
  assert.equal(swapped.orderPass, false);
  assert.equal(swapped.text.includes('ZXQMATH'), false);

  const plainSource = '연산 R2 ← R2 - 2R1을 적용하면 x=1, y=-3, z=7을 얻는다.';
  const plainFrozen = literalSpans.freezeMath(plainSource);
  assert.equal(plainFrozen.count, 2);
  assert.equal(literalSpans.restoreMath(plainFrozen.text, plainFrozen).text, plainSource);
});

test('v2.5.32: 행렬 기호 I와 코드 식별자는 영어 1인칭 화자로 세지 않는다', () => {
  assert.equal(pov.computePovSeed('항등행렬 \\(I\\)와 식 $A^{-1}=I$를 확인했다.').fp_singular, 0);
  assert.equal(pov.computePovSeed('변수 `I`와 `my`는 코드 식별자다.').fp_singular, 0);
  assert.equal(pov.computePovSeed('항등행렬 값은 I=1로 두었다.').fp_singular, 0);
  assert.equal(pov.computePovSeed('I reviewed the matrix.').fp_singular, 1);
});

test('v2.5.32: 학술 프롬프트는 수식 비추정과 시간·인과·전문 동사 보존을 명시한다', () => {
  const profile = { profile: 'long_explainer', group: 'academic_report_explainer', targetRegister: 'academic_formal' };
  const core = stableCore.humanizeStableCore(profile);
  const genre = genreBlocks.genreBlock('blog', 'plain', '', profile, 'basic');
  assert.match(core, /수식·행렬·변수·연산 기호·코드·의사코드는 문자와 순서를 그대로 보존/u);
  assert.match(core, /비어 있거나 빠진 식은 외부 지식으로 추측해 채우지 않는다/u);
  assert.match(core, /“뒤·후”를 “그 결과·~자”로 강화하지 않는다/u);
  assert.match(genre, /“시설을 구축하다”를 “마련하다”로 낮추는/u);
});
