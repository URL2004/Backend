'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const refinement = require('../engine-gpt-prod/koreanRefinement');

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
