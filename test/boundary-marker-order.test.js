'use strict';

// v2.5.95 (2026-09-30): 병합 청크의 원문 경계 표식은 누락·중복·유출만 검사했고
// 순서는 보지 않았다. 표식 두 개가 자리를 바꿔도 ok:true였다. 기대 순서는
// 표식 종류별 목록을 이어 붙인 순서가 아니라 모델에 보낸 llmText의 실제 순서다.
// 같은 버전에서 시도별 감사를 건수로만 모으는 카운터와 관리자 랩의 NLP 스위치를 고정한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const structure = require('../engine-gpt-prod/structureChunk');
const layout = require('../engine/layout');
const { CATALOG } = require('../lib/opsEvents');

function swapTokens(text, left, right) {
  const hold = '\u0000SWAP\u0000';
  return text.replace(left, hold).replace(right, left).replace(hold, right);
}

function coalescedParagraphChunk() {
  const paragraphs = Array.from({ length: 18 }, (_, index) => `본문 ${index + 1}은 원문의 의미와 구조를 보존하는 충분한 길이의 설명 문단입니다.`);
  const source = ['Ⅰ. 서론', ...paragraphs, 'Ⅱ. 결론', '마지막 문단입니다.'].join('\n\n');
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
  return plan.chunks.find(item => (item.boundaryMarkers || []).length >= 2);
}

function mixedMarkerChunk() {
  const paragraphs = Array.from({ length: 6 }, (_, index) => [
    `문단 ${index + 1}의 첫 문장은 관찰한 내용을 차분하게 설명함.`,
    `둘째 문장은 짧게 정리함.`,
    `셋째 문장은 앞선 설명을 근거와 함께 다시 묶어 마무리함.`
  ].join(' '));
  const source = paragraphs.join('\n\n');
  const plan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveSentenceBoundaries: true,
    sentenceBoundaryMinimum: 3
  });
  return plan.chunks.find(item => (item.boundaryMarkers || []).length && (item.sentenceBoundaryMarkers || []).length);
}

test('병합 청크의 문단 표식 두 개가 자리를 바꾸면 순서 위반으로 실패한다', () => {
  const chunk = coalescedParagraphChunk();
  assert.ok(chunk, 'expected a coalesced chunk with at least two paragraph markers');
  const [first, second] = chunk.boundaryMarkers.map(item => item.marker);
  assert.equal(structure.restoreBoundaryMarkers(chunk.llmText, chunk).ok, true);

  const swapped = structure.restoreBoundaryMarkers(swapTokens(chunk.llmText, first, second), chunk);
  assert.equal(swapped.ok, false);
  assert.equal(swapped.orderChanged, true);
  // 기대 순서상 뒤에 있어야 할 표식이 앞에서 먼저 나타난 것이 위반 지점이다.
  assert.equal(swapped.orderViolation, second);
  assert.deepEqual(swapped.missing, []);
  assert.deepEqual(swapped.duplicated, []);
});

test('기대 순서는 목록 이어 붙이기가 아니라 llmText의 실제 순서다', () => {
  const chunk = mixedMarkerChunk();
  assert.ok(chunk, 'expected a chunk with paragraph and sentence markers');
  const tokens = chunk.llmText.match(/\[\[\[V2_(?:BOUNDARY|LINE|SENTENCE)_\d{3,4}\]\]\]/gu);
  const concatenated = [...chunk.boundaryMarkers, ...(chunk.lineBoundaryMarkers || []), ...chunk.sentenceBoundaryMarkers].map(item => item.marker);
  // 첫 문단 안의 문장 표식이 첫 문단 경계보다 앞에 온다. 목록 순서로 검사했다면 정상 출력도 실패했을 것이다.
  assert.notDeepEqual(tokens, concatenated);
  const restored = structure.restoreBoundaryMarkers(chunk.llmText, chunk);
  assert.equal(restored.ok, true);
  assert.equal(restored.orderChanged, false);

  const paragraphMarker = chunk.boundaryMarkers[0].marker;
  const firstSentenceMarker = tokens.find(token => token.includes('V2_SENTENCE_'));
  const swapped = structure.restoreBoundaryMarkers(swapTokens(chunk.llmText, firstSentenceMarker, paragraphMarker), chunk);
  assert.equal(swapped.ok, false);
  assert.equal(swapped.orderChanged, true);
});

test('누락·중복은 순서 위반과 따로 보고한다', () => {
  const chunk = coalescedParagraphChunk();
  const [first] = chunk.boundaryMarkers.map(item => item.marker);
  const missing = structure.restoreBoundaryMarkers(chunk.llmText.replace(first, ''), chunk);
  assert.equal(missing.ok, false);
  assert.equal(missing.orderChanged, false);
  assert.deepEqual(missing.missing, [first]);
  const duplicated = structure.restoreBoundaryMarkers(chunk.llmText.replace(first, `${first} 그리고 ${first}`), chunk);
  assert.equal(duplicated.ok, false);
  assert.equal(duplicated.orderChanged, false);
  assert.deepEqual(duplicated.duplicated, [first]);
});

test('시도별 감사 요약은 원문 없이 표식 종류와 실패 사유만 센다', () => {
  const chunk = mixedMarkerChunk();
  assert.equal(structure.summarizeBoundaryAudit({ applied: false, ok: true }, chunk), null);
  const ok = structure.summarizeBoundaryAudit(structure.restoreBoundaryMarkers(chunk.llmText, chunk), chunk);
  assert.equal(ok.ok, true);
  assert.equal(ok.kinds.paragraph, chunk.boundaryMarkers.length);
  assert.equal(ok.kinds.sentence, chunk.sentenceBoundaryMarkers.length);
  assert.deepEqual(ok.reasons, []);

  const paragraphMarker = chunk.boundaryMarkers[0].marker;
  const missing = structure.summarizeBoundaryAudit(
    structure.restoreBoundaryMarkers(chunk.llmText.replace(paragraphMarker, ''), chunk), chunk);
  assert.equal(missing.ok, false);
  assert.ok(missing.reasons.includes('missing'));
  assert.ok(missing.failedKinds.includes('paragraph'));
  assert.doesNotMatch(JSON.stringify(missing), /문단|문장|V2_/u);
});

test('문서 카운터는 1차 실패·재시도 회복·잔여를 나누고 잠긴 청크는 뺀다', () => {
  const audit = (ok, reasons = [], failedKinds = []) => ({
    kinds: { paragraph: 2, line: 0, sentence: 3 }, ok, reasons, failedKinds
  });
  const records = [
    { escalated: false, boundaryMarkerAudit: audit(true), warnings: [] },
    { escalated: true, primaryBoundaryMarkerAudit: audit(false, ['order'], ['paragraph']), boundaryMarkerAudit: audit(true), warnings: [] },
    {
      escalated: true,
      primaryBoundaryMarkerAudit: audit(false, ['missing'], ['sentence']),
      boundaryMarkerAudit: audit(false, ['missing'], ['sentence']),
      warnings: ['v2_residual:structure_boundary_marker_failed']
    },
    { locked: true, boundaryMarkerAudit: audit(false, ['missing'], ['paragraph']) },
    { escalated: false, boundaryMarkerAudit: null, warnings: [] },
    null
  ];
  const stats = structure.summarizeBoundaryMarkerStats(records, { mode: 'blog' });
  assert.equal(stats.version, 1);
  assert.equal(stats.mode, 'blog');
  assert.equal(stats.markedChunks, 3);
  assert.deepEqual(stats.markers, { paragraph: 6, line: 0, sentence: 9 });
  assert.deepEqual(stats.chunksByKind, { paragraph: 3, line: 0, sentence: 3 });
  assert.equal(stats.firstAttemptFailedChunks, 2);
  assert.equal(stats.escalationFailedChunks, 1);
  assert.equal(stats.recoveredByEscalationChunks, 1);
  assert.equal(stats.residualChunks, 1);
  assert.equal(stats.failureReasons.order, 1);
  assert.equal(stats.failureReasons.missing, 1);
  assert.deepEqual(stats.failedKinds, { paragraph: 1, line: 0, sentence: 1 });
  assert.equal(stats.documentAffected, true);

  const clean = structure.summarizeBoundaryMarkerStats([{ escalated: false, boundaryMarkerAudit: audit(true), warnings: [] }]);
  assert.equal(clean.documentAffected, false);
  assert.equal(clean.firstAttemptFailedChunks, 0);
});

test('표식 실패 이벤트는 관리자 로그에만 남고 디스코드로 가지 않는다', () => {
  const entry = CATALOG['gpt_prod.boundary_marker_failed'];
  assert.ok(entry);
  assert.equal(entry.sev, 'SEV3');
  assert.equal(entry.discord, false);
  assert.match(entry.action, /residualChunks/u);
});

test('관리자 랩과 운영 경로는 같은 Python NLP 스위치를 따르고 기본값은 꺼짐이다', () => {
  assert.equal(layout.isPythonNlpEnabled({}), false);
  assert.equal(layout.isPythonNlpEnabled({ LAYOUT_NLP_PYTHON_ENABLED: 'true' }), false);
  assert.equal(layout.isPythonNlpEnabled({ LAYOUT_NLP_PYTHON_ENABLED: '1' }), true);
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'transform.js'), 'utf8');
  assert.doesNotMatch(route, /enableNlp:\s*true/u);
  assert.equal((route.match(/enableNlp:\s*layoutNormalizer\.isPythonNlpEnabled\(\)/gu) || []).length, 2);
  const engineSource = fs.readFileSync(path.join(__dirname, '..', 'engine-gpt-prod', 'index.js'), 'utf8');
  assert.match(engineSource, /enableNlp:\s*layoutNormalizer\.isPythonNlpEnabled\(\)/u);
  assert.doesNotMatch(engineSource, /enableNlp:\s*process\.env\.LAYOUT_NLP_PYTHON_ENABLED/u);
});

test('상세 헬스에는 메모리가 있고 공개 헬스에는 없다', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const publicStart = source.indexOf("app.get(['/healthz', '/api/health']");
  const internalStart = source.indexOf("app.get('/internal/health'");
  assert.ok(publicStart > 0 && internalStart > publicStart);
  assert.doesNotMatch(source.slice(publicStart, internalStart), /memoryHealthMeta|rssMb/u);
  const detailed = source.slice(source.indexOf('async function detailedHealth'), publicStart);
  assert.equal((detailed.match(/\.\.\.memoryHealthMeta\(\)/gu) || []).length, 2);
});
