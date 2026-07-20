'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const koreanText = require('../engine/koreanText');
const floor = require('../engine/floor');
const dedupe = require('../engine/dedupe');
const chunk = require('../engine/chunk');
const nikl = require('../engine/koreanQuality/niklTest');
const freeze = require('../engine/freezeblocks');
const structure = require('../engine-gpt-prod/structureChunk');
const layoutStructure = require('../engine-gpt-prod/layoutStructure');
const { detectDocumentProfile, applyDocumentProfileOverride } = require('../engine-gpt-prod/documentProfile');
const { buildVoiceProfile, voicePromptBlock, auditVoice, sentenceDistributionShift, paragraphExpansionLimit } = require('../engine-gpt-prod/voiceProfile');
const qualityV2 = require('../engine-gpt-prod/finalQualityV2');
const factAudit = require('../engine-gpt-prod/factAudit');
const { assessRepairCandidate } = require('../engine-gpt-prod/judge');
const prompts = require('../engine-gpt-prod/prompts');
const contract = require('../engine/contract');
const { compareNaturalnessShadow } = require('../engine/koreanQuality/naturalnessShadow');

test('한국어 문장 분리기는 장·절 번호, 소수점, 약어와 인용부호를 보존한다', () => {
  const value = '제 1장. 연구 개요\n연구 배경\n값은 3.14이다. e.g. 예시는 유지한다. U.S. 자료도 유지한다. “인용문이다.” 다음 문장이다.';
  const sentences = koreanText.splitSentences(value);
  assert.equal(sentences[0], '제 1장. 연구 개요');
  assert.ok(sentences.some(sentence => sentence.includes('연구 배경') && sentence.includes('값은 3.14이다.')));
  assert.ok(sentences.includes('e.g. 예시는 유지한다.'));
  assert.ok(sentences.includes('U.S. 자료도 유지한다.'));
  assert.ok(sentences.includes('“인용문이다.”'));
});

test('숫자 감사는 단위·연도·목록 번호의 횟수를 보존하고 사용자 메모 숫자만 추가 허용한다', () => {
  const source = '제 1장 조사 결과에서 2026년 참여자는 20명이고 응답률은 35%였다.\n1. 첫 항목';
  const same = '제1장 조사 결과에서 2026년 참여자는 20 명이며 응답률은 35％였다.\n1. 첫 항목';
  const changed = '제1장 조사 결과에서 2026년 참여자는 21명이며 응답률은 35%였다.\n1. 첫 항목';
  assert.equal(factAudit.compareNumberMultiset(source, same).changed, false);
  const drift = factAudit.compareNumberMultiset(source, changed);
  assert.equal(drift.changed, true);
  assert.equal(drift.removedCount, 1);
  assert.equal(drift.addedCount, 1);
  assert.equal(factAudit.compareNumberMultiset(source, `${same} 추가 표본은 4명이었다.`, '추가 표본은 4명이었다.').changed, false);
});

test('의미 수리 후보가 원문 숫자를 새로 잃으면 안전 후보로 채택하지 않는다', () => {
  const source = '2026년 조사에는 학생 20명이 참여했고 응답률은 35%였다.';
  const before = '2026년 조사에는 학생 20명이 참여했으며 응답률은 35%였다.';
  const candidate = '2026년 조사에는 학생들이 참여했으며 응답률은 35%였다.';
  const audit = assessRepairCandidate(source, before, candidate);
  assert.equal(audit.pass, false);
  assert.ok(audit.reasons.includes('number_facts_worsened'));
});

test('한국어 Unicode 경계는 숫자 단위와 실제 조사 중복을 정확히 인식한다', () => {
  for (const value of [
    '20명과 35%가 참여했고 2026년에 마쳤다.',
    '유관 학과와 협의했고 두 결과의 차이가 분명했다.',
    '깊이가 충분하고 고양이가 곁에 있었다.'
  ]) {
    const clean = nikl.analyzeNiklQuality(value);
    assert.equal(clean.normPatterns.some(item => item.id === 'double_particle'), false, value);
  }
  for (const value of ['사람은는 간다.', '학생이가 왔다.']) {
    const report = nikl.analyzeNiklQuality(value);
    assert.equal(report.normPatterns.some(item => item.id === 'double_particle'), true);
  }
});

test('숫자 뒤 서술격 일 때는 날짜 단위로 오인하지 않는다', () => {
  const copular = floor.measureNovelty('성분 수 5에서 성능이 높았다.', '성분 수가 5일 때 성능이 높았다.', '');
  assert.equal(copular.count, 0);
  const actualDay = floor.measureNovelty('관찰 기간은 5일이다.', '관찰 기간은 6일이다.', '');
  assert.ok(actualDay.items.includes('6일'));
  const calendarDay = floor.measureNovelty('행사 날짜는 정하지 않았다.', '행사는 5일에 열린다.', '');
  assert.ok(calendarDay.items.includes('5일'));
});

test('일반 기관 지시어의 띄어쓰기는 고유 기관명 손실로 보지 않는다', () => {
  const generic = floor.measureLostFacts('해당기관의 승인을 받았다.', '해당 기관의 승인을 받았다.');
  assert.equal(generic.count, 0);
  const named = floor.measureLostFacts('한국대학교 연구팀이 승인했다.', '연구팀이 승인했다.');
  assert.ok(named.items.includes('한국대학교'));
});

test('고립 접속어와 조사로 시작하는 장문 청크 경계를 회귀 검사한다', () => {
  const connector = nikl.analyzeNiklQuality('앞 문장은 끝났다. 그리고');
  assert.ok(connector.topPatterns.some(item => item.id === 'orphan_connector_after_period' || item.id === 'unfinished_final_sentence'));
  const validConnector = nikl.analyzeNiklQuality('연구를 마쳤다. 또한 결과를 정리했다. 그러나 해석에는 한계가 있다.');
  assert.equal(validConnector.topPatterns.some(item => item.id === 'orphan_connector_after_period'), false);
  const validComma = nikl.analyzeNiklQuality('자료를 비교했고, 그 결과를 표로 정리했다.');
  assert.equal(validComma.topPatterns.some(item => item.id === 'connector_comma_fragment'), false);
  const longText = '연구 자료를 바탕으로 결과를 자세히 분석하고 의미를 설명한다 '.repeat(90);
  const chunks = chunk.splitChunks(longText);
  assert.ok(chunks.length >= 2);
  for (const item of chunks.slice(1)) {
    assert.doesNotMatch(item.text.trim(), /^(?:및|과|와|의|을|를|은|는|이|가|에|에서|으로|로|부터|까지)(?=$|[^가-힣A-Za-z0-9_])/u);
  }
});

test('장 제목의 제는 1인칭으로 세지 않고 새 화자 주입·삭제를 잡는다', () => {
  assert.equal(floor.computePovSeed('제 1장 연구 개요\n제2절 분석').fp_singular, 0);
  assert.equal(floor.computePovSeed('팀 활동을 돌아보면 나는 설명을 맡았고 나도 끝까지 참여했으며 우리는 함께 마무리했다').fp_singular, 2);
  assert.equal(floor.computePovSeed('주방에서 냄새 나는 음식을 정리했다.').fp_singular, 0);
  const source = '이 연구는 자료를 분석한다.';
  const injected = floor.measurePovDrift(source, '저는 이 연구에서 자료를 분석한다.');
  assert.equal(injected.introducedAnyFirstPerson, true);
  const dropped = floor.measurePovDrift('저는 자료를 분석했다.', '자료를 분석했다.');
  assert.equal(dropped.droppedFirstPerson, true);
  const punctuationless = '팀 활동을 돌아보면 나는 설명을 맡았고 나도 끝까지 참여했으며 우리는 함께 마무리했다';
  const preserved = floor.measurePovDrift(punctuationless, '팀 활동을 돌아봤다. 나는 설명을 맡았고 나도 끝까지 참여했으며, 우리는 함께 마무리했다.');
  assert.equal(preserved.introducedAnyFirstPerson, false);
  assert.equal(preserved.droppedAnyFirstPerson, false);
});

test('dedupe는 인과 방향이 다른 유사 문장을 보존하고 인접 완전 중복만 제거한다', () => {
  const source = '원인이 결과를 만든다. 결과가 원인을 만든다.\n\n같은 문장이다.\n\n같은 문장이다.';
  const report = dedupe.dedupeSentences(source);
  assert.match(report.text, /원인이 결과를 만든다\. 결과가 원인을 만든다\./u);
  assert.equal((report.text.match(/같은 문장이다\./gu) || []).length, 1);
  assert.equal(report.removed, 1);
});

test('원문에 없던 비인접 중복 블록은 완전 일치 anchor로만 제거한다', () => {
  const block = [
    '첫 번째 근거는 재정착 조건과 실제 부담의 관계를 충분히 설명하는 문장입니다.',
    '두 번째 근거는 사업 진행 단계에 따라 비용이 달라지는 과정을 구체적으로 설명합니다.',
    '세 번째 근거는 기존 주민이 선택할 수 있는 대안의 범위를 차분하게 정리합니다.',
    '네 번째 근거는 정책의 평가 기준을 준공률에서 재정착률로 바꿔야 한다고 설명합니다.'
  ];
  const source = ['도입 문장은 논의의 범위를 제시합니다.', ...block, '마무리 문장은 다음 절의 내용을 안내합니다.'].join(' ');
  const duplicated = [
    '도입 문장은 논의의 범위를 제시합니다.',
    ...block,
    '연결 문장은 앞부분을 다시 붙이는 청크 오류입니다.',
    ...block,
    '마무리 문장은 다음 절의 내용을 안내합니다.'
  ].join(' ');
  const repaired = dedupe.removeNewExactDuplicateBlocks(source, duplicated);
  assert.equal(repaired.applied, true);
  assert.equal(repaired.removedBlockCount, 1);
  assert.equal(repaired.removedSentenceCount, 4);
  for (const sentence of block) assert.equal((repaired.text.split(sentence).length - 1), 1);

  const intentionalSource = ['도입 문장입니다.', ...block, '중간 문장입니다.', ...block, '마무리 문장입니다.'].join(' ');
  const intentional = dedupe.removeNewExactDuplicateBlocks(intentionalSource, intentionalSource);
  assert.equal(intentional.applied, false);

  const protectedBlock = [
    '일반 설명으로 시작하지만 뒤의 목록과 함께 보존해야 하는 충분히 긴 첫 문장입니다.',
    '- 첫 번째 목록 항목은 사용자가 직접 정한 구조이므로 중복처럼 보여도 자동 삭제하지 않습니다.',
    '목록 다음 설명도 앞의 목록과 한 블록을 이루며 원래 순서를 그대로 유지해야 합니다.',
    '마지막 설명은 보호 블록 판정에 필요한 세 번째 완전 일치 기준을 충분히 제공합니다.'
  ];
  const protectedSource = ['보호 구조 도입 문장입니다.', ...protectedBlock, '보호 구조 마무리 문장입니다.'].join('\n\n');
  const protectedDuplicate = ['보호 구조 도입 문장입니다.', ...protectedBlock, ...protectedBlock, '보호 구조 마무리 문장입니다.'].join('\n\n');
  const protectedResult = dedupe.removeNewExactDuplicateBlocks(protectedSource, protectedDuplicate);
  assert.equal(protectedResult.applied, false);
});

test('반복 경고는 원문에 있던 반복이 아니라 결과에서 증가한 반복만 기록한다', () => {
  const repeated = '같은 결론을 다시 설명하는 문장입니다.';
  const source = `${repeated} ${repeated} 다른 근거를 설명하는 문장입니다.`;
  const unchanged = `${repeated} ${repeated} 다른 근거를 조금 더 분명하게 설명합니다.`;
  const increased = `${repeated} ${repeated} ${repeated} 다른 근거를 설명하는 문장입니다.`;
  const unchangedAudit = qualityV2.compareRepetitionDelta(source, unchanged);
  const increasedAudit = qualityV2.compareRepetitionDelta(source, increased);
  assert.equal(unchangedAudit.increased, false);
  assert.equal(unchangedAudit.delta.total, 0);
  assert.equal(increasedAudit.increased, true);
  assert.ok(increasedAudit.delta.exactGroups > 0 || increasedAudit.delta.maxRepeat > 0 || increasedAudit.delta.total > 0);
});

test('목차·참고문헌은 한 판정기로 잠그고 참고문헌 뒤 부록 본문은 변환 대상으로 둔다', () => {
  const source = [
    '제목', '', '목차', 'Ⅰ. 서론 .... 1', 'Ⅱ. 본론 .... 2', '',
    'Ⅰ. 서론', '본문입니다.', '', '참고문헌',
    '홍길동. (2020). 연구 제목.', '김철수. (2021). 연구 제목.', '',
    '부록', '부록 본문은 선택 모드로 다듬는다.'
  ].join('\n');
  const spans = freeze.detectAcademicSpans(source);
  assert.deepEqual(spans.map(item => item.type), ['toc', 'references']);
  const plan = structure.splitChunksForGpt(source);
  assert.ok(plan.chunks.some(item => item.locked && item.lockType === 'toc_item'));
  assert.ok(plan.chunks.some(item => item.locked && item.lockType === 'reference_item'));
  const appendixBody = plan.chunks.find(item => item.text.includes('부록 본문'));
  assert.equal(appendixBody.locked, undefined);
});

test('표·로마 숫자 제목·통계 줄을 구조로 잠그고 청크 왕복을 보존한다', () => {
  const source = 'Ⅰ. 서론\n본문이다.\n\n표 1 연구 결과\n항목\t20명\t35%\t2026년\n\nⅡ. 결론\n마무리다.';
  const plan = structure.splitChunksForGpt(source);
  assert.ok(plan.chunks.some(item => item.lockType === 'heading'));
  assert.ok(plan.chunks.some(item => item.lockType === 'table'));
  assert.equal(structure.mergeChunks(plan.chunks), source);
  assert.equal(chunk.mergeChunks(chunk.splitChunks(source)), source);
});

test('의미 심사 뒤 제목을 독립 행으로 복원하고 보고서 문단 과분할을 제한한다', () => {
  const source = 'Ⅰ. 서론\n첫 번째 설명 문장입니다. 두 번째 설명 문장입니다.\n\nⅡ. 결론\n세 번째 설명 문장입니다. 네 번째 설명 문장입니다.';
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
  const inline = 'Ⅰ. 서론 첫 번째 설명 문장입니다.\n\n두 번째 설명 문장입니다.\n\n중간 설명입니다.\n\nⅡ. 결론 세 번째 설명 문장입니다.\n\n네 번째 설명 문장입니다.\n\n마무리 설명입니다.';
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: inline,
    chunks: plan.chunks,
    mode: 'assignment',
    documentProfile: 'report_assignment',
    profileConfidence: 0.9
  });
  assert.equal(restored.heading.missingCount, 0);
  assert.match(restored.text, /(?:^|\n)Ⅰ\. 서론(?:\n|$)/u);
  assert.match(restored.text, /(?:^|\n)Ⅱ\. 결론(?:\n|$)/u);
  assert.ok(restored.paragraphs.afterCount <= restored.paragraphs.targetCount);
  assert.equal(restored.pass, true);
});

test('polish 최종 레이아웃은 어휘를 바꾸지 않고 원문 문단 수를 복원한다', () => {
  const source = '첫 문장은 표현이 어색합니다. 둘째 문장은 연결이 매끄럽지 않습니다. 마지막 문장은 내용을 정리합니다.';
  const output = '첫 문장은 표현이 다소 어색합니다.\n\n둘째 문장은 연결이 자연스럽지 않습니다.\n\n마지막 문장은 내용을 정리합니다.';
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: output,
    chunks: plan.chunks,
    mode: 'polish',
    documentProfile: 'general',
    profileConfidence: 0.6
  });
  assert.equal(restored.paragraphs.sourceCount, 1);
  assert.equal(restored.paragraphs.beforeCount, 3);
  assert.equal(restored.paragraphs.afterCount, 1);
  assert.equal(restored.pass, true);
  assert.equal(restored.text.replace(/\s+/gu, ''), output.replace(/\s+/gu, ''));
});

test('일반 글도 원문 문단 분포의 1.5배를 넘는 과분할을 어휘 변경 없이 줄인다', () => {
  const source = [
    '첫 문단은 주제의 배경과 문제의식을 설명합니다. 이어서 탐구 목적을 정리합니다.',
    '둘째 문단은 작동 원리와 관련 근거를 설명합니다. 핵심 개념의 관계도 함께 정리합니다.',
    '셋째 문단은 관찰 결과와 한계를 설명합니다. 표본이 작다는 점도 밝힙니다.',
    '마지막 문단은 배운 점과 이후 계획을 정리합니다. 과도한 일반화는 피합니다.'
  ].join('\n\n');
  const output = koreanText.splitSentences(source).join('\n\n');
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: output,
    chunks: structure.splitChunksForGpt(source).chunks,
    mode: 'blog',
    documentProfile: 'general',
    profileConfidence: 0.65
  });
  assert.equal(restored.paragraphs.sourceCount, 4);
  assert.equal(restored.paragraphs.beforeCount, 8);
  assert.equal(restored.paragraphs.targetCount, 6);
  assert.equal(restored.paragraphs.afterCount, 6);
  assert.equal(restored.paragraphs.policy, 'bounded_source_paragraphs');
  assert.equal(restored.text.replace(/\s+/gu, ''), output.replace(/\s+/gu, ''));
  assert.equal(paragraphExpansionLimit(1, 900), 2);
  assert.equal(paragraphExpansionLimit(1, 2880), 9, '긴 단일 문단은 읽기 가능한 분할 여지를 남긴다');
});

test('공백이 든 빈 줄을 실제 문단 경계로 세고 청크 왕복에서 원문을 보존한다', () => {
  const source = '독립 제목\n \t\n첫 문단은 원문의 의미를 설명합니다.\n\n둘째 문단은 결과를 정리합니다.';
  const chunks = chunk.splitChunks(source);
  assert.equal(chunks.length, 3);
  assert.equal(chunk.mergeChunks(chunks), source);
  assert.equal(layoutStructure.splitExplicitParagraphs(source).length, 3);
});

test('제목과 완결된 긴 단일 행을 문단 역할로 인식해 장문을 다시 벽글로 합치지 않는다', () => {
  const title = '말이 안 된다고 생각하면서도 클릭했다';
  const bodyLines = Array.from({ length: 8 }, (_, index) => (
    `${index + 1}번째 단락은 사용자가 관찰한 과정과 판단 근거를 충분한 길이로 설명합니다. `
    + '이어서 앞 문장의 맥락을 유지하면서 구체적인 확인 내용을 정리합니다.'
  ));
  const source = [title, '', ...bodyLines].join('\n');
  const output = [title, ...bodyLines.flatMap(line => koreanText.splitSentences(line))].join('\n\n');
  const plan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveLineBoundaries: 'structural'
  });
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: output,
    chunks: plan.chunks,
    mode: 'assignment',
    documentProfile: { profile: 'general' },
    profileConfidence: 0.65
  });
  assert.ok(plan.chunks.some(item => item.locked && item.lockType === 'title'));
  assert.ok(plan.chunks.some(item => item.lineBoundaryPolicy === 'structural'));
  assert.ok(restored.paragraphs.sourceCount >= 9);
  assert.ok(restored.paragraphs.afterCount >= 9);
  assert.equal(restored.paragraphs.readability.overlongCount, 0);
  assert.match(restored.text, new RegExp(`^${title}\\n`, 'u'));
});

test('표·항목형 문서는 라벨 행만 역할 기반 경계 토큰으로 보존한다', () => {
  const source = [
    'Ⅰ. 운영 개요',
    '현황:',
    '현재 운영 상황과 확인된 수치를 설명하는 본문입니다.',
    '문제점:',
    '자료 반영 과정에서 확인한 문제와 원인을 설명하는 본문입니다.',
    '적용 범위: 전체 기관을 대상으로 단계적으로 적용합니다.',
    '검증 방법: 결과 수치를 같은 기준으로 다시 확인합니다.',
    '주요 기대 효과  기관  적용 범위  예상 값',
    '효과 항목  A기관  전체  35%'
  ].join('\n');
  const profile = detectDocumentProfile(source);
  const voice = buildVoiceProfile(source, { documentProfile: profile, mode: 'polish' });
  const plan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveLineBoundaries: voice.lineBoundaryPolicy,
    formatProfile: profile.formatProfile
  });
  assert.ok(profile.formatProfile.flags.includes('label_heavy'));
  assert.equal(voice.lineBoundaryPolicy, 'structural');
  assert.ok(plan.chunks.some(item => item.locked && item.lockType === 'label'));
  assert.ok(plan.chunks.some(item => item.locked && item.lockType === 'label_prefix'));
  assert.ok(plan.chunks.some(item => !item.locked && /전체 기관을 대상으로/u.test(item.text)));
  assert.equal(structure.mergeChunks(plan.chunks), source);
});

test('긴 단일 문단 polish는 내용 변경 없이 문장 경계에서 읽기 가능한 문단만 만든다', () => {
  const sentences = Array.from({ length: 14 }, (_, index) => (
    `${index + 1}번째 문장은 원문에 있는 업무 과정과 판단 근거를 삭제하지 않고 충분한 길이로 설명하며 표현만 안전하게 정리합니다.`
  ));
  const source = sentences.join(' ');
  const output = [
    sentences.slice(0, 3).join(' '),
    sentences.slice(3, 6).join(' '),
    sentences.slice(6, 9).join(' '),
    sentences.slice(9, 12).join(' '),
    sentences.slice(12).join(' ')
  ].join('\n\n');
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: output,
    chunks: structure.splitChunksForGpt(source, { coalesceEditable: true }).chunks,
    mode: 'polish',
    documentProfile: { profile: 'general' },
    profileConfidence: 0.6
  });
  assert.equal(restored.paragraphs.policy, 'readable_polish');
  assert.equal(restored.paragraphs.afterCount, 2);
  assert.equal(restored.paragraphs.readability.overlongCount, 0);
  assert.equal(restored.text.replace(/\s+/gu, ''), source.replace(/\s+/gu, ''));
  assert.equal(restored.pass, true);
});

test('최종 화자 감사는 제목 병합·라벨 손실·과대 문단을 사용자 경고로 기록한다', () => {
  const source = [
    '운영 결과를 다시 확인했다',
    '',
    '현황:',
    '첫 문단은 확인한 과정과 판단 근거를 충분한 길이로 설명합니다. '.repeat(8).trim(),
    '문제점:',
    '둘째 문단은 원문에서 확인한 문제와 이후 조치를 충분한 길이로 설명합니다. '.repeat(8).trim()
  ].join('\n');
  const collapsed = source.replace(/\n+/gu, ' ');
  const profile = { profile: 'report_assignment', formatProfile: { flags: ['sectioned', 'label_heavy'] } };
  const audit = auditVoice(
    buildVoiceProfile(source, { documentProfile: profile, mode: 'assignment' }),
    collapsed,
    { documentProfile: profile, mode: 'assignment' }
  );
  const codes = new Set(audit.warnings.map(item => item.code));
  assert.ok(codes.has('title_line_merged'));
  assert.ok(codes.has('structural_line_loss'));
  assert.ok(codes.has('line_structure_changed'));
  assert.ok(codes.has('paragraph_readability'));
});

test('v2 청커는 작은 본문 문단을 묶되 문단 구분과 동결 구조 왕복을 보존한다', () => {
  const paragraphs = Array.from({ length: 18 }, (_, index) => `본문 ${index + 1}은 원문의 의미와 구조를 보존하는 충분한 길이의 설명 문단입니다.`);
  const source = ['Ⅰ. 서론', ...paragraphs, 'Ⅱ. 결론', '마지막 문단입니다.'].join('\n\n');
  const legacyPlan = structure.splitChunksForGpt(source);
  const v2Plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
  assert.ok(v2Plan.chunks.length < legacyPlan.chunks.length);
  assert.equal(structure.mergeChunks(v2Plan.chunks), source);
  assert.ok(v2Plan.chunks.some(item => item.locked && item.lockType === 'heading'));
  assert.ok(v2Plan.chunks.some(item => !item.locked && item.text.includes('\n\n')));
  const coalesced = v2Plan.chunks.find(item => item.boundaryMarkers?.length);
  assert.ok(coalesced.llmText.includes('[[[V2_BOUNDARY_001]]]'));
  const restored = structure.restoreBoundaryMarkers(coalesced.llmText.replaceAll('본문', '내용'), coalesced);
  assert.equal(restored.ok, true);
  assert.equal(restored.text, coalesced.text.replaceAll('본문', '내용'));
  const missing = structure.restoreBoundaryMarkers(coalesced.llmText.replace('[[[V2_BOUNDARY_001]]]', ''), coalesced);
  assert.equal(missing.ok, false);
});

test('길이 변동이 큰 짧은 문서는 문장 경계 토큰을 왕복 보존한다', () => {
  const source = '짧은 관찰문임. 이 문장은 앞 문장보다 조금 더 길게 이어지는 내용임. 학생이 여러 자료를 직접 찾아 비교하고 발표 과정에서 질문에 답하며 탐구 내용을 확장한 매우 긴 관찰문임. 마지막은 다시 짧게 마무리함.';
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true, preserveSentenceBoundaries: true });
  const body = plan.chunks.find(item => item.sentenceBoundaryMarkers?.length);
  assert.ok(body);
  assert.equal(body.sentenceBoundaryMarkers.length, 3);
  assert.match(body.llmText, /\[\[\[V2_SENTENCE_0001\]\]\]/);
  const rewritten = body.llmText.replace('짧은 관찰문임', '짧게 관찰함');
  const restored = structure.restoreBoundaryMarkers(rewritten, body);
  assert.equal(restored.ok, true);
  assert.equal(restored.text, source.replace('짧은 관찰문임', '짧게 관찰함'));
  const missing = structure.restoreBoundaryMarkers(rewritten.replace('[[[V2_SENTENCE_0002]]]', ''), body);
  assert.equal(missing.ok, false);
  const extraSentence = structure.restoreBoundaryMarkers(rewritten.replace('이 문장은', '추가 문장임. 이 문장은'), body);
  assert.equal(extraSentence.ok, false);
  assert.equal(extraSentence.segmentationChanged, true);
  assert.equal(extraSentence.actualSentenceCount, extraSentence.expectedSentenceCount + 1);
});

test('polish용 3문장 문서도 기존 경계를 잠글 수 있다', () => {
  const source = '첫 문장은 다소 길게 이어지지만 하나의 의미 단위를 유지하며 기록함. 둘째 문장은 짧게 마무리함. 마지막 문장은 다시 충분한 설명을 담아 원문의 관찰 범위를 정리함.';
  const plan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveSentenceBoundaries: true,
    sentenceBoundaryMinimum: 3
  });
  const body = plan.chunks.find(item => item.sentenceBoundaryMarkers?.length);
  assert.ok(body);
  assert.equal(body.sentenceBoundaryMarkers.length, 2);
  assert.equal(structure.restoreBoundaryMarkers(body.llmText, body).ok, true);
});

test('세특의 독립 제목 행은 잠금 블록으로 왕복 보존한다', () => {
  const source = '교과 활동 관찰 기록\n학생은 자료를 비교하고 핵심 내용을 정리함. 발표 과정에서 친구의 질문에 답하며 탐구 범위를 넓힘.';
  const plan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveLineBoundaries: true
  });
  const title = plan.chunks.find(item => item.locked && item.lockType === 'title');
  assert.ok(title);
  assert.equal(structure.mergeChunks(plan.chunks), source);
  const inline = source.replace('\n', ' ').replace('핵심 내용을', '중요 내용을');
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: inline,
    chunks: plan.chunks,
    mode: 'assignment',
    documentProfile: { profile: 'student_record_teacher' },
    profileConfidence: 0.9
  });
  assert.match(restored.text, /^교과 활동 관찰 기록\n/u);
  assert.match(restored.text, /중요 내용을/u);
});

test('문서 프로필은 요청 mode와 basicStyle 없이 원문만으로 판정한다', () => {
  const source = '지원 동기\n저는 직무 역량을 바탕으로 귀사에 지원하게 되었습니다. 입사 후 포부를 말씀드리겠습니다.';
  const reportA = detectDocumentProfile(source, { basicStyle: 'blog' });
  const reportB = detectDocumentProfile(source, { basicStyle: 'report' });
  assert.equal(reportA.profile, 'resume_application');
  assert.equal(reportB.profile, 'resume_application');
  assert.equal(reportA.contentGenre, reportB.contentGenre);
  assert.equal(reportA.profileDecisionSource, 'content_only');
  assert.equal(reportA.tonePolicy, 'conversational');
  assert.equal(reportB.tonePolicy, 'formal');
  assert.ok(reportA.confidence >= 0.75);
});

test('사용자 장르 선택은 저신뢰 판정만 보완하고 고신뢰 원문 판정은 덮지 않는다', () => {
  const ambiguous = {
    profile: 'unknown', confidence: 0.51, group: 'unknown', profileDecisionSource: 'low_confidence_preserve',
    safetyProfiles: [], formatProfile: { flags: [] }
  };
  const applied = applyDocumentProfileOverride(ambiguous, 'resume_application');
  assert.equal(applied.profile, 'resume_application');
  assert.equal(applied.profileDecisionSource, 'user_override');
  assert.equal(applied.profileOverrideApplied, true);
  assert.ok(applied.safetyProfiles.includes('resume_application'));
  assert.equal(applied.detectedProfile, 'unknown');

  const confident = {
    profile: 'academic_paper', confidence: 0.91, group: 'academic_report_explainer',
    profileDecisionSource: 'content_only', safetyProfiles: ['academic_paper'], formatProfile: { flags: [] }
  };
  const ignored = applyDocumentProfileOverride(confident, 'review_blog');
  assert.equal(ignored.profile, 'academic_paper');
  assert.equal(ignored.profileOverrideApplied, false);
  assert.equal(ignored.profileOverrideIgnoredReason, 'high_confidence_content');
  assert.equal(ignored.requestedDocumentProfile, 'review_blog');
});

test('제목이 없는 경력 서술도 행동·성과·직무 연결이 함께 있으면 지원서로 판정한다', () => {
  const source = [
    '국제경제 수업에서 관세 정책을 주제로 발표했습니다.',
    '여러 자료를 수집하고 핵심을 분석한 뒤 발표 흐름과 화면 구성을 설계했습니다.',
    '데이터를 시각화하며 전달 역량을 키웠고 자격시험에도 합격해 실무 능력을 다졌습니다.',
    '이 경험을 교육 운영 지원 업무에 활용하고 조직에 기여하고 싶습니다.'
  ].join(' ');
  const report = detectDocumentProfile(source);
  assert.equal(report.profile, 'resume_application');
  assert.ok(report.confidence >= 0.75, JSON.stringify(report.candidateProfiles));
  assert.ok(report.safetyProfiles.includes('resume_application'));
});

test('논문 어휘가 많은 연구개발 자기소개서도 강점-수행-직업 포부 프레임으로 판정한다', () => {
  const source = [
    '저의 가장 큰 경쟁력은 공정 변수를 조정하고 측정 결과를 해석해 목표 특성을 구현하는 연구개발 역량입니다. 실험 설계부터 조건 최적화와 재현성 검증까지 직접 수행하며 데이터 신뢰성을 높였습니다.',
    '연구실에서는 분석 장비를 유지 관리하고 여러 시편을 측정했습니다. 결과를 공정 조건과 연결해 해석한 뒤 연구 과제 보고서에 반영했으며, 앞으로도 근거를 바탕으로 소재 개발에 기여하는 연구원이 되겠습니다.'
  ].join('\n\n');
  const report = detectDocumentProfile(source);
  assert.equal(report.profile, 'resume_application', JSON.stringify(report.candidateProfiles));
  assert.ok(report.confidence >= 0.75, JSON.stringify(report.candidateProfiles));
  assert.ok(report.safetyProfiles.includes('resume_application'));
  assert.ok(report.signals.applicationValuePropositionSignals >= 1);
  assert.ok(report.signals.careerAspirationSignals >= 1);
  assert.ok(report.candidateProfiles.find(item => item.profile === 'resume_application').score
    > report.candidateProfiles.find(item => item.profile === 'academic_paper').score);
});

test('숫자가 많은 일반 문장과 구매·가격 연구어를 표·광고로 오인하지 않는다', () => {
  const source = [
    '소비자의 구매 단계와 가격 정보가 선택에 미치는 영향을 분석했다.',
    '표본은 20명, 비교 비율은 35%, 조사 연도는 2026년이며 모형의 계수는 1.25였다.',
    '구매 가격과 결제 순서를 변수로 두고 연구 결과를 보고서에 정리했다.'
  ].join('\n');
  const report = detectDocumentProfile(source);
  assert.equal(report.formatProfile.flags.includes('table_heavy'), false);
  assert.notEqual(report.profile, 'marketing');
  assert.equal(report.riskFlags.includes('commercial_claim'), false);
  assert.equal(report.riskFlags.includes('experience_claim'), false);
});

test('게임 모델·소비자 구매를 다루는 학술 구조를 자소서나 광고로 오인하지 않는다', () => {
  const source = `온라인 선택 설계가 소비자 후생에 미치는 영향 분석
1. 서론
본 연구는 정보 비대칭성 관점에서 선택 설계의 발생 원인을 분석하고 순차 게임 모델로 규제의 경제적 정당성을 검토한다.
2. 이론적 배경
무료 체험 이후 자동 결제와 구매 전환은 소비자의 제한된 합리성에 영향을 줄 수 있다.
3. 연구 모형
플랫폼의 전략과 소비자의 수용·이탈을 변수로 두고 보수 구조를 모형화한다. 연구 가설은 규제 비용이 기만 이익보다 커질 때 정직한 설계가 선택된다는 것이다.
4. 결론 및 향후 연구
향후 연구에서는 이용자 설문과 실제 이탈률을 수집해 가설을 실증적으로 분석할 필요가 있다.
참고문헌
공정거래위원회. (2023. 7. 31.). 온라인 다크패턴 가이드라인.
한국소비자원. (2024. 1. 25.). 온라인 거래 소비자 조사.
정책연구원. (2025. 2. 10.). 플랫폼 규제 연구.`;
  const report = detectDocumentProfile(source);
  assert.equal(report.profile, 'academic_paper');
  assert.equal(report.candidateProfiles[0].profile, 'academic_paper');
  assert.ok(report.formatProfile.flags.includes('reference_heavy'));
  assert.ok(!report.riskFlags.includes('commercial_claim'));
  const marketing = report.candidateProfiles.find(item => item.profile === 'marketing');
  assert.ok(!marketing || marketing.score <= 0.9);
});

test('그날의·바람 같은 약한 어휘만으로 창작 보호 프로필을 켜지 않는다', () => {
  const source = '그날의 가격 변화를 살펴봤다. 바람이 강한 날에는 구매량이 달라졌고 소비자 선택에도 영향을 주었다. 분석 결과는 보고서에 정리했다.';
  const report = detectDocumentProfile(source);
  assert.notEqual(report.profile, 'creative');
  assert.equal(report.safetyProfiles.includes('creative'), false);
});

test('번호형 학생 자기평가는 basicStyle과 무관하게 장르·형식·위험 축을 분리한다', () => {
  const questions = [
    '이번 수업 활동에서 맡은 역할은 무엇인가요?',
    '자료를 찾을 때 어떤 방법을 사용했나요?',
    '모둠 활동에서 기여한 점을 설명하세요.',
    '발표를 준비하며 가장 노력한 점은 무엇인가요?',
    '활동 과정에서 어려웠던 점은 무엇인가요?',
    '그 어려움을 어떻게 해결했나요?',
    '이번 활동에서 새롭게 배운 점은 무엇인가요?',
    '부족했던 점과 개선 방법을 작성하세요.',
    '친구의 의견을 반영한 경험은 무엇인가요?',
    '다음 학습에서 이어 갈 계획을 적어 주세요.'
  ];
  const source = questions.map((question, index) => (
    `${index + 1}. ${question}\n${index < 2 ? '나는 ' : ''}자료를 살피고 의견을 정리하면서 맡은 활동을 수행했다.`
  )).join('\n\n');
  const variants = ['', 'blog', 'report'].map(basicStyle => detectDocumentProfile(source, { basicStyle }));
  assert.deepEqual(variants.map(item => item.contentGenre), [
    'student_self_assessment',
    'student_self_assessment',
    'student_self_assessment'
  ]);
  assert.deepEqual(variants.map(item => item.tonePolicy), ['source_preserve', 'conversational', 'formal']);
  const profile = variants[1];
  assert.equal(profile.formatProfile.primary, 'questionnaire');
  assert.equal(profile.formatProfile.length, 'standard');
  assert.ok(profile.formatProfile.flags.includes('line_sensitive'));
  assert.ok(profile.safetyProfiles.includes('student_self_assessment'));
  assert.ok(profile.riskFlags.includes('pov_sensitive'));
  assert.ok(profile.riskFlags.includes('questionnaire_answer_boundary'));
  assert.equal(profile.riskFlags.includes('number_dense'), false, '질문 번호는 사실 수치로 세지 않아야 한다');

  const plan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    formatProfile: profile.formatProfile
  });
  const lockedQuestions = plan.chunks.filter(item => item.lockType === 'questionnaire_question');
  const answers = plan.chunks.filter(item => !item.locked);
  assert.equal(lockedQuestions.length, 10);
  assert.equal(answers.length, 10);
  assert.equal(structure.mergeChunks(plan.chunks), source);
  assert.ok(answers.every(item => item.sectionPath && !item.text.includes('?')));
  const reversed = [...plan.chunks].reverse().map(item => `${item.text}${item.sep || ''}`).join('');
  const orderAudit = structure.buildStructureAudit({ source, outputText: reversed, chunks: plan.chunks, plan });
  assert.equal(orderAudit.lockedOrderChanged, true);
  assert.equal(orderAudit.pass, false);
});

test('보고서가 최종 장르여도 중간 신뢰도 학생 자기평가 후보의 보호 규칙을 합성한다', () => {
  const source = [
    '서론 본론 결론 보고서 목차 조사 결과 문제점 개선 방안 시사점',
    'Ⅰ. 서론',
    '1. 이번 수업 활동에서 맡은 역할은 무엇인가요?',
    '자료를 비교하고 의견을 정리했다.',
    '2. 활동 과정에서 배운 점은 무엇인가요?',
    '설명 순서를 다시 확인하는 방법을 배웠다.',
    '3. 부족했던 점을 어떻게 개선할 계획인가요?',
    '다음 활동에서는 준비 시간을 더 체계적으로 나눌 계획이다.',
    'Ⅱ. 결론'
  ].join('\n');
  const profile = detectDocumentProfile(source, { basicStyle: 'blog' });
  assert.equal(profile.profile, 'report_assignment');
  assert.ok(profile.candidateProfiles.some(item => item.profile === 'student_self_assessment'));
  assert.ok(profile.safetyProfiles.includes('student_self_assessment'));
  assert.ok(profile.riskFlags.includes('pov_sensitive'));
  assert.ok(profile.riskFlags.includes('experience_claim'));
  assert.ok(profile.riskFlags.includes('evaluation_claim'));
  assert.ok(profile.riskFlags.includes('questionnaire_answer_boundary'));
});

test('공통 프롬프트는 불변 계약과 요청 강도를 한 번씩만 선언하고 업종 하드코딩을 포함하지 않는다', () => {
  const source = '활동 질문에 답하고 배운 점을 정리했다.';
  const documentProfile = detectDocumentProfile(source, { basicStyle: 'blog' });
  const voiceProfile = buildVoiceProfile(source, { documentProfile });
  const basic = prompts.buildHumanizePrompt('blog', 'ko', {
    requestStrength: 'basic',
    register: voiceProfile.register,
    documentProfile,
    voiceProfile
  }).stable;
  const advanced = prompts.buildHumanizePrompt('assignment', 'ko', {
    requestStrength: 'advanced',
    register: voiceProfile.register,
    documentProfile,
    voiceProfile
  }).stable;
  assert.equal((basic.match(/\[요청 강도: 기본\]/gu) || []).length, 1);
  assert.equal((advanced.match(/\[요청 강도: 고급\]/gu) || []).length, 1);
  assert.match(advanced, /고급은 기본보다 더 넓은 범위의 일반 문장/u);
  assert.match(advanced, /고급 범위로 실질 재구성/u);
  assert.match(basic, /눈에 띄는 실질 휴머나이징/u);
  assert.match(basic, /띄어쓰기·쉼표·조사·단순 동의어만 바꾼 결과는 실패/u);
  assert.doesNotMatch(basic, /안전한 한 곳만|이 청크만 다듬는다/u);
  assert.doesNotMatch(basic, /보존에 머무르지|원문과 가깝게 두지|충분히 재서술/u);
  assert.doesNotMatch(advanced, /청소|청결|악취|곰팡|하수구|업체 후기/u);
  const advancedDynamic = prompts.buildHumanizePrompt('assignment', 'ko', {
    requestStrength: 'advanced',
    register: voiceProfile.register,
    documentProfile: { ...documentProfile, tonePolicy: 'source_preserve' },
    voiceProfile
  }).dynamic;
  assert.match(advancedDynamic, /tonePolicy=preserve_register_only; rewriteScope=advanced/u);
  assert.doesNotMatch(advancedDynamic, /tonePolicy=source_preserve/u);
});

test('지원서 프롬프트는 거시 구조와 미시 편집을 분리하고 직무 어휘 격식을 지킨다', () => {
  const source = '저는 자료를 분석해 발표 흐름을 설계했고 이 경험을 운영 지원 업무에 활용하고 싶습니다.';
  const documentProfile = {
    profile: 'resume_application',
    group: 'essay_application',
    confidence: 0.9,
    tonePolicy: 'formal',
    formatProfile: { flags: [] },
    safetyProfiles: ['resume_application'],
    riskFlags: ['pov_sensitive', 'experience_claim']
  };
  const voiceProfile = buildVoiceProfile(source, { documentProfile });
  const prompt = prompts.buildHumanizePrompt('blog', 'ko', {
    requestStrength: 'basic',
    register: voiceProfile.register,
    documentProfile,
    voiceProfile
  }).stable;
  assert.match(prompt, /거시 구조는 잠금 대상/u);
  assert.match(prompt, /미시 문장은 편집 대상/u);
  assert.match(prompt, /자기소개서의 직무·성과·역량 어휘/u);
  assert.match(prompt, /짰다·봤다·힘·준·어울렸다·일했다/u);
  const advancedPrompt = prompts.buildHumanizePrompt('assignment', 'ko', {
    requestStrength: 'advanced',
    register: voiceProfile.register,
    documentProfile,
    voiceProfile
  }).stable;
  assert.match(advancedPrompt, /역량을 길렀다·능력을 키웠다·노력했다/u);
  assert.match(advancedPrompt, /첫 문단만 재작성하고 뒤 문단을 복사하지 않는다/u);
});

test('학술·보고서 프롬프트는 논리 연산자·행위 주체·표 압축도·격식을 보존한다', () => {
  const source = '본 연구는 새 도구의 개발 자체보다 자료와 판단의 구조화에 초점을 둔다.';
  const documentProfile = {
    profile: 'academic_paper',
    group: 'academic_report_explainer',
    confidence: 0.95,
    tonePolicy: 'formal',
    formatProfile: { flags: ['sectioned', 'table_heavy'] },
    safetyProfiles: ['academic_paper'],
    riskFlags: ['citation_dense']
  };
  const voiceProfile = buildVoiceProfile(source, { documentProfile });
  const prompt = prompts.buildHumanizePrompt('assignment', 'ko', {
    requestStrength: 'advanced',
    register: voiceProfile.register,
    documentProfile,
    voiceProfile
  }).stable;
  assert.match(prompt, /~자체보다.*~에서 나아가/u);
  assert.match(prompt, /~에 그치지 않고.*~이\/가 아니라/u);
  assert.match(prompt, /행위 주체와 대상/u);
  assert.match(prompt, /설명 평서문.*명령문/u);
  assert.match(prompt, /표·그림 제목·캡션·셀/u);
  assert.match(prompt, /재다·메우다/u);
  assert.match(prompt, /의인화하지 않는다/u);
});

test('문단 안에서 반복되는 관찰형 명사 종결은 세특 프로필로 판정한다', () => {
  const source = '체육 수업과 활동에 꾸준히 참여함. 친구들에게 자세와 방법을 알려 주며 협력하는 태도를 보임. 어려움이 있어도 끝까지 해내는 모습을 보임. 체력과 책임감을 함께 키워 나감. 다양한 방향을 탐색하며 성장하려는 자세를 지님.';
  const report = detectDocumentProfile(source, { basicStyle: 'blog' });
  assert.equal(report.profile, 'student_record_teacher');
  assert.ok(report.confidence >= 0.75);
  assert.ok(report.signals.nominalObservationEndings >= 3);
});

test('미래형 수업 계획 목록은 명사형 종결만으로 세특이 되지 않는다', () => {
  const source = '- 명화의 배색을 분석하는 수업을 진행할 예정임.\n- 팔레트를 활용해 일러스트레이션을 제작할 계획임.\n- 디지털 도구 활용법을 익히는 것을 학습 목표로 설정함.';
  const report = detectDocumentProfile(source);
  assert.notEqual(report.profile, 'student_record_teacher');
  assert.ok(report.signals.instructionalPlanSignals >= 2);
  assert.ok(report.signals.bulletLineCount >= 2);
});

test('voice 프롬프트는 원문의 문장 길이 범위와 비균일 경계를 명시한다', () => {
  const source = '짧은 문장임. 이 문장은 앞 문장보다 조금 더 길게 이어지는 관찰 내용임. 학생이 여러 자료를 직접 찾아 비교하고 발표 과정에서 친구들의 질문에 답하며 탐구 내용을 확장한 매우 긴 문장임. 마지막 문장은 다시 짧게 마무리함.';
  const prompt = voicePromptBlock(buildVoiceProfile(source, { documentProfile: 'student_record_teacher' }));
  assert.match(prompt, /문장 수≈4/);
  assert.match(prompt, /길이 범위≈\d+~\d+자/);
  assert.match(prompt, /원문 문장별 길이 순서≈\d+→\d+→\d+→\d+자/);
  assert.match(prompt, /길이를 고르게 만들 목적으로 합치거나 쪼개지 않는다/);
});

test('voice 프롬프트는 20문장 이하의 길이 순서와 구두점 없는 장문의 비균일 분할 목표를 보존한다', () => {
  const manySentences = Array.from({ length: 17 }, (_, index) => `${index + 1}번째 문장은 ${'내용을 '.repeat((index % 5) + 1)}기록함.`).join(' ');
  const manyProfile = buildVoiceProfile(manySentences, { documentProfile: 'general' });
  assert.equal(manyProfile.sentence.lengthSequence.length, 17);
  assert.match(voicePromptBlock(manyProfile), /원문 문장별 길이 순서≈/);

  const runOn = '북한의 문화어 제정은 단순한 표준어 확립이 아니라 언어를 국가 이념과 사회 통제의 수단으로 재구성한 사례로 이해할 수 있다 국가 언어 정책은 민족 정체성을 내세우면서도 사회주의 사상 교육의 매개로 활용되었다 문화어는 그 담론을 일상 언어 속에 심는 제도적 장치였고 장기간 이어진 우리말 다듬기는 남북한 어휘 차이를 확대하는 결과를 낳았다 외부에서 보면 동일 언어 공동체 내부의 상호이해 가능성을 약화하는 방향으로 작용하였다 언어를 통한 통합의 장치라기보다 체제 내부 결속을 강화하고 외부와의 언어적 경계를 분명하게 만드는 분리의 장치로 기능하였으며 일상적인 표현과 교육 현장에도 지속적인 영향을 남겼다';
  const runOnProfile = buildVoiceProfile(runOn, { documentProfile: 'unknown' });
  const runOnPrompt = voicePromptBlock(runOnProfile);
  assert.equal(runOnProfile.sentence.punctuationSparse, true);
  assert.match(runOnPrompt, /구두점이 거의 없이 이어진 초안/);
  assert.match(runOnPrompt, /짧은 문장과 \d+자 이상의 긴 문장/);
  assert.match(runOnPrompt, /바로 앞 문장을 요약·평가·되풀이하는 새 덧문장을 만들지 않는다/);
  assert.match(runOnPrompt, /원문 내용을 삭제하거나 서로 다른 주장을 억지로 합치지 않는다/);
});

test('voice 감사는 장단문 분포가 크게 평탄해지면 사용자 검토 경고를 남긴다', () => {
  const source = '짧게 관찰함. 이 문장은 중간 길이의 관찰 내용을 기록함. 학생이 여러 자료를 직접 비교하고 발표 과정에서 질문에 답하며 탐구 내용을 크게 확장한 매우 긴 관찰 문장을 기록함. 다시 짧게 마무리함.';
  const output = '학생의 활동을 차분하게 관찰하고 내용을 기록함. 관련 자료를 찾아 비교하며 탐구 내용을 정리함. 발표 과정에서 질문에 답하고 내용을 확장함. 마지막으로 활동의 의미와 과정을 함께 정리함.';
  const profile = buildVoiceProfile(source, { documentProfile: 'student_record_teacher' });
  const audit = auditVoice(profile, output, { documentProfile: 'student_record_teacher', mode: 'assignment' });
  assert.ok(audit.warnings.some(item => item.code === 'sentence_distribution_shift'));
});

test('청크와 최종 감사가 같은 짧은 문서 장단문 분포 판정을 공유한다', () => {
  const textWithLengths = lengths => lengths.map(length => `${'가'.repeat(length - 1)}.`).join(' ');
  const source = buildVoiceProfile(textWithLengths([60, 92, 76, 72])).sentence;
  const flattened = buildVoiceProfile(textWithLengths([63, 92, 70, 73])).sentence;
  const localized = buildVoiceProfile(textWithLengths([60, 92, 76, 73])).sentence;
  assert.equal(sentenceDistributionShift(source, flattened).shift, true);
  assert.equal(sentenceDistributionShift(source, localized).shift, false);
});

test('voice 감사는 구두점 없는 장문의 분할 목표가 남지 않으면 검토 경고를 남긴다', () => {
  const sourcePart = '학습 활동에 참여하면서 자료를 비교하고 핵심 내용을 정리하는 방법을 익혔다 처음에는 설명 방향을 잡기 어려웠지만 여러 사례를 차분히 살피면서 상대가 이해하기 어려워하는 지점을 확인했다 질문을 주고받는 과정에서 모호하게 알고 있던 개념을 다시 정리했고 다른 관점을 존중하는 태도도 배웠다 마지막에는 함께 문제를 해결한 과정이 확실한 복습이 되었으며 앞으로도 배운 내용을 꾸준히 나누겠다는 생각을 갖게 되었다';
  const source = `${sourcePart} ${sourcePart}`;
  const uniform = '학습 활동에 참여하면서 자료를 비교하고 핵심 내용을 정리하는 방법을 차분하게 익혔다. 처음에는 설명 방향을 잡기 어려웠지만 여러 사례를 살피면서 이해하기 어려운 지점을 확인했다. 질문을 주고받는 과정에서 모호하게 알고 있던 개념을 다시 정리하고 다른 관점을 존중했다. 마지막에는 함께 문제를 해결한 과정이 복습이 되었고 앞으로도 배운 내용을 꾸준히 나누기로 했다.';
  const profile = buildVoiceProfile(source, { documentProfile: 'unknown' });
  const audit = auditVoice(profile, uniform, { documentProfile: 'unknown', mode: 'assignment' });
  assert.equal(profile.sentence.punctuationSparse, true);
  assert.ok(audit.warnings.some(item => item.code === 'sentence_distribution_shift'));
});

test('창작문은 줄바꿈을 구조로 기록하고 화자 변화 감사를 공유한다', () => {
  const poem = '밤이 온다\n창문에 빛이 머문다\n나는 한참 서 있다\n바람은 대답하지 않는다';
  const voice = buildVoiceProfile(poem, { documentProfile: 'creative' });
  assert.equal(voice.lineBreakSensitive, true);
  assert.equal(voice.lineCount, 4);
  const audit = auditVoice(voice, poem.replace('나는 ', ''), { documentProfile: 'creative' });
  assert.ok(audit.warnings.some(item => item.code === 'speaker_removed'));
});

test('세특의 제목 행과 줄바꿈은 voice 구조로 기록하고 변경을 경고한다', () => {
  const source = '교과 활동 관찰 기록\n학생은 자료를 비교하고 발표 과정에서 질문에 답하며 탐구 범위를 넓힘.';
  const voice = buildVoiceProfile(source, { documentProfile: 'student_record_teacher' });
  assert.equal(voice.lineStructureSensitive, true);
  assert.match(voicePromptBlock(voice), /제목·항목 라벨·표·목록/u);
  const audit = auditVoice(voice, source.replace('\n', ' '), { documentProfile: 'student_record_teacher' });
  assert.ok(audit.warnings.some(item => item.code === 'title_line_merged'));
});

test('polish voice 감사는 새 문단과 제목 구조 변경을 경고한다', () => {
  const source = '제 1장 연구\n본문은 한 문단으로 이어집니다.';
  const voice = buildVoiceProfile(source, { documentProfile: 'report_assignment' });
  const audit = auditVoice(voice, '본문이 바뀝니다.\n\n새 문단이 생깁니다.\n\n세 번째 문단도 생깁니다.', { documentProfile: 'report_assignment', mode: 'polish' });
  assert.ok(audit.warnings.some(item => item.code === 'paragraph_structure_changed'));
  assert.ok(audit.warnings.some(item => item.code === 'heading_structure_changed'));
});

test('리듬 shadow는 네 문장 미만 원문과 분할 결과를 악화값으로 비교하지 않는다', () => {
  const sparse = '첫째 내용을 길게 설명하고 둘째 근거를 이어서 정리하며 셋째 관찰과 마지막 판단까지 구두점 없이 한 흐름으로 기록한다';
  const split = '첫째 내용을 길게 설명한다. 둘째 근거를 이어서 정리한다. 셋째 관찰을 기록한다. 마지막 판단까지 한 흐름으로 기록한다.';
  const incomparable = compareNaturalnessShadow(sparse, split);
  assert.equal(incomparable.rhythmComparable, false);
  assert.equal(incomparable.rhythmUniformityDelta, null);
  assert.equal(incomparable.delta.uniformSentenceRhythm, null);

  const varied = '짧게 끝난다. 두 번째 문장은 비교적 긴 설명을 담아 서로 다른 호흡이 자연스럽게 이어지도록 구성한다. 다시 짧다. 마지막 문장은 앞의 관찰을 구체적인 맥락과 함께 충분히 풀어 정리한다.';
  const uniform = '첫 번째 문장은 내용을 차분하게 정리한다. 두 번째 문장은 근거를 차분하게 정리한다. 세 번째 문장은 관찰을 차분하게 정리한다. 네 번째 문장은 판단을 차분하게 정리한다.';
  const comparable = compareNaturalnessShadow(varied, uniform);
  assert.equal(comparable.rhythmComparable, true);
  assert.ok(comparable.rhythmUniformityDelta > 0);
});

test('리듬 shadow는 4문장 same-band 한 칸 이동을 큰 악화로 과장하지 않는다', () => {
  const build = lengths => lengths.map(length => `${'a'.repeat(length - 1)}x.`).join(' ');
  const source = build([26, 34, 34, 44]);
  const output = build([20, 20, 22, 32]);
  const audit = compareNaturalnessShadow(source, output);
  assert.equal(audit.version, 4);
  assert.equal(audit.rhythmComparable, true);
  assert.ok(audit.after.sentenceCv > audit.before.sentenceCv, 'CV 기준 리듬은 더 다양해져야 한다');
  assert.ok(audit.rhythmUniformityDelta <= 0.03, JSON.stringify(audit));
});

test('운영 프롬프트는 원문에 없던 보고서식 완충 표현을 새로 만들지 않게 명시한다', () => {
  const built = prompts.buildHumanizePrompt('blog', 'ko', {
    documentProfile: { profile: 'general', confidence: 0.6, formatProfile: { flags: [] } }
  });
  assert.match(built.stable, /할 수 있다·볼 수 있다·필요가 있다/u);
  assert.match(built.stable, /다듬기 모드에서도/u);
});

test('voice 프롬프트는 기존 1인칭을 최소 한 곳 남기고 새 화자는 만들지 않게 한다', () => {
  const personal = voicePromptBlock(buildVoiceProfile('저는 자료를 읽었습니다. 결론을 다시 정리했습니다.', { documentProfile: 'general_essay' }));
  const impersonal = voicePromptBlock(buildVoiceProfile('자료를 읽었습니다. 결론을 다시 정리했습니다.', { documentProfile: 'general_essay' }));
  assert.match(personal, /1인칭 단수.*종류별로 최소 한 곳 남긴다/u);
  assert.match(personal, /화자를 완전히 지우지 않는다/u);
  assert.match(impersonal, /원문에 없는 나는·저는·제가·우리·저희/u);
});

test('우리 몸의 bare 우리를 집단 화자로 세고 polish의 실제 화자 완전 손실만 복원한다', () => {
  const sourceWithCollective = '우리 몸은 방어 작용을 조절합니다. 우리의 미래 보건에도 중요한 의미가 있습니다.';
  const preservedCollective = '우리 몸은 방어 작용을 조절합니다. 미래 보건에도 중요한 의미가 있습니다.';
  const collectiveVoice = buildVoiceProfile(sourceWithCollective);
  const collectiveAudit = auditVoice(collectiveVoice, preservedCollective, { mode: 'polish' });
  assert.ok(collectiveVoice.pov.firstPlural >= 2);
  assert.equal(collectiveAudit.warnings.some(item => item.code === 'speaker_removed'), false);

  const source = '저는 관련 자료를 직접 조사했습니다. 결과는 표로 정리했고 표현이 조금 어색했습니다.';
  const output = '관련 자료를 직접 조사했습니다. 결과는 표로 정리했고 표현이 다소 어색했습니다.';
  const restored = qualityV2.restoreMissingPolishSpeaker({ source, outputText: output, documentProfile: 'general_essay' });
  assert.equal(restored.applied, true);
  assert.equal(restored.restoredSentenceCount, 1);
  assert.match(restored.text, /^저는 관련 자료를 직접 조사했습니다\./u);
  assert.match(restored.text, /표현이 다소 어색했습니다\.$/u);
  const repairedAudit = auditVoice(buildVoiceProfile(source), restored.text, { mode: 'polish' });
  assert.equal(repairedAudit.warnings.some(item => item.code === 'speaker_removed'), false);
});

test('우리학교 띄어쓰기 보정은 새 화자로 오인하지 않되 실제 우리 주입은 경고한다', () => {
  const source = '물질주의의 예시로는 우리학교의 자판기가 있다. 나도 보상 심리를 느낀다.';
  const spacingOnly = '물질주의의 예시로는 우리 학교의 자판기가 있다. 나도 보상 심리를 느낀다.';
  const voice = buildVoiceProfile(source);
  const spacingAudit = auditVoice(voice, spacingOnly, { mode: 'polish', sourceText: source });
  assert.equal(spacingAudit.warnings.some(item => item.code === 'speaker_injected'), false);

  const injected = `${spacingOnly} 우리는 이 문제를 해결해야 한다.`;
  const injectedAudit = auditVoice(voice, injected, { mode: 'polish', sourceText: source });
  assert.ok(injectedAudit.warnings.some(item => item.code === 'speaker_injected'));
});

test('원문에 있던 발화 내용에 따옴표만 보완하면 인용 변경으로 경고하지 않는다', () => {
  const source = '선생님께서 목소리에서 전달력이 느껴져 좋았다라고 칭찬하셨다.';
  const quoted = '선생님께서 "목소리에서 전달력이 느껴져 좋았다"라고 칭찬하셨다.';
  const voice = buildVoiceProfile(source);
  const punctuationAudit = auditVoice(voice, quoted, { sourceText: source });
  assert.equal(punctuationAudit.warnings.some(item => item.code === 'quote_count_changed'), false);

  const invented = '선생님께서 "발표가 완벽했다"라고 칭찬하셨다.';
  const inventedAudit = auditVoice(voice, invented, { sourceText: source });
  assert.ok(inventedAudit.warnings.some(item => item.code === 'quote_count_changed'));
});

test('원문의 마침표 뒤 누락 공백만 보정한 결과를 리듬 평탄화로 오인하지 않는다', () => {
  const source = `${'가'.repeat(160)}.${'나'.repeat(60)}. ${'다'.repeat(82)}. ${'라'.repeat(45)}.`;
  const output = source.replace(/\.(?=나)/u, '. ');
  const voice = buildVoiceProfile(source);
  const repairedAudit = auditVoice(voice, output, {
    sourceText: source,
    formattingSentenceSpaceRepairCount: 1
  });
  assert.equal(repairedAudit.warnings.some(item => item.code === 'sentence_distribution_shift'), false);
});

test('민감 문서 프로필은 목록의 삭제뿐 아니라 신규 목록 추가도 경고한다', () => {
  const source = '연구 결과는 본문 문장으로 설명한다.';
  const voice = buildVoiceProfile(source, { documentProfile: 'report_assignment' });
  const audit = auditVoice(voice, '- 연구 결과를 본문 문장으로 설명한다.', { documentProfile: 'report_assignment', mode: 'assignment' });
  assert.ok(audit.warnings.some(item => item.code === 'list_structure_changed'));
});

test('polish 편집률 정책은 문서 단위 무변환과 길이별 상한을 서버에서 계산한다', () => {
  const source = '이 문장은 표현이 조금 어색하고 연결도 매끄럽지 않습니다.';
  const safe = qualityV2.polishEditPolicy(source, '이 문장은 표현이 다소 어색하고 연결도 매끄럽지 않습니다.');
  assert.equal(safe.pass, true);
  assert.deepEqual(
    contract.buildContract(source, { mode: 'polish' }).lengthPolicy,
    { min: safe.limits.minLength, max: safe.limits.maxLength, hardMax: safe.limits.maxLength }
  );
  const noChange = qualityV2.polishEditPolicy(source, source);
  assert.equal(noChange.noSafeChange, true);
  const rewrite = qualityV2.polishEditPolicy(source, '전혀 다른 주장과 사례를 새로 만든 문장입니다.');
  assert.equal(rewrite.excessiveChange, true);
  const longSource = `${source} `.repeat(40).trim();
  const oneSafeEdit = qualityV2.polishEditPolicy(longSource, longSource.replace('조금 어색하고', '다소 어색하고'));
  assert.equal(oneSafeEdit.pass, true);
  assert.equal(oneSafeEdit.belowRecommendedChange, true);
  assert.deepEqual(
    contract.buildContract(longSource, { mode: 'polish' }).lengthPolicy,
    { min: oneSafeEdit.limits.minLength, max: oneSafeEdit.limits.maxLength, hardMax: oneSafeEdit.limits.maxLength }
  );
});

test('의미 심사 트리거는 formal·polish·장문 blog·저유사도·복합 구조를 포함한다', () => {
  const base = { editMetrics: { fiveGramSimilarity: 1 }, protectedFactCount: 0, structureSignals: {}, warnings: [] };
  assert.equal(qualityV2.shouldRunSemanticJudge({ requestedMode: 'formal', effectiveMode: 'assignment', source: '가', audit: base }).run, true);
  assert.equal(qualityV2.shouldRunSemanticJudge({ requestedMode: 'polish', effectiveMode: 'polish', source: '가', audit: base }).run, true);
  assert.equal(qualityV2.shouldRunSemanticJudge({ requestedMode: 'blog', effectiveMode: 'blog', source: '가'.repeat(1500), audit: base }).run, true);
  assert.equal(qualityV2.shouldRunSemanticJudge({ requestedMode: 'blog', effectiveMode: 'blog', source: '짧은 글', audit: { ...base, editMetrics: { fiveGramSimilarity: 0.2 } } }).run, true);
  const questionnaire = {
    profile: 'general',
    confidence: 0.62,
    safetyProfiles: ['student_self_assessment'],
    formatProfile: { primary: 'questionnaire', flags: ['questionnaire'] },
    riskFlags: ['questionnaire_answer_boundary']
  };
  assert.equal(qualityV2.shouldRunSemanticJudge({ requestedMode: 'blog', effectiveMode: 'blog', source: '짧은 답변', documentProfile: questionnaire, audit: base }).reason, 'questionnaire');
});

test('12,000자 초과 심사는 원문과 결과 중 더 긴 쪽 기준으로 겹침 섹션을 만든다', () => {
  const source = '원문 문장이다. '.repeat(1800);
  const output = '결과 문장이다. '.repeat(500);
  const pairs = qualityV2.buildReviewPairs(source, output);
  assert.ok(pairs.length >= 2);
  assert.equal(pairs.map(pair => pair.output).join(''), output);
  assert.ok(pairs.every(pair => pair.sourceContext.length < source.length));
});

test('의미 심사는 원문 핵심 내용 누락을 사용자 경고 코드로 변환한다', () => {
  const warnings = qualityV2.warningsFromSemantic({
    ran: true,
    pass: false,
    violations: [{ type: 'omission', span: '', detail: '핵심 결론 누락' }]
  });
  assert.ok(warnings.some(item => item.code === 'semantic_omission'));
});
