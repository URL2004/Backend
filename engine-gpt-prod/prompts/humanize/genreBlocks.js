'use strict';

function genreBlock(mode, register, styleProfile = '', documentProfile = null) {
  if (mode === 'polish') return polishBlock(register, documentProfile);
  const group = documentProfile?.group || 'unknown';
  if (group === 'academic_report_explainer') return academicReportBlock(mode, register);
  if (group === 'student_record') return studentRecordBlock(register);
  if (group === 'essay_application') return essayApplicationBlock(mode, register);
  if (group === 'blog_social') return blogSocialBlock(mode, styleProfile);
  if (group === 'functional_copy') return functionalCopyBlock(mode, documentProfile?.profile);
  if (group === 'creative') return creativeBlock();
  return unknownBlock(mode, register, styleProfile);
}

function blogBlock(styleProfile = '') {
  const profile = String(styleProfile || '').toLowerCase();
  const lines = [
    '[문서 형태: 웹글/블로그]',
    '정보 전달과 자연스러운 흐름을 우선한다.',
    '친근하게 쓰되 과장, 광고성 단정, 문학적 표현은 낮춘다.',
    '현장감은 유지하되 “조용히 쌓입니다”, “청결감이 버팁니다”처럼 어색한 감성 표현은 담백하게 고친다.',
    '업체 후기나 안내문은 원문에 적힌 범위 안에서 실제 작업 흐름이 보이도록 문장을 이어 쓴다.',
    '짧은 문장을 줄줄이 끊기보다 관련 문장을 자연스럽게 묶는다.'
  ];
  if (profile.includes('report')) {
    lines.push('보고서형 블로그 프로필이면 친근함보다 정보 전달 중심의 단정한 흐름을 우선한다.');
  }
  return lines.join('\n');
}

function assignmentBlock(register, styleProfile = '') {
  const profile = String(styleProfile || '').toLowerCase();
  const lines = [
    '[문서 형태: 과제/보고서/설명문]',
    '차분한 제출용 흐름으로 쓴다.',
    '칼럼식 논평이나 과한 수사 대신 설명 관계가 분명한 문장으로 바꾼다.',
    '실제로 어색한 문장틀만 항목별 논리 흐름 안에서 표현과 연결 방식을 다듬는다.'
  ];
  if (profile.includes('long') || profile.includes('sectioned')) {
    lines.push('장문·섹션형 글은 각 항목 안에서 문장을 바꾸고, 항목 간 역할을 임의로 합치지 않는다.');
  }
  return lines.join('\n');
}

function polishBlock(register, documentProfile) {
  return [
    `[문서 형태: 보존형 윤문 / ${documentProfile?.profile || 'unknown'}]`,
    '비문, 어색한 접속, 중복, 말투 혼합만 고친다.',
    '새 주장, 새 예시, 새 문단, 새 화자를 만들지 않는다.',
    `원문의 ${register || 'mixed'} 종결체를 그대로 유지한다.`
  ].join('\n');
}

function academicReportBlock(mode, register) {
  return [
    '[원문 장르: 학술·보고서·설명문]',
    '논지, 근거의 인과 방향, 학술 용어, 내부 참조와 절 구조를 그대로 유지한다.',
    '정보를 친근한 후기체나 광고체로 바꾸지 않는다.',
    `요청 모드=${mode}, 원문 종결체=${register}. 요청 강도 안에서만 문장 흐름을 다듬는다.`
  ].join('\n');
}

function studentRecordBlock(register) {
  return [
    '[원문 장르: 세특·생활기록부]',
    '교사가 관찰한 학생의 행동과 역량 범위를 보존한다.',
    '학생 1인칭, 새 활동, 새 성취, 새 평가를 만들지 않는다.',
    `명사형·관찰형 종결과 ${register} 문체를 원문 비율대로 유지한다.`
  ].join('\n');
}

function essayApplicationBlock(mode, register) {
  return [
    '[원문 장르: 에세이·자소서]',
    '원문에 있는 경험·감정·성과만 사용하고 장면이나 수치를 만들어내지 않는다.',
    '화자의 태도와 경험 순서를 보존하면서 상투적인 자기소개 문구만 필요한 만큼 줄인다.',
    `요청 모드=${mode}, 종결체=${register}.`
  ].join('\n');
}

function blogSocialBlock(mode, styleProfile) {
  return [
    blogBlock(styleProfile),
    `요청 모드=${mode}. 원문에 없는 체험담, 감탄, 추천 근거를 추가하지 않는다.`,
    '문장 길이를 모두 짧게 맞추거나 문단 크기를 대칭으로 만들지 않는다.'
  ].join('\n');
}

function functionalCopyBlock(mode, profile) {
  return [
    `[원문 장르: 광고·메일·짧은 기능문 / ${profile || 'unknown'}]`,
    '날짜, 대상, 조건, 연락처, 가격, 행동 요청을 정확히 보존한다.',
    '원문에 없는 할인·보장·긴급성·친근한 체험을 추가하지 않는다.',
    `요청 모드=${mode}. 짧은 문서는 짧게 유지한다.`
  ].join('\n');
}

function creativeBlock() {
  return [
    '[원문 장르: 시·창작문]',
    '행갈이, 장면 순서, 화자, 반복 장치를 구조로 취급한다.',
    '각 행을 합치거나 설명문으로 풀지 않는다. 오탈자와 명백한 비문만 문맥 안에서 다듬는다.'
  ].join('\n');
}

function unknownBlock(mode, register, styleProfile) {
  return [
    '[원문 장르: 불확실 / 보존 우선]',
    '블로그·과제·광고 등 특정 장르를 추정해 말투나 구성을 새로 입히지 않는다.',
    `요청 모드=${mode}, 원문 종결체=${register}. 원문의 화자·구조·분량을 유지하며 명백히 어색한 곳만 다듬는다.`,
    String(styleProfile || '').toLowerCase().includes('report')
      ? '사용자 스타일 힌트는 격식 유지에만 참고하고 장르 사실로 취급하지 않는다.'
      : '사용자 스타일 힌트는 문장 친밀도에만 참고하고 장르 사실로 취급하지 않는다.'
  ].join('\n');
}

module.exports = { genreBlock };
