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
    lines.push('역할 범위: 원문의 참여·지원·검토·협업을 직접 수행·주도·완료로 확대하지 않고, 수동으로 적용된 변경을 화자의 능동 행위로 바꾸지 않는다.');
  } else if (profile === 'legal_contract') {
    lines.push('어휘 격식: 계약·약관의 정의어와 권리·의무·가능성 표현을 보존하고 구어체나 친근체로 낮추지 않는다.');
  } else if (profile === 'clinical_record') {
    lines.push('어휘 격식: SOAP 구획별 임상 용어와 관찰·측정의 확실성 수준을 보존하고, 일상적 추측이나 구어체로 낮추지 않는다.');
    lines.push('임상 범주: 검사명, 슬래시로 묶인 반응 범주, 명사형 관찰 종결과 정보 출처를 그대로 유지한다.');
  } else if (['academic_paper', 'report_assignment', 'long_explainer'].includes(profile)) {
    lines.push('어휘 격식: 학술·보고서의 정확한 개념어를 보존하고, 구어적 축약이나 감탄형 표현을 새로 넣지 않는다.');
    lines.push('논리 강도: 여부와 정도, 필요와 불가능, 권고와 의무를 구분하고 원문보다 강하거나 약한 단정으로 바꾸지 않는다.');
  } else if (['student_record_teacher', 'student_self_assessment'].includes(profile)) {
    lines.push('어휘 격식: 관찰자와 학생 화자의 차이를 유지하고, 평가 주체나 성취 강도를 높이는 표현을 새로 넣지 않는다.');
  } else if (profile === 'mail_notice') {
    lines.push('어휘 격식: 안내의 공손함과 행동 요청의 명확성을 유지하고 지나친 친근체로 낮추지 않는다.');
  }
  return lines.join('\n');
}

module.exports = { registerBlock };
