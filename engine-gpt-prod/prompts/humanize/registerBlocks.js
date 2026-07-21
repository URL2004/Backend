'use strict';

function registerBlock(register, documentProfile = null) {
  const profile = String(documentProfile?.profile || documentProfile || 'unknown');
  const lines = [];
  if (register === 'polite') lines.push('종결 기준: 원문의 ~습니다/~입니다 계열과 격식을 유지한다.');
  else if (register === 'haeyo') lines.push('종결 기준: 원문의 해요체와 친밀도를 유지한다.');
  else if (register === 'plain') lines.push('종결 기준: 원문의 평어체를 유지한다.');
  else lines.push('종결 기준: 원문에서 우세한 종결 흐름과 혼합 비율을 유지한다.');

  if (profile === 'resume_application') {
    lines.push('어휘 격식: 읽기 쉽게 만들되 자기소개서의 직무·성과·역량 어휘를 일상 대화 수준으로 낮추지 않는다.');
  } else if (profile === 'legal_contract') {
    lines.push('어휘 격식: 계약·약관의 정의어와 권리·의무·가능성 표현을 보존하고 구어체나 친근체로 낮추지 않는다.');
  } else if (['academic_paper', 'report_assignment'].includes(profile)) {
    lines.push('어휘 격식: 학술·보고서의 정확한 개념어를 보존하고, 구어적 축약이나 감탄형 표현을 새로 넣지 않는다.');
  } else if (['student_record_teacher', 'student_self_assessment'].includes(profile)) {
    lines.push('어휘 격식: 관찰자와 학생 화자의 차이를 유지하고, 평가 주체나 성취 강도를 높이는 표현을 새로 넣지 않는다.');
  } else if (profile === 'mail_notice') {
    lines.push('어휘 격식: 안내의 공손함과 행동 요청의 명확성을 유지하고 지나친 친근체로 낮추지 않는다.');
  }
  return lines.join('\n');
}

module.exports = { registerBlock };
