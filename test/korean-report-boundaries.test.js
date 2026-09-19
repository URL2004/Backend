'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSentenceSpans, missingTerminalBoundaries } = require('../engine/koreanText');
const { buildDetectInputDocument } = require('../lib/detectInputDocument');
const { buildDetectSurfaceInput } = require('../lib/detectSurfaceInput');
const { buildSentenceMap } = require('../lib/detectReportView');
const korean = require('../engine-gpt-prod/koreanRefinement');
const { restoreSourceParagraphTransitions } = require('../engine-gpt-prod/sourceParagraphTransitions');

test('dates, decimals, uncertainty and embedded speech do not inflate sentences', () => {
  for (const text of [
    '2026. 9. 18. 시행했다. 이후 결과를 확인했다.',
    '시행일은 2026. 09. 18.이다. 수치는 3.14다.',
    '1920년(?)이다. 버전 2.1.0을 썼다.',
    '“끝났나요? 결과가 있나요?”라고 물었다. 답변을 기다렸다.',
    '1900~?이다. 정확한 연대는 모른다.'
  ]) {
    const spans = splitSentenceSpans(text);
    assert.equal(spans.length, 2, text);
    for (const span of spans) assert.equal(text.slice(span.start, span.end), span.text);
  }
});

test('formal unpunctuated prose splits without rewriting source; quoted mention and code do not', () => {
  const text = '자료를 조사했습니다 결과를 비교했습니다 원인을 확인했습니다';
  assert.equal(splitSentenceSpans(text).length, 3);
  assert.equal(missingTerminalBoundaries(text).length, 2);
  for (const text of ['“조사했습니다 결과를 비교했습니다”라는 문구다.', '`조사했습니다 결과를 비교했습니다`', '감사합니다 라는 인사말이다.']) {
    assert.equal(missingTerminalBoundaries(text).length, 0, text);
  }
  assert.equal(splitSentenceSpans('조사한 자료와 주요\n수요 변화의 관계를 확인했다.').length, 1);
  assert.equal(splitSentenceSpans('검토한 결과가 필요\n조건을 충족했다.').length, 1);
});

test('safe formatting inserts only missing finite boundary and protects quotes, code and creative text', () => {
  const text = '자료를 조사했습니다 결과를 비교했습니다.';
  const result = korean.applySafeFormattingRepairs({ source: text, outputText: text, documentProfile: 'report_assignment' });
  assert.equal(result.text, '자료를 조사했습니다. 결과를 비교했습니다.');
  assert.equal(korean.applySafeFormattingRepairs({ source: text, outputText: result.text }).text, result.text);
  for (const text of ['“자료를 조사했습니다 결과를 비교했습니다”라고 썼다.', '```\n자료를 조사했습니다 결과를 비교했습니다\n```']) {
    assert.equal(korean.applySafeFormattingRepairs({ source: text, outputText: text }).text, text);
  }
  assert.equal(korean.applySafeFormattingRepairs({ source: text, outputText: text, documentProfile: 'creative' }).text, text);
});

const a = '지역 기관의 교육 프로그램을 조사하면서 참여 기회를 확인했습니다. 지원 분야의 업무와 평소 관심사가 맞아 지원을 결정했습니다.';
const b = '이전 직장에서는 연구 자료를 정리하고 거래처별 구매 내역을 관리했습니다. 새로운 요청이 접수되면 담당자와 협의하여 필요한 서류를 준비했습니다.';
test('unique source topic boundary restored without moving words, including locked preambles', () => {
  const source = `# 신청서\n\n${a}\n\n${b}`;
  const output = `# 신청서\n\n${a} ${b}`;
  const fixed = restoreSourceParagraphTransitions(source, output);
  assert.equal(fixed.text, source);
  assert.equal(fixed.repairedCount, 1);
  assert.equal(restoreSourceParagraphTransitions(source, fixed.text).repairedCount, 0);
  assert.equal(restoreSourceParagraphTransitions(`${a}\n\n${b}`, `${a} ${b}\n\n${a} ${b}`).repairedCount, 0);
  const structure = require('../engine-gpt-prod/structureChunk');
  const chunks = structure.splitChunksForGpt(source).chunks;
  const actual = structure.restorePostSemanticLayout({ source, outputText: output, chunks,
    mode: 'assignment', requestStrength: 'advanced', documentProfile: { profile: 'resume_application', confidence: .95 } });
  assert.ok(actual.text.includes(`${a}\n\n${b.split('. ')[0]}`));
  assert.equal(actual.text.replace(/\s/gu, ''), output.replace(/\s/gu, ''));
});

test('new multi-clause fusion is repairable, long source itself is not an error', () => {
  const sentences = [
    '지역의 여러 기관에서 운영하는 다양한 교육 프로그램과 주민들에게 제공되는 참여 기회를 자세히 조사했습니다.',
    '조사 결과를 바탕으로 기관별 신청 절차와 이용 가능한 시설의 종류를 정리했습니다.',
    '담당자에게 연락하여 운영 시간과 참가자의 준비 사항을 추가로 확인했습니다.',
    '확인한 자료를 동료들에게 공유하여 각자의 일정에 맞게 함께 이용할 수 있는 프로그램을 신중하게 선정했습니다.'
  ];
  const source = sentences.join(' ');
  const output = sentences.slice(0, -1).map(s => s.replace(/했습니다\.$/u, '했으며,')).join(' ') + ' ' + sentences.at(-1);
  const audit = (a, b) => korean.analyzeKoreanRefinement({ source: a, outputText: b }).issueCodes;
  assert.ok(audit(source, output).includes('introduced_sentence_chain'));
  assert.ok(!audit(output, output).includes('introduced_sentence_chain'));
  assert.ok(!audit(source, source).includes('introduced_sentence_chain'));
});

test('report causes and preview exclude protected text, preserving paragraph identity and UTF16', () => {
  const paras = ['# 자료의 중요성', '“사회 변화의 중요성은 크다. 역할과 의미가 중요하다.”',
    '```js\n😀 AI. AI. AI.\n```', '실험 장치를 확인했다. 측정값을 기록했다.'];
  const surface = buildDetectSurfaceInput(paras);
  assert.equal(surface.text.length, paras.join('\n\n').length);
  assert.equal(surface.measurements.genericness.total, 2);
  assert.equal(surface.measurements.genericness.count, 0);
  assert.equal(surface.detail.length, paras.length);
  assert.ok(surface.detail.slice(0, 3).every(item => item.excluded));
  const map = buildSentenceMap(surface.analysisParagraphs, surface.detail, { sourceParagraphs: paras });
  assert.equal(map.total, 2);
  assert.ok(map.sentences.every(item => item.paragraph === 3));
  assert.equal(map.paragraphs[0].head, paras[0]);
  assert.equal(buildDetectInputDocument(paras.join('\n\n')).eligibleSentenceCount, 2);
});

test('valid auxiliary and context-dependent spellings are not blanket rewritten', () => {
  for (const text of ['그 일을 도와주다.', '책을 읽어보다.', '그 일은 할만하다.', '한번 해 보자.', '한 번 더 확인했다.', '기억을 못 하겠다.', '기억을 잘 못하겠다.']) {
    assert.equal(korean.applySafeFormattingRepairs({ source: text, outputText: text }).text, text);
  }
});

test('masked quotation cannot become a fabricated before-preview sentence', () => {
  const mixed = '그는 “구체적인 역할이 중요하다. 새로운 변화도 필요하다.”라고 설명했다. 기록을 찾아 정확한 사실관계를 다시 확인했다.';
  const surface = buildDetectSurfaceInput([mixed]);
  assert.equal(surface.previewParagraphs[0], '기록을 찾아 정확한 사실관계를 다시 확인했다.');
  const map = buildSentenceMap(surface.analysisParagraphs, surface.detail, { sourceParagraphs: [mixed] });
  assert.ok(map.sentences.every(item => mixed.includes(item.text)));
  assert.ok(map.sentences.some(item => item.protectedContentExcluded));
  const lines = '1919년 4월 8일, 맑음\n새벽 다섯 시, 기록을 확인했다.';
  const preview = buildDetectSurfaceInput([lines]);
  const { splitSentences } = require('../engine/koreanText');
  assert.ok(splitSentences(preview.previewParagraphs[0]).every(sentence => lines.includes(sentence)));
});

test('source-backed wrap repair cannot rejoin a heading or an unpunctuated complete sentence', () => {
  const source = '2) 사회 차원 사회 차원에서는 여러 사람이 참여할 수 있는 기회를 넓혀야 한다.';
  const output = '2) 사회 차원\n\n사회 차원에서는 여러 사람이 참여할 수 있는 기회를 넓혀야 한다.';
  assert.equal(korean.applySafeFormattingRepairs({ source, outputText: output }).text, output);
  const before = '관련 자료를 찾아보며 꾸준히 작업했다 평소 관련 서적을 읽으며 필요한 내용을 정리했다';
  const after = before.replace('작업했다 평소', '작업했다\n\n평소');
  assert.equal(korean.applySafeFormattingRepairs({ source: before, outputText: after }).text, after);
});

test('double-space typos in long finite prose cannot lock whole paragraphs as a table', () => {
  const prose = '지역의 여러 기관에서 진행하는 교육 과정과 참여 방법을 자세히 조사했습니다 담당자와 상담하여 신청 일정과 준비 사항을 꼼꼼하게 확인했습니다 수집한 자료는 동료들과 함께 읽어 보고 각자의 상황에 맞는 과정을 비교하면서 필요한 내용을 정리했습니다';
  const source = `${prose}  이후 참여 일정을 확정했습니다\n${prose}  다음 활동을 준비했습니다`;
  const layout = require('../engine-gpt-prod/layoutStructure');
  const chunks = require('../engine-gpt-prod/structureChunk').splitChunksForGpt(source).chunks;
  assert.ok(chunks.every(chunk => chunk.lockType !== 'table'));
  assert.equal(layout.tableColumnCount(`${prose}\t후속 활동`), 2);
  assert.equal(layout.tableColumnCount(`| ${prose} | 후속 활동 |`), 2);
  const table = require('../engine-gpt-prod/structureChunk').splitChunksForGpt('항목  내용\n가격  100원').chunks;
  assert.ok(table.some(chunk => chunk.lockType === 'table'));
});

test('restoring one source sentence behind its split paraphrase is a review candidate, not automatic deletion', () => {
  const first = '저는 낯선 자료를 찾아 직접 읽어 보고 동료에게 필요한 정보를 추천하는 일을 좋아했습니다';
  const second = '직장에서는 구매 재고 업체 문서 관리와 같은 운영 업무를 경험했습니다';
  const combined = first.replace('좋아했습니다', '좋아했으며') + ' ' + second;
  const source = combined + '. 이후에는 관련 분야에 지원했습니다.';
  const output = first + '. ' + second + '. ' + combined + '. 이후에는 관련 분야에 지원했습니다.';
  const audit = korean.analyzeKoreanRefinement({ source, outputText: output });
  assert.ok(audit.issueCodes.includes('source_restore_echo'));
  assert.equal(audit.issues.find(i => i.code === 'source_restore_echo').deterministicSafe, false);
  assert.ok(!korean.analyzeKoreanRefinement({ source: output, outputText: output }).issueCodes.includes('source_restore_echo'));
});
