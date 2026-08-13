'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const layout = require('../engine-gpt-prod/layoutStructure');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const structure = require('../engine-gpt-prod/structureChunk');
const literal = require('../engine-gpt-prod/literalSpans');

function reportProfile() {
  return {
    profile: 'report_assignment',
    confidence: 0.96,
    formatProfile: { primary: 'sectioned', flags: ['sectioned', 'table'] }
  };
}

function bare(value) {
  return String(value || '').replace(/\s+/gu, '');
}

test('source preflight는 날짜 범위·탭 표·인용 출처를 보존하고 경계의 작성 지시만 제거한다', () => {
  const dateHeading = '8. 추진 절차와 일정 (2026. 8. ~ 11. 30.)';
  const table = [
    '시기\t핵심 업무\t작가 관련 업무',
    '8월\t착수·자문단 구성\t기존 기획자료 검토',
    '9월\t공동회의\t시나리오 1차 작성'
  ].join('\n');
  const quotation = [
    '“문자가 처음 만들어진 그 방법으로 서예가 다시 발전한다.”',
    '- 훈민정음 해례본의 창제 원리에 대한 해석'
  ].join('\n');
  const body = '이 작품은 원문의 구조와 사실을 유지하며 한글서예의 발전 과정을 설명한다.';
  const source = [
    '소제목을 모두 제외하고, 한 눈에 매끄럽게 읽히는 하나의 글로 길게 연결한 완성본입니다. 바로 복사해서 사용하시면 됩니다!',
    '본인의 가치관을 형성하는데 가장 큰 영향을 준 경험을 적으라고 해서 적어보았어.',
    dateHeading,
    table,
    quotation,
    body,
    'AI 느낌이 안 나게 해주면 좋을 것 같아'
  ].join('\n');

  const result = preflight.auditAndSanitizeSource(source);
  const expected = [dateHeading, table, quotation, body].join('\n');

  assert.equal(result.text, expected);
  assert.equal(result.integrityText, expected);
  assert.equal(result.removedLineCount, 3);
  assert.equal(result.removedArtifactCount, 3);
  assert.equal(result.issueCodes.includes('source_generation_meta_artifact'), true);
  assert.equal(result.issueCodes.includes('source_instruction_artifact'), true);
  assert.equal(result.issueCodes.includes('source_rewrite_request_artifact'), true);
  assert.equal(result.text.includes('2026. 8. ~ 11. 30.'), true);
  assert.equal(result.text.split('\n').filter(line => line.includes('\t')).length, 3);
  assert.match(result.text, /“문자가 처음[^”]+”\n- 훈민정음/u);
});

test('source preflight는 숫자 날짜를 절 제목으로 오인하지 않고 실제 4차 제목은 분리한다', () => {
  for (const source of [
    '일정은 2026. 8월에 시작한다.',
    '일정은 2026. 8. ~ 11. 30.에 진행한다.',
    '일정은 2026. 8. ~ 11. 30. 진행한다.'
  ]) {
    const result = preflight.repairSourceLayoutArtifacts(source);
    assert.equal(result.text, source);
    assert.equal(result.changed, false);
  }

  const heading = '앞 문장이다. 2. 4차 산업혁명 대응 전략';
  const repaired = preflight.repairSourceLayoutArtifacts(heading);
  assert.equal(repaired.text, '앞 문장이다.\n\n2. 4차 산업혁명 대응 전략');
  assert.equal(repaired.changes.some(change => change.code === 'source_inline_heading_repaired'), true);
});

test('creative 입력은 내부 번호 표현이 있어도 preflight가 시행을 분절하지 않는다', () => {
  const source = [
    '밤의 기록',
    '창문 너머 바람이 와서',
    '나는 걷는다. 2. 다시 피는 빛',
    '손끝에 새벽이 머물고',
    '',
    '오래된 길이 숨을 쉬고',
    '조용히 아침이 온다'
  ].join('\n');

  assert.equal(preflight.looksLikeCreativeLineLayout(source), true);
  const repaired = preflight.repairSourceLayoutArtifacts(source);
  assert.equal(repaired.text, source);
  assert.equal(repaired.changed, false);
  assert.deepEqual(repaired.changes, []);
});

test('layout structure는 자소서의 무번호 소제목 두 개를 독립 제목으로 판정한다', () => {
  const firstHeading = 'Reservation & Revenue 직무 이해와 역량';
  const secondHeading = '고객 커뮤니케이션 및 문제해결 경험';
  const source = [
    firstHeading,
    '객실 수요와 점유율, 가격을 서로 연결된 지표로 해석하는 방법을 배웠습니다. 예약 속도와 잔여 객실 수, 예상 수요, 경쟁 호텔의 가격과 고객 세그먼트도 함께 검토하며 객실 판매 판단의 기준을 익혔습니다.',
    secondHeading,
    '카페에서 예상하지 못한 상황이 발생했을 때 고객에게 진행 상황을 안내하고, 상대방을 자극하지 않도록 차분하게 대응했습니다. 문제가 해결된 뒤에도 고객에게 상황을 다시 설명하고 필요한 후속 조치를 끝까지 수행했습니다.'
  ].join('\n');

  const records = layout.buildLineRecords(source).filter(record => !record.blank);
  const headings = records.filter(record => record.role === 'heading').map(record => record.text);

  assert.deepEqual(headings, [firstHeading, secondHeading]);
  assert.equal(records.find(record => record.text === firstHeading)?.role, 'heading');
  assert.equal(records.find(record => record.text === secondHeading)?.role, 'heading');
});

test('layout structure는 탭 표 뒤의 무번호 소제목을 표 행이 아닌 제목으로 판정한다', () => {
  const heading = '시각적 정체성';
  const source = [
    '원칙\t내용',
    '초반은 질문과 감각\t설명을 앞세우지 않고 화면과 음향으로 원리를 보여 준다.',
    '후반은 창작과 미래\t작가의 창작과 현대적 융합을 다룬다.',
    heading,
    '이 작품은 문방사우를 도구의 나열로 보지 않고, 서예가 실제로 생성되는 물질적·감각적 과정으로 촬영하며 획이 생겨나는 시간을 보여 준다.'
  ].join('\n');

  const records = layout.buildLineRecords(source).filter(record => !record.blank);
  const record = records.find(item => item.text === heading);

  assert.equal(records.slice(0, 3).every(item => item.role === 'table'), true);
  assert.equal(record?.role, 'heading');
});

test('같은 행의 인용문과 출처는 하이픈 종류와 무관하게 quote 잠금으로 유지한다', () => {
  for (const dash of ['-', '–', '—']) {
    const source = `“기록은 기억을 남긴다.” ${dash} 연구자`;
    const records = layout.buildLineRecords(source).filter(record => !record.blank);
    const chunks = structure.splitChunksForGpt(source, { coalesceEditable: true }).chunks;

    assert.equal(records.length, 1, dash);
    assert.equal(records[0].role, 'quote', dash);
    assert.equal(chunks.length, 1, dash);
    assert.equal(chunks[0].locked, true, dash);
    assert.equal(chunks[0].lockType, 'quote', dash);
    assert.equal(chunks[0].text.trim(), source, dash);
  }
});

test('동일 인용문이 본문과 독립 행에 함께 있어도 exact 잠금은 독립 행 span을 고른다', () => {
  const quote = '“같은 인용문입니다.” — 작가';
  const source = [
    `서론에서는 ${quote}를 설명한다.`,
    '',
    quote,
    '',
    '다음 본문이다.'
  ].join('\n');
  const chunks = structure.splitChunksForGpt(source, { coalesceEditable: true }).chunks;
  const quoteChunk = chunks.find(chunk => chunk.locked && chunk.lockType === 'quote');

  assert.ok(quoteChunk);
  const restored = structure.restoreExactLockedBlocks(source, chunks, source);
  assert.equal(restored.text, source);
  assert.equal(restored.applied, false);
  assert.equal(restored.boundaryRestoredCount, 0);
  assert.equal(restored.missingCount, 0);
});

test('final document layout은 표 앞뒤 경계와 날짜 제목을 복원하고 멱등이며 문자 내용을 보존한다', () => {
  const dateHeading = '8. 추진 절차와 일정 (2026. 8. ~ 11. 30.)';
  const source = [
    '7. 집필·고증·표현 가이드',
    '자문단이 확인한 근거를 기준으로 집필하며 화면과 출연자의 말이 스스로 의미를 만들게 한다.',
    '피해야 할 표현·구성\t권장 방향',
    '세종과 학자들이 함께 만들었다는 단순화\t창제와 해례 편찬의 역할을 구분해 설명',
    '유네스코 등재가 확정된 것처럼 표현\t등재 추진을 위한 기록 자료라는 현재 지위를 표시',
    dateHeading,
    '시기\t핵심 업무\t작가 관련 업무',
    '8월\t착수·자문단 구성\t기존 기획자료 검토',
    '9월\t공동회의\t시나리오 1차 작성',
    '자문단 확정 즉시 작가와 내용을 공유하고 1차 자문회의 일정을 잡는다.'
  ].join('\n');
  const broken = [
    '7. 집필·고증·표현 가이드',
    '',
    '자문단이 확인한 근거를 기준으로 집필하며 화면과 출연자의 말이 스스로 의미를 만들게 한다. 피해야 할 표현·구성\t권장 방향',
    '세종과 학자들이 함께 만들었다는 단순화\t창제와 해례 편찬의 역할을 구분해 설명 유네스코 등재가 확정된 것처럼 표현\t등재 추진을 위한 기록 자료라는 현재 지위를 표시',
    '8. 추진 절차와 일정 (2026.',
    '',
    '8. ~ 11.',
    '',
    '30.) 시기\t핵심 업무\t작가 관련 업무',
    '8월\t착수·자문단 구성\t기존 기획자료 검토 9월\t공동회의\t시나리오 1차 작성 자문단 확정 즉시 작가와 내용을 공유하고 1차 자문회의 일정을 잡는다.'
  ].join('\n');
  const chunks = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveLineBoundaries: 'structural'
  }).chunks;
  const options = {
    source,
    outputText: broken,
    chunks,
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: reportProfile(),
    profileConfidence: 0.96,
    normalizeVisualGaps: true
  };

  const first = structure.restoreFinalDocumentLayout(options);
  const second = structure.restoreFinalDocumentLayout({ ...options, outputText: first.text });

  assert.equal(first.pass, true);
  assert.equal(first.contentPreserved, true);
  assert.equal(bare(first.text), bare(broken));
  assert.match(first.text, /만들게 한다\.\n\n?피해야 할 표현·구성\t권장 방향/u);
  assert.match(first.text, /권장 방향\n세종과 학자들이/u);
  assert.match(first.text, /현재 지위를 표시\n\n?8\. 추진 절차와 일정 \(2026\. 8\. ~ 11\. 30\.\)/u);
  assert.match(first.text, /\(2026\. 8\. ~ 11\. 30\.\)\n\n?시기\t핵심 업무\t작가 관련 업무/u);
  assert.match(first.text, /8월\t[^\n]+\n9월\t[^\n]+\n자문단 확정/u);
  assert.equal(second.text, first.text);
  assert.equal(second.pass, true);
  assert.equal(second.contentPreserved, true);
});

test('최종 레이아웃은 긴 문단 가독성 미달을 구조 실패로 승격하지 않는다', () => {
  const heading = '1. 분석 결과';
  const body = `이 분석은 ${'동일한 사실관계와 구조적 맥락을 보존하면서도 근거와 판단 기준을 구체적으로 설명하는 긴 문장 구성을 유지하고 '.repeat(14)}최종 결론을 제시한다.`;
  const source = `${heading}\n\n${body}`;
  const chunks = structure.splitChunksForGpt(source, { coalesceEditable: true }).chunks;

  const restored = structure.restoreFinalDocumentLayout({
    source,
    outputText: source,
    chunks,
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: reportProfile(),
    profileConfidence: 0.96,
    normalizeVisualGaps: true
  });

  assert.equal(restored.paragraphs.paragraphs.pass, false);
  assert.ok(restored.paragraphs.paragraphs.readability.overlongCount > 0);
  assert.equal(restored.readabilityPass, false);
  assert.equal(restored.structuralPass, true);
  assert.equal(restored.pass, true);
  assert.equal(restored.contentPreserved, true);
  assert.equal(bare(restored.text), bare(source));
});

test('최종 레이아웃은 citation-only tail을 독립 문단으로 남기지 않고 내부 수렴한다', () => {
  const first = `본 문단은 ${'사실과 근거를 차례로 설명하고 연구 결과를 분석한다. '.repeat(8).trim()} (7, 8)`;
  const second = `다음 문단은 ${'추가 분석과 시사점을 구체적으로 정리한다. '.repeat(5).trim()}`;
  const source = `${first}\n\n${second}`;
  const broken = `${first.replace(/ \(7, 8\)$/u, '')}\n\n(7, 8)\n\n${second}`;
  const chunks = structure.splitChunksForGpt(source, { coalesceEditable: true }).chunks;
  const options = {
    source,
    outputText: broken,
    chunks,
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: reportProfile(),
    profileConfidence: 0.96,
    normalizeVisualGaps: true
  };

  const restored = structure.restoreFinalDocumentLayout(options);
  const repeated = structure.restoreFinalDocumentLayout({ ...options, outputText: restored.text });

  assert.doesNotMatch(restored.text, /\n\s*\(7, 8\)(?=\s*\n|$)/u);
  assert.match(restored.text, /분석한다\. \(7, 8\)/u);
  assert.ok(restored.citationTailRepairCount >= 1);
  assert.equal(restored.converged, true);
  assert.ok(restored.iterationCount >= 1 && restored.iterationCount <= 5);
  assert.equal(repeated.text, restored.text);
  assert.equal(repeated.iterationCount, 1);
  assert.equal(repeated.converged, true);
  assert.equal(restored.contentPreserved, true);
});

test('중간 heading cursor 오탐은 최종 잠금 복원과 내용 보존이 통과하면 전달 구조를 실패시키지 않는다', () => {
  const firstHeading = '1. Alpha heading with a sufficiently descriptive nominal phrase';
  const secondHeading = '2. Beta heading with another sufficiently descriptive nominal phrase';
  const label = '\tLabel: ';
  const firstBody = 'First body sentence has enough content to explain the context and ends properly.';
  const secondBody = 'Second body sentence has enough content to explain the result and ends properly.';
  const parts = [firstHeading, label, firstBody, secondHeading, label, secondBody];
  const source = parts.join('\n');
  const starts = [];
  let cursor = 0;
  for (const part of parts) {
    starts.push(cursor);
    cursor += part.length + 1;
  }
  const chunks = [
    { locked: true, lockType: 'heading', text: firstHeading, index: 0, start: starts[0], end: starts[0] + firstHeading.length },
    { locked: true, lockType: 'label_prefix', text: label, index: 1, start: starts[1], end: starts[1] + label.length },
    { locked: true, lockType: 'heading', text: secondHeading, index: 2, start: starts[3], end: starts[3] + secondHeading.length },
    { locked: true, lockType: 'label_prefix', text: label, index: 3, start: starts[4], end: starts[4] + label.length }
  ];
  const collapsed = parts.map(part => part.trim()).join(' ');

  const restored = structure.restoreFinalDocumentLayout({
    source,
    outputText: collapsed,
    chunks,
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: reportProfile(),
    profileConfidence: 0.96,
    normalizeVisualGaps: true
  });

  assert.equal(restored.paragraphs.structuralPass, false);
  assert.ok(restored.paragraphs.heading.missingCount > 0);
  assert.equal(restored.transientStructuralPass, false);
  assert.equal(restored.finalLocked.pass, true);
  assert.equal(restored.contentPreserved, true);
  assert.equal(restored.structuralPass, true);
  assert.equal(restored.pass, true);
});

test('후단 공백 수리가 건드린 인라인 코드는 최종 순서 고정점에서 원문으로 복원한다', () => {
  const source = '설정값은 `foo_bar = 1`로 유지하고 결과는 `items.map(x => x.id)`로 확인한다.';
  const frozen = literal.freezeInlineCode(source);
  const changed = '설정값은 `foo bar = 2`로 유지하고 결과는 `items.map(x=>x.name)`로 확인한다.';
  const restored = literal.restoreInlineCodeByOrder(changed, frozen);

  assert.equal(restored.pass, true);
  assert.equal(restored.orderPass, true);
  assert.equal(restored.restoredCount, 2);
  assert.equal(restored.text, source);

  const missing = literal.restoreInlineCodeByOrder('설정값을 본문으로만 설명한다.', frozen);
  assert.equal(missing.pass, false);
  assert.equal(missing.applied, false);
});
