'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const deliveryPolicy = require('../lib/humanizeDeliveryPolicy');
const structure = require('../engine-gpt-prod/structureChunk');
const layout = require('../engine-gpt-prod/layoutStructure');
const literalSpans = require('../engine-gpt-prod/literalSpans');
const legalAudit = require('../engine-gpt-prod/legalAudit');
const { detectDocumentProfile } = require('../engine-gpt-prod/documentProfile');
const { detectRegister } = require('../engine/contract');
const surfaceguard = require('../engine/surfaceguard');
const outputguard = require('../engine/outputguard');
const endingStyleAudit = require('../engine-gpt-prod/endingStyleAudit');
const dedupe = require('../engine/dedupe');
const transform = require('../routes/transform');

test('deliveryPolicy는 기술 실패·안전 경고·효과 제한을 서로 다른 상태로 결정한다', () => {
  const pipelineError = deliveryPolicy.applyDeliveryPolicy({ status: 'error' }, { mode: 'blog' });
  assert.equal(pipelineError.decision, 'block_technical');
  assert.deepEqual(pipelineError.reasonCodes, ['floor_report_error']);

  const safety = deliveryPolicy.applyDeliveryPolicy({
    status: 'blocked',
    criticals: [{ gate: 'semantic_omission' }],
    warnings: []
  }, { mode: 'formal' });
  assert.equal(safety.decision, 'deliver_review');
  assert.equal(safety.report.status, 'needs_review');

  const limited = deliveryPolicy.applyDeliveryPolicy({
    status: 'blocked',
    criticals: [{ gate: 'humanization_depth_no_effect' }],
    warnings: []
  }, { mode: 'blog' });
  assert.equal(limited.decision, 'deliver_clean');
  assert.equal(limited.report.status, 'clean');
  assert.deepEqual(limited.reasonCodes, []);
  assert.equal(limited.effectItems[0].gate, 'humanization_depth_no_effect');

  const polish = deliveryPolicy.applyDeliveryPolicy({
    status: 'blocked',
    criticals: [{ gate: 'polish_excessive_change' }],
    warnings: []
  }, { mode: 'polish' });
  assert.equal(polish.decision, 'block_technical');
});

test('근거와 사용자 메모는 라벨을 유지한 채 모두 허용 범위에 들어간다', () => {
  const combined = deliveryPolicy.buildAllowedExtra({
    evidence: '통계청 조사에서 2026년 수치를 확인했다.',
    userNotes: '제가 직접 참여한 활동은 3회입니다.'
  });
  assert.match(combined, /\[사용자 제공 근거\][\s\S]*2026년/u);
  assert.match(combined, /\[사용자 메모\][\s\S]*3회/u);
});

test('법률 문서는 조 번호·제목만 잠그고 같은 행의 조문 본문은 편집 대상으로 둔다', () => {
  const source = [
    '제1조(목적) 본 계약은 서비스 이용에 관한 권리와 의무를 정한다.',
    '제2조(해지) 이용자는 회사에 통지한 뒤 계약을 해지할 수 있다.',
    '제3조(의무) 회사는 약관에 따라 손해 배상 의무를 이행하여야 한다.'
  ].join('\n');
  const profile = detectDocumentProfile(source);
  assert.equal(profile.profile, 'legal_contract');

  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
  const prefixes = plan.chunks.filter(chunk => chunk.lockType === 'legal_clause_prefix');
  const editable = plan.chunks.filter(chunk => !chunk.locked && String(chunk.text || '').trim());
  assert.equal(prefixes.length, 3);
  assert.ok(editable.length >= 1);
  assert.equal(structure.mergeChunks(plan.chunks), source);
  assert.ok(editable.every(chunk => /^제\s*\d+\s*조/u.test(chunk.text) === false));
});

test('법률 가능성 표현과 조문 순서가 바뀌면 법률 무결성 경고가 생긴다', () => {
  const source = '제1조(해지) 이용자는 계약을 해지할 수 있다.\n제2조(의무) 회사는 통지하여야 한다.';
  const output = '제2조(의무) 회사는 통지하여야 한다.\n제1조(해지) 이용자는 계약을 해지한다.';
  const audit = legalAudit.auditLegalIntegrity(source, output, { profile: 'legal_contract' });
  assert.equal(audit.pass, false);
  assert.ok(audit.issueCodes.includes('legal_relation_shift'));
  assert.ok(audit.issueCodes.includes('legal_article_structure_changed'));
});

test('문서 전체 연산자 개수가 같아도 권리·의무가 다른 조문으로 이동하면 차단 후보가 된다', () => {
  const source = [
    '제1조(해지) 이용자는 통지 후 30일 안에 계약을 해지할 수 있다.',
    '제2조(의무) 회사는 매월 1회 이용 내역을 통지하여야 한다.'
  ].join('\n');
  const output = [
    '제1조(해지) 회사는 매월 1회 이용 내역을 통지하여야 한다.',
    '제2조(의무) 이용자는 통지 후 30일 안에 계약을 해지할 수 있다.'
  ].join('\n');
  const audit = legalAudit.auditLegalIntegrity(source, output, { profile: 'legal_contract' });
  assert.equal(audit.pass, false);
  assert.ok(audit.issueCodes.includes('legal_relation_shift'));
  assert.deepEqual(audit.changedClauses.map(item => item.article), ['제1조', '제2조']);
});

test('법과 규제를 설명하는 학술 글은 조문 형식 계약서로 오인하지 않는다', () => {
  const source = [
    'Ⅰ. 서론',
    '본 연구는 온라인 플랫폼 약관의 해지 조항과 소비자 권리 보호의 관계를 분석한다.',
    '전자상거래법 제17조는 소비자가 일정한 경우 청약을 철회할 수 있다고 정한다.',
    'Ⅱ. 이론적 배경',
    '선행 연구는 회사와 이용자 사이의 정보 비대칭이 계약 효력과 손해 배상 판단에 미치는 영향을 검토했다.',
    'Ⅲ. 연구 방법',
    '판례와 정책 보고서를 비교 분석해 규제 의무의 정당성을 살펴본다.',
    'Ⅳ. 결론',
    '분석 결과를 토대로 약관 규제의 한계와 향후 연구 과제를 제시한다.'
  ].join('\n');
  assert.notEqual(detectDocumentProfile(source).profile, 'legal_contract');
});

test('숫자 네 개가 있는 산문은 표가 아니고 일관된 탭 행은 표로 잠긴다', () => {
  const prose = '2026년 조사에는 학생 20명과 교사 35명이 참여했고 만족도는 90%였다.';
  assert.equal(layout.buildLineRecords(prose)[0].role, 'prose');

  const table = '항목\t학생\t교사\n참여자\t20명\t35명';
  const roles = layout.buildLineRecords(table).filter(row => !row.blank).map(row => row.role);
  assert.deepEqual(roles, ['table', 'table']);
  assert.equal(structure.splitChunksForGpt(table).chunks.every(chunk => chunk.locked), true);
});

test('절 경로는 새 제목을 이전 본문에 미리 적용하지 않는다', () => {
  const source = 'Ⅰ. 서론\n서론의 문제 제기와 연구 범위를 설명한다.\nⅡ. 본론\n본론에서 분석 기준과 결과를 설명한다.';
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
  const intro = plan.chunks.find(chunk => !chunk.locked && chunk.text.includes('문제 제기'));
  const body = plan.chunks.find(chunk => !chunk.locked && chunk.text.includes('분석 기준'));
  assert.match(intro.sectionPath, /Ⅰ\. 서론/u);
  assert.doesNotMatch(intro.sectionPath, /Ⅱ\. 본론/u);
  assert.match(body.sectionPath, /Ⅱ\. 본론/u);
  assert.equal(structure.buildStructureAudit({ source, outputText: source, chunks: plan.chunks, plan }).sectionPathErrorCount, 0);
});

test('코드와 확장 한국어 따옴표는 원문 그대로 왕복한다', () => {
  const source = '설정값은 `HUMANIZE_CHUNK_CONCURRENCY=2`이다.\n```js\nconst value = 2;\n```\n「나는 나를 파괴할 권리가 있다」';
  const frozen = literalSpans.freezeInlineCode(source);
  assert.equal(frozen.count, 1);
  assert.equal(literalSpans.restoreInlineCode(frozen.text, frozen).text, source);

  const plan = structure.splitChunksForGpt(source);
  assert.ok(plan.chunks.some(chunk => chunk.lockType === 'code'));
  assert.ok(plan.chunks.some(chunk => chunk.lockType === 'title'));
  assert.equal(structure.mergeChunks(plan.chunks), source);
});

test('명사 끝 요는 해요체가 아니며 종결 증거가 없으면 unknown이다', () => {
  const nounOnly = '주요 목적\n정책 수요\n필요 조건\n연구 개요';
  assert.equal(detectRegister(nounOnly), 'unknown');
  assert.equal(surfaceguard.measureRegisterMix(nounOnly).dominant, 'unknown');
  assert.equal(outputguard.detectRegister(nounOnly).dominant, 'other');
  assert.equal(endingStyleAudit.endingHistogram(['주요.', '수요.', '필요.', '개요.']).other, 4);
  assert.equal(detectRegister('이 결과는 중요해요. 다음 단계도 확인해요.'), 'haeyo');
});

test('삭제할 중복이 없으면 dedupe가 원래 줄바꿈과 조문을 그대로 보존한다', () => {
  const source = '제1조(목적) 이 계약의 목적을 정한다.\n\n첫 문장이다.\n둘째 문장이다.\n\n제2조(권리) 이용자는 해지할 수 있다.';
  const result = dedupe.dedupeSentences(source);
  assert.equal(result.removed, 0);
  assert.equal(result.text, source);
});

test('구조만 있는 문서는 작업 생성 전에 NO_EDITABLE_CONTENT 대상으로 판정한다', () => {
  const source = '항목\t값\t비고\n인원\t20명\t확정\n비율\t35%\t확정';
  const result = transform.assessEditableContent(source, { mode: 'formal' });
  assert.equal(result.editableChunkCount, 0);
});
