'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const resumeCoverage = require('../engine-gpt-prod/resumeCoverage');

// 2026-10-09 점검(F-14): 역사 노트에 자기소개서 누락 경고가 붙었고, 긴 지원
// 동기 문장이 둘로 나뉜 자소서가 누락으로 집계됐다. 지어낸 글로 재현한다.

const RESUME_SOURCE = [
  '안녕하십니까.',
  '제가 한빛전자고등학교에 지원하게 된 동기는 앞으로 나올 자율주행차, 스마트폰, 노트북 같은 전자제품에 기본적으로 반도체가 들어가기 때문에 그에 따른 반도체의 필요성과 전망이 밝아 보였기 때문입니다.',
  '또한 저는 반도체와 관련된 수학과 과학 과목에 다른 과목보다 관심이 많고 성취도도 높습니다.',
  '1학년 때 지속가능발전대회에서 반도체를 활용한 공기 정화 장치를 포스터로 그려 상장을 받았습니다.',
  '이러한 이유로 한빛전자고등학교에 입학하고 싶습니다.'
].join('\n');

const RESUME_SPLIT_OUTPUT = [
  '안녕하십니까.',
  '김하늘입니다.',
  '앞으로 출시될 자율주행차와 스마트폰, 노트북 같은 전자제품에는 기본적으로 반도체가 들어갑니다.',
  '반도체의 필요성이 크고 전망도 밝다고 생각해 한빛전자고등학교에 지원했습니다.',
  '또한 저는 반도체와 관련된 수학과 과학 과목에 다른 과목보다 관심이 많고, 성취도도 높습니다.',
  '1학년 때 지속가능발전대회에서 반도체를 활용한 공기 정화 장치를 포스터로 그려 상장을 받았습니다.',
  '이러한 이유로 한빛전자고등학교에 입학하고 싶습니다.'
].join('\n');

test('자소서 누락 감사는 보고서로 확정된 글에 안전 프로필 꼬리표만으로 걸리지 않는다', () => {
  const source = [
    '통일 왕국의 성립',
    '왕은 영토가 늘자 행정 조직을 다시 짜고 지방 제도를 정비하는 일을 수행했다.',
    '군사 조직도 중앙과 지방으로 나누어 운영했고 관료 체제의 역량을 강화했다.'
  ].join('\n');
  const output = [
    '통일 왕국의 성립',
    '영토가 늘어난 뒤 왕은 행정 조직을 새로 짜고 지방 제도를 손봤다.',
    '군사 조직 역시 중앙과 지방으로 나눠 운영하면서 관료 체제를 다졌다.'
  ].join('\n');
  const report = resumeCoverage.auditResumeCoverage(source, output, {
    profile: 'report_assignment',
    safetyProfiles: ['report_assignment', 'resume_application']
  });
  assert.equal(report.applicable, false);
  assert.deepEqual(report.issueCodes, []);

  // 분류가 비어 있는 저신뢰 라우팅의 안전 프로필은 계속 존중한다.
  const undecided = resumeCoverage.auditResumeCoverage(RESUME_SOURCE, RESUME_SOURCE, {
    profile: 'unknown',
    confidence: 0.31,
    safetyProfiles: ['resume_application']
  });
  assert.equal(undecided.applicable, true);

  // 자기평가(생활기록부형)도 자소서 계열로 본다.
  const selfAssessment = resumeCoverage.auditResumeCoverage(RESUME_SOURCE, RESUME_SOURCE, {
    profile: 'student_self_assessment'
  });
  assert.equal(selfAssessment.applicable, true);
  assert.equal(selfAssessment.pass, true);
});

test('긴 지원 동기 한 문장이 두 결과 문장으로 나뉘어도 주장 누락으로 세지 않는다', () => {
  const report = resumeCoverage.auditResumeCoverage(RESUME_SOURCE, RESUME_SPLIT_OUTPUT, {
    profile: 'resume_application',
    confidence: 0.9
  });
  assert.equal(report.applicable, true);
  assert.equal(report.pass, true, JSON.stringify(report.omissions));
  assert.deepEqual(report.issueCodes, []);
  assert.equal(report.coveredClaimCount, report.claimCount);
});

test('나뉜 문장 가운데 한 문장만 주장과 닿는 묶음은 분할 보존으로 인정하지 않는다', () => {
  const output = [
    '안녕하십니까.',
    '김하늘입니다.',
    '앞으로 출시될 자율주행차와 스마트폰, 노트북 같은 전자제품에는 기본적으로 반도체가 들어갑니다.',
    '학교 급식은 매일 정해진 시간에 제공됩니다.',
    '또한 저는 반도체와 관련된 수학과 과학 과목에 다른 과목보다 관심이 많고, 성취도도 높습니다.',
    '1학년 때 지속가능발전대회에서 반도체를 활용한 공기 정화 장치를 포스터로 그려 상장을 받았습니다.',
    '이러한 이유로 한빛전자고등학교에 입학하고 싶습니다.'
  ].join('\n');
  const report = resumeCoverage.auditResumeCoverage(RESUME_SOURCE, output, {
    profile: 'resume_application',
    confidence: 0.9
  });
  assert.equal(report.pass, false);
  assert.ok(report.issueCodes.includes('resume_claim_omission'));
  assert.ok(report.omissions.every(item => item.splitCovered !== true));
});

test('실제 자소서 성과 문장 누락은 계속 탐지한다', () => {
  const source = [
    '직무 역량',
    '생산 라인의 불량 데이터를 분석해 결함 원인을 찾아냈고 재작업 비용을 15% 줄이는 프로젝트를 수행했습니다.',
    '입사 후 포부',
    '이 경험을 바탕으로 현장 품질을 높이는 엔지니어가 되겠습니다.'
  ].join('\n');
  const output = [
    '직무 역량',
    '현장 구성원과 원활히 협력하는 태도를 중요하게 생각합니다.',
    '입사 후 포부',
    '이 경험을 바탕으로 현장 품질을 높이는 엔지니어가 되겠습니다.'
  ].join('\n');
  const report = resumeCoverage.auditResumeCoverage(source, output, {
    profile: 'resume_application',
    confidence: 0.95
  });
  assert.equal(report.pass, false);
  assert.ok(report.issueCodes.includes('resume_claim_omission'));
});
