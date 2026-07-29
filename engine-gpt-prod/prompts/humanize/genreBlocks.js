'use strict';

function genreBlock(_mode, register, _styleProfile = '', documentProfile = null, requestStrength = '') {
  const group = documentProfile?.group || 'unknown';
  const blocks = [];
  if (group === 'clinical_record') blocks.push(clinicalRecordBlock(register));
  else if (group === 'legal_contract') blocks.push(legalContractBlock(register));
  else if (group === 'academic_report_explainer') blocks.push(academicReportBlock(register));
  else if (group === 'student_record_teacher') blocks.push(studentRecordTeacherBlock(register));
  else if (group === 'student_self_assessment') blocks.push(studentSelfAssessmentBlock(register));
  else if (group === 'essay_application') blocks.push(essayApplicationBlock(register, documentProfile?.profile, requestStrength));
  else if (group === 'blog_social') blocks.push(blogSocialBlock(documentProfile?.profile));
  else if (group === 'functional_copy') blocks.push(functionalCopyBlock(documentProfile?.profile));
  else if (group === 'creative') blocks.push(creativeBlock());
  else if (group === 'general') blocks.push(generalBlock(register));
  else blocks.push(unknownBlock(register));

  if (documentProfile?.formatProfile?.flags?.includes?.('assessment_item')) {
    blocks.push(assessmentItemBlock());
  } else if (documentProfile?.formatProfile?.flags?.includes?.('questionnaire')) {
    blocks.push(questionnaireBlock());
  }
  blocks.push(tonePolicyBlock(
    documentProfile?.targetRegister || documentProfile?.tonePolicy,
    requestStrength
  ));
  return blocks.filter(Boolean).join('\n');
}

function clinicalRecordBlock(register) {
  return [
    '[원문 장르: SOAP·임상 전문 기록]',
    'SOAP의 S·O·A·P 구획, 대상자·평가일·평가 도구 라벨, 목록과 측정값의 위치를 그대로 유지한다.',
    'S의 주관적 보고, O의 관찰·측정, A의 임상적 해석, P의 계획을 서로 옮기거나 합치지 않는다.',
    '대상자, 보호자, 치료사 등 정보의 출처와 행위 주체를 바꾸지 않는다. 원문에 없는 진단·증상·원인·예후·치료 목표를 추가하지 않는다.',
    '검사명, 약어, 수치, 날짜, 빈도, 기간, 신체 부위와 좌우 방향을 원문 그대로 보존한다.',
    '슬래시·가운뎃점으로 병렬 표기된 감각·반응 범주를 임의로 합치거나 상하 관계로 바꾸지 않는다.',
    '임상 기록의 간결한 명사형·관찰형 종결을 일상 대화체로 풀거나 모든 항목을 완전한 설명문으로 늘리지 않는다.',
    `원문 종결체=${register}.`
  ].join('\n');
}

function legalContractBlock(register) {
  return [
    '[원문 장르: 계약서·약관]',
    '제N조의 번호·제목·순서와 조문 사이 경계를 그대로 유지한다. 조문을 다른 조로 옮기거나 합치지 않는다.',
    '갑·을·당사자·회사·이용자 등 행위 주체와 권리·의무의 귀속을 절대 바꾸지 않는다.',
    '부정, 예외, 조건, 가능성, 재량, 의무는 법적 의미를 이루는 연산자다. “할 수 있다”를 “한다”로, “하여야 한다”를 권고 표현으로 바꾸지 않는다.',
    '날짜·기간·금액·비율·통지 방식·해지 요건·관할과 준거법을 원문 그대로 보존한다.',
    '삼단 나열과 정의된 전문 용어를 반복이나 추상 표현으로 보고 삭제하지 않는다.',
    '자연스러움은 조문의 법적 효과를 낮추는 구어체가 아니라, 같은 조문 안에서 어색한 연결과 중복만 정리해 만든다.',
    `원문 종결체=${register}.`
  ].join('\n');
}

function academicReportBlock(register) {
  return [
    '[원문 장르: 학술·보고서·설명문]',
    '논지, 근거의 인과 방향, 학술 용어, 수치, 인용, 내부 참조와 절 구조를 유지한다.',
    '대조·부정·제한·양보·가능성 표현은 논리 연산자다. “~자체보다”를 “~에서 나아가”로 바꾸지 않는다. “~에 그치지 않고”와 “~이/가 아니라”도 서로 바꾸지 말고 원문의 인정·가산 또는 부정·배제 범위와 강도를 그대로 남긴다.',
    '여부를 정도로, 필요를 불가능으로, 검토 가능성을 확정 결론으로 바꾸지 않는다. 권고·전망·추정의 강도도 원문보다 세게 만들지 않는다.',
    '행위 주체와 대상을 바꾸지 않는다. 연구자가 시료를 표집한 문장을 시료 자체가 표집한 것처럼 쓰지 말고, 설명 평서문을 독자에게 하는 명령문으로 바꾸지 않는다.',
    '정보를 후기체·광고체로 바꾸거나 원문에 없는 해석과 결론을 덧붙이지 않는다.',
    '제목·절·표·목록과 논증 단계는 거시 구조로 잠근다. 다만 각 단계 안의 일반 서술은 절 배치·주어 위치·문장 경계를 조정해 기계적인 호흡을 풀어 쓴다.',
    '표·그림 제목·캡션·셀은 압축된 개념어를 유지하고 본문처럼 길게 풀어 쓰지 않는다.',
    '학술적 정확성을 낮추는 쉬운 말이나 구어체로 바꾸지 말고, 같은 전문 용어를 불필요하게 되풀이하는 문장만 자연스럽게 재구성한다.',
    '원문의 이론·법률·개념 주장이 외부 지식과 맞는지 추정하여 사실 교정하지 않는다. 근거가 주어지지 않은 의심스러운 주장도 의미와 한정 범위를 보존하고, 문장 표현만 고친다.',
    '원문의 게임·군사·신체 은유나 구어적 별칭은, 그것이 가리키는 실제 행위·상태·절차가 원문 같은 문장이나 앞뒤 문맥에 명시돼 있을 때에만 그 명시된 범위의 중립 표현으로 바꾼다. 대응 절차가 원문에 없거나 불확실하면 전문 용어를 추정하지 말고 원래 표현을 유지한다.',
    '게임식 조작 별칭, 시스템을 무기·신체·지형에 빗댄 표현, 익숙한 관용 비유도 직접 인용·정식 용어이거나 원문 안에서 실제 관계를 확인할 수 없으면 그대로 둔다. 외부 지식으로 숨은 절차를 만들어 풀어 쓰지 않는다.',
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
      '적용된 설계 변경을 검토했다고 쓴 경력을 본인이 변경을 직접 수행한 경력으로 넓히지 않는다. 참여·지원·협업·검토와 주도·총괄·전담·완료를 구분한다.',
      '통신의 전송, 시스템에 지정·설정된 상태, 검증·인허가 같은 기능어는 일상 동사로 바꾸지 않고 기술적 관계를 그대로 유지한다.',
      '“시험·검증한 결과”를 “시험해 보니”로, “비교 검토”를 “함께 놓고 비교”로 낮추지 않는다. 기술 경력서는 자연스럽게 쓰되 검증·비교·분석의 공식 문체를 유지한다.',
      '원문이 회로 설계, PCB 설계 검토, 자동 신고, 신고 화면 실행처럼 구현 범위를 구분했다면 그 경계를 그대로 쓴다. 문맥만 보고 직접 설계·자동 실행·전체 구현으로 넓히거나 줄이지 않는다.',
      '유속·유량처럼 비슷하지만 다른 기술 용어는 임의로 통일하지 않는다. Trade-off·trade-off·트레이드오프 같은 표기도 원문의 지배 표기를 따르며 새 혼용을 만들지 않는다.',
      '개선이 필요한 부분·주어진 업무를 수행하다·검사 기준을 숙지하다 같은 업무 표현도 손봐야 할 부분·그냥 하다·익히다처럼 가볍게 바꾸지 않는다. 자연스러움은 격식을 낮추는 것이 아니라 문장 구조와 호흡을 조정해 만든다.',
      '딱딱함은 문장 구조와 호흡으로 줄이되, 성과의 근거·본인의 행동·직무 연결은 명확한 업무 언어로 남긴다.',
      '제목이 없어도 원문의 각 완결 행·문단은 서로 다른 자기소개서 문항 답변일 수 있다. 다른 행의 경험·강점·지원 동기·포부를 한 문단으로 합치거나 서로 옮기지 않는다.',
      '현장실습·인턴 경험처럼 활동 단계별로 나뉜 글은 교육·설계 검토·현장 동행·환경 대응·계약 관리·안전 관리의 문단 경계를 유지한다. 각 단계에서 얻은 판단은 그 근거가 나온 문단 끝에 남긴다.',
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
  const lines = [
    `[원문 장르: 광고·메일·기능문 / ${profile || 'unknown'}]`,
    '날짜, 대상, 조건, 연락처, 가격, 행동 요청과 책임 범위를 정확히 유지한다.',
    '원문에 없는 할인, 보장, 긴급성, 성과 주장이나 친근한 체험을 추가하지 않는다.',
    '짧은 문서는 불필요하게 늘리지 않는다.'
  ];
  if (profile === 'mail_notice') {
    lines.push(
      '첫머리의 인사는 한 번만 사용한다. “인사드립니다” 뒤에 “안녕하십니까”를 새로 덧붙이는 중복 인사를 만들지 않는다.',
      '끝부분의 날짜·기관명·부서·직책·이름·드림/올림은 서명 블록이다. 내용을 바꾸거나 본문에 합치지 않고 줄 순서를 그대로 유지한다.'
    );
  }
  return lines.join('\n');
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

function assessmentItemBlock() {
  return [
    '[형식: 평가 문항·정답·해설]',
    '문항 안내, 지문, 대화의 화자와 발화, 선택지, 정답은 평가의 정합성을 이루는 보호 구조이므로 한 글자도 바꾸지 않는다.',
    '해설 제목 뒤의 설명 본문만 편집한다. 해설에서도 정답 번호, 오답 근거, 발화 주체와 시제를 바꾸지 않는다.',
    '선택지를 자연스럽게 고치거나 문항과 해설을 한 문단으로 합치지 않는다.'
  ].join('\n');
}

function tonePolicyBlock(targetRegister, requestStrength = '') {
  const formalTarget = ['academic_formal', 'clinical_formal', 'legal_formal', 'record_formal', 'student_formal', 'professional', 'functional_formal', 'formal']
    .includes(String(targetRegister || ''));
  if (requestStrength === 'advanced') {
    return formalTarget
      ? '말투 정책: 고급 강도와 격식 변경은 별개다. 화자·종결체와 원문의 공식·전문 격식을 유지하면서 일반 서술의 절 배치·연결·호흡을 넓게 재구성한다. 장르 하한보다 명백히 낮은 구어·게임식 별칭·과장 은유만 같은 의미의 중립적 전문 표현으로 바로잡고, 이미 적절한 어휘를 더 딱딱하게 올리지 않는다.'
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
