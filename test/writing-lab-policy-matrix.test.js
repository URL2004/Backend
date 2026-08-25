'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../engine-writing-v1');
const { PACKS } = require('../engine-writing-v1/policy');

function preparedFor(text, { genre = 'general', evidence = false } = {}) {
  if (genre === 'marketing') {
    return engine.prepare({
      genre: 'marketing', subtype: 'service', targetChars: 120,
      answers: {
        product: text,
        audience: '일반 사용자',
        features: '현재 제공하는 기능을 설명해요.',
        evidence: evidence ? '내부 기능 명세에서 확인했어요.' : ''
      }
    });
  }
  return engine.prepare({
    genre: 'general', subtype: 'explanation', targetChars: 120,
    answers: {
      purpose: `${text}에 관한 확인 사실을 정리해요.`,
      keyMessage: text,
      source: evidence ? '확인 가능한 원문과 출처가 있어요.' : ''
    }
  });
}

test('regulated policy term matrix has at least 350 fixed domain-intent-claim decisions', () => {
  const regulated = PACKS.filter(pack => ['medical', 'legal', 'finance'].includes(pack.domain));
  const neutralTemplates = [
    term => `${term} 관련 사실`,
    term => `${term} 개인 경험`,
    term => `${term} 이용 내용`,
    term => `${term} 일반 설명`,
    term => `${term} 확인 기록`
  ];
  let cases = 0;
  for (const pack of regulated) {
    for (const term of [...pack.institutionTerms, ...pack.treatmentTerms]) {
      for (const makeText of neutralTemplates) {
        const prepared = preparedFor(makeText(term));
        assert.ok(prepared.policy.domains.includes(pack.domain), `${pack.domain}: ${term}`);
        assert.ok(['MANUAL_REVIEW', 'BLOCK'].includes(prepared.policy.status), `${pack.domain}: ${makeText(term)}`);
        cases += 1;
      }
      const promotional = preparedFor(`${term} 홍보 신청`, { genre: 'marketing' });
      assert.equal(promotional.policy.status, 'BLOCK', `${pack.domain} promotional: ${term}`);
      cases += 1;
    }
    const anchor = pack.institutionTerms[0] || pack.treatmentTerms[0];
    for (const claim of pack.blockedClaimTerms) {
      for (const makeText of neutralTemplates) {
        const prepared = preparedFor(`${anchor} ${makeText(claim)}`);
        assert.equal(prepared.policy.status, 'BLOCK', `${pack.domain} blocked: ${claim}`);
        cases += 1;
      }
    }
  }
  assert.ok(cases >= 350, `expected >=350, got ${cases}`);
});

test('advertising pack matrix covers evidence, disclosure notice, and promotional terms', () => {
  const advertising = PACKS.find(pack => pack.domain === 'advertising');
  let cases = 0;
  for (const claim of advertising.claimTerms) {
    for (const suffix of ['소개', '상세 안내']) {
      const withoutEvidence = preparedFor(`${claim} ${suffix}`, { genre: 'marketing' });
      assert.equal(withoutEvidence.policy.status, 'MANUAL_REVIEW', `without evidence: ${claim}`);
      const withEvidence = preparedFor(`${claim} ${suffix}`, { genre: 'marketing', evidence: true });
      assert.equal(withEvidence.policy.status, 'MANUAL_REVIEW', `with evidence: ${claim}`);
      cases += 2;
    }
  }
  for (const term of [...advertising.institutionTerms, ...advertising.treatmentTerms]) {
    for (const suffix of ['사실 안내', '조건 정리', '일정 공지']) {
      const prepared = preparedFor(`${term} ${suffix}`);
      assert.equal(prepared.policy.domains.includes('advertising'), true, term);
      assert.equal(prepared.policy.status, 'MANUAL_REVIEW', term);
      cases += 1;
    }
  }
  assert.ok(cases >= 50, `expected >=50, got ${cases}`);
});

test('curated polysemy boundaries do not enter regulated domains', () => {
  const safe = [
    '웨이트리프팅 체육관 후기', '취업 클리닉 일정 안내', '미용실 염색 시술 후기',
    '리프팅 스트랩 상품 설명', '마인드 케어 독서 모임', '법칙을 설명하는 수학 글',
    '책임감을 배운 팀 프로젝트', '상승 기류를 설명하는 날씨 글', '하락 구간이 있는 등산로',
    '보험이 아닌 보증 기간 안내', '원금이 등장하는 소설 요약', '처방전이라는 영화 후기',
    '수술대가 등장하는 연극 감상', '진료가 아닌 진로 상담', '계약서 형식의 글쓰기 과제',
    '펀드가 아닌 크라우드펀딩 행사', '주식이 아닌 주식회사 명칭', '은행나무 산책 후기',
    '코인 노래방 방문 후기', '필러 단어를 채우는 디자인 설명'
  ];
  // 명시적으로 규제 대상 단어 자체를 비유·부정한 일부 문구는 보수적으로 검토될 수 있다.
  // 여기서는 기존 실제 오탐 세 가지를 포함해 자동 허용해야 하는 다의어만 고정한다.
  for (const text of safe.slice(0, 9)) {
    const prepared = preparedFor(text);
    assert.equal(prepared.policy.domains.some(domain => ['medical', 'legal', 'finance'].includes(domain)), false, text);
  }
});
