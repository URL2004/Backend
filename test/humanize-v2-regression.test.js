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
const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');
const { buildVoiceProfile, voicePromptBlock, auditVoice, sentenceDistributionShift } = require('../engine-gpt-prod/voiceProfile');
const qualityV2 = require('../engine-gpt-prod/finalQualityV2');
const factAudit = require('../engine-gpt-prod/factAudit');
const { assessRepairCandidate } = require('../engine-gpt-prod/judge');

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
  const clean = nikl.analyzeNiklQuality('20명과 35%가 참여했고 2026년에 마쳤다.');
  assert.equal(clean.normPatterns.some(item => item.id === 'double_particle'), false);
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
  const source = '이 연구는 자료를 분석한다.';
  const injected = floor.measurePovDrift(source, '저는 이 연구에서 자료를 분석한다.');
  assert.equal(injected.introducedAnyFirstPerson, true);
  const dropped = floor.measurePovDrift('저는 자료를 분석했다.', '자료를 분석했다.');
  assert.equal(dropped.droppedFirstPerson, true);
});

test('dedupe는 인과 방향이 다른 유사 문장을 보존하고 인접 완전 중복만 제거한다', () => {
  const source = '원인이 결과를 만든다. 결과가 원인을 만든다.\n\n같은 문장이다.\n\n같은 문장이다.';
  const report = dedupe.dedupeSentences(source);
  assert.match(report.text, /원인이 결과를 만든다\. 결과가 원인을 만든다\./u);
  assert.equal((report.text.match(/같은 문장이다\./gu) || []).length, 1);
  assert.equal(report.removed, 1);
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
    documentProfile: 'general_essay',
    profileConfidence: 0.6
  });
  assert.equal(restored.paragraphs.sourceCount, 1);
  assert.equal(restored.paragraphs.beforeCount, 3);
  assert.equal(restored.paragraphs.afterCount, 1);
  assert.equal(restored.pass, true);
  assert.equal(restored.text.replace(/\s+/gu, ''), output.replace(/\s+/gu, ''));
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

test('세특의 제목·항목 행은 줄바꿈 경계 토큰으로 왕복 보존한다', () => {
  const source = '교과 활동 관찰 기록\n학생은 자료를 비교하고 핵심 내용을 정리함. 발표 과정에서 친구의 질문에 답하며 탐구 범위를 넓힘.';
  const plan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveLineBoundaries: true
  });
  const body = plan.chunks.find(item => item.lineBoundaryMarkers?.length);
  assert.ok(body);
  assert.equal(body.lineBoundaryMarkers.length, 1);
  assert.match(body.llmText, /\[\[\[V2_LINE_0001\]\]\]/u);
  const restored = structure.restoreBoundaryMarkers(body.llmText.replace('핵심 내용을', '중요 내용을'), body);
  assert.equal(restored.ok, true);
  assert.equal(restored.text, source.replace('핵심 내용을', '중요 내용을'));
  const missing = structure.restoreBoundaryMarkers(body.llmText.replace('[[[V2_LINE_0001]]]', ''), body);
  assert.equal(missing.ok, false);
  assert.equal(missing.expectedLineCount, 2);
  assert.equal(missing.actualLineCount, 1);
});

test('문서 프로필은 요청 mode 없이 원문과 basicStyle 보조 힌트만으로 판정한다', () => {
  const source = '지원 동기\n저는 직무 역량을 바탕으로 귀사에 지원하게 되었습니다. 입사 후 포부를 말씀드리겠습니다.';
  const reportA = detectDocumentProfile(source, { basicStyle: 'blog' });
  const reportB = detectDocumentProfile(source, { basicStyle: 'report' });
  assert.equal(reportA.profile, 'resume_application');
  assert.equal(reportB.profile, 'resume_application');
  assert.ok(reportA.confidence >= 0.75);
});

test('문단 안에서 반복되는 관찰형 명사 종결은 세특 프로필로 판정한다', () => {
  const source = '체육 수업과 활동에 꾸준히 참여함. 친구들에게 자세와 방법을 알려 주며 협력하는 태도를 보임. 어려움이 있어도 끝까지 해내는 모습을 보임. 체력과 책임감을 함께 키워 나감. 다양한 방향을 탐색하며 성장하려는 자세를 지님.';
  const report = detectDocumentProfile(source, { basicStyle: 'blog' });
  assert.equal(report.profile, 'student_record');
  assert.ok(report.confidence >= 0.75);
  assert.ok(report.signals.nominalObservationEndings >= 3);
});

test('미래형 수업 계획 목록은 명사형 종결만으로 세특이 되지 않는다', () => {
  const source = '- 명화의 배색을 분석하는 수업을 진행할 예정임.\n- 팔레트를 활용해 일러스트레이션을 제작할 계획임.\n- 디지털 도구 활용법을 익히는 것을 학습 목표로 설정함.';
  const report = detectDocumentProfile(source);
  assert.notEqual(report.profile, 'student_record');
  assert.ok(report.signals.instructionalPlanSignals >= 2);
  assert.ok(report.signals.bulletLineCount >= 2);
});

test('voice 프롬프트는 원문의 문장 길이 범위와 비균일 경계를 명시한다', () => {
  const source = '짧은 문장임. 이 문장은 앞 문장보다 조금 더 길게 이어지는 관찰 내용임. 학생이 여러 자료를 직접 찾아 비교하고 발표 과정에서 친구들의 질문에 답하며 탐구 내용을 확장한 매우 긴 문장임. 마지막 문장은 다시 짧게 마무리함.';
  const prompt = voicePromptBlock(buildVoiceProfile(source, { documentProfile: 'student_record' }));
  assert.match(prompt, /문장 수≈4/);
  assert.match(prompt, /길이 범위≈\d+~\d+자/);
  assert.match(prompt, /원문 문장별 길이 순서≈\d+→\d+→\d+→\d+자/);
  assert.match(prompt, /길이를 고르게 만들 목적으로 합치거나 쪼개지 않는다/);
});

test('voice 프롬프트는 20문장 이하의 길이 순서와 구두점 없는 장문의 비균일 분할 목표를 보존한다', () => {
  const manySentences = Array.from({ length: 17 }, (_, index) => `${index + 1}번째 문장은 ${'내용을 '.repeat((index % 5) + 1)}기록함.`).join(' ');
  const manyProfile = buildVoiceProfile(manySentences, { documentProfile: 'general_essay' });
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
  const profile = buildVoiceProfile(source, { documentProfile: 'student_record' });
  const audit = auditVoice(profile, output, { documentProfile: 'student_record', mode: 'assignment' });
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
  const voice = buildVoiceProfile(source, { documentProfile: 'student_record' });
  assert.equal(voice.lineStructureSensitive, true);
  assert.match(voicePromptBlock(voice), /원문의 행 수=2/);
  const audit = auditVoice(voice, source.replace('\n', ' '), { documentProfile: 'student_record' });
  assert.ok(audit.warnings.some(item => item.code === 'line_structure_changed'));
});

test('polish voice 감사는 새 문단과 제목 구조 변경을 경고한다', () => {
  const source = '제 1장 연구\n본문은 한 문단으로 이어집니다.';
  const voice = buildVoiceProfile(source, { documentProfile: 'report_assignment' });
  const audit = auditVoice(voice, '본문이 바뀝니다.\n\n새 문단이 생깁니다.', { documentProfile: 'report_assignment', mode: 'polish' });
  assert.ok(audit.warnings.some(item => item.code === 'paragraph_structure_changed'));
  assert.ok(audit.warnings.some(item => item.code === 'heading_structure_changed'));
});

test('민감 문서 프로필은 목록의 삭제뿐 아니라 신규 목록 추가도 경고한다', () => {
  const source = '연구 결과는 본문 문장으로 설명한다.';
  const voice = buildVoiceProfile(source, { documentProfile: 'report_assignment' });
  const audit = auditVoice(voice, '- 연구 결과를 본문 문장으로 설명한다.', { documentProfile: 'report_assignment', mode: 'assignment' });
  assert.ok(audit.warnings.some(item => item.code === 'list_structure_changed'));
});

test('polish 편집률 정책은 길이별 상·하한을 서버에서 계산한다', () => {
  const source = '이 문장은 표현이 조금 어색하고 연결도 매끄럽지 않습니다.';
  const safe = qualityV2.polishEditPolicy(source, '이 문장은 표현이 다소 어색하고 연결도 매끄럽지 않습니다.');
  assert.equal(safe.pass, true);
  const noChange = qualityV2.polishEditPolicy(source, source);
  assert.equal(noChange.noSafeChange, true);
  const rewrite = qualityV2.polishEditPolicy(source, '전혀 다른 주장과 사례를 새로 만든 문장입니다.');
  assert.equal(rewrite.excessiveChange, true);
});

test('의미 심사 트리거는 formal·polish·장문 blog·저유사도·복합 구조를 포함한다', () => {
  const base = { editMetrics: { fiveGramSimilarity: 1 }, protectedFactCount: 0, structureSignals: {}, warnings: [] };
  assert.equal(qualityV2.shouldRunSemanticJudge({ requestedMode: 'formal', effectiveMode: 'assignment', source: '가', audit: base }).run, true);
  assert.equal(qualityV2.shouldRunSemanticJudge({ requestedMode: 'polish', effectiveMode: 'polish', source: '가', audit: base }).run, true);
  assert.equal(qualityV2.shouldRunSemanticJudge({ requestedMode: 'blog', effectiveMode: 'blog', source: '가'.repeat(1500), audit: base }).run, true);
  assert.equal(qualityV2.shouldRunSemanticJudge({ requestedMode: 'blog', effectiveMode: 'blog', source: '짧은 글', audit: { ...base, editMetrics: { fiveGramSimilarity: 0.2 } } }).run, true);
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
