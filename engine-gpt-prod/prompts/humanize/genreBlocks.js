'use strict';

function genreBlock(_mode, register, _styleProfile = '', documentProfile = null, requestStrength = '') {
  const group = documentProfile?.group || 'unknown';
  const blocks = [];
  if (group === 'academic_report_explainer') blocks.push(academicReportBlock(register));
  else if (group === 'student_record_teacher') blocks.push(studentRecordTeacherBlock(register));
  else if (group === 'student_self_assessment') blocks.push(studentSelfAssessmentBlock(register));
  else if (group === 'essay_application') blocks.push(essayApplicationBlock(register, documentProfile?.profile, requestStrength));
  else if (group === 'blog_social') blocks.push(blogSocialBlock(documentProfile?.profile));
  else if (group === 'functional_copy') blocks.push(functionalCopyBlock(documentProfile?.profile));
  else if (group === 'creative') blocks.push(creativeBlock());
  else if (group === 'general') blocks.push(generalBlock(register));
  else blocks.push(unknownBlock(register));

  if (documentProfile?.formatProfile?.flags?.includes?.('questionnaire')) {
    blocks.push(questionnaireBlock());
  }
  blocks.push(tonePolicyBlock(
    documentProfile?.targetRegister || documentProfile?.tonePolicy,
    requestStrength
  ));
  return blocks.filter(Boolean).join('\n');
}

function academicReportBlock(register) {
  return [
    '[원문 장르: 학술·보고서·설명문]',
    '논지, 근거의 인과 방향, 학술 용어, 수치, 인용, 내부 참조와 절 구조를 유지한다.',
    '대조·부정·제한·양보·가능성 표현은 논리 연산자다. “~자체보다”를 “~에서 나아가”로 바꾸지 않는다. “~에 그치지 않고”와 “~이/가 아니라”도 서로 바꾸지 말고 원문의 인정·가산 또는 부정·배제 범위와 강도를 그대로 남긴다.',
    '행위 주체와 대상을 바꾸지 않는다. 연구자가 시료를 표집한 문장을 시료 자체가 표집한 것처럼 쓰지 말고, 설명 평서문을 독자에게 하는 명령문으로 바꾸지 않는다.',
    '정보를 후기체·광고체로 바꾸거나 원문에 없는 해석과 결론을 덧붙이지 않는다.',
    '제목·절·표·목록과 논증 단계는 거시 구조로 잠근다. 다만 각 단계 안의 일반 서술은 절 배치·주어 위치·문장 경계를 조정해 기계적인 호흡을 풀어 쓴다.',
    '표·그림 제목·캡션·셀은 압축된 개념어를 유지하고 본문처럼 길게 풀어 쓰지 않는다.',
    '학술적 정확성을 낮추는 쉬운 말이나 구어체로 바꾸지 말고, 같은 전문 용어를 불필요하게 되풀이하는 문장만 자연스럽게 재구성한다.',
    '원문의 이론·법률·개념 주장이 외부 지식과 맞는지 추정하여 사실 교정하지 않는다. 근거가 주어지지 않은 의심스러운 주장도 의미와 한정 범위를 보존하고, 문장 표현만 고친다.',
    '원문 자체에 게임·군사·신체 은유나 구어적 별칭이 남아 있더라도 공식 보고서의 핵심 서술에는 그대로 복사하지 않는다. 실제 행위·상태·절차를 가리키는 중립적 전문 표현으로 바꾸되 사실과 인과는 유지한다.',
    '게임식 조작 별칭, 시스템을 무기·신체·지형에 빗댄 표현, 익숙한 관용 비유는 직접 인용이나 해당 분야의 정식 용어가 아닌 한 실제 절차·상태·관계를 드러내는 문장으로 풀어 쓴다.',
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

function essayApplicationBlock(register, profile, requestStrength = '') {
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
      '개선이 필요한 부분·주어진 업무를 수행하다·검사 기준을 숙지하다 같은 업무 표현도 손봐야 할 부분·그냥 하다·익히다처럼 가볍게 바꾸지 않는다. 자연스러움은 격식을 낮추는 것이 아니라 문장 구조와 호흡을 조정해 만든다.',
      '딱딱함은 문장 구조와 호흡으로 줄이되, 성과의 근거·본인의 행동·직무 연결은 명확한 업무 언어로 남긴다.',
      '제목이 없어도 원문의 각 완결 행·문단은 서로 다른 자기소개서 문항 답변일 수 있다. 다른 행의 경험·강점·지원 동기·포부를 한 문단으로 합치거나 서로 옮기지 않는다.',
      '지원 동기·현재의 어려움·참여 후 계획처럼 문단 역할이 나뉜 글에서는 같은 지원 전제나 고민을 문단마다 완전한 문장으로 되풀이하지 않는다. 첫 언급은 충분히 설명하고 뒤에서는 짧게 받은 뒤, 그 문단에 원래 있던 구체적인 이유나 행동 계획을 앞세운다.',
      '학교·기관 맞춤성을 높인다는 이유로 SOURCE에 없는 프로그램명, 관심 분야, 질문 내용, 과거 탐색 경험을 만들어 내지 않는다. 원문 정보만으로 반복과 추상적인 결론을 줄인다.');
    if (requestStrength === 'advanced') {
      lines.splice(5, 0,
        '고급에서는 “역량을 길렀다·능력을 키웠다·노력했다·역량을 갖추었다” 같은 자기평가형 결론이 연속되면 그대로 반복하지 않는다. 원문에 있는 수행과 확인 가능한 결과를 문장 앞에 두고, 그 행동이 보여 주는 역량을 직접 드러낸다.',
        '첫 문단만 재작성하고 뒤 문단을 복사하지 않는다. 각 경험 문단에서 바꿀 대상이 있으면 원래 경험·성과·순서를 지킨 채 어순과 절 구조를 고르게 재구성한다.',
        '연구개발 지원서에서는 변화를 만들기 위해 전문 개념을 일상어로 낮추지 않는다. 원문의 공정 최적화·구조/성능 상관관계·원인 분석·재현성 검증·정량/수치화·데이터 해석 같은 직무 용어는 같은 주장 안에서 정확도를 유지한다.',
        '데이터가 보고서·논문을 작성하는 것처럼 주어와 목적어를 바꾸지 않고, 피드백을 반복했다고 쓰지 않는다. 문장을 나누거나 합칠 때도 행위 주체·대상·순서를 유지한다.');
    }
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

function tonePolicyBlock(targetRegister, requestStrength = '') {
  const formalTarget = ['academic_formal', 'record_formal', 'student_formal', 'professional', 'functional_formal', 'formal']
    .includes(String(targetRegister || ''));
  if (requestStrength === 'advanced') {
    return formalTarget
      ? '말투 정책: 화자·종결체는 유지하되 목표 격식은 공식·전문 문체다. 원문의 구어·게임식 별칭·과장 은유까지 보존하지 말고 중립적 전문 표현으로 높이면서 일반 서술을 고급 범위로 실질 재구성한다.'
      : '말투 정책: 원문의 격식·화자·종결체는 유지하되, 이는 원문 어휘와 문장 배열을 보존형으로 복사하라는 뜻이 아니다. 일반 서술은 고급 범위로 실질 재구성한다.';
  }
  if (targetRegister === 'conversational') {
    return '말투 정책: 장르·화자·종결체를 바꾸지 않는 범위에서 단어 선택과 연결을 조금 더 친근하게 한다.';
  }
  if (formalTarget) {
    return '말투 정책: 장르·화자·종결체를 바꾸지 않는 범위에서 공식·전문 문체의 격식과 정확성을 지킨다. 원문에 남은 명백한 구어·과장 은유는 중립적인 장르 표현으로 정리한다.';
  }
  return '말투 정책: 별도 말투를 덧씌우지 않고 원문의 격식과 친밀도를 유지한다.';
}

module.exports = { genreBlock };
