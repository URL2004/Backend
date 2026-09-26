'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/layoutStructure');
const structureChunk = require('../engine-gpt-prod/structureChunk');
const documentStructure = require('../engine-gpt-prod/documentStructure');
const { adoptValidatedRepairBlocks, splitParagraphBlocks } = require('../engine-gpt-prod/repairBlockAdoption');
const { restoreCertaintyEndings } = require('../engine-gpt-prod/certaintyEndingRestore');
const { auditRelationCandidates } = require('../engine-gpt-prod/relationAudit');

const body = '영웅 서사는 시대의 불안과 기대를 함께 담아 왔다. 관객은 인물의 선택을 통해 자신의 고민을 비추어 보았다. '.repeat(4);
const cover = ['미디어 보고서', '', '2026 – 09 - 26', '영웅 장르에 대한 다층적 분석',
  ': 영웅 장르에 관한 자료 조사와 여러 관점에서의 분석', '목 차', '1. 영웅 장르란 무엇인가?', '2. 결론',
  '', '1. 영웅 장르란 무엇인가?', body, '', '2. 결론', body].join('\n');

test('a cover title and its colon-led subtitle row are title furniture, not joined prose', () => {
  const records = layout.buildLineRecords(cover);
  assert.equal(records[3].role, 'title');
  assert.equal(records[4].role, 'title');
  const doc = documentStructure.buildDocument(cover);
  const titleBlocks = doc.blocks.filter(block => /다층적 분석|자료 조사와/u.test(block.text));
  assert.deepEqual(titleBlocks.map(block => block.kind), ['heading', 'heading']);
  // An unchanged plan must keep the two rows separate.
  const applied = documentStructure.applyPlan(doc, documentStructure.identityPlan(doc));
  assert.ok(!/분석 : 영웅/u.test(applied.text));
  const locked = structureChunk.splitChunksForGpt(cover, { coalesceEditable: true }).chunks
    .filter(chunk => chunk.locked).map(chunk => chunk.text);
  assert.ok(locked.some(text => text.includes('영웅 장르에 대한 다층적 분석')));
  assert.ok(locked.some(text => text.includes(': 영웅 장르에 관한 자료 조사와 여러 관점에서의 분석')));
});

test('colon-led rows after body prose, sentence subtitles and labels keep their roles', () => {
  const prose = ['영웅 서사의 변화를 정리한다', body, '관객의 반응을 비교했다.', ': 이 행은 설명이 이어지는 본문 문장이다.', body].join('\n');
  const rows = layout.buildLineRecords(prose);
  assert.notEqual(rows[3].role, 'title');
  const labelled = ['연구 제목: 영웅 서사의 변화', body].join('\n');
  assert.notEqual(layout.buildLineRecords(labelled)[1].role, 'title');
  const sentence = ['미디어 보고서', '', '영웅 장르의 분석', ': 이 보고서는 여러 관점에서 영웅 장르를 분석하였다.', body].join('\n');
  assert.notEqual(layout.buildLineRecords(sentence)[3].role, 'title');
});

test('relative structure comparison tolerates only defects the current text already has', () => {
  const source = ['영웅 장르 보고서', '', '1. 배경', body, '', '2. 결론', body].join('\n');
  const chunks = structureChunk.splitChunksForGpt(source, { coalesceEditable: true }).chunks;
  const audit = text => structureChunk.buildStructureAudit({ source, outputText: text, chunks });
  const current = source.replace('영웅 장르 보고서', '영웅 장르 연구 보고서');
  const baseline = audit(current);
  assert.equal(baseline.pass, false);
  const repaired = current.replace('자신의 고민을 비추어 보았다', '자신의 고민을 돌아보았다');
  assert.equal(structureChunk.structureAuditNotWorseThan(baseline, audit(repaired)), true);
  const worse = repaired.replace('2. 결론', '2. 결론과 전망');
  assert.equal(structureChunk.structureAuditNotWorseThan(baseline, audit(worse)), false);
  const traded = source.replace('2. 결론', '2. 결론과 전망');
  assert.equal(structureChunk.structureAuditNotWorseThan(baseline, audit(traded)), false);
  assert.equal(structureChunk.structureAuditNotWorseThan(baseline, audit(source)), true);
});

test('repair blocks are adopted one by one and the combination is revalidated', () => {
  const current = ['첫 문단이다.', '둘째 문단이다.', '셋째 문단이다.', '넷째 문단이다.'].join('\n\n');
  const repaired = ['첫 문단을 고쳤다.', '둘째 문단이다.', '셋째 문단을 망쳤다.', '넷째 문단을 고쳤다.'].join('\n\n');
  const calls = [];
  const validate = (base, candidate) => {
    calls.push(candidate);
    return { pass: !candidate.includes('망쳤다'), candidate, codes: candidate.includes('망쳤다') ? ['semantic_shift'] : [] };
  };
  const result = adoptValidatedRepairBlocks({ current, repaired, validate });
  assert.equal(result.applied, true);
  assert.equal(result.text, ['첫 문단을 고쳤다.', '둘째 문단이다.', '셋째 문단이다.', '넷째 문단을 고쳤다.'].join('\n\n'));
  assert.equal(result.adoptedCount, 2);
  assert.equal(result.rejectedCount, 1);
  assert.equal(calls.at(-1), result.text);
  // Changed paragraph boundaries, a single-block repair and an all-pass
  // repair (identical to the rejected whole candidate) are never adopted.
  assert.equal(adoptValidatedRepairBlocks({ current, repaired: repaired.replace('\n\n넷째', ' 넷째'), validate }).applied, false);
  assert.equal(adoptValidatedRepairBlocks({ current, repaired: current.replace('첫 문단이다', '첫 문단을 고쳤다'), validate }).applied, false);
  assert.equal(adoptValidatedRepairBlocks({ current, repaired: repaired.replace('망쳤다', '고쳤다'), validate }).reason, 'equals_rejected_candidate');
  const combinedFails = (base, candidate) => ({ pass: base !== current || !candidate.includes('넷째 문단을 고쳤다') || !candidate.includes('첫 문단을 고쳤다'), candidate });
  assert.equal(adoptValidatedRepairBlocks({ current, repaired, validate: (b, c) => (c.includes('망쳤다') ? { pass: false } : combinedFails(b, c)) }).applied, false);
  assert.deepEqual(splitParagraphBlocks('가\n\n나\n \n다').blocks, ['가', '나', '다']);
});

test('an interpretive frame the rewrite hardened into an assertion is restored on the same predicate', () => {
  const restored = restoreCertaintyEndings(
    '공감은 흥행의 중요한 요소로 볼 수 있다. 관객은 인물에게 이입한다.',
    '관객이 이입한다는 점에서 공감은 흥행의 중요한 요소다. 관객은 인물에게 이입한다.'
  );
  assert.equal(restored.applied, true);
  assert.equal(restored.text, '관객이 이입한다는 점에서 공감은 흥행의 중요한 요소로 볼 수 있다. 관객은 인물에게 이입한다.');
  assert.equal(restoreCertaintyEndings('그것은 사회 불안의 산물이라고 할 수 있다.', '그것은 사회 불안의 산물이다.').text,
    '그것은 사회 불안의 산물이라고 할 수 있다.');
  assert.equal(restoreCertaintyEndings('이는 대표적인 사례로 볼 수 있습니다.', '이는 대표적인 사례입니다.').text,
    '이는 대표적인 사례로 볼 수 있습니다.');
});

test('certainty restoration never invents a frame or crosses register, quotes or other predicates', () => {
  const unchanged = (source, output) => assert.equal(restoreCertaintyEndings(source, output).applied, false);
  unchanged('이는 대표적인 사례다. 다른 곳에서는 대표적인 사례로 볼 수 있다.', '이는 대표적인 사례다.');
  unchanged('이는 대표적인 사례로 볼 수 있습니다.', '이는 대표적인 사례다.');
  unchanged('이는 대표적인 사례로 볼 수 있다.', '그는 “이는 대표적인 사례다.”라고 말했다.');
  unchanged('이는 대표적인 사례로 볼 수 있다.', '전혀 다른 주제의 문장이 여기 있고 결론은 대표적인 사례다.');
  unchanged('이는 대표적인 사례로 볼 수 있다.', '이는 드문 사례다.');
  unchanged('이는 대표적인 사례로 볼 수 있다. 저것도 대표적인 사례로 볼 수 있다.', '이는 대표적인 사례다.');
  // Two equally close output sentences leave the owner ambiguous.
  unchanged('이는 대표적인 사례로 볼 수 있다.', '이는 대표적인 사례다. 이는 대표적인 사례다.');
  // A clearly corresponding sentence is restored; an added one is left alone.
  assert.equal(restoreCertaintyEndings('이는 대표적인 사례로 볼 수 있다.', '이는 대표적인 사례다. 저것도 대표적인 사례다.').text,
    '이는 대표적인 사례로 볼 수 있다. 저것도 대표적인 사례다.');
});

test('hedged verbal and "라 할 수 있다" endings are restored only on their own corresponding sentence', () => {
  const source = '반복되는 행동을 통해 영웅성이 형성된다는 점에서 스파이더맨은 구원자와 전문 직업인 사이에 놓인다. 그의 능력은 도시를 지키지만 파괴하기도 한다. '
    + '그런 점에서 스파이더맨은 보호자와 파괴자 사이에 놓인다고 할 수 있다. 이런 점에서 그는 두 세계의 경계에 놓인 존재라 할 수 있다.';
  const output = '그는 구원자와 전문 직업인 사이에 놓인다. 그의 능력은 도시를 지키지만 파괴하기도 한다. '
    + '스파이더맨은 이 때문에 보호자와 파괴자 사이에 놓인다. 그는 두 세계의 경계에 놓인 존재다.';
  assert.equal(restoreCertaintyEndings(source, output).text, '그는 구원자와 전문 직업인 사이에 놓인다. 그의 능력은 도시를 지키지만 파괴하기도 한다. '
    + '스파이더맨은 이 때문에 보호자와 파괴자 사이에 놓인다고 할 수 있다. 그는 두 세계의 경계에 놓인 존재라 할 수 있다.');
  // The plainly stated sentence of the source is never given a frame.
  assert.equal(restoreCertaintyEndings('스파이더맨은 구원자와 전문 직업인 사이에 놓인다.', '그는 구원자와 전문 직업인 사이에 놓인다.').applied, false);
});

test('an interpretive frame replaced by a causal link is nominated for semantic review', () => {
  assert.ok(auditRelationCandidates(
    '그의 평범한 고민은 관객과 경험을 잇는 한 요소로 볼 수 있다.',
    '그의 평범한 고민 때문에 관객은 경험을 연결할 수 있었다.'
  ).codes.includes('causal_relation_candidate'));
  assert.ok(!auditRelationCandidates(
    '그의 평범한 고민 때문에 관객은 경험을 연결할 수 있었다.',
    '그의 평범한 고민 때문에 관객은 자신의 경험을 연결할 수 있었다.'
  ).codes.includes('causal_relation_candidate'));
  assert.ok(!auditRelationCandidates(
    '그의 평범한 고민은 관객과 경험을 잇는 한 요소로 볼 수 있다.',
    '그의 평범한 고민은 관객과 경험을 잇는 한 요소로 볼 수 있다고 정리된다.'
  ).codes.includes('causal_relation_candidate'));
});

test('a plain nominal comparison rewritten as exclusion is nominated for semantic review', () => {
  const nominated = (source, output) => auditRelationCandidates(source, output).codes.includes('comparison_negation_candidate');
  assert.equal(nominated('그의 영웅성은 특별한 한 번의 행동보다 반복되는 행동을 통해 만들어진다.',
    '그의 영웅성은 특별한 한 번의 행동이 아니라 반복되는 행동을 통해 만들어진다.'), true);
  assert.equal(nominated('무엇보다 그의 영웅성은 반복되는 행동을 통해 만들어진다.',
    '그의 영웅성은 단발적 행동이 아니라 반복되는 행동을 통해 만들어진다.'), false);
  assert.equal(nominated('그의 영웅성은 특별한 한 번의 행동보다 반복되는 행동을 통해 만들어진다.',
    '그의 영웅성은 특별한 한 번의 행동보다 반복되는 실천을 통해 만들어진다.'), false);
});
