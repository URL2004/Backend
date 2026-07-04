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
    '업체 후기나 안내문을 보고서체로 바꾸지 않는다.',
    '문단은 보통 2~4문장 흐름으로 둔다.'
  ];
  if (profile.includes('report')) {
    lines.push('단, 보고서형 블로그 프로필이면 해요체로 끌어내리지 말고 정보 전달 중심의 단정한 문체를 유지한다.');
  }
  return lines.join('\n');
}

function assignmentBlock(register, styleProfile = '') {
  const profile = String(styleProfile || '').toLowerCase();
  const lines = [
    '[문서 형태: 과제/보고서/설명문]',
    '차분한 제출용 문체를 유지한다.',
    '칼럼식 논평, 과한 수사, 개인 감상 추가를 금지한다.',
    '서론-본론-결론, 번호, 참고문헌 구조가 있으면 보존한다.',
    register === 'polite' ? '존댓말 보고서체를 유지한다.' : '평어체 보고서면 평어체를 유지하고 존댓말과 섞지 않는다.'
  ];
  if (profile.includes('long') || profile.includes('sectioned')) {
    lines.push('장문·섹션형 글은 각 항목의 논리 역할과 설명량을 유지하고 일부 항목을 결론으로 흡수하지 않는다.');
  }
  return lines.join('\n');
}

function adminPolishBlock(register) {
  return [
    '[문서 형태: 관리자 다듬기 검증]',
    '관리자 테스트에서만 사용하는 보존형 다듬기다.',
    '비문, 어색한 접속, 중복, 말투 혼합만 고친다.',
    '새 주장, 새 예시, 새 문단을 만들지 않는다.',
    register === 'polite' ? '존댓말 보고서체를 유지한다.' : '원문의 우세한 종결체를 유지한다.'
  ].join('\n');
}

module.exports = { genreBlock };
