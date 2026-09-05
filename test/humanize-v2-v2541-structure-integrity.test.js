'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../engine-gpt-prod');
const finalQuality = require('../engine-gpt-prod/finalQualityV2');
const judge = require('../engine-gpt-prod/judge');
const korean = require('../engine-gpt-prod/koreanRefinement');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const structure = require('../engine-gpt-prod/structureChunk');
const voice = require('../engine-gpt-prod/voiceProfile');

test('v2.5.41: 새 제목·중복 제목은 원문 제목이 모두 남아 있어도 구조 실패다', () => {
  const source = [
    '3.3 시각 효과 (VFX)',
    '',
    '합성은 실사 영상과 CG 요소를 자연스럽게 결합하는 과정이다.',
    '',
    '3.4 애니메이션',
    '',
    '모션 캡처는 실제 움직임 데이터를 기록해 캐릭터에 적용한다.'
  ].join('\n');
  const output = [
    '3.3 시각 효과 (VFX)',
    '',
    '합성은 실사 영상과 CG 요소를 자연스럽게 결합하는 과정이다.',
    '',
    '3.4 애니메이션',
    '',
    '첫 번째 애니메이션 설명이다.',
    '',
    '3.4 애니메이션',
    '',
    '모션 캡처는 실제 움직임 데이터를 기록해 캐릭터에 적용한다.'
  ].join('\n');
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
  const role = structure.compareStructuralRoleSignatures(source, output);
  const markers = structure.compareOriginalStructuralMarkers(source, output);
  const anchors = structure.compareLineAnchorLayout(source, output);
  const audit = structure.buildStructureAudit({ source, outputText: output, chunks: plan.chunks, plan });

  // Contextual role counts remain telemetry; exact marker/line inventories own
  // the hard duplicate check so an existing short source line is not rejected.
  assert.equal(role.pass, true);
  assert.ok(role.additions.some(item => item.role === 'titleHeading'));
  assert.equal(markers.pass, false);
  assert.equal(markers.additions.length, 1);
  assert.equal(anchors.pass, false);
  assert.equal(anchors.additions.length, 1);
  assert.equal(audit.pass, false);
  assert.ok(audit.structuralRoleAdditionCount >= 1);
  assert.ok(audit.sourceLineAnchorAdditionCount >= 1);
});

test('v2.5.41: 원문에 있던 짧은 독립 행의 제목 승격은 신규 제목으로 오인하지 않는다', () => {
  const source = [
    '-배경 이론: 실험 조건과 판단 기준이 달라지는 인지 편향',
    '',
    '가설',
    '1. 첫 번째 가설의 내용을 아주 길고 구체적으로 설명하는 문장입니다.',
    '2. 두 번째 가설의 내용을 아주 길고 구체적으로 설명하는 문장입니다.',
    '',
    '실험 진행'
  ].join('\n');
  const output = [
    '-배경 이론: 실험 조건과 판단 기준이 달라지는 인지 편향',
    '',
    '가설',
    '',
    '1. 첫 번째 가설의 내용을 아주 길고 구체적으로 설명하는 문장입니다.',
    '2. 두 번째 가설의 내용을 아주 길고 구체적으로 설명하는 문장입니다.',
    '',
    '실험 진행'
  ].join('\n');
  const anchors = structure.compareLineAnchorLayout(source, output);

  assert.equal(anchors.pass, true);
  assert.equal(anchors.additions.length, 0);
});

test('v2.5.41: 장문 의미 심사 쌍은 공통 제목으로 정렬되고 원문 overlap이 없다', () => {
  const prose = marker => `${marker} ${'세부 설명과 검증 조건을 빠짐없이 보존하는 문장이다. '.repeat(110)}`;
  const source = [
    '1. 정의',
    prose('정의구간'),
    '2. 역사',
    prose('역사구간'),
    '2.4 고도화와 융합 시기',
    prose('GLOBAL_ILLUMINATION_SENTINEL'),
    '3.3 시각 효과 (VFX)',
    prose('VFX_COMPOSITION_SENTINEL'),
    '3.4 애니메이션',
    prose('MOTION_CAPTURE_SENTINEL')
  ].join('\n\n');
  const output = source
    .replaceAll('세부 설명과 검증 조건을 빠짐없이 보존하는 문장이다.', '검증 조건과 세부 설명을 모두 유지한 문장이다.');
  assert.ok(source.length > 12000);
  assert.ok(output.length > 12000);

  const pairs = finalQuality.buildReviewPairs(source, output, 4200);
  assert.ok(pairs.length >= 3);
  assert.equal(pairs.map(item => item.sourceContext).join(''), source);
  assert.equal(pairs.map(item => item.output).join(''), output);
  for (const sentinel of [
    'GLOBAL_ILLUMINATION_SENTINEL',
    'VFX_COMPOSITION_SENTINEL',
    'MOTION_CAPTURE_SENTINEL'
  ]) {
    assert.equal(pairs.filter(item => item.sourceContext.includes(sentinel)).length, 1);
  }
  const vfxPair = pairs.find(item => item.sourceContext.includes('VFX_COMPOSITION_SENTINEL'));
  assert.match(vfxPair.output, /VFX_COMPOSITION_SENTINEL/u);
  assert.doesNotMatch(vfxPair.sourceContext, /GLOBAL_ILLUMINATION_SENTINEL/u);
});

test('v2.5.41: 제목 없는 장문도 원문 구간을 겹치지 않고 정확히 한 번씩 심사한다', () => {
  const source = Array.from({ length: 500 }, (_, index) => (
    `원문 ${index + 1}번째 문장은 서로 다른 사실과 조건을 자세히 설명한다.`
  )).join('\n\n');
  const output = source.replaceAll('자세히 설명한다', '구체적으로 밝힌다');
  const pairs = finalQuality.buildReviewPairs(source, output, 3500);
  assert.ok(pairs.length >= 2);
  assert.equal(pairs.map(item => item.sourceContext).join(''), source);
  assert.equal(pairs.map(item => item.output).join(''), output);
  assert.equal(pairs.filter(item => item.sourceContext.includes('원문 130번째')).length, 1);
  assert.ok(pairs.every(item => item.alignment === 'relative_non_overlapping'));
});

test('v2.5.41: 의미 수리 후보가 다음 절 제목을 복제하면 공통 후보 감사가 거부한다', () => {
  const source = [
    '3.3 시각 효과 (VFX)',
    '합성은 실사 영상과 CG 요소를 결합하는 과정이다.',
    '3.4 애니메이션',
    '모션 캡처는 움직임 데이터를 캐릭터에 적용하는 기술이다.'
  ].join('\n\n');
  const before = source.replace('결합하는 과정이다', '한 장면에 어우러지게 하는 과정이다');
  const candidate = before.replace(
    '3.4 애니메이션',
    '3.4 애니메이션\n\n애니메이션 설명이 한 번 더 들어갔다.\n\n3.4 애니메이션'
  );
  const audit = judge.assessRepairCandidate(source, before, candidate, {
    mode: 'assignment',
    documentProfile: { profile: 'long_explainer' }
  });
  assert.equal(audit.pass, false);
  assert.ok(audit.reasons.includes('structure_integrity_worsened'), JSON.stringify(audit.reasons));
});

test('v2.5.41: 1차 편집 청크가 원문에 없던 번호 제목을 만들면 문서 병합 전에 거부한다', () => {
  const source = '시각 효과의 합성 원리를 설명한다. 이어서 애니메이션의 움직임 기록 방식을 설명한다.';
  const output = '시각 효과의 합성 원리를 정리한다.\n\n3.4 애니메이션\n\n이어서 움직임 기록 방식을 설명한다.';
  const gate = engine.evaluateChunkGate({
    outputText: output,
    original: source,
    contract: { povSeed: {}, lengthPolicy: {} },
    mode: 'assignment',
    protectedTerms: [],
    documentProfile: { profile: 'long_explainer', formatProfile: { flags: [] } }
  });

  assert.equal(gate.hardFail, true);
  assert.equal(gate.reason, 'generated_structure_added');
  assert.ok(gate.violations.some(item => item.gate === 'generated_structure_added'));
});

test('v2.5.41: 원문에 있던 짧은 독립 행은 본문을 고쳐도 청크 신규 구조로 오인하지 않는다', () => {
  const source = [
    '가설',
    '첫 번째 가설은 관찰 조건과 결과의 관계를 구체적으로 설명한다.'
  ].join('\n');
  const output = [
    '가설',
    '첫 번째 가설은 관찰 조건과 결과가 어떻게 연결되는지 구체적으로 설명한다.'
  ].join('\n');
  const gate = engine.evaluateChunkGate({
    outputText: output,
    original: source,
    contract: { povSeed: {}, lengthPolicy: {} },
    mode: 'assignment',
    protectedTerms: [],
    documentProfile: { profile: 'report_assignment', formatProfile: { flags: [] } }
  });

  assert.equal(gate.hardFail, false, JSON.stringify(gate));
});

test('v2.5.41: 한 행 라벨 본문이 새 문단으로 갈라지면 청크 승인 전에 거부한다', () => {
  const source = '설명: 시각 효과와 애니메이션의 차이를 한 문단에서 비교한다.';
  const output = [
    '설명: 시각 효과와 애니메이션의 차이를',
    '',
    '한 문단에서 비교해 설명한다.'
  ].join('\n');
  const gate = engine.evaluateChunkGate({
    outputText: output,
    original: source,
    contract: { povSeed: {}, lengthPolicy: {} },
    mode: 'assignment',
    protectedTerms: [],
    documentProfile: { profile: 'long_explainer', formatProfile: { flags: [] } }
  });

  assert.equal(gate.hardFail, true);
  assert.equal(gate.reason, 'inline_label_body_split');
  assert.ok(gate.violations.some(item => item.gate === 'inline_label_body_split'));
});

test('v2.5.41: 한 행 라벨 본문은 문자 변경 없이 청크 단계에서 다시 한 행으로 복원한다', () => {
  const source = '설명: 시각 효과와 애니메이션의 차이를 한 문단에서 비교한다.';
  const output = [
    '설명: 시각 효과와 애니메이션의 차이를',
    '',
    '한 문단에서 비교해 설명한다.'
  ].join('\n');
  const restored = structure.restoreInlineLabelBodyLayout(source, output);

  assert.equal(restored.applied, true);
  assert.equal(restored.contentPreserved, true);
  assert.equal(restored.text, '설명: 시각 효과와 애니메이션의 차이를 한 문단에서 비교해 설명한다.');
  assert.equal(structure.compareInlineLabelBodyLayout(source, restored.text).pass, true);
});

test('v2.5.41: 한국어 연결 어미와 영문 약어가 붙은 수리 잔재를 탐지해 공백을 복원한다', () => {
  const source = '보다 현실적이고 복잡한 동작에는 모션 캡처를 사용한다. VFX 합성도 별도로 설명한다.';
  const output = '보다 현실적이고VFX 작업에서 합성은 중요한 단계다.';
  const before = korean.analyzeKoreanRefinement({
    source,
    outputText: output,
    documentProfile: { profile: 'long_explainer' },
    mode: 'assignment'
  });
  assert.ok(before.issueCodes.includes('hangul_connective_acronym_glue'));
  const repaired = korean.applySafeDeterministicRepairs({
    source,
    outputText: output,
    documentProfile: { profile: 'long_explainer' }
  });
  assert.match(repaired.text, /현실적이고 VFX/u);
  assert.ok(repaired.changeCodes.includes('hangul_connective_acronym_glue'));
});

test('v2.5.41: 혼합형 인용부호 안의 원문은 연결 어미·약어 공백 수리에서 제외한다', () => {
  const source = '저자는 "현실적이고VFX적인 표현”이라는 문구를 그대로 인용했다.';
  const repaired = korean.applySafeDeterministicRepairs({
    source,
    outputText: source,
    documentProfile: { profile: 'long_explainer' }
  });

  assert.equal(repaired.text, source);
  assert.equal(repaired.changeCodes.includes('hangul_connective_acronym_glue'), false);
});

test('v2.5.41: ASCII 여는 부호와 곡선형 닫는 부호도 완결된 직접 인용으로 보호한다', () => {
  const source = '독일 속담에는 "정원을 가꾸면 나비가 찾아온다”라는 말이 있다. 나는 내 정원을 가꾸기로 했다.';
  const altered = '독일 속담에는 "꽃을 심으면 행운이 찾아온다”라는 말이 있다. 나는 내 정원을 가꾸기로 했다.';
  const sourceAudit = preflight.auditAndSanitizeSource(source);
  const voiceProfile = voice.buildVoiceProfile(source);
  const gate = engine.evaluateChunkGate({
    outputText: altered,
    original: source,
    contract: { povSeed: {}, lengthPolicy: {} },
    mode: 'blog',
    protectedTerms: [],
    documentProfile: { profile: 'personal_essay', formatProfile: { flags: [] } }
  });

  assert.equal(sourceAudit.issueCodes.includes('source_unclosed_delimiter'), false);
  assert.equal(voiceProfile.directQuoteCount, 1);
  assert.equal(gate.hardFail, true);
  assert.equal(gate.reason, 'direct_quote_worsened');
});

test('v2.5.41: 완결된 원문을 조사에서 잘라낸 결과는 문장 절단으로 재시도한다', () => {
  const source = '낯선 도시에서 지내며 타인의 반응을 통제할 수 없다는 점을 배웠다. 독일의 속담을 떠올리며 내 삶을 가꾸기로 했다.';
  const output = '낯선 도시에서 지내며 타인의 반응을 좌우할 수 없다는 점을 배웠다. 독일의 속담 중에';
  const gate = engine.evaluateChunkGate({
    outputText: output,
    original: source,
    contract: { povSeed: {}, lengthPolicy: {} },
    mode: 'blog',
    protectedTerms: [],
    documentProfile: { profile: 'personal_essay', formatProfile: { flags: [] } }
  });

  assert.equal(gate.hardFail, true);
  assert.equal(gate.reason, 'sentence_truncated');
});

test('v2.5.43 엔진 버전을 노출한다', () => {
  assert.equal(engine.VERSION, 'gpt-prod-v2.5.46');
});
