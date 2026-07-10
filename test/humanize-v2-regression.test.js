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
const { buildVoiceProfile, auditVoice } = require('../engine-gpt-prod/voiceProfile');
const qualityV2 = require('../engine-gpt-prod/finalQualityV2');

test('한국어 문장 분리기는 장·절 번호, 소수점, 약어와 인용부호를 보존한다', () => {
  const value = '제 1장. 연구 개요\n연구 배경\n값은 3.14이다. e.g. 예시는 유지한다. U.S. 자료도 유지한다. “인용문이다.” 다음 문장이다.';
  const sentences = koreanText.splitSentences(value);
  assert.equal(sentences[0], '제 1장. 연구 개요');
  assert.ok(sentences.some(sentence => sentence.includes('연구 배경') && sentence.includes('값은 3.14이다.')));
  assert.ok(sentences.includes('e.g. 예시는 유지한다.'));
  assert.ok(sentences.includes('U.S. 자료도 유지한다.'));
  assert.ok(sentences.includes('“인용문이다.”'));
});

test('한국어 Unicode 경계는 숫자 단위와 실제 조사 중복을 정확히 인식한다', () => {
  const clean = nikl.analyzeNiklQuality('20명과 35%가 참여했고 2026년에 마쳤다.');
  assert.equal(clean.normPatterns.some(item => item.id === 'double_particle'), false);
  for (const value of ['사람은는 간다.', '학생이가 왔다.']) {
    const report = nikl.analyzeNiklQuality(value);
    assert.equal(report.normPatterns.some(item => item.id === 'double_particle'), true);
  }
});

test('고립 접속어와 조사로 시작하는 장문 청크 경계를 회귀 검사한다', () => {
  const connector = nikl.analyzeNiklQuality('앞 문장은 끝났다. 그리고');
  assert.ok(connector.topPatterns.some(item => item.id === 'orphan_connector_after_period' || item.id === 'unfinished_final_sentence'));
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

test('문서 프로필은 요청 mode 없이 원문과 basicStyle 보조 힌트만으로 판정한다', () => {
  const source = '지원 동기\n저는 직무 역량을 바탕으로 귀사에 지원하게 되었습니다. 입사 후 포부를 말씀드리겠습니다.';
  const reportA = detectDocumentProfile(source, { basicStyle: 'blog' });
  const reportB = detectDocumentProfile(source, { basicStyle: 'report' });
  assert.equal(reportA.profile, 'resume_application');
  assert.equal(reportB.profile, 'resume_application');
  assert.ok(reportA.confidence >= 0.75);
});

test('창작문은 줄바꿈을 구조로 기록하고 화자 변화 감사를 공유한다', () => {
  const poem = '밤이 온다\n창문에 빛이 머문다\n나는 한참 서 있다\n바람은 대답하지 않는다';
  const voice = buildVoiceProfile(poem, { documentProfile: 'creative' });
  assert.equal(voice.lineBreakSensitive, true);
  assert.equal(voice.lineCount, 4);
  const audit = auditVoice(voice, poem.replace('나는 ', ''), { documentProfile: 'creative' });
  assert.ok(audit.warnings.some(item => item.code === 'speaker_removed'));
});

test('polish voice 감사는 새 문단과 제목 구조 변경을 경고한다', () => {
  const source = '제 1장 연구\n본문은 한 문단으로 이어집니다.';
  const voice = buildVoiceProfile(source, { documentProfile: 'report_assignment' });
  const audit = auditVoice(voice, '본문이 바뀝니다.\n\n새 문단이 생깁니다.', { documentProfile: 'report_assignment', mode: 'polish' });
  assert.ok(audit.warnings.some(item => item.code === 'paragraph_structure_changed'));
  assert.ok(audit.warnings.some(item => item.code === 'heading_structure_changed'));
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
