'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVoiceProfile, auditVoice } = require('../engine-gpt-prod/voiceProfile');

// 2026-10-09 점검(F-14): `나의 생각을`→`생각을`, `우리의 생활을`→`생활을`처럼
// 대명사 하나만 빠지고 1인칭 서술어는 남은 결과에 화자 삭제 경고가 붙었다.

function audit(source, output, { documentProfile = 'report_assignment', mode = 'blog' } = {}) {
  const profile = buildVoiceProfile(source, { documentProfile, mode });
  return auditVoice(profile, output, { documentProfile, mode, sourceText: source });
}

const SOURCE_SINGULAR = [
  '이번 활동에서는 유아의 놀이를 관찰하고 교사의 역할을 정리했다.',
  '관찰 기록을 바탕으로 놀이 환경을 바꾸는 방법을 토론했다.',
  '앞으로도 다양한 사람들과 협력하며 나의 생각을 넓히고, 유아에게 더 적합한 놀이를 지원할 수 있도록 노력하고 싶다.'
].join(' ');

test('소유격 대명사 하나만 빠지고 1인칭 서술어가 남은 결과는 화자 삭제로 보지 않는다', () => {
  const output = [
    '이번 활동에서는 유아의 놀이를 관찰하고 교사의 역할을 정리했다.',
    '관찰 기록을 바탕으로 놀이 환경을 바꾸는 방법을 토론했다.',
    '앞으로도 다양한 사람들과 협력해 생각을 넓히고, 유아에게 더 적합한 놀이를 지원하도록 노력하고 싶다.'
  ].join(' ');
  const report = audit(SOURCE_SINGULAR, output);
  assert.equal(report.warnings.some(item => item.code === 'speaker_removed'), false, JSON.stringify(report.warnings));
});

test('내가 두 번 쓰인 소감문도 생각이 들었다·의미가 있었다 서술어가 남으면 화자 삭제가 아니다', () => {
  const source = [
    '이번 공연 실습을 준비하면서 내가 노래를 부르는 것도 좋아하지만 연기와 노래 중 하나를 고르라고 한다면 연기를 선택할 것 같다는 생각이 들었다.',
    '무대 동선을 정리하고 소품을 준비하는 일도 맡았다.',
    '이번 공연 실습이 완벽하지는 않았더라도 바쁜 와중에 내가 할 수 있는 만큼 준비했다는 점에서 의미가 있었다.'
  ].join(' ');
  const output = [
    '이번 공연 실습을 준비하며 노래 부르는 것도 좋아하지만, 연기와 노래 중 하나를 택한다면 연기를 고를 것 같다는 생각이 들었다.',
    '무대 동선을 정리하고 소품을 준비하는 일도 맡았다.',
    '공연 실습이 완벽하지는 않았더라도 바쁜 와중에 할 수 있는 만큼 준비했다는 점에서 의미가 있었다.'
  ].join(' ');
  const report = audit(source, output, { documentProfile: 'student_self_assessment' });
  assert.equal(report.warnings.some(item => item.code === 'speaker_removed'), false, JSON.stringify(report.warnings));
});

test('대명사와 함께 1인칭 서술어까지 사라지면 화자 삭제 경고를 유지한다', () => {
  const source = [
    '디자인 수업에서 여러 사례를 조사하고 발표 자료를 정리했다.',
    '디자인의 역할이 어떻게 사회적 가치를 만들고 생활을 개선하는지 이해하면서 나의 진로 목표에 대해 더욱 명확한 방향성을 잡을 수 있었다.'
  ].join(' ');
  const output = [
    '디자인 수업에서 여러 사례를 조사하고 발표 자료를 정리했다.',
    '디자인이 사회적 가치를 만들고 생활을 개선하는 방식을 이해하면서 진로 목표의 방향도 한층 선명해졌다.'
  ].join(' ');
  const report = audit(source, output, { documentProfile: 'student_self_assessment' });
  assert.equal(report.warnings.some(item => item.code === 'speaker_removed'), true, JSON.stringify(report.warnings));
});

test('다듬기 모드에서는 대명사 삭제를 계속 화자 삭제로 본다', () => {
  const output = SOURCE_SINGULAR.replace('나의 생각을', '생각을');
  const report = audit(SOURCE_SINGULAR, output, { mode: 'polish' });
  assert.equal(report.warnings.some(item => item.code === 'speaker_removed'), true, JSON.stringify(report.warnings));
});

test('소유 위치의 우리만 빠진 문장은 집단 화자 삭제가 아니지만 주어 우리는 삭제는 경고한다', () => {
  const source = [
    '인공지능 기술은 빠르게 퍼지고 있다.',
    'AI나 빅데이터는 우리의 생활을 편리하게 만들어 주지만, 개인정보 유출이나 인간 소외 같은 문제를 일으키기도 한다.',
    '따라서 기술 발전 속도만이 아니라 그 방향을 함께 살펴야 한다고 본다.'
  ].join(' ');
  const possessiveDropped = [
    '인공지능 기술은 빠르게 퍼지고 있다.',
    'AI나 빅데이터는 생활을 편리하게 하지만, 개인정보 유출이나 인간 소외를 낳기도 한다.',
    '따라서 기술 발전 속도만이 아니라 그 방향을 함께 살펴야 한다고 본다.'
  ].join(' ');
  const report = audit(source, possessiveDropped);
  assert.equal(report.warnings.some(item => item.code === 'speaker_removed'), false, JSON.stringify(report.warnings));

  const subjectSource = [
    '인공지능 기술은 빠르게 퍼지고 있다.',
    '우리는 지역 도서관 세 곳의 이용 자료를 직접 조사해 표로 정리했다.',
    '따라서 기술 발전 속도만이 아니라 그 방향을 함께 살펴야 한다고 본다.'
  ].join(' ');
  const subjectDropped = [
    '인공지능 기술은 빠르게 퍼지고 있다.',
    '지역 도서관 세 곳의 이용 자료는 직접 조사돼 표로 정리됐다.',
    '따라서 기술 발전 속도만이 아니라 그 방향을 함께 살펴야 한다고 본다.'
  ].join(' ');
  const subjectReport = audit(subjectSource, subjectDropped);
  assert.equal(subjectReport.warnings.some(item => item.code === 'speaker_removed'), true, JSON.stringify(subjectReport.warnings));
});
