'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  auditUnsupportedSpecificity,
  restoreUnsupportedSpecificityClaims
} = require('../engine-gpt-prod/unsupportedSpecificityAudit');

test('다른 대상에게 기존 작품의 출시·매출·전환 성과를 재귀속한 문장을 원문으로 국소 복원한다', () => {
  const source = [
    '해당 작품을 주초 구좌에 배치하고 런칭 당일 구매 전환율과 거래액에서 우수한 성과를 확인했습니다.',
    '이 성공 경험을 바탕으로 타 장르의 신규 IP도 검토하고 데이터 기반 마케팅을 연계했습니다.'
  ].join(' ');
  const output = [
    '해당 작품을 주초 구좌에 배치하고 런칭 당일 구매 전환율과 거래액에서 우수한 성과를 확인했습니다.',
    '이후 ZX 같은 다른 장르의 작품도 수급했으며, 해당 작품들 역시 런칭 당일 거래액과 전환율에서 우수한 성과를 보였습니다.'
  ].join(' ');
  const audit = auditUnsupportedSpecificity(source, output, '');
  assert.equal(audit.issueCount, 1, JSON.stringify(audit));
  assert.equal(audit.issues[0].autoRestorable, true, JSON.stringify(audit));
  assert.deepEqual(audit.issues[0].introducedEntities, ['ZX']);

  const restored = restoreUnsupportedSpecificityClaims(source, output, audit);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.match(restored.text, /타 장르의 신규 IP도 검토/u);
  assert.doesNotMatch(restored.text, /ZX/u);
  assert.equal(restored.residualCount, 0);
});

test('동일 대상과 성과 결합이 source나 allowedExtra에 있으면 통과한다', () => {
  const source = 'QX 장르를 출시한 뒤 매출과 전환율이 개선된 성과를 확인했습니다.';
  const output = 'QX 장르를 출시한 이후 매출과 전환율에서 개선 성과를 확인했습니다.';
  assert.equal(auditUnsupportedSpecificity(source, output, '').pass, true);

  const generic = '타 장르의 신규 IP를 검토했습니다.';
  const notes = 'QX 장르를 출시해 매출과 전환율 성과를 확인했습니다.';
  assert.equal(auditUnsupportedSpecificity(generic, output, notes).pass, true);
});

test('2배와 두 배 표기 변환과 일반 의역은 오탐하지 않는다', () => {
  const source = '기존 작품의 거래액은 평균의 2배였고 구매 전환율도 상승했습니다.';
  const output = '기존 작품은 평균보다 두 배 높은 거래액을 기록했고, 구매 전환율 역시 상승했습니다.';
  assert.equal(auditUnsupportedSpecificity(source, output, '').pass, true);
});

test('글로벌·핵심 같은 일반 수식어 의역은 새 대상명으로 오인하지 않는다', () => {
  assert.equal(
    auditUnsupportedSpecificity(
      '해외 시장에서 매출을 개선했습니다.',
      '글로벌 시장에서 매출을 개선했습니다.',
      ''
    ).pass,
    true
  );
  assert.equal(
    auditUnsupportedSpecificity(
      '대표 제품의 매출을 개선했습니다.',
      '핵심 제품의 매출을 개선했습니다.',
      ''
    ).pass,
    true
  );
});

test('삼성과 같은 브랜드처럼 조사가 붙은 신규 고유 대상도 탐지한다', () => {
  const audit = auditUnsupportedSpecificity(
    '새 브랜드의 매출을 검토했습니다.',
    '삼성과 같은 브랜드의 매출을 기록했습니다.',
    ''
  );
  assert.equal(audit.pass, false, JSON.stringify(audit));
  assert.deepEqual(audit.issues[0].introducedEntities, ['삼성']);
  assert.equal(audit.residualCount, audit.issueCount);
});

test('한글로 새로 특정한 카테고리의 성과 재귀속도 특정 장르명 사전 없이 탐지한다', () => {
  const source = '타 장르의 신규 작품도 검토하고 마케팅 방향을 정리했습니다.';
  const output = '퍼즐 장르의 작품을 출시해 매출과 구매 전환율에서 우수한 성과를 거두었습니다.';
  const audit = auditUnsupportedSpecificity(source, output, '');
  assert.equal(audit.issueCount, 1, JSON.stringify(audit));
  assert.ok(audit.issues[0].introducedEntities.includes('퍼즐'));
});

test('숫자·인용·부정·양태 서명이 다른 주장은 탐지하되 자동 복원하지 않는다', () => {
  const source = '타 장르의 신규 IP를 검토할 수 있지만 출시 성과를 단정하지 않았습니다.';
  const output = '“ZX 성공작” 장르를 출시해 일주일 만에 매출 30%와 전환율 성과를 달성했습니다.';
  const audit = auditUnsupportedSpecificity(source, output, '');
  assert.equal(audit.issueCount, 1, JSON.stringify(audit));
  assert.equal(audit.issues[0].autoRestorable, false);
  assert.ok(audit.issues[0].restoreBlockReasons.includes('number_signature_changed'));
  assert.ok(audit.issues[0].restoreBlockReasons.includes('quote_signature_changed'));
  assert.ok(audit.issues[0].restoreBlockReasons.includes('negation_signature_changed'));
  assert.ok(audit.issues[0].restoreBlockReasons.includes('modality_signature_changed'));

  const restored = restoreUnsupportedSpecificityClaims(source, output, audit);
  assert.equal(restored.applied, false);
  assert.equal(restored.residualCount, 1);
  assert.equal(restored.text, output);
});

test('서로 다른 원문 문장이 같은 결과 문장에 모호하게 대응하면 residual로 남긴다', () => {
  const source = [
    'A사의 타 장르 신규 IP를 검토하고 데이터 마케팅을 준비했습니다.',
    'B사의 타 장르 신규 IP를 검토하고 데이터 마케팅을 준비했습니다.'
  ].join(' ');
  const output = 'ZX 장르를 출시해 매출과 전환율에서 우수한 성과를 거두었습니다.';
  const audit = auditUnsupportedSpecificity(source, output, '');
  assert.equal(audit.issueCount, 1, JSON.stringify(audit));
  assert.equal(audit.issues[0].autoRestorable, false);
  assert.ok(audit.issues[0].restoreBlockReasons.includes('ambiguous_or_weak_alignment'));
});

test('1:N 분할에서 인접 결과가 원문 주장을 충분히 보존하면 근거 없는 중간 성과 문장만 삭제한다', () => {
  const source = [
    '기존 작품은 런칭 당일 거래액과 구매 전환율이 상위 5%인 성과를 기록했습니다.',
    '시장과 이용자 반응을 살피며 콘텐츠의 소구점을 파악하는 안목을 길렀습니다.',
    '이 경험을 바탕으로 타 장르의 신규 IP를 검토하고 데이터 기반 마케팅을 연계해 콘텐츠 다양성을 확대했습니다.'
  ].join(' ');
  const output = [
    '기존 작품은 런칭 당일 거래액과 구매 전환율이 상위 5%인 성과를 기록했습니다.',
    '시장과 이용자 반응을 살피며 콘텐츠의 소구점을 파악하는 안목을 길렀습니다.',
    '이후 ZX 같은 다른 장르의 작품도 출시했고, 해당 작품 역시 거래액과 전환율에서 우수한 성과를 냈습니다.',
    '이 경험을 바탕으로 데이터 기반 마케팅을 연계해 콘텐츠 다양성을 확대했습니다.'
  ].join(' ');
  const audit = auditUnsupportedSpecificity(source, output, '');
  assert.equal(audit.issueCount, 1, JSON.stringify(audit));
  assert.equal(audit.issues[0].autoRestorable, false, JSON.stringify(audit));

  const restored = restoreUnsupportedSpecificityClaims(source, output, audit);
  assert.equal(restored.applied, true, JSON.stringify(restored));
  assert.equal(restored.reason, 'grounded_residual_sentence_removed');
  assert.equal(restored.removedCount, 1);
  assert.equal(restored.residualCount, 0);
  assert.doesNotMatch(restored.text, /ZX/u);
  assert.match(restored.text, /데이터 기반 마케팅을 연계해 콘텐츠 다양성을 확대/u);
});

test('근거 없는 문장이 원문 의미의 유일한 대응 위치라면 삭제하지 않는다', () => {
  const source = '타 장르 신규 IP를 검토하고 데이터 기반 마케팅을 준비했습니다.';
  const output = 'ZX 장르의 작품을 출시해 매출과 구매 전환율에서 우수한 성과를 거두었습니다.';
  const audit = auditUnsupportedSpecificity(source, output, '');
  const restored = restoreUnsupportedSpecificityClaims(source, output, audit);
  assert.equal(audit.issueCount, 1, JSON.stringify(audit));
  assert.equal(restored.applied, false, JSON.stringify(restored));
  assert.equal(restored.residualCount, 1);
  assert.ok(restored.residualIssues[0].removalBlockReasons.includes('empty_or_unalignable_candidate'));
});

test('삭제 대상 문장이 원문의 유일한 숫자·인용 보존 위치면 삭제하지 않는다', () => {
  const source = [
    '“핵심 캠페인”은 총 3회 검토했습니다.',
    '타 장르 신규 IP를 검토하고 데이터 마케팅을 준비했습니다.'
  ].join(' ');
  const output = [
    '“핵심 캠페인”을 3회 검토한 뒤 ZX 장르를 출시해 매출과 전환율에서 우수한 성과를 거두었습니다.',
    '타 장르 신규 IP를 살피고 데이터 마케팅을 준비했습니다.'
  ].join(' ');
  const audit = auditUnsupportedSpecificity(source, output, '');
  const restored = restoreUnsupportedSpecificityClaims(source, output, audit);
  assert.equal(audit.issueCount, 1, JSON.stringify(audit));
  assert.equal(restored.removedCount, 0, JSON.stringify(restored));
  assert.match(restored.text, /“핵심 캠페인”/u);
  assert.match(restored.text, /3회/u);
});

test('수식의 미분 apostrophe와 일반적인 우선 장르는 새 대상명으로 오인하지 않는다', () => {
  const mathSource = "x<6에서는 P'(x)>0이고 x>6에서는 P'(x)<0이다.";
  const mathOutput = "x<6에서는 P'(x)>0이므로 광고비가 증가하고, x>6에서는 P'(x)<0이므로 감소한다.";
  assert.equal(auditUnsupportedSpecificity(mathSource, mathOutput, '').pass, true);

  const genreSource = '장르의 영향을 확인하고 여러 신작의 성과를 비교했습니다.';
  const genreOutput = '우선 장르의 영향을 확인하고 여러 신작의 성과를 비교했습니다.';
  assert.equal(auditUnsupportedSpecificity(genreSource, genreOutput, '').pass, true);
});
