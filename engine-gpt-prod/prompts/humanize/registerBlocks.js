'use strict';

function registerBlock(register, documentProfile = null, { mode = 'assignment', requestStrength = '' } = {}) {
  const profile = String(documentProfile?.profile || documentProfile || 'unknown');
  const lines = [];
  if (register === 'polite') lines.push('종결 기준: 원문의 ~습니다/~입니다 계열과 격식을 유지한다.');
  else if (register === 'haeyo') lines.push('종결 기준: 원문의 해요체와 친밀도를 유지한다.');
  else if (register === 'plain') lines.push('종결 기준: 원문의 평어체를 유지한다.');
  else if (mode === 'polish') {
    lines.push('종결 기준: 인용·목록·화자 전환처럼 의도된 혼합은 유지하고, 같은 화자·같은 절 안에서 우연히 섞인 종결만 지배 종결체에 맞춘다.');
  } else {
    lines.push('종결 기준: 원문에서 우세한 종결 흐름과 의도된 혼합 비율을 유지한다.');
  }

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
  } else if (['review_blog', 'blog_review', 'social', 'social_caption'].includes(profile)) {
    lines.push('어휘 격식: 원문의 실제 후기·대화체 친밀도를 유지하되 광고 문구처럼 과장하거나 보고서체로 올리지 않는다.');
  } else if (['marketing', 'marketing_ad'].includes(profile)) {
    lines.push('어휘 격식: 홍보 목적은 유지하되 원문에 없는 체험·효능·절대적 보장이나 과도한 감탄을 새로 만들지 않는다.');
  } else if (['personal_essay', 'general_essay'].includes(profile)) {
    lines.push('어휘 격식: 화자의 개인적 리듬과 감정 강도를 유지하고 모범답안식 결론이나 업무 보고서체를 덧씌우지 않는다.');
  } else if (profile === 'creative') {
    lines.push('어휘 격식: 시적 어휘·행갈이·의도된 비문과 반복을 일반 설명문 문체로 교정하지 않는다.');
  } else {
    lines.push('어휘 격식: 특정 장르의 말투를 새로 입히지 않고 원문의 친밀도와 전문성 수준을 유지한다.');
  }
  if (requestStrength === 'advanced') {
    lines.push('강도와 격식은 별개다. 고급에서도 격식을 올리거나 낮추지 말고, 같은 격식 안에서 문장 구조와 호흡을 더 넓게 재구성한다.');
  }
  return lines.join('\n');
}

module.exports = { registerBlock };
