'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const refinement = require('../engine-gpt-prod/koreanRefinement');

test('따옴표로 시작한 자소서 산문의 닫는 부호 경계만 안전하게 띄운다', () => {
  const source = '‘빨리 먹은 밥은 체한다’어린 시절부터 정해진 과정을 지키는 태도를 배웠습니다.';
  const profile = { profile: 'resume_application', targetRegister: 'professional' };
  const audit = refinement.analyzeKoreanRefinement({
    source,
    outputText: source,
    documentProfile: profile,
    mode: 'assignment'
  });
  assert.equal(audit.version, 26);
  assert.ok(audit.issueCodes.includes('closed_quote_spacing'));
  assert.ok(audit.sourceReviewWarnings.some(item => item.code === 'quote_terminal_punctuation_review'));

  const repaired = refinement.applySafeDeterministicRepairs({ source, outputText: source, documentProfile: profile });
  assert.equal(repaired.text, '‘빨리 먹은 밥은 체한다’ 어린 시절부터 정해진 과정을 지키는 태도를 배웠습니다.');
  assert.ok(repaired.changeCodes.includes('closed_quote_spacing'));

  const attachedParticle = '저의 좌우명은 ‘끝까지 책임진다’라는 문장입니다.';
  const particleAudit = refinement.analyzeKoreanRefinement({ source: attachedParticle, outputText: attachedParticle, documentProfile: profile });
  assert.equal(particleAudit.issueCodes.includes('closed_quote_spacing'), false);
  assert.equal(particleAudit.sourceReviewWarnings.some(item => item.code === 'quote_terminal_punctuation_review'), false);
  assert.equal(refinement.applySafeDeterministicRepairs({ source: attachedParticle, outputText: attachedParticle }).text, attachedParticle);

  const formalCopula = 'AI 기반 교육의 가능성은 학습의 ‘개인화’와 ‘사각지대 해소’였습니다.';
  const formalAudit = refinement.analyzeKoreanRefinement({
    source: formalCopula,
    outputText: formalCopula,
    documentProfile: profile
  });
  assert.equal(formalAudit.issueCodes.includes('closed_quote_spacing'), false, JSON.stringify(formalAudit));
  assert.equal(
    refinement.applySafeDeterministicRepairs({ source: formalCopula, outputText: formalCopula }).text,
    formalCopula
  );
});

test('엔진이 만든 서로 상호작용 중복은 제거하고 도움·비교절 중복은 국소 수리 대상으로 잡는다', () => {
  const source = '학교는 여러 구성원이 상호작용하며 운영된다. 주민이 필요한 지원을 받을 수 있도록 안내하겠습니다.';
  const output = '학교는 여러 구성원이 서로 상호작용하며 운영된다. 주민이 실질적인 도움을 받을 수 있게 돕겠습니다. 절차를 꼼꼼히 챙기며 빠른 성과를 내기 위해 서두르기보다 과정에 충실하겠습니다.';
  const profile = { profile: 'resume_application', targetRegister: 'professional' };
  const audit = refinement.analyzeKoreanRefinement({ source, outputText: output, documentProfile: profile, mode: 'assignment' });
  assert.ok(audit.issueCodes.includes('reciprocal_expression_redundancy'));
  assert.ok(audit.repairableCodes.includes('benefit_help_predicate_redundancy'));
  assert.ok(audit.repairableCodes.includes('contrast_clause_attachment'));

  const repaired = refinement.applySafeDeterministicRepairs({ source, outputText: output, documentProfile: profile });
  assert.match(repaired.text, /여러 구성원이 상호작용하며/u);
  assert.doesNotMatch(repaired.text, /서로\s+상호작용/u);
});

test('지원 이후 역할의 시제 의심은 원문 검토 알림으로만 남기고 자동 교정하지 않는다', () => {
  const source = '이런 경험들은 제가 공직에서 마주한 여러 상황을 풀어 내는 밑거름이 될 것입니다. 시간을 효율적으로 관리하려고 마감 기한을 여유 있게 잡았습니다. 이를 위해 입사 후 두 가지 계획을 실천하겠습니다.';
  const audit = refinement.analyzeKoreanRefinement({
    source,
    outputText: source,
    documentProfile: { profile: 'resume_application', targetRegister: 'professional' },
    mode: 'assignment'
  });
  assert.ok(audit.sourceReviewWarnings.some(item => item.code === 'future_role_tense_review'));
  assert.ok(audit.sourceReviewWarnings.some(item => item.code === 'resume_weakness_mitigation_review'));
  assert.ok(audit.sourceReviewWarnings.some(item => item.code === 'public_service_employment_term_review'));
  assert.equal(audit.issueCodes.includes('future_role_tense_review'), false);
  const repaired = refinement.applySafeDeterministicRepairs({ source, outputText: source });
  assert.equal(repaired.text, source);
});

test('공식 지원서의 장식적 디딤돌·동행자 결론은 직접 인용 밖에서만 수리 대상으로 잡는다', () => {
  const profile = { profile: 'resume_application', targetRegister: 'professional' };
  const source = '주민의 이야기를 듣고 절차를 설명하겠습니다.';
  const output = '끝까지 곁을 지키는 디딤돌이 되겠습니다. 주민의 든든한 동행자이자 따뜻한 조력자가 되겠습니다.';
  const audit = refinement.analyzeKoreanRefinement({ source, outputText: output, documentProfile: profile, mode: 'assignment' });
  const issue = audit.issues.find(item => item.code === 'formal_register_residual');
  assert.ok(issue?.details?.families?.includes('resume_ornamental_closing'));

  const quoted = refinement.analyzeKoreanRefinement({
    source: '저의 좌우명은 “누군가의 든든한 동행자가 되자”입니다.',
    outputText: '저의 좌우명은 “누군가의 든든한 동행자가 되자”입니다.',
    documentProfile: profile,
    mode: 'assignment'
  });
  assert.equal(quoted.issueCodes.includes('formal_register_residual'), false);
});

test('공식 보고서의 구어적 게임·군사 은유 잔존을 잡고 직접 인용은 보호한다', () => {
  const source = '운영 절차는 부검-표적수술 사이클로 이어졌다. 무휴식 모드와 역타기를 적용했고 서버 탄환 십여 발을 사용했다. 결과는 양날의 검이었다.';
  const profile = { profile: 'report_assignment', targetRegister: 'academic_formal' };
  const residual = refinement.analyzeKoreanRefinement({
    source,
    outputText: source,
    documentProfile: profile,
    mode: 'assignment'
  });
  const issue = residual.issues.find(item => item.code === 'formal_register_residual');
  assert.ok(issue?.afterCount >= 4, JSON.stringify(residual));
  assert.equal(residual.pass, false);

  const cleaned = refinement.analyzeKoreanRefinement({
    source,
    outputText: '운영 절차는 장애 원인 분석과 표적 조치 순서로 이어졌다. 중단 없는 운용 조건과 역방향 전환을 적용했고 서버 요청을 여러 차례 실행했다. 결과에는 이점과 위험이 함께 있었다.',
    documentProfile: profile,
    mode: 'assignment'
  });
  assert.equal(cleaned.issueCodes.includes('formal_register_residual'), false, JSON.stringify(cleaned));

  const quoted = refinement.analyzeKoreanRefinement({
    source: '보고서는 “양날의 검”이라는 직접 인용을 분석했다.',
    outputText: '보고서는 “양날의 검”이라는 직접 인용을 분석했다.',
    documentProfile: profile,
    mode: 'assignment'
  });
  assert.equal(quoted.issueCodes.includes('formal_register_residual'), false);

  const literalDomains = refinement.analyzeKoreanRefinement({
    source: '임상 의료 보고서는 환자의 수술과 병변 진단 절차를 설명한다. 군사 훈련에서는 표적 사격과 탄환 관리를 기록한다. 지리 조사는 큰 골짜기의 지형을 측정한다.',
    outputText: '임상 의료 보고서는 환자의 수술과 병변 진단 절차를 설명한다. 군사 훈련에서는 표적 사격과 탄환 관리를 기록한다. 지리 조사는 큰 골짜기의 지형을 측정한다.',
    documentProfile: profile,
    mode: 'assignment'
  });
  assert.equal(literalDomains.issueCodes.includes('formal_register_residual'), false);
});

test('목적 관형어·인지 서술어 중첩·대화 연어와 표집 주체 오류를 검출한다', () => {
  const text = [
    '공정한 사회를 만들 정책과 제도를 더 깊이 고민하게 된다고 생각했다.',
    '참여자에게 대화를 건넸다.',
    '두보 시는 기준에 따라 목적표집하였다.'
  ].join(' ');
  const issues = new Set(refinement.detectTextIssues(text, {
    profile: 'academic_paper', targetRegister: 'academic_formal'
  }).map(item => item.code));
  assert.ok(issues.has('purpose_modifier_collocation'));
  assert.ok(issues.has('metacognitive_predicate_stack'));
  assert.ok(issues.has('dialogue_give_collocation'));
  assert.ok(issues.has('sampling_subject_mismatch'));

  const passive = refinement.detectTextIssues('두보의 시는 같은 기준에 따라 목적 표집되었다.', {
    profile: 'academic_paper', targetRegister: 'academic_formal'
  }).map(item => item.code);
  assert.equal(passive.includes('sampling_subject_mismatch'), false);
});

test('문장부호·수량 괄호 붙임과 새로 생긴 깊게 이해 결합만 안전하게 고친다', () => {
  const source = '가정을 세웠다. 아버지는 두 사례를 깊이 이해했습니다. 목록(3개)에서 항목을 골랐습니다.';
  const output = '가정을 세웠다.아버지는 2가지)어머니의 사례를 깊게 이해했습니다. 목록(3개)에서 항목을 골랐습니다.';
  const repaired = refinement.applySafeDeterministicRepairs({ source, outputText: output });
  assert.equal(repaired.applied, true);
  assert.match(repaired.text, /세웠다\. 아버지는/u);
  assert.match(repaired.text, /2가지\) 어머니/u);
  assert.match(repaired.text, /깊이 이해했습니다/u);
  assert.match(repaired.text, /목록\(3개\)에서/u, '괄호 뒤 조사는 띄우지 않아야 한다');
  assert.deepEqual(new Set(repaired.changeCodes), new Set([
    'missing_sentence_space',
    'numeric_parenthesis_join',
    'deep_understanding_collocation'
  ]));
});

test('변환 중 새로 생긴 한글 토큰 중복 오타를 검출하고 원문 어휘로 안전 복원한다', () => {
  const source = '지역 복지 정책은 주민의 생활 안정에 기여합니다.';
  const output = '지역 복복지 정책은 주민의 생활 안정에 기여합니다.';
  const audit = refinement.analyzeKoreanRefinement({ source, outputText: output });
  const issue = audit.issues.find(item => item.code === 'introduced_token_duplication');
  assert.equal(issue?.introducedCount, 1, JSON.stringify(audit));
  assert.equal(issue?.details?.mappings?.[0]?.outputToken, '복복지');

  const repaired = refinement.applySafeDeterministicRepairs({ source, outputText: output });
  assert.equal(repaired.text, source);
  assert.ok(repaired.changeCodes.includes('introduced_token_duplication'));

  const quoted = refinement.applySafeDeterministicRepairs({
    source: '보고서는 “복지”라는 표현을 분석합니다.',
    outputText: '보고서는 “복복지”라는 표현을 분석합니다.'
  });
  assert.match(quoted.text, /“복복지”/u, '직접 인용 내부는 결정론적으로 바꾸지 않아야 한다');

  const validParticle = refinement.analyzeKoreanRefinement({
    source: '외부 전문가 의견을 들었습니다.',
    outputText: '외부 전문가가 검토에 참여했습니다.'
  });
  assert.equal(validParticle.issueCodes.includes('introduced_token_duplication'), false, '전문가+가를 중복 오타로 오인하지 않아야 한다');

  const validAuxiliaryParticle = refinement.analyzeKoreanRefinement({
    source: '분석 강도를 확인했습니다.',
    outputText: '분석 강도도 함께 확인했습니다.'
  });
  assert.equal(
    validAuxiliaryParticle.issueCodes.includes('introduced_token_duplication'),
    false,
    '강도+도처럼 명사 끝과 보조사가 같은 정상 결합을 중복 오타로 오인하지 않아야 한다'
  );

  const validVerbEnding = refinement.analyzeKoreanRefinement({
    source: '두 절의 논의가 자연스럽게 이어지는지 살폈습니다.',
    outputText: '두 절의 논의가 자연스럽게 이어지지 않는 부분을 살폈습니다.'
  });
  assert.equal(
    validVerbEnding.issueCodes.includes('introduced_token_duplication'),
    false,
    '이어지지처럼 용언 어간과 부정 연결어미가 만난 정상 활용을 중복 오타로 오인하지 않아야 한다'
  );

  const normalRepeatedLexemes = [
    {
      source: '자기 감정은 스스로 알아차리고 조절할 수 있습니다.',
      output: '거듭 나타나는 생각과 감정의 패턴을 스스로 알아차립니다.'
    },
    {
      source: '교육을 이수한 부부에게 안내문을 제공합니다.',
      output: '예비 부부와 교육을 이수한 부부에게 안내합니다.'
    },
    {
      source: '주가 상승이 주주에게 미치는 영향을 분석했습니다.',
      output: '주주가 의결권을 행사하고 주가도 확인했습니다.'
    },
    {
      source: '표현의 의의를 검토했습니다.',
      output: '이 연구의 의의와 한계를 함께 검토했습니다.'
    }
  ];
  for (const item of normalRepeatedLexemes) {
    const audit = refinement.analyzeKoreanRefinement({
      source: item.source,
      outputText: item.output
    });
    assert.equal(
      audit.issueCodes.includes('introduced_token_duplication'),
      false,
      `${item.output}을 반복 오타로 오인하지 않아야 한다`
    );
    const repaired = refinement.applySafeDeterministicRepairs({
      source: item.source,
      outputText: item.output
    });
    assert.equal(repaired.text, item.output, '정상 반복 음절을 결정론적으로 삭제하지 않아야 한다');
  }
});

test('원문에 있던 깊게 이해는 자동 변경하지 않고 원문 검토 알림으로 분리한다', () => {
  const source = '원리를 깊게 이해하려고 했습니다.';
  const repaired = refinement.applySafeDeterministicRepairs({ source, outputText: source });
  assert.equal(repaired.applied, false);
  const audit = refinement.analyzeKoreanRefinement({ source, outputText: source });
  assert.ok(audit.sourceReviewWarnings.some(item => item.code === 'deep_understanding_collocation'));
  assert.equal(audit.sourceReviewWarnings[0].severity, 'notice');
});

test('빈도 충돌과 어색한 초점 연결을 문맥 수리 대상으로 검출한다', () => {
  const text = '그때마다 고객에게서 같은 말을 자주 들었습니다. 시장 접근 방식이 어떻게 달라지는지도 중심에 두고 분석했습니다.';
  const audit = refinement.analyzeKoreanRefinement({ source: text, outputText: text, documentProfile: 'resume_application' });
  assert.ok(audit.repairableCodes.includes('frequency_quantifier_conflict'));
  assert.ok(audit.repairableCodes.includes('awkward_focus_attachment'));
  assert.equal(audit.introducedIssueCount, 0);
});

test('변환 중 새로 생긴 인용 조사·이중 주제·어미·연어 비문을 문장 단위로 검출한다', () => {
  const source = [
    '저희는 “AI는 인간이 될 수 없다.”라는 입장을 주장합니다.',
    '이번 활동을 하면서 나는 예술 작품을 새롭게 바라보았습니다.',
    '실험 조건에 따라 성능에 어떤 차이가 생겼는지 확인했습니다.',
    '가치에 동참하는 행동이며 소비가 확대될수록 영향도 커집니다.'
  ].join(' ');
  const output = [
    '저희는 “AI는 인간이 될 수 없다.”는 입장을 주장합니다.',
    '이번 활동을 하면서 나는 예술 작품은 새롭게 바라보았습니다.',
    '실험 조건에 따라 성능에 어떤 차이가 저는지 확인했습니다.',
    '가치에 함께하는 행동이며 소비가 넓어질수록 영향도 커집니다.'
  ].join(' ');
  const audit = refinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'report_assignment' }
  });
  const codes = new Set(audit.issueCodes);
  assert.ok(codes.has('quote_attribution_particle_mismatch'), JSON.stringify(audit));
  assert.ok(codes.has('double_topic_chain'), JSON.stringify(audit));
  assert.ok(codes.has('malformed_question_ending'), JSON.stringify(audit));
  assert.ok(codes.has('value_participation_collocation'), JSON.stringify(audit));
  assert.ok(codes.has('scope_expansion_collocation'), JSON.stringify(audit));
  assert.ok(audit.introducedIssueCount >= 5);
});

test('정상적인 인용 연결·가치와 함께하는 표현·기준 이해는 격식 오류로 오탐하지 않는다', () => {
  const text = '연구진은 “추가 검토가 필요하다.”는 입장을 밝혔습니다. 사회적 가치와 함께하는 활동이며 업무 기준을 이해했습니다. 저는 이 구절에서 특히 깊은 인상을 받았습니다.';
  const audit = refinement.analyzeKoreanRefinement({
    source: text,
    outputText: text,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.equal(audit.issueCodes.includes('quote_attribution_particle_mismatch'), false);
  assert.equal(audit.issueCodes.includes('value_participation_collocation'), false);
  assert.equal(audit.issueCodes.includes('double_topic_chain'), false);
  assert.equal(audit.issueCodes.includes('professional_register_downgrade'), false);
});

test('지원서의 전문 개념어가 구어체로 모두 내려간 경우 격식 하락을 기록한다', () => {
  const source = '발표 흐름을 설계하고 자료를 분석해 전달 역량을 키웠습니다. 피드백을 반영했고 학생들과 교류했으며 편의점에서 근무했습니다.';
  const output = '발표 흐름부터 짰고 자료를 함께 봐서 전달하는 힘을 키웠습니다. AI가 준 내용을 반영했고 학생들과 어울렸으며 다시 일한 편의점 아르바이트에서도 배웠습니다.';
  const audit = refinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'resume_application' }
  });
  assert.ok(audit.issueCodes.includes('professional_register_downgrade'), JSON.stringify(audit));
  assert.ok(audit.introducedIssueCount >= 1);
  assert.ok(audit.residualWarnings.some(item => item.code === 'korean_professional_register_downgrade'));
});

test('지원서의 개선·수행·숙지 표현과 학술 판단 부사의 격식·의미 약화를 잡는다', () => {
  const source = [
    '개선이 필요한 부분을 확인한 뒤 주어진 작업을 수행하기보다 원인을 먼저 분석했습니다.',
    '검사 기준을 숙지하지 못했던 점을 보완했습니다.',
    '사회가 약자를 어떻게 대하는지를 객관적으로 마주했습니다.'
  ].join(' ');
  const output = [
    '손봐야 할 부분을 확인한 뒤 주어진 작업만 하기보다 원인을 먼저 분석했습니다.',
    '검사 기준을 익히지 못했던 점을 보완했습니다.',
    '사회가 약자를 어떻게 대하는지를 직접적으로 마주했습니다.'
  ].join(' ');
  const audit = refinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'resume_application', confidence: 0.96 }
  });
  const issue = audit.issues.find(item => item.code === 'professional_register_downgrade');
  assert.ok(issue, JSON.stringify(audit));
  assert.deepEqual(
    new Set(issue.details.alignedLosses.map(item => item.concept)),
    new Set(['improvement_requirement', 'assigned_task_performance', 'standards_familiarity', 'objective_stance'])
  );
});

test('연구개발 자소서의 전문용어 약화·연어 오류·자기평가 반복을 같이 검출한다', () => {
  const source = [
    '저의 경쟁력은 공정 조건을 최적화하고 소재의 구조와 성능 간 상관관계를 분석하는 역량입니다.',
    '원인을 분석해 실험 조건을 조정했고, 반복 실험을 통해 재현성을 검증했습니다.',
    '실습수업을 진행했습니다.',
    '얻은 데이터를 연구과제 보고서와 투고 논문에 직접 작성해 문서화 능력을 길렀습니다.',
    '데이터 해석 능력을 키우기 위해 노력했습니다.',
    '지도교수와 피드백을 반복하며 분석력과 사고력을 발전시키고자 노력했습니다.'
  ].join(' ');
  const output = source
    .replace('공정 조건을 최적화하고', '공정 조건을 조정하고')
    .replace('구조와 성능 간 상관관계', '구조와 성능 사이의 관계')
    .replace('원인을 분석해', '원인을 짚고')
    .replace('재현성을 검증했습니다', '재현성을 확인하는 일도 했습니다');
  const audit = refinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'resume_application', confidence: 0.95 }
  });
  const codes = new Set(audit.issueCodes);
  assert.ok(codes.has('professional_register_downgrade'), JSON.stringify(audit));
  assert.ok(codes.has('data_document_collocation'));
  assert.ok(codes.has('feedback_exchange_collocation'));
  assert.ok(codes.has('self_evaluation_repetition'));
  assert.ok(codes.has('practice_class_spacing'));
  const professional = audit.issues.find(item => item.code === 'professional_register_downgrade');
  assert.deepEqual(
    new Set(professional.details.alignedLosses.map(item => item.concept)),
    new Set(['process_optimization', 'structure_performance_correlation', 'cause_analysis', 'reproducibility_verification'])
  );
});

test('전문 개념과 주어·목적어 연어 감사는 자소서가 아닌 일반 글에도 적용한다', () => {
  const source = [
    '연구에서는 공정 조건을 최적화하고 구조와 성능 간 상관관계를 분석했습니다.',
    '측정 데이터를 연구 보고서에 반영했습니다.',
    '연구진과 여러 차례 피드백을 주고받았습니다.'
  ].join(' ');
  const output = [
    '연구에서는 공정 조건을 조정하고 구조와 성능 사이의 관계를 살폈습니다.',
    '측정 데이터를 연구 보고서에 직접 작성했습니다.',
    '연구진과 피드백을 반복했습니다.'
  ].join(' ');
  const audit = refinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'general_essay', confidence: 0.82 }
  });
  const codes = new Set(audit.issueCodes);
  assert.ok(codes.has('professional_register_downgrade'), JSON.stringify(audit));
  assert.ok(codes.has('data_document_collocation'));
  assert.ok(codes.has('feedback_exchange_collocation'));
});

test('연구개발 자소서의 실습 수업 띄어쓰기는 최종 형식 보정에서 안전하게 고친다', () => {
  const text = '연구실 구성원을 대상으로 실습수업을 직접 진행했습니다.';
  const repaired = refinement.applySafeFormattingRepairs({
    source: text,
    outputText: text,
    documentProfile: { profile: 'resume_application' }
  });
  assert.equal(repaired.text, '연구실 구성원을 대상으로 실습 수업을 직접 진행했습니다.');
  assert.ok(repaired.changeCodes.includes('practice_class_spacing'));
});

test('원문 검토 경고는 결과 품질 경고와 별도 배열로 유지한다', () => {
  const source = '-항목을 적었습니다.\n그때마다 같은 말을 자주 들었습니다.';
  const output = '- 항목을 적었습니다.\n그 과정에서 같은 말을 여러 번 들었습니다.';
  const audit = refinement.analyzeKoreanRefinement({ source, outputText: output });
  assert.ok(audit.sourceReviewWarnings.some(item => item.code === 'list_marker_spacing'));
  assert.ok(audit.sourceReviewWarnings.some(item => item.code === 'frequency_quantifier_conflict'));
  assert.equal(audit.residualWarnings.some(item => item.code === 'korean_frequency_quantifier_conflict'), false);
});

test('보고서의 문장 중간 빈 문단을 합치고 과도한 빈 줄을 1개로 줄인다', () => {
  const source = [
    '윤리적 소비 탐구 보고서',
    '',
    '소비자의 작은 선택 하나가 생산 방식과 기업의 책임 의식을 ',
    '',
    '변화시킬 수 있다는 사실은 개인의 행동이 사회 변화와 연결될 수 있음을 보여준다.',
    '',
    '',
    '',
    '다음 문단은 별도의 완결된 문장이다.'
  ].join('\n');
  const repaired = refinement.applySafeFormattingRepairs({
    source,
    outputText: source,
    documentProfile: { profile: 'report_assignment', formatProfile: { flags: ['sectioned'] } }
  });
  assert.equal(repaired.applied, true);
  assert.match(repaired.text, /책임 의식을 변화시킬 수/u);
  assert.doesNotMatch(repaired.text, /의식을\s*\n\s*\n\s*변화시킬/u);
  assert.doesNotMatch(repaired.text, /\n{3,}/u);
  assert.equal(repaired.brokenParagraphBreakRepairCount, 1);
  assert.equal(repaired.excessiveBlankLineRepairCount, 2);
});

test('일반 산문 문단의 앞뒤 공백만 제거하고 목록 들여쓰기는 보존한다', () => {
  const source = '첫 문단입니다.\n\n  둘째 문단입니다.  \n  - 목록 항목입니다.';
  const repaired = refinement.applySafeFormattingRepairs({
    source,
    outputText: source,
    documentProfile: { profile: 'report_assignment' }
  });
  assert.match(repaired.text, /\n\n둘째 문단입니다\.\n/u);
  assert.match(repaired.text, /\n  - 목록 항목입니다\./u);
  assert.equal(repaired.changeCounts.prose_edge_whitespace, 1);
});

test('학술·보고서 결과에 새로 남은 진짜와 문장 첫 그래서를 격식 수리 대상으로 잡는다', () => {
  const source = '이 결과는 매우 중요하다. 따라서 후속 분석이 필요하다.';
  const output = '이 결과는 진짜 중요하다. 그래서 후속 분석이 필요하다.';
  const audit = refinement.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'academic_paper', targetRegister: 'academic_formal' }
  });
  const issue = audit.issues.find(item => item.code === 'formal_register_residual');
  assert.ok(issue?.introducedCount >= 2, JSON.stringify(audit));
  assert.deepEqual(new Set(issue.details.families), new Set(['casual_emphasis', 'casual_sentence_connector']));

  const general = refinement.analyzeKoreanRefinement({
    source: '그래서 직접 확인했다.',
    outputText: '그래서 직접 확인했다.',
    documentProfile: { profile: 'general_essay', targetRegister: 'conversational' }
  });
  assert.equal(general.issueCodes.includes('formal_register_residual'), false);
});

test('문맥형 띄어쓰기를 고치되 인용된 논문명과 참고문헌은 원문대로 남긴다', () => {
  const source = [
    '윤리적 소비와 기업 책임',
    '',
    '인간 중심의 시선에서 한걸음 벗어나 사회적 약자를 보여주는 방식을 살폈다.',
    '수업중에 자료를 재구성 하였고, 가치소비가 지속이용의도에 미치는 영향을 정리했다.',
    '2026년 연구 「ESG 경영 활동이 대학생 소비자의 지속이용의도에 미치는 영향」을 인용했다.',
    '',
    '참고문헌',
    '홍길동, 「가치소비와 지속이용의도」, 2026.'
  ].join('\n');
  const repaired = refinement.applySafeFormattingRepairs({
    source,
    outputText: source,
    documentProfile: { profile: 'report_assignment', formatProfile: { flags: ['reference_heavy'] } }
  });
  assert.match(repaired.text, /한 걸음 벗어나/u);
  assert.match(repaired.text, /보여 주는 방식/u);
  assert.match(repaired.text, /수업 중에 자료를 재구성하였고/u);
  assert.match(repaired.text, /가치 소비가 지속 이용 의도에/u);
  assert.match(repaired.text, /「ESG 경영 활동이 대학생 소비자의 지속이용의도에 미치는 영향」/u);
  assert.match(repaired.text, /홍길동, 「가치소비와 지속이용의도」, 2026\./u);
});

test('시·창작문은 행갈이와 의도적 띄어쓰기를 수정하지 않는다', () => {
  const creative = '한걸음\n멈춘 자리에\n빛을 보여주는\n사람';
  const repaired = refinement.applySafeFormattingRepairs({
    source: creative,
    outputText: creative,
    documentProfile: { profile: 'creative', formatProfile: { flags: ['creative_lines'] } }
  });
  assert.equal(repaired.applied, false);
  assert.equal(repaired.text, creative);
  assert.equal(repaired.reason, 'creative_line_structure');
});

test('워드·PDF에서 복사한 일반 텍스트 표의 셀 경계는 산문처럼 합치지 않는다', () => {
  const source = [
    '평가 기준을 다음과 같이 정리하였다.',
    '표 8. 학습자 산출물과 잠정 평가 준거',
    '',
    '평가 영역',
    '핵심 준거',
    '원문·문헌 근거의 정확성',
    '사실과 추론을 구분하였는가',
    '자료 비판과 출처 투명성',
    '자료 출처와 한계를 기록하였는가',
    '',
    '',
    '이 표는 평가 항목을 보여주는 자료다.'
  ].join('\n');
  const repaired = refinement.applySafeFormattingRepairs({
    source,
    outputText: source,
    documentProfile: { profile: 'report_assignment', formatProfile: { flags: ['table'] } }
  });
  assert.match(repaired.text, /사실과 추론을 구분하였는가\n자료 비판과 출처 투명성/u);
  assert.match(repaired.text, /자료 비판과 출처 투명성\n자료 출처와 한계를 기록하였는가/u);
  assert.doesNotMatch(repaired.text, /구분하였는가 자료 비판/u);
  assert.match(repaired.text, /이 표는 평가 항목을 보여 주는 자료다\./u);
  assert.equal(repaired.brokenLineBreakRepairCount, 0);
});

test('보여 주다의 활용형 띄어쓰기를 문서 전체에서 같은 기준으로 맞춘다', () => {
  const source = '이 사례는 변화를 보여준다. 다음 결과도 보여준 자료이며 앞으로의 가능성을 보여줄 수 있다. 이전 사례도 보여줬다.';
  const repaired = refinement.applySafeFormattingRepairs({ source, outputText: source });
  assert.equal(
    repaired.text,
    '이 사례는 변화를 보여 준다. 다음 결과도 보여 준 자료이며 앞으로의 가능성을 보여 줄 수 있다. 이전 사례도 보여 줬다.'
  );
  assert.equal(repaired.changeCounts.show_auxiliary_spacing, 4);
});
