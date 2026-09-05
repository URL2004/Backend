'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../engine-gpt-prod');
const structure = require('../engine-gpt-prod/structureChunk');
const layout = require('../engine-gpt-prod/layoutStructure');
const { compactHistoryEngineMeta } = require('../lib/historyService');

function compact(value) {
  return String(value || '').replace(/\s+/gu, '');
}

function reportProfile() {
  return {
    profile: 'report_assignment',
    confidence: 0.95,
    formatProfile: { primary: 'sectioned', flags: ['sectioned'] }
  };
}

test('v2.5.43 엔진 버전을 사용한다', () => {
  assert.equal(engine.VERSION, 'gpt-prod-v2.5.45');
});

test('긴 영문 병기 라벨도 구조 판정과 동일한 접두부로 잠근다', () => {
  const source = '피드백 및 통제 (Feedback & Control): 결과를 점검하고 다음 공정에 반영합니다.';
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
  const prefix = plan.chunks.find(chunk => chunk.lockType === 'label_prefix');

  assert.ok(prefix);
  assert.equal(prefix.text, '피드백 및 통제 (Feedback & Control): ');
  assert.equal(plan.chunks.some(chunk => !chunk.locked && /결과를 점검/u.test(chunk.text)), true);
});

test('합쳐진 라벨 경계와 라벨 본문의 임의 문단 분리를 어휘 변경 없이 복원한다', () => {
  const source = [
    '1. 서론',
    '생산시스템의 구조와 적용 범위를 설명합니다.',
    '2. 본론',
    '1) 생산시스템의 기본 구조',
    '투입 (Input): 자원과 정보를 준비합니다.',
    '변환 과정 (Transformation Process): 투입된 자원을 공정에서 처리하고 가치 있는 결과로 바꿉니다.',
    '산출 (Output): 완성된 제품과 서비스를 제공합니다.',
    '피드백 및 통제 (Feedback & Control): 결과를 점검하고 다음 공정에 반영합니다.',
    '3. 결론',
    '각 단계는 서로 연결됩니다.'
  ].join('\n');
  const output = [
    '1. 서론',
    '생산시스템의 구성과 적용 범위를 설명합니다.',
    '2. 본론',
    '1) 생산시스템의 기본 구조',
    '투입 (Input): 자원과 정보를 먼저 준비합니다.',
    '변환 과정 (Transformation Process): 준비한 자원을 공정에서 처리하고',
    '',
    '가치 있는 결과로 바꿉니다.',
    '산출 (Output): 완성된 제품과 서비스를 제공합니다. 피드백 및 통제 (Feedback & Control): 결과를 확인해 다음 공정에 반영합니다.',
    '3. 결론',
    '각 단계는 긴밀하게 연결됩니다.'
  ].join('\n');
  const plan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveLineBoundaries: 'structural'
  });
  const restored = structure.restorePostSemanticLayout({
    source,
    outputText: output,
    chunks: plan.chunks,
    mode: 'assignment',
    requestStrength: 'basic',
    documentProfile: reportProfile(),
    profileConfidence: 0.95
  });

  assert.equal(compact(restored.text), compact(output));
  assert.match(restored.text, /변환 과정 \(Transformation Process\): [^\n]+가치 있는 결과로 바꿉니다\./u);
  assert.match(restored.text, /산출 \(Output\): [^\n]+\n피드백 및 통제 \(Feedback & Control\):/u);
  assert.equal(restored.inlineLabels.repairCount, 1);
  assert.equal(restored.inlineLabels.pass, true);

  const audit = structure.buildStructureAudit({
    source,
    integritySource: source,
    outputText: restored.text,
    chunks: plan.chunks,
    plan,
    layoutRepair: restored
  });
  assert.equal(audit.lineAnchorLayoutPass, true, JSON.stringify(audit.lineAnchorBoundaryChanges));
  assert.equal(audit.inlineLabelBodyLayoutPass, true, JSON.stringify(audit.inlineLabelBodySplits));
  assert.equal(audit.pass, true);
});

test('라벨 본문 분리를 최종 구조 감사에서 독립적으로 검출한다', () => {
  const source = [
    '변환 과정 (Transformation Process): 자원을 처리하고 결과로 바꿉니다.',
    '산출 (Output): 완성된 결과를 제공합니다.'
  ].join('\n');
  const broken = [
    '변환 과정 (Transformation Process): 자원을 처리하고',
    '',
    '결과로 바꿉니다.',
    '산출 (Output): 완성된 결과를 제공합니다.'
  ].join('\n');
  const compared = structure.compareInlineLabelBodyLayout(source, broken);

  assert.equal(compared.pass, false);
  assert.equal(compared.violations[0]?.reason, 'single_line_label_body_split');
});

test('반복되는 라벨 묶음의 범주 행을 일반 산문이 아닌 제목으로 보호한다', () => {
  const source = [
    'SWOT 분석',
    '강점 (Strength - 내부 긍정 요인)',
    '기술 역량: 설계 경험이 풍부합니다.',
    '약점 (Weakness - 내부 부정 요인)',
    '보완 과제: 문서화 경험을 늘려야 합니다.',
    '기회 (Opportunity - 외부 긍정 요인)',
    '시장 변화: 신규 수요가 확대되고 있습니다.',
    '위협 (Threat - 외부 부정 요인)',
    '경쟁 심화: 유사 서비스가 늘고 있습니다.'
  ].join('\n');
  const records = layout.buildLineRecords(source).filter(record => !record.blank);
  const groupHeadings = records.filter(record => /^(?:강점|약점|기회|위협)\s/u.test(record.text));
  assert.equal(groupHeadings.length, 4);
  assert.equal(groupHeadings.every(record => record.role === 'heading'), true);

  const plan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveLineBoundaries: 'structural'
  });
  assert.equal(plan.chunks.filter(chunk => chunk.lockType === 'heading').length >= 4, true);
});

test('라벨 다음에 일반 산문이 오는 문서는 별도 문단을 라벨 본문으로 합치지 않는다', () => {
  const source = [
    '주의 사항: 제출 전에 수치를 다시 확인합니다.',
    '',
    '다음 문단은 별도의 해설이며 라벨 항목에 속하지 않습니다.'
  ].join('\n');
  const result = structure.restoreInlineLabelBodyLayout(source, source);

  assert.equal(result.applicableCount, 0);
  assert.equal(result.applied, false);
  assert.equal(result.text, source);
});

test('여러 라벨 행은 하나의 과장 산문 문단으로 오인하지 않는다', () => {
  const labelGroup = [
    '담당 역할: 임상 요구를 성능 사양으로 구체화했습니다.',
    '핵심 과제: 원가 절감형 변경과 신제품 개발을 병행했습니다.',
    '설계 판단: 후보 부품을 비교했습니다. 검토 결과 듀얼 펌프를 채택했습니다.',
    '전원 구조: 전력 예산을 산정했습니다. USB-C PD 방식도 검토했습니다.',
    '검증 및 문서화: 수명 시험 조건을 정의했습니다. 결과는 성적서로 남겼습니다.'
  ].join('\n');
  const readability = layout.measureParagraphReadability([labelGroup], {
    mode: 'assignment',
    requestStrength: 'advanced',
    documentProfile: { profile: 'resume_application' }
  });

  assert.equal(readability.overlongCount, 0);
  assert.equal(readability.targetCount, 1);
  assert.equal(readability.details[0]?.structureDominated, true);
});

test('최종 잠금 복원은 라벨 행을 붙여 두고 섹션 제목 사이만 보기 좋게 띄운다', () => {
  const source = [
    '[현 직장 – 의료기기 하드웨어 개발]',
    '담당 역할: 임상 요구를 성능 사양으로 구체화했습니다.',
    '핵심 과제: 원가 절감형 변경과 신제품 개발을 병행했습니다.',
    '[이전 직장 – 방산 장비 개발]',
    '담당 역할: 레이더 장비의 하드웨어 설계를 검토했습니다.',
    '시험 경험: 기능 시험 결과를 기록했습니다.'
  ].join('\n');
  const plan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveLineBoundaries: 'structural'
  });
  const restored = structure.restoreLockedStructureLayout({
    source,
    outputText: source,
    chunks: plan.chunks,
    normalizeVisualGaps: true
  });

  assert.match(restored.text, /^\[현 직장[^\n]+\]\n\n담당 역할:/u);
  assert.match(restored.text, /핵심 과제:[^\n]+\n\n\[이전 직장/u);
  assert.match(restored.text, /담당 역할:[^\n]+\n시험 경험:/u);
  assert.equal(restored.visualGapRepairCount >= 3, true);
  assert.equal(structure.compareInlineLabelBodyLayout(source, restored.text).pass, true);
});

test('코드·표·인용의 행 구조는 라벨 복원 대상이 아니다', () => {
  const source = [
    '```js',
    'const label = "입력: 값";',
    '```',
    '항목\t값',
    '입력\t35%',
    '「입력: 값은 그대로 둔다」'
  ].join('\n');
  const result = structure.restoreInlineLabelBodyLayout(source, source);

  assert.equal(result.applicableCount, 0);
  assert.equal(result.repairCount, 0);
  assert.equal(result.text, source);
});

test('라벨 레이아웃 복원·잔여 오류 수를 원문 없이 이력 메타에 보존한다', () => {
  const stored = compactHistoryEngineMeta({
    schemaVersion: 3,
    documentProfile: 'report_assignment',
    inlineLabelBodyRepairCount: 2,
    inlineLabelBodyApplicableCount: 5,
    inlineLabelBodySplitCount: 0,
    inlineLabelBodyLayoutPass: true
  });

  assert.equal(stored.inlineLabelBodyRepairCount, 2);
  assert.equal(stored.inlineLabelBodyApplicableCount, 5);
  assert.equal(stored.inlineLabelBodySplitCount, 0);
  assert.equal(stored.inlineLabelBodyLayoutPass, true);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'source'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'outputText'), false);
});
