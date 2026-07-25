'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const structure = require('../engine-gpt-prod/structureChunk');
const layout = require('../engine-gpt-prod/layoutStructure');
const { splitSentences } = require('../engine/koreanText');

function compact(value) {
  return String(value || '').replace(/\s+/gu, '');
}

function paragraphSentenceCounts(value) {
  return layout.splitReadableParagraphs(value)
    .map(paragraph => splitSentences(paragraph).filter(Boolean).length);
}

test('번호 절과 산문이 섞인 장문도 구조 블록이라는 이유로 가독성 검사를 면제하지 않는다', () => {
  const source = [
    '현대사회에서 복지는 개인의 문제를 넘어 공동체가 함께 다루어야 할 과제가 되었다. 제도적 복지는 이러한 변화에 대응하는 관점을 제공한다.',
    '1. 대상 기준의 변화 첫 번째 기준은 복지 대상을 일부 계층에 한정하지 않는다는 점이다. 사회 구성원 전체가 제도의 대상이 된다.',
    '과거 제도는 위기 상황에 놓인 사람을 선별해 지원했다. 지원은 임시적인 성격이 강했다. 수급 과정에서 사회적 낙인이 생기기도 했다. 제도적 관점은 이러한 한계를 줄이려 한다. 보편적 권리라는 인식도 이때 강조된다.',
    '2. 국가 책임의 확대 두 번째 기준은 국가의 역할을 사후 대응에 한정하지 않는다는 점이다. 예방적 개입도 중요한 책임으로 본다.',
    '현대 산업사회에서는 실업과 질병이 반복해서 발생할 수 있다. 개인의 노력만으로 모든 위험을 피하기는 어렵다. 국가는 제도를 통해 위험을 분산해야 한다. 헌법은 “사회보장의 증진에 노력할 의무”를 규정한다. 이 인용은 국가 책임의 법적 근거를 보여 준다. 사회보험과 공공서비스도 같은 방향에서 이해할 수 있다. 결국 제도적 복지는 예방과 보장을 함께 요구한다. 이런 점에서 국가의 적극적인 개입이 필요하다.',
    '',
    '결론적으로 두 개념은 보편적 권리와 국가 책임이라는 공통된 방향을 가진다.'
  ].join('\n');
  const profile = {
    profile: 'long_explainer',
    confidence: 0.94,
    formatProfile: { primary: 'plain', flags: [] }
  };
  const plan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveLineBoundaries: 'structural',
    formatProfile: profile.formatProfile
  });
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: source,
    chunks: plan.chunks,
    mode: 'blog',
    requestStrength: 'basic',
    documentProfile: profile,
    profileConfidence: 0.94
  });

  assert.equal(compact(restored.text), compact(source));
  assert.match(restored.text, /\n\n1\. 대상 기준/u);
  assert.match(restored.text, /\n\n2\. 국가 책임/u);
  assert.ok(Math.max(...paragraphSentenceCounts(restored.text)) <= 7);
  assert.equal(restored.paragraphs.readability.overlongCount, 0);
  assert.ok(restored.paragraphs.visualGapRepairCount >= 2);
});

test('원문 문단은 서로 합치지 않되 긴 원문 문단 내부는 안전하게 나눈다', () => {
  const first = '첫 문단은 지원 동기와 회사 선택 기준을 설명합니다. 이 역할에 관심을 갖게 된 이유도 함께 제시합니다.';
  const middle = [
    '현장에서는 마감 업무가 구두 인수인계로만 이어지고 있었습니다.',
    '근무자마다 업무 방식이 달라 일부 업무가 누락되었습니다.',
    '저는 경력이 많은 직원들에게 기존 절차를 확인했습니다.',
    '확인한 내용을 비교해 공통 단계를 정리했습니다.',
    '매니저의 검토를 받아 표준 체크리스트를 만들었습니다.',
    '체크리스트를 적용한 뒤 누락과 혼선이 줄었습니다.',
    '이 경험을 통해 신뢰할 수 있는 기준의 중요성을 배웠습니다.'
  ].join(' ');
  const last = '마지막 문단은 입사 후 계획을 설명합니다. 현장에서 배운 방식을 바탕으로 안정적인 운영에 기여하겠습니다.';
  const source = [first, middle, last].join('\n\n');
  const profile = {
    profile: 'resume_application',
    confidence: 0.96,
    formatProfile: { primary: 'plain', flags: [] }
  };
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: source,
    chunks: structure.splitChunksForGpt(source, { coalesceEditable: true }).chunks,
    mode: 'blog',
    requestStrength: 'basic',
    documentProfile: profile,
    profileConfidence: 0.96
  });

  assert.equal(restored.paragraphs.policy, 'source_paragraph_roles');
  assert.equal(compact(restored.text), compact(source));
  assert.ok(restored.paragraphs.afterCount > 3);
  assert.ok(restored.paragraphs.proseSplitCount >= 1);
  assert.ok(restored.text.startsWith(`${first}\n\n`));
  assert.ok(restored.text.endsWith(`\n\n${last}`));
  assert.ok(Math.max(...paragraphSentenceCounts(restored.text)) <= 5);
});

test('빈 줄 없이 이어진 자소서 완결 행은 합치지 않고 실제 문단 간격으로 출력한다', () => {
  const units = [
    '첫 번째 답변은 지원 동기를 설명합니다. 회사에 관심을 갖게 된 계기를 구체적으로 적었습니다.',
    '두 번째 답변은 문제 해결 경험을 설명합니다. 당시 맡은 역할과 판단 근거를 함께 제시했습니다.',
    '세 번째 답변은 협업 경험을 설명합니다. 의견 차이를 조율한 과정과 결과를 적었습니다.',
    '네 번째 답변은 직무 역량을 설명합니다. 관련 지식과 현장 경험을 연결했습니다.',
    '다섯 번째 답변은 입사 후 계획을 설명합니다. 준비할 내용과 기여 방향을 제시했습니다.'
  ];
  const source = units.join('\n');
  const profile = {
    profile: 'resume_application',
    confidence: 0.95,
    formatProfile: { primary: 'plain', flags: [] }
  };
  const plan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveLineBoundaries: 'structural',
    formatProfile: profile.formatProfile
  });
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: source,
    chunks: plan.chunks,
    mode: 'blog',
    requestStrength: 'basic',
    documentProfile: profile,
    profileConfidence: 0.95
  });

  assert.equal(compact(restored.text), compact(source));
  assert.equal(layout.splitExplicitParagraphs(restored.text).length, units.length);
  assert.equal(restored.paragraphs.policy, 'source_readable_units');
  assert.equal(restored.paragraphs.visualGapRepairCount, units.length - 1);
});

test('도입문·불릿 목록·후속 설명은 구분하되 목록 행 사이에는 빈 줄을 넣지 않는다', () => {
  const source = [
    '소비자 행동에 영향을 미치는 요인은 다음과 같다.',
    '* 문화적 요인은 소비자의 생활 방식에 영향을 준다.',
    '* 사회적 요인은 가족과 또래 집단의 영향을 포함한다.',
    '* 개인적 요인은 연령과 소득 수준에 따라 달라진다.',
    '이러한 요인은 서로 결합하여 최종 구매 결정에 영향을 준다.'
  ].join('\n');
  const profile = {
    profile: 'report_assignment',
    confidence: 0.92,
    formatProfile: { primary: 'list_heavy', flags: ['list_heavy'] }
  };
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: source,
    chunks: structure.splitChunksForGpt(source, {
      coalesceEditable: true,
      preserveLineBoundaries: 'structural',
      formatProfile: profile.formatProfile
    }).chunks,
    mode: 'blog',
    requestStrength: 'basic',
    documentProfile: profile,
    profileConfidence: 0.92
  });

  assert.equal(compact(restored.text), compact(source));
  assert.match(restored.text, /다음과 같다\.\n\n\* 문화적/u);
  assert.match(restored.text, /포함한다\.\n\* 개인적/u);
  assert.doesNotMatch(restored.text, /\* 문화적[^\n]+\n\n\* 사회적/u);
  assert.match(restored.text, /달라진다\.\n\n이러한 요인은/u);
});

test('완결된 일반 산문 행은 내부 줄바꿈이 아니라 실제 문단 간격으로 전달한다', () => {
  const lines = [
    '첫 번째 행은 현장에서 확인한 문제와 그 배경을 충분한 길이로 설명하며, 당시 어떤 판단이 필요했는지와 선택 가능한 대안도 함께 정리합니다.',
    '두 번째 행은 앞선 문제를 해결하기 위해 자료를 확인하고 관계자와 조율한 구체적인 과정을 차례대로 설명하며 실제 적용 순서도 기록합니다.',
    '세 번째 행은 적용 결과와 남은 한계를 구분해 기록하고, 이후 같은 상황에서 보완할 기준과 추가로 확인해야 할 항목을 분명히 제시합니다.'
  ];
  const source = lines.join('\n');
  const profile = {
    profile: 'report_assignment',
    confidence: 0.91,
    formatProfile: { primary: 'plain', flags: [] }
  };
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: source,
    chunks: structure.splitChunksForGpt(source, {
      coalesceEditable: true,
      preserveLineBoundaries: 'structural'
    }).chunks,
    mode: 'assignment',
    requestStrength: 'basic',
    documentProfile: profile,
    profileConfidence: 0.91
  });

  assert.equal(compact(restored.text), compact(source));
  assert.equal(layout.splitExplicitParagraphs(restored.text).length, 3);
  assert.equal(restored.paragraphs.visualGapRepairCount, 2);
});

test('번호 제목에 공백만 추가돼도 원문 제목을 찾아 구조 복원에 성공한다', () => {
  const source = [
    '1.소비자 행동 분석',
    '소비자가 제품을 탐색하고 구매하는 과정을 설명합니다.',
    '2.마케팅 전략',
    '기업이 소비자와 소통하는 방식을 정리합니다.'
  ].join('\n');
  const output = source
    .replace('1.소비자', '1. 소비자')
    .replace('2.마케팅', '2. 마케팅');
  const profile = {
    profile: 'report_assignment',
    confidence: 0.94,
    formatProfile: { primary: 'sectioned', flags: ['sectioned'] }
  };
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: output,
    chunks: structure.splitChunksForGpt(source, { coalesceEditable: true }).chunks,
    mode: 'assignment',
    requestStrength: 'basic',
    documentProfile: profile,
    profileConfidence: 0.94
  });

  assert.equal(restored.heading.missingCount, 0);
  assert.match(restored.text, /(?:^|\n)1\.소비자 행동 분석(?:\n|$)/u);
  assert.match(restored.text, /(?:^|\n)2\.마케팅 전략(?:\n|$)/u);
  assert.equal(restored.pass, true);
});

test('보호 인용이 포함돼도 문단 전체를 분리 금지하지 않는다', () => {
  const sentences = [
    '첫 문장은 현장의 문제를 설명합니다.',
    '둘째 문장은 문제의 원인을 정리합니다.',
    '셋째 문장은 “원문 인용은 그대로 유지한다”라는 기준을 제시합니다.',
    '넷째 문장은 확인한 자료를 설명합니다.',
    '다섯째 문장은 적용한 조치를 기록합니다.',
    '여섯째 문장은 조치 결과를 설명합니다.',
    '일곱째 문장은 이후 보완점을 정리합니다.',
    '마지막 문장은 전체 경험의 의미를 설명합니다.'
  ];
  const source = sentences.join(' ');
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: source,
    chunks: [{ locked: true, lockType: 'quote', text: '“원문 인용은 그대로 유지한다”' }],
    mode: 'blog',
    requestStrength: 'basic',
    documentProfile: {
      profile: 'resume_application',
      confidence: 0.94,
      formatProfile: { primary: 'sectioned', flags: ['sectioned'] }
    },
    profileConfidence: 0.94
  });

  assert.equal(compact(restored.text), compact(source));
  assert.match(restored.text, /“원문 인용은 그대로 유지한다”/u);
  assert.ok(restored.paragraphs.afterCount >= 2);
  assert.equal(restored.paragraphs.readability.overlongCount, 0);
});

test('polish·창작문·코드·표의 의도적 줄 구조는 재배치하지 않는다', () => {
  const creative = [
    '좋은 마음, 미운 마음.',
    '우정일까 사랑일까.',
    '기다림 끝에 남은 말.',
    '그래도 오늘은 걷는다.',
    '바람이 문을 두드린다.',
    '나는 대답하지 않는다.',
    '밤은 그대로 깊어진다.',
    '짧은 숨만 남는다.'
  ].join('\n');
  const creativeResult = structure.restorePostSemanticLayout({
    source: creative,
    outputText: creative,
    chunks: structure.splitChunksForGpt(creative, { coalesceEditable: true }).chunks,
    mode: 'blog',
    requestStrength: 'basic',
    documentProfile: { profile: 'creative', confidence: 0.97, formatProfile: { primary: 'creative_lines', flags: ['creative_lines'] } },
    profileConfidence: 0.97
  });
  assert.equal(creativeResult.text, creative);

  const polish = Array.from({ length: 8 }, (_, index) => `${index + 1}번째 문장은 기존 문단의 순서를 그대로 유지합니다.`).join(' ');
  const polishResult = structure.restorePostSemanticLayout({
    source: polish,
    outputText: polish,
    chunks: structure.splitChunksForGpt(polish, { coalesceEditable: true }).chunks,
    mode: 'polish',
    requestStrength: 'polish',
    documentProfile: { profile: 'general', confidence: 0.7, formatProfile: { primary: 'plain', flags: [] } },
    profileConfidence: 0.7
  });
  assert.equal(polishResult.text, polish);

  const structured = [
    '다음 코드는 계산 기준을 설명합니다.',
    '```js',
    'const value = 1;',
    '```',
    '표에는 비교 결과를 정리했습니다.',
    '항목\t값',
    'A\t35%',
    'B\t40%',
    '표 아래 설명도 원래 행을 유지합니다.'
  ].join('\n');
  const structuredResult = structure.restorePostSemanticLayout({
    source: structured,
    outputText: structured,
    chunks: structure.splitChunksForGpt(structured, { coalesceEditable: true }).chunks,
    mode: 'blog',
    requestStrength: 'basic',
    documentProfile: { profile: 'report_assignment', confidence: 0.9, formatProfile: { primary: 'table', flags: ['table', 'table_heavy'] } },
    profileConfidence: 0.9
  });
  assert.equal(structuredResult.text, structured);

  const references = [
    '본문 마지막 문장은 연구 결과를 정리합니다.',
    '<참고문헌>',
    '1. 홍길동. (2024). 연구 제목. 학술지.',
    '2. Kim, A. (2025). Article title. Journal.'
  ].join('\n');
  const referenceResult = structure.restorePostSemanticLayout({
    source: references,
    outputText: references,
    chunks: structure.splitChunksForGpt(references, { coalesceEditable: true }).chunks,
    mode: 'assignment',
    requestStrength: 'basic',
    documentProfile: {
      profile: 'academic_paper',
      confidence: 0.96,
      formatProfile: { primary: 'reference_heavy', flags: ['reference_heavy'] }
    },
    profileConfidence: 0.96
  });
  assert.equal(referenceResult.text, references);
});
