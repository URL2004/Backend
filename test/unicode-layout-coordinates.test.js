'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/structureChunk');
const voice = require('../engine-gpt-prod/voiceProfile');
const bare = value => String(value).replace(/\s/gu, '');

function fixture(symbol) {
  return `${symbol} 동아리 발표 준비\n\n① 자기소개\n안녕하세요. 발표를 맡은 학생입니다. 준비한 내용을 설명하겠습니다.\n\n키워드: 성실 → 협력\n\n② 지원동기\n함께 배우고 실제 활동에 참여하고 싶습니다.\n\n${symbol} 일정\n날짜\t할 일\n4/12\t신청 완료\n4/13\t발표 연습\n\n[ ] 준비물 확인`;
}

for (const symbol of ['📅', '💬🗓', '👩🏽‍💻', '🇰🇷', '𠮷', '𝑥']) {
  test(`locked layout keeps UTF-16 ownership after ${symbol}`, () => {
    const source = fixture(symbol);
    const { chunks } = layout.splitChunksForGpt(source, { coalesceEditable: true });
    let text = source;
    for (let repeat = 0; repeat < 5; repeat++) {
      const result = layout.restoreLockedStructureLayout({ source, outputText: text, chunks });
      assert.equal(bare(result.text), bare(source), `restoration pass ${repeat} changed literal content`);
      if (repeat) assert.equal(result.text, text, 'repeating layout must reach a fixed point');
      text = result.text;
    }
    assert.equal((text.match(/키워드:/gu) || []).length, 1);
    assert.equal((text.match(/4\/12/gu) || []).length, 1);
    assert.ok(text.includes('② 지원동기'));
  });
}

test('whitespace-equivalent protected blocks at the end do not append the entire input', () => {
  const source = '📚 소개\n\n날짜\t활동\n4/12\t신청 완료';
  const output = '📚 소개\n날짜 활동\n4/12 신청 완료';
  const chunks = layout.splitChunksForGpt(source).chunks;
  const result = layout.restoreExactLockedBlocks(output, chunks, source);
  assert.equal(bare(result.text), bare(source));
  assert.equal((result.text.match(/📚/gu) || []).length, 1);
  assert.equal((result.text.match(/4\/12/gu) || []).length, 1);
});

test('layout preserves edited prose between repeated labels and supplementary characters', () => {
  const source = '💬 질문\n\n키워드: 목표 → 실천\n\n처음에는 활동을 자세하게 살펴보려고 합니다.\n\n🗓 다음 질문\n\n키워드: 경험 → 배움\n\n다음에는 결과를 차근차근 정리하려고 합니다.';
  const output = source.replace('처음에는 활동을 자세하게 살펴보려고 합니다.', '먼저 활동 내용을 살펴보겠습니다.');
  const chunks = layout.splitChunksForGpt(source).chunks;
  const result = layout.restoreLockedStructureLayout({ source, outputText: output, chunks });
  assert.equal(bare(result.text), bare(output));
  assert.ok(result.text.includes('먼저 활동 내용을 살펴보겠습니다.'));
});

test('final layout is content-preserving and converges with emoji, labels and a table', () => {
  const source = fixture('📅');
  const chunks = layout.splitChunksForGpt(source, { coalesceEditable: true }).chunks;
  const result = layout.restoreFinalDocumentLayout({ source, outputText: source, chunks,
    mode: 'assignment', requestStrength: 'advanced', documentProfile: 'resume_application', normalizeVisualGaps: true });
  assert.equal(result.contentPreserved, true);
  assert.equal(result.converged, true);
  assert.equal(bare(result.text), bare(source));
});

test('quote delimiters restore at their own evidence after supplementary letters', () => {
  const source = '𠮷 연구자의 기록이다. 그는 “작은 실천부터 함께 시작합시다”라고 말했다. 이후 내용을 정리했다.';
  const output = source.replace('“작은 실천부터 함께 시작합시다”', '작은 실천부터 함께 시작합시다');
  const result = voice.restoreDirectQuoteContents(source, output);
  assert.equal(result.applied, true);
  assert.equal(result.text, source);
});

test('supplementary characters inside quoted evidence retain the whole code point', () => {
  const source = '그는 “𠮷이라는 글자를 함께 읽습니다”라고 말했다.';
  const output = '그는 𠮷이라는 글자를 함께 읽습니다라고 말했다.';
  assert.equal(voice.restoreDirectQuoteContents(source, output).text, source);
});

test('ambiguous quote evidence is not assigned an arbitrary location', () => {
  const source = '𠮷 기록에서 “함께 배우는 태도”를 확인했다. 함께 배우는 태도를 다시 설명했다.';
  const output = source.replace('“함께 배우는 태도”', '함께 배우는 태도');
  const result = voice.restoreDirectQuoteContents(source, output);
  assert.equal(result.applied, false);
  assert.equal(result.text, output);
});

test('wrapped polite endings are not locked as 가나다 prefixes or moved to earlier sentences', () => {
  const source = '💬 준비 안내\n\n① 소개\n"저의 장점은 함께 배우는 태도입니다. 차근차근 준비합니다.\n새로운 활동을 시작할 때는 살피는 편입니\n다. 다음에는 직접 참여하고 싶습니\n다."\n\n② 마무리\n"함께 배울 수 있다는 자신 있습\n니다. 참여할 기회를 주셔서 감사합니\n다."';
  const chunks = layout.splitChunksForGpt(source, { coalesceEditable: true }).chunks;
  assert.equal(chunks.filter(c => c.locked && c.text.trim() === '다.').length, 0);
  for (const mode of ['blog', 'assignment', 'polish']) {
    const result = layout.restoreFinalDocumentLayout({ source, outputText: source, chunks,
      mode, requestStrength: mode === 'assignment' ? 'advanced' : 'basic', documentProfile: 'resume_application', normalizeVisualGaps: true });
    assert.equal(bare(result.text), bare(source));
    assert.ok(result.text.includes('태도입니다.'));
    assert.doesNotMatch(result.text, /(?:입니|싶습니|있습|감사합니)\n\n/u);
    assert.equal(result.converged, true);
  }
});

test('attested label word wraps do not turn into independent headings', () => {
  const source = '신청 안내\n\n신청기간: 다음 주 월요일부터 금요일까지 입\n학홈페이지에서 신청\n\n입학홈페이지에서 신청 내용을 확인합니다.';
  const roles = require('../engine-gpt-prod/layoutStructure').buildLineRecords(source);
  const tail = roles.find(r => r.text === '학홈페이지에서 신청');
  assert.equal(tail.role, 'prose');
  assert.equal(tail.physicalWordContinuation, true);
});

test('real 가나다 items and code retain their ownership near polite prose', () => {
  const source = '가. 첫 번째 준비\n나. 두 번째 준비\n다. 세 번째 준비\n\n이 문장은 끝을 일부러 남겨 둔 것입니\n\n다. 별도 항목은 그대로 둔다.\n\n```\n이것은 코드 안의 행입니\n다. 그대로 유지\n```';
  const roles = require('../engine-gpt-prod/layoutStructure').buildLineRecords(source);
  assert.equal(roles.filter(r => r.role === 'list').length, 4);
  assert.equal(roles.find(r => r.text === '다. 그대로 유지').role, 'code');
});
