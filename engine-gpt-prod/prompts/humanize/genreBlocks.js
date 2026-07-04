'use strict';

function genreBlock(mode, register, styleProfile = '') {
  if (mode === 'blog') return blogBlock(styleProfile);
  if (mode === 'polish') return adminPolishBlock(register);
  return assignmentBlock(register, styleProfile);
}

function blogBlock(styleProfile = '') {
  const profile = String(styleProfile || '').toLowerCase();
  const lines = [
    '[문서 형태: 웹글/블로그]',
    '정보 전달과 자연스러운 흐름을 우선한다.',
    '친근하게 쓰되 과장, 광고성 단정, 문학적 표현은 낮춘다.',
    '현장감은 유지하되 “조용히 쌓입니다”, “청결감이 버팁니다”처럼 어색한 감성 표현은 담백하게 고친다.',
    '업체 후기나 안내문은 실제 작업 흐름이 보이는 문장으로 이어 쓴다.',
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
    '문장틀을 그대로 복사하지 말고, 항목별 논리 흐름 안에서 표현과 연결 방식을 재서술한다.'
  ];
  if (profile.includes('long') || profile.includes('sectioned')) {
    lines.push('장문·섹션형 글은 각 항목 안에서 문장을 바꾸고, 항목 간 역할을 임의로 합치지 않는다.');
  }
  return lines.join('\n');
}

function adminPolishBlock(register) {
  return [
    '[문서 형태: 관리자 다듬기 검증]',
    '관리자 테스트에서만 사용하는 보존형 다듬기다.',
    '비문, 어색한 접속, 중복, 말투 혼합만 고친다.',
    '새 주장, 새 예시, 새 문단을 만들지 않는다.'
  ].join('\n');
}

module.exports = { genreBlock };
