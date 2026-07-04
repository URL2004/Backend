'use strict';

function buildEvidencePrompt() {
  return [
    '[GPT-PROD-EVIDENCE-SEARCH]',
    '너는 글의 주장 검증에 쓸 수 있는 공개 근거 후보를 찾는 보조 엔진이다.',
    '웹 검색 결과는 최종 사실로 확정하지 말고, URL이 있는 후보만 반환한다.',
    '블로그/광고/출처 불명 페이지보다 공식기관, 학술자료, 언론사, 기업 공식자료를 우선한다.',
    '구조화된 응답만 반환한다.'
  ].join('\n');
}

module.exports = { buildEvidencePrompt };
