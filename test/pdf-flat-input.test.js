'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { repairExtractedPageLayout } = require('../engine-gpt-prod/extractedPageLayout');
const { auditAndSanitizeSource } = require('../engine-gpt-prod/sourcePreflight');
const { splitChunksForGpt } = require('../engine-gpt-prod/structureChunk');
// Synthetic logistics report, never a copy of a customer's medical document.
const prose = '작업자는 창고의 물품을 확인하였다. 점검 기록을 작성하고 담당 부서에 전달하였다. 출고 자료와 재고 자료의 대응 관계를 검토하였다. '.repeat(5);
const dense = value => value.replaceAll(' ', '   ');
const source = ['- 1 - 재고 관리 보고서 1. 점검 내용 ' + dense(prose),
 '- 2 - ' + dense(prose) + ' 자료의 내용을 확   설명을 기록하면 전달 내',
 '- 3 - 5. 다음 점검 ' + dense(prose) + ' 인한다. 용을 확인할 수 있다.', '- 4 -'].join('\n\n');
const compact = value => value.replace(/\s/gu, '');
test('numbered report without Roman headings reaches PDF normalization', () => {
 const result = auditAndSanitizeSource(source);
 assert.ok(result.changed);
 assert.ok(result.issueCodes.includes('source_pdf_spacing_repaired'));
 assert.ok(result.issueCodes.includes('source_pdf_reading_order_unverified'));
 assert.ok(result.issueCodes.includes('source_pdf_boundary_review'), 'new section does not hide a broken previous page');
 assert.ok(!result.issueCodes.includes('source_layout_repair_skipped'));
 assert.equal(compact(result.text), compact(source.replace(/^\s*-\s*\d+\s*-[ \t]*/gmu, '')));
 assert.doesNotMatch(result.text, / {2,}/u);
});
test('uncertain cell fragments are not invented, reordered or joined across new sections', () => {
 const result = repairExtractedPageLayout(source);
 assert.match(result.text, /자료의 내용을 확 설명을 기록하면 전달 내/u);
 assert.match(result.text, /인한다\. 용을 확인할 수 있다\./u);
 assert.ok(result.text.indexOf('5. 다음 점검') > result.text.indexOf('전달 내'));
});
test('real tab-separated cells remain separate throughout preflight and chunking', () => {
 const text = '점검 계획\n\n행동\t이유\n물품 번호를 확인한다.\t기록의 일치 여부를 파악한다.\n수량을 확인한다.\t차이를 파악한다.\n\n' + prose;
 const result = auditAndSanitizeSource(text);
 const plan = splitChunksForGpt(result.text, { coalesceEditable: true });
 assert.ok(result.text.includes('물품 번호를 확인한다.\t기록의 일치 여부를 파악한다.'));
 assert.ok(plan.chunks.some(c => c.locked && c.text.includes('\t')));
 assert.ok(plan.chunks.some(c => !c.locked && c.text.includes('작업자는')));
});
test('ordinary numbered lists, sparse pages and nonsequential page labels are not normalized', () => {
 for (const value of [source.replaceAll('   ', ' '), source.replace('- 3 -', '- 8 -'),
  '- 1 - 표기\n- 2 - 표기\n- 3 - 표기', '```text\n' + source + '\n```']) {
  assert.equal(repairExtractedPageLayout(value).text, value);
 }
});
test('quotations, URLs, table tabs and non-whitespace content remain literal', () => {
 const value = source.replace('자료의 내용을 확', '“표현   그대로” https://example.com/p?n=3\n계획\t근거\n검토\t비교\n자료의 내용을 확');
 const result = repairExtractedPageLayout(value);
 assert.ok(result.text.includes('“표현   그대로”'));
 assert.ok(result.text.includes('계획\t근거\n검토\t비교'));
 assert.ok(result.text.includes('https://example.com/p?n=3'));
 assert.equal(compact(result.text), compact(value.replace(/^\s*-\s*\d+\s*-[ \t]*/gmu, '')));
});
test('normalization is idempotent and fallback chunks receive normalized input', () => {
 const result = auditAndSanitizeSource(source);
 assert.equal(auditAndSanitizeSource(result.text).text, result.text);
 const plan = splitChunksForGpt(result.text, { coalesceEditable: true });
 assert.ok(!plan.chunks.some(c => / {3,}/u.test(c.text)));
 assert.ok(!plan.chunks.some(c => c.lockType === 'bullet_prefix' && /-\s*\d+\s*-/u.test(c.text)));
});
