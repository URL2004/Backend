'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const extracted = require('../engine-gpt-prod/extractedPageLayout');
const structure = require('../engine-gpt-prod/structureChunk');
const layout = require('../engine-gpt-prod/layoutStructure');
const dedupe = require('../engine/dedupe');
const engine = require('../engine-gpt-prod');
const literals = require('../engine-gpt-prod/literalSpans');
const { preservationBlock } = require('../engine-gpt-prod/prompts/common/preservation');

// Synthetic document only: no submitted user text or identity in committed tests.
const BODY = '도서관의 자료 관리 절차를 검토하였다. 담당자는 시스템 점검 기록을 남겼다. 자료의 순서와 기관명은 그대로 유지해야 한다. '.repeat(3);
const PDF = [
  '-   1   -  자료 관리 분석 보고서  이름   테스트   학번   9999999999   학과   문헌정보학과',
  '',
  '-   2   -  I.   서론   ( 분석 목적 )  ' + BODY.replaceAll(' ', '   ') + '관리   시스',
  '',
  '-   3   -  템   점검이   필요하다 .   II.   본론   ( 사건 분석 )  1.   근본적 원인   ( 확인 절차 )  ' + BODY.replaceAll(' ', '   ')
    + '2.   개선방안   ' + BODY.replaceAll(' ', '   ') + '-   기록 보존 : 기록의 내용을 유지한다. -   교차 확인 : 서로 다른 절차를 확인한다.',
  '',
  '-   4   -  IV.   참고문헌  자료원. (2026.08.02). 기록 관리. https://example.com/ref?date=2026.08.02&v=2'
].join('\n');
const compact = value => String(value).replace(/\s/gu, '');

test('sequential PDF page markers are removed without changing content, dates or outline order', () => {
  const result = preflight.auditAndSanitizeSource(PDF);
  assert.equal(result.issueCodes.includes('source_pdf_page_marker_removed'), true);
  assert.equal(result.issueCodes.includes('source_layout_repair_skipped'), false);
  assert.equal(result.removedArtifactCount, 4);
  assert.equal(compact(result.text), compact(PDF.replace(/^\s*-\s*\d+\s*-[ \t]*/gmu, '')));
  assert.match(result.text, /관리 시스템 점검이 필요하다\./u);
  assert.match(result.text, /1\. 근본적 원인 \( 확인 절차 \)\n\n도서관/u);
  assert.match(result.text, /2\. 개선방안\n\n도서관/u);
  assert.match(result.text, /\n- 교차 확인/u);
  assert.ok(result.text.includes('https://example.com/ref?date=2026.08.02&v=2'));
  assert.equal(preflight.auditAndSanitizeSource(result.text).text, result.text);
});

test('cover identity and Roman numeral references are locked while report prose stays editable', () => {
  const result = preflight.auditAndSanitizeSource(PDF);
  const chunks = structure.splitChunksForGpt(result.text, { coalesceEditable: true }).chunks;
  assert.ok(chunks.some(c => c.locked && c.lockType === 'signature' && c.text.includes('9999999999')));
  assert.ok(chunks.some(c => c.locked && c.lockType === 'reference_item' && c.text.includes('https://example.com/ref')));
  assert.ok(chunks.some(c => !c.locked && c.text.includes('도서관의 자료 관리')));
  assert.ok(!chunks.some(c => c.lockType === 'bullet_prefix' && c.text.includes('- 2')));
  assert.equal(layout.isExactMetadataLine('이름을 부르기 전에 학번 9999999999를 확인했다.'), false);
});

test('ordinary lists, nonsequential page-like values, poetry and fenced samples are not normalized', () => {
  for (const text of [
    '- 1 - 첫 번째 항목\n- 2 - 두 번째 항목\n- 3 - 세 번째 항목',
    'I. 본론\n' + [1, 2, 3].map(n => '- ' + n + ' - ' + BODY).join('\n'),
    PDF.replace('-   3   -', '-   9   -'),
    '밤의 기록\n\n- 1 - 바람\n- 2 - 구름\n- 3 - 빛\n별이 흐른다',
    '```text\n' + PDF + '\n```'
  ]) assert.equal(extracted.repairExtractedPageLayout(text).text, text);
});

test('dense page spacing does not join legitimate neighboring words, quotes, URLs or table cells', () => {
  const inserted = PDF.replace('관리   시스', '사례라고  생각된다. 받고  자료를 확인했다. “표현   그대로” https://example.com/a\n항목\t값\n자료\t20\n관리   시스');
  const result = extracted.repairExtractedPageLayout(inserted);
  assert.match(result.text, /사례라고 생각된다/u);
  assert.match(result.text, /받고 자료를/u);
  assert.ok(result.text.includes('“표현   그대로”'));
  assert.ok(result.text.includes('항목\t값\n자료\t20'));
});

test('unwitnessed page-boundary fragments remain unchanged and produce a review notice', () => {
  const text = PDF.replace('관리   시스', '기록   미확').replace('-   3   -  템', '-   3   -  인어');
  const result = extracted.repairExtractedPageLayout(text);
  assert.ok(result.changes.some(c => c.code === 'source_pdf_boundary_review'));
  assert.ok(!result.text.includes('미확인어'));
});

test('page-boundary joining does not change table cells or quoted fragments', () => {
  for (const source of [
    PDF.replace('관리   시스', '\n항목\t관리 시스'),
    PDF.replace('관리   시스', '“관리 시스').replace('템   점검이   필요하다 .', '템   점검이   필요하다.”')
  ]) {
    const result = extracted.repairExtractedPageLayout(source);
    assert.ok(!result.changes.some(c => c.code === 'source_pdf_page_word_joined'));
    assert.equal(compact(result.text), compact(source.replace(/^\s*-\s*\d+\s*-[ \t]*/gmu, '')));
  }
});

const CLAIM = '자료 관리 체계 전반에 대한 점검 필요성을 확인하였다.';
const LEFT = '본 사례는 자료 관리 체계 전반을 점검해야 할 필요성을 보여 준다.';
const RIGHT = '이에 따라 자료 관리 체계 전반을 점검할 필요성이 제기되었다.';
test('short necessity restatements are removed only when both represent one source claim', () => {
  const result = dedupe.removeGeneratedLocalOverlapDuplicates(CLAIM, LEFT + ' ' + RIGHT);
  assert.equal(result.applied, true);
  assert.equal(result.removedCount, 1);
  assert.equal(result.text, LEFT);
});

test('legitimate repeated source claims, distinct scope, numbers and polarity are preserved', () => {
  const cases = [
    [LEFT + ' ' + RIGHT, LEFT + ' ' + RIGHT],
    [CLAIM, LEFT + ' ' + RIGHT.replace('자료 관리', '직원 배치')],
    [CLAIM, LEFT + ' ' + RIGHT.replace('점검할', '점검하지 않을')],
    [CLAIM, LEFT + ' ' + RIGHT.replace('전반을', '전반을 2회')]
  ];
  for (const [source, output] of cases) assert.equal(dedupe.removeGeneratedLocalOverlapDuplicates(source, output).text, output);
});

test('the final production dedupe gate accepts a safe report restatement removal', () => {
  const source = 'I. 결론\n\n' + CLAIM;
  const output = 'I. 결론\n\n' + LEFT + ' ' + RIGHT;
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true });
  const result = engine.applyFinalGeneratedDedupe({ source, outputText: output, chunks: plan.chunks, plan, mode: 'assignment', documentProfile: { profile: 'report_assignment' } });
  assert.equal(result.applied, true, JSON.stringify(result));
  assert.ok(result.text.includes('I. 결론'));
  assert.equal(result.text.includes(RIGHT), false);
});

test('unclear dose units and disposition subjects generate notices without inventing facts', () => {
  const source = '약물은 체중 기준 2mg을 투여했다고 적었다. 실형이 확정되었지만 벌금도 선고되었다.';
  const result = preflight.auditAndSanitizeSource(source);
  assert.equal(result.text, source);
  assert.ok(result.issueCodes.includes('source_weight_dose_unit_review'));
  assert.ok(result.issueCodes.includes('source_disposition_subject_review'));
  const clear = preflight.auditAndSanitizeSource('약물은 체중 기준 2mg/kg으로 기재돼 있다. 실형이 확정되었지만 다른 피고인에게는 벌금이 선고되었다.');
  assert.ok(!clear.issueCodes.includes('source_weight_dose_unit_review'));
  assert.ok(!clear.issueCodes.includes('source_disposition_subject_review'));
  const prompt = preservationBlock();
  assert.match(prompt, /불확실성을 확정 사실로 바꾸지 않는다/u);
});

test('URL parameters and inline code stay outside math tokenization and final math restoration', () => {
  const url = 'https://example.com/ref?v=2&n=30';
  const source = '참고 주소 ' + url + '와 www.example.com/doc?n=4를 확인한다. `count=7`은 코드다. 식 x = 2와 $y=3$은 보존한다.';
  const frozen = literals.freezeMath(source);
  assert.equal(frozen.count, 2);
  assert.ok(frozen.text.includes(url));
  assert.ok(frozen.text.includes('`count=7`'));
  assert.equal(literals.restoreMath(frozen.text, frozen).text, source);
  const audit = literals.restoreMathByOrder(source.replace('x = 2', 'x= 2'), frozen);
  assert.equal(audit.pass, true);
  assert.equal(audit.text, source);
  assert.equal(literals.freezeMath(preflight.auditAndSanitizeSource(PDF).text).count, 0);
});
