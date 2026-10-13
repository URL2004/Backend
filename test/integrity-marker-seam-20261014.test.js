'use strict';
// 2026-10-14 운영 전수 점검 회귀. 모든 문장은 합성 예시다.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../engine-gpt-prod');
const markers = require('../engine-gpt-prod/internalMarkerIntegrity');
const seam = require('../engine-gpt-prod/koreanEndingSeam');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const structure = require('../engine-gpt-prod/structureChunk');
const policy = require('../lib/humanizeDeliveryPolicy');

const sanitize = text => preflight.auditAndSanitizeSource(text).text;

// ---------------------------------------------------------------- 내부 토큰

const LOCK_SOURCE = '## 면담 기록\n초안 질문: 준비는 어떻게 했나요?\n점검: 질문이 넓어 답이 짧았다.';
const lockChunks = () => [
  { index: 0, text: '## 면담 기록', locked: true },
  { index: 1, text: '초안 질문: 준비는 어떻게 했나요?', locked: false },
  { index: 2, text: '점검: ', locked: true },
  { index: 3, text: '질문이 넓어 답이 짧았다.', locked: false }
];

test('a lock the primary freeze missed is still a known token and restores exactly', t => {
  t.mock.method(crypto, 'randomInt', () => 5713);
  const chunks = lockChunks();
  // 1차 병합 결과에서는 모델이 잠긴 라벨을 바꿔 써서 exact 일치가 없다.
  const firstOutput = '## 면담 기록\n초안 질문: 준비 과정은 어땠나요?\n진단: 질문이 넓어 답이 짧았다.';
  const frozen = engine.freezeLockedBlocks(LOCK_SOURCE, firstOutput, chunks);
  assert.deepEqual(frozen.blocks.map(block => block.token), ['ZXQLOCK5713QXZ']);
  assert.equal(frozen.missCount, 1);

  // 후단 수리가 라벨을 되돌린 뒤의 깊이 감사 쌍은 같은 순번으로 다시 동결한다.
  const repaired = '## 면담 기록\n초안 질문: 준비 과정은 어땠나요?\n점검: 질문이 넓어 답이 짧았다.';
  const pair = engine.buildHumanizationDepthPair({
    source: LOCK_SOURCE, outputText: repaired, chunks, primaryFrozen: frozen
  });
  assert.ok(pair.output.includes('ZXQLOCK5714QXZ질문이 넓어'));
  assert.ok(!frozen.blocks.some(block => block.token === 'ZXQLOCK5714QXZ'));

  const known = markers.buildLockedRestoreBlocks(chunks, frozen.markerContext);
  assert.deepEqual(known, [
    { token: 'ZXQLOCK5713QXZ', value: '## 면담 기록' },
    { token: 'ZXQLOCK5714QXZ', value: '점검: ' }
  ]);
  let delivered = pair.output;
  for (const block of known) delivered = delivered.split(block.token).join(block.value);
  assert.equal(delivered, repaired);
  assert.deepEqual(markers.residualInternalMarkers(LOCK_SOURCE, delivered), []);
});

test('every locked-block restore in the engine uses the complete request registry', () => {
  const code = fs.readFileSync(path.join(__dirname, '../engine-gpt-prod/index.js'), 'utf8');
  assert.ok(!/restoreLockedBlocks\([^\n]*[Ff]rozen\??\.blocks\)/u.test(code));
  assert.ok((code.match(/restoreLockedBlocks\([^\n]*lockedRestoreBlocks\(/gu) || []).length >= 5);
  assert.match(code, /residualInternalMarkers\(rawSource, outputText\)/u);
});

test('unregistered internal tokens are leaks; identical user-written strings are content', () => {
  const source = '과제 안내문에는 ZXQLOCK5714QXZ 라는 예시 문자열과 [[[V2_LINE_0001]]] 표기가 적혀 있다.';
  assert.deepEqual(markers.residualInternalMarkers(source, source), []);
  assert.deepEqual(markers.residualInternalMarkers(source,
    '안내문에는 ZXQLOCK5714QXZ 라는 예시와 [[[V2_LINE_0001]]] 표기가 있다.'), []);
  // 원문 보유분을 넘는 같은 문자열, 그리고 원문에 없는 토큰은 누출이다.
  assert.deepEqual(markers.residualInternalMarkers(source, `${source}\nZXQLOCK5714QXZ질문이 넓었다.`),
    [{ family: 'ZXQLOCK####QXZ', count: 1 }]);
  assert.deepEqual(markers.residualInternalMarkers('본문이다.', 'ZXQMATH0007QXZ 본문이다. [[[V2_SENTENCE_0003]]]')
    .map(item => item.family).sort(), ['ZXQMATH####QXZ', '[[[V2_SENTENCE_####]]]']);
  // 토큰 문법이 아닌 비슷한 문자열은 내부 토큰이 아니다.
  assert.deepEqual(markers.residualInternalMarkers('', 'ZXQLOCK57QXZ, ZXQ, QXZ, [[[V2_NOTE_0001]]]'), []);
});

test('a leaked internal token blocks delivery as a technical failure', () => {
  assert.ok(policy.TECHNICAL_GATES.has('internal_marker_leak'));
  const delivery = policy.applyDeliveryPolicy({
    status: 'needs_review',
    criticals: [{ gate: 'internal_marker_leak' }],
    warnings: [{ code: 'semantic_relation_shift', message: '관계 변화' }]
  }, { mode: 'assignment' });
  assert.equal(delivery.decision, 'block_technical');
  assert.deepEqual(delivery.reasonCodes, ['internal_marker_leak']);
});

// ------------------------------------------------------- 종결어미 줄 끊김

const LEFT_DUN = '이 실습은 조별 발표를 준비하는 과정에서 자료 조사와 역할 분담을 점검하는 데 초점을 둔';
const LEFT_HAN = '조장은 발표 자료와 대본이 정해진 일정에 따라 모두 제출되도록 미리 안내해야 한';

test('present-tense endings cut before the last syllable are seams only for predicate shapes', () => {
  assert.equal(seam.isEndingSeam(LEFT_DUN, '다. 발표 전에 원고를 읽는다.'), true);
  assert.equal(seam.isEndingSeam(LEFT_HAN, '다.'), true);
  assert.equal(seam.isEndingSeam('발표가 끝나면 조원들은 다음 과제에서 고칠 점을 함께 정리하게 된', '다. 이후 공유한다.'), true);
  assert.equal(seam.isEndingSeam('조원들은 수업 전에 발표 순서와 맡은 부분을 서로 다시 확인한', '다. 이후 연습한다.'), true);
  // 명사로 끝난 행 뒤의 `다.`는 실제 항목일 수 있다.
  for (const left of [
    '공유 폴더의 자료를 고칠 수 있는 사람은 조장과 부조장으로 정한 수정 권한',
    '조별 과제 초안을 담당 조교에게 전자 우편으로 보내야 하는 제출 기한',
    '다음 주 발표에서 다룰 주제는 조별 과제를 하며 겪은 어려움과 개선 방안',
    '발표 연습은 수업이 없는 날 오후에 모여서 진행하며 한 번에 두 시간'
  ]) assert.equal(seam.isEndingSeam(left, '다. 세부 내용은 추후 공지'), false, left);
  // 짧은 시행, 가나다 항목 행 자체, 마침표 없는 `다`는 대상이 아니다.
  assert.equal(seam.isEndingSeam('길을 나서려 한', '다. 저문 강가에서'), false);
  assert.equal(seam.isEndingSeam('나. 대본은 조원 모두가 읽을 수 있도록 공유 폴더에 올려야 한', '다. 발표 순서'), false);
  assert.equal(seam.isEndingSeam(LEFT_HAN, '다음 일정은 추후 공지한다.'), false);
});

test('source preflight rejoins the broken ending instead of planning a locked 다. list item', () => {
  const single = `실습 보고서\n\n${LEFT_DUN}\n다. 발표 전에 조원들은 함께 원고를 읽고 순서를 확인한다.`;
  const blank = `실습 보고서\n\n${LEFT_HAN}\n\n다. 일정이 밀리면 원인을 함께 살펴보고 역할을 다시 나눈다.`;
  assert.equal(sanitize(single),
    `실습 보고서\n\n${LEFT_DUN}다. 발표 전에 조원들은 함께 원고를 읽고 순서를 확인한다.`);
  assert.equal(sanitize(blank),
    `실습 보고서\n\n${LEFT_HAN}다. 일정이 밀리면 원인을 함께 살펴보고 역할을 다시 나눈다.`);
  for (const text of [single, blank]) {
    const source = sanitize(text);
    assert.equal(source.replace(/\s/gu, ''), text.replace(/\s/gu, ''));
    const plan = structure.splitChunksForGpt(source, { coalesceEditable: true, preserveLineBoundaries: 'structural' });
    assert.ok(!plan.chunks.some(chunk => /^\s*다\.(?:\s|$)/u.test(String(chunk.text || ''))));
  }
});

test('real 가나다 lists, verse, tables and quotations keep their line and paragraph boundaries', () => {
  const unchanged = [
    // 빈 행으로 띄운 실제 목록: 나. 항목이 `한`으로 끝나도 다. 항목은 그대로다.
    '준비물 안내\n\n가. 발표 자료는 조별로 한 부씩 인쇄하여 수업 전에 제출한다\n\n나. 대본은 조원 모두가 읽을 수 있도록 공유 폴더에 올려야 한\n\n다. 발표 순서는 수업 당일 추첨으로 정하며 변경할 수 없다',
    '가. 발표 자료는 조별로 한 부씩 인쇄하여 수업 전에 제출한다\n나. 대본은 조원 모두가 읽을 수 있도록 공유 폴더에 올려야 한\n다. 발표 순서는 수업 당일 추첨으로 정하며 변경할 수 없다',
    // 나. 항목과 다. 항목 사이에 줄바꿈된 설명 행이 낀 목록.
    '가. 발표 자료는 조별로 인쇄한다\n나. 대본은 공유 폴더에 올린다\n아래 표는 조원들이 수업 전에 함께 확인해야 하는 사항을 간단히 정리한\n다. 발표 순서는 수업 당일 추첨으로 정한다',
    '바람이 지나간 자리에 남은 한\n\n다. 그리고 또 하루',
    '봄이 오면 나는 다시\n길을 나서려 한\n다. 저문 강가에서',
    '항목\t내용\n준비 단계에서 조원들이 함께 확인해야 하는 사항을 정리한\t필요한\n\n다. 비고란은 비워 둔다',
    '> 조장은 발표 자료와 대본이 정해진 일정에 따라 모두 제출되도록 안내해야 한\n\n다. 일정이 밀리면 원인을 살핀다.',
    '다음 주 발표에서 다룰 주제는 조별 과제를 진행하면서 겪은 어려움과 개선 방안\n\n다. 세부 일정은 추후 공지'
  ];
  for (const text of unchanged) assert.equal(sanitize(text), text, text);
});

// ------------------------------------------------------ 굵은 라벨 닫는 기호

test('a bold label lock keeps its closing emphasis delimiter', () => {
  const plan = text => structure.splitChunksForGpt(text, { coalesceEditable: true, preserveLineBoundaries: 'structural' });
  const prefixes = text => plan(text).chunks.filter(chunk => chunk.locked).map(chunk => chunk.text);
  const body = '이러한 오류의 원인은 규칙의 과잉 적용이다. 학습자는 이를 반복한다.';
  assert.deepEqual(prefixes(`**원인 분석:** ${body}`), ['**원인 분석:** ']);
  assert.deepEqual(prefixes(`*원인:* ${body}`), ['*원인:* ']);
  assert.deepEqual(prefixes(`**원인 분석:** **핵심 요인**은 규칙이다. 학습자는 이를 반복한다.`), ['**원인 분석:** ']);
  // 라벨을 감싸지 않는 강조는 본문 소유다.
  assert.deepEqual(prefixes(`원인 분석: **핵심 요인**은 규칙의 과잉 적용이다. 학습자는 이를 반복한다.`), ['원인 분석: ']);
  for (const text of [`**원인 분석:** ${body}`, `*원인:* ${body}`, `원인 분석: **핵심 요인**은 규칙이다.`]) {
    assert.equal(structure.mergeChunks(plan(text).chunks), text);
  }
});

// ------------------------------------------------- 반복되는 한 단어 소제목

test('a one-word section label repeated across cases stays a locked heading', () => {
  const block = n => [
    `사례 ${n}`,
    '결론',
    `따라서 ${n}번 발표문은 조별 활동의 준비 과정과 결과를 함께 살펴본 글이다.`,
    '점검',
    `이 정리는 ${n}번 발표문의 제목과 목차에서 드러나는 목적을 근거로 삼았으며 본문 전체를 읽은 평가는 아니다.`
  ].join('\n');
  const text = [1, 2, 3].map(block).join('\n');
  const source = sanitize(text);
  assert.equal((source.match(/^점검$/gmu) || []).length, 3);
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true, preserveLineBoundaries: 'structural' });
  assert.equal(plan.chunks.filter(chunk => chunk.locked && chunk.text.trim() === '점검').length, 3);
});

test('a short line is not promoted without three peers after finished sentences', () => {
  const layout = require('../engine-gpt-prod/layoutStructure');
  const role = (text, word) => layout.buildLineRecords(text).filter(row => row.text === word).map(row => row.role);
  const body = '이 정리는 발표문의 제목과 목차에서 드러나는 목적을 근거로 삼았으며 전체 평가는 아니다.';
  // 두 번뿐인 반복, 끝나지 않은 문장 뒤의 낱말, 서술어로 끝나는 짧은 행.
  assert.ok(!role(`발표는 무사히 끝났다.\n점검\n${body}\n질문도 많이 나왔다.\n점검\n${body}`, '점검').includes('heading'));
  const wrapped = [1, 2, 3].map(() => `조원들은 발표가 끝난 뒤에 모여서 자료를 다시\n점검\n${body}`).join('\n');
  assert.ok(!role(wrapped, '점검').includes('heading'));
  const predicate = [1, 2, 3].map(() => `발표는 무사히 끝났다.\n그렇다\n${body}`).join('\n');
  assert.ok(!role(predicate, '그렇다').includes('heading'));
});
