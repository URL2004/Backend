'use strict';

function genreBlock(_mode, register, _styleProfile = '', documentProfile = null) {
  const group = documentProfile?.group || 'unknown';
  const blocks = [];
  if (group === 'academic_report_explainer') blocks.push(academicReportBlock(register));
  else if (group === 'student_record_teacher') blocks.push(studentRecordTeacherBlock(register));
  else if (group === 'student_self_assessment') blocks.push(studentSelfAssessmentBlock(register));
  else if (group === 'essay_application') blocks.push(essayApplicationBlock(register, documentProfile?.profile));
  else if (group === 'blog_social') blocks.push(blogSocialBlock(documentProfile?.profile));
  else if (group === 'functional_copy') blocks.push(functionalCopyBlock(documentProfile?.profile));
  else if (group === 'creative') blocks.push(creativeBlock());
  else if (group === 'general') blocks.push(generalBlock(register));
  else blocks.push(unknownBlock(register));

  if (documentProfile?.formatProfile?.flags?.includes?.('questionnaire')) {
    blocks.push(questionnaireBlock());
  }
  blocks.push(tonePolicyBlock(documentProfile?.tonePolicy));
  return blocks.filter(Boolean).join('\n');
}

function academicReportBlock(register) {
  return [
    '[원문 장르: 학술·보고서·설명문]',
    '논지, 근거의 인과 방향, 학술 용어, 수치, 인용, 내부 참조와 절 구조를 유지한다.',
    '대조·부정·제한·양보·가능성 표현은 논리 연산자다. “~자체보다”를 “~에서 나아가”로, “~에 그치지 않고”를 “~이/가 아니라”로 바꾸지 말고 원문의 배제 범위와 강도를 그대로 남긴다.',
    '행위 주체와 대상을 바꾸지 않는다. 연구자가 시료를 표집한 문장을 시료 자체가 표집한 것처럼 쓰지 말고, 설명 평서문을 독자에게 하는 명령문으로 바꾸지 않는다.',
    '정보를 후기체·광고체로 바꾸거나 원문에 없는 해석과 결론을 덧붙이지 않는다.',
    '제목·절·표·목록과 논증 단계는 거시 구조로 잠근다. 다만 각 단계 안의 일반 서술은 절 배치·주어 위치·문장 경계를 조정해 기계적인 호흡을 풀어 쓴다.',
    '표·그림 제목·캡션·셀은 압축된 개념어를 유지하고 본문처럼 길게 풀어 쓰지 않는다.',
    '학술적 정확성을 낮추는 쉬운 말이나 구어체로 바꾸지 말고, 같은 전문 용어를 불필요하게 되풀이하는 문장만 자연스럽게 재구성한다.',
    '개념을 일상어로 낮출 때도 “재다·메우다”처럼 논문에 어색한 구어를 쓰지 않고, 플랫폼·도구가 사람에게 무엇을 “~해 준다”고 의인화하지 않는다.',
    `원문 종결체=${register}.`
  ].join('\n');
}

function studentRecordTeacherBlock(register) {
  return [
    '[원문 장르: 교사 세특·생활기록부]',
    '교사가 관찰한 학생의 행동, 성취, 평가 주체와 범위를 유지한다.',
    '학생 1인칭, 새 활동, 새 성취, 새 역량 평가를 만들지 않는다.',
    '관찰형·명사형 종결, 제목·항목 행, 문장별 길이 차이를 원문대로 보존한다.',
    `원문 종결체=${register}.`
  ].join('\n');
}

function studentSelfAssessmentBlock(register) {
  return [
    '[원문 장르: 학생 자기평가·성찰]',
    '학생이 실제로 한 활동, 맡은 역할, 배운 점, 부족했던 점과 서술 순서를 유지한다.',
    '원문에 없는 성취·감정·반성·진로 계획을 만들거나 교사 관찰자 시점으로 바꾸지 않는다.',
    '주어가 생략된 답변에는 새 1인칭을 반복 삽입하지 않고, 기존 시제와 개인적인 문장 리듬을 남긴다.',
    `원문 종결체=${register}.`
  ].join('\n');
}

function essayApplicationBlock(register, profile) {
  const label = profile === 'resume_application' ? '자기소개서·지원서' : '개인 에세이';
  const lines = [
    `[원문 장르: ${label}]`,
    '원문에 있는 경험, 감정, 성과, 시간 순서만 사용하고 장면이나 수치를 만들지 않는다.',
    '화자의 태도와 인칭을 유지하고, 없는 동기·교훈·포부를 보태지 않는다.',
    `원문 종결체=${register}.`
  ];
  if (profile === 'resume_application') {
    lines.splice(3, 0,
      '지원서의 전문성 하한을 지킨다. 설계·구성·분석·역량·피드백·교류·근무처럼 직무 의미가 있는 말을 단순히 짰다·봤다·힘·준·어울렸다·일했다 같은 가벼운 말로 낮추지 않는다.',
      '딱딱함은 문장 구조와 호흡으로 줄이되, 성과의 근거·본인의 행동·직무 연결은 명확한 업무 언어로 남긴다.');
  }
  return lines.join('\n');
}

function blogSocialBlock(profile) {
  return [
    `[원문 장르: ${profile === 'social' ? 'SNS' : '블로그·리뷰'}]`,
    '원문에 있는 정보와 체험만 사용하고 가짜 체험담, 감탄, 추천 근거를 추가하지 않는다.',
    '문장 길이를 모두 짧게 맞추거나 문단 크기를 대칭으로 만들지 않는다.',
    '정보성 글은 정보 흐름을, 후기 글은 실제 경험 순서를 유지한다.'
  ].join('\n');
}

function functionalCopyBlock(profile) {
  return [
    `[원문 장르: 광고·메일·기능문 / ${profile || 'unknown'}]`,
    '날짜, 대상, 조건, 연락처, 가격, 행동 요청과 책임 범위를 정확히 유지한다.',
    '원문에 없는 할인, 보장, 긴급성, 성과 주장이나 친근한 체험을 추가하지 않는다.',
    '짧은 문서는 불필요하게 늘리지 않는다.'
  ].join('\n');
}

function creativeBlock() {
  return [
    '[원문 장르: 시·창작문]',
    '행갈이, 장면 순서, 화자, 시제, 반복 장치를 구조로 취급한다.',
    '각 행을 합치거나 설명문으로 풀지 않고, 원문에 없는 이미지와 해석을 추가하지 않는다.'
  ].join('\n');
}

function generalBlock(register) {
  return [
    '[원문 장르: 일반 글]',
    '특정 장르의 상투적인 말투나 구성을 새로 입히지 않는다.',
    `원문의 화자, 종결체(${register}), 사실 순서와 문단 역할을 유지한다.`
  ].join('\n');
}

function unknownBlock(register) {
  return [
    '[원문 장르: 불확실 / 보존 우선]',
    '블로그·과제·광고 등 특정 장르를 추정해 화자나 구성을 새로 입히지 않는다.',
    `원문의 화자, 구조, 분량, 종결체(${register})를 우선 보존한다.`
  ].join('\n');
}

function questionnaireBlock() {
  return [
    '[형식: 질문지·문답형]',
    '질문 문구와 번호는 한 글자도 바꾸지 않는다.',
    '각 질문 아래의 답변만 그 경계 안에서 편집하고, 다른 답변으로 문장을 옮기지 않는다.',
    '답변마다 시제·화자·길이·종결어미를 같게 맞추지 않는다.'
  ].join('\n');
}

function tonePolicyBlock(tonePolicy) {
  if (tonePolicy === 'conversational') {
    return '말투 정책: 장르·화자·종결체를 바꾸지 않는 범위에서 단어 선택과 연결을 조금 더 친근하게 한다.';
  }
  if (tonePolicy === 'formal') {
    return '말투 정책: 장르·화자·종결체를 바꾸지 않는 범위에서 표현의 격식과 정확성을 유지한다.';
  }
  return '말투 정책: 별도 말투를 덧씌우지 않고 원문의 격식과 친밀도를 유지한다.';
}

module.exports = { genreBlock };
