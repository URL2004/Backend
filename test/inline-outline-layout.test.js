'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pre = require('../engine-gpt-prod/sourcePreflight');
const layout = require('../engine-gpt-prod/layoutStructure');
const bare = s => s.replace(/\s/gu, '');
// Synthetic fixtures; never store a customer's submitted document in Git.
const parent = 'Ⅳ. 지역 센터에서의 협력적 운영';
const child = '1. 관리자와 담당자의 협력';
const body = '관리자는 사업의 목표와 전체 운영을 담당하고, 담당자는 장비와 접근 가능한 자료 등에 관해 전문적으로 지원할 수 있다.';
const next = '2. 담당자에게 모든 책임을 맡기지 않기';
const nextBody = '관리자가 프로그램의 운영을 담당자만의 책임으로 생각하면 참여자는 활동에서 배제될 수 있다.';
const end = 'Ⅶ. 결론';
const conclusion = '지역 센터의 공동 운영은 주민이 함께 생활하고 활동할 기회를 제공한다는 점에서 의미가 있다.';
const input = `${parent} ${child} ${body}\n${next} ${nextBody}\n${end} ${conclusion}`;

test('nested headings and spaced nominal/infinitive headings survive the complete source pipeline', () => {
  const out = pre.auditAndSanitizeSource(input);
  assert.equal(out.text, `${parent}\n${child}\n${body}\n${next}\n${nextBody}\n${end}\n${conclusion}`);
  assert.equal(bare(out.text), bare(input));
  assert.equal(out.integrityText, input);
  assert.ok(!out.issueCodes.includes('source_layout_repair_skipped'));
  assert.equal(pre.auditAndSanitizeSource(out.text).text, out.text);
  for (const title of [parent, child, next, end]) {
    assert.ok(layout.buildLineRecords(out.text).some(r => r.text === title && ['heading','title'].includes(r.role)), title);
  }
});

test('known spaced Roman conclusion is not reverted by exact structural-line protection', () => {
  const source = `${end} ${conclusion}`;
  assert.equal(pre.repairSourceLayoutArtifacts(source).text, `${end}\n${conclusion}`);
});

test('prepared headings stay protected, bodies stay editable, and final layout repairs a flattened candidate', () => {
  const st = require('../engine-gpt-prod/structureChunk');
  const source = pre.auditAndSanitizeSource(input).text;
  const chunks = st.splitChunksForGpt(source).chunks;
  assert.equal(chunks.filter(c => c.locked).length, 4);
  assert.ok(chunks.filter(c => !c.locked).some(c => c.text.includes(body)));
  for (const mode of ['blog','formal']) {
    const options = {source, outputText:input, chunks, mode,
      documentProfile:{profile:'report_assignment',confidence:.96},normalizeVisualGaps:true};
    const out = st.restoreFinalDocumentLayout(options);
    assert.equal(out.structuralPass, true);
    assert.equal(bare(out.text), bare(input));
    for (const heading of [parent,child,next,end]) assert.ok(out.text.split('\n').includes(heading));
    assert.equal(st.restoreFinalDocumentLayout({...options,outputText:out.text}).text,out.text);
    const damaged = out.text.replace(next+'\n','');
    assert.equal(st.buildStructureAudit({source,outputText:damaged,chunks}).pass,false);
  }
});

test('numbered prose, questions, table cells, code and quotations are not invented headings', () => {
  for (const source of [
    '1. 지역 사업의 운영 담당자는 주민의 요구를 살피며 정해진 활동 계획에 따라 필요한 자료를 준비했다.',
    '2. 담당자의 협력 방안을 설명하고 그 근거를 구체적으로 제시하시오.',
    'Ⅳ. 지역의 운영 1.2에서는 여러 사업의 주요 목표를 소개하고 필요한 조건을 자세히 설명한다.',
    `| ${child} ${body} | 다른 셀 |`,
    `\x60\x60\x60\n${input}\n\x60\x60\x60`,
    `“${child} ${body}”`,
    `“\n${child} ${body}\n다음 행의 인용 내용이다.\n”`,
    '1. 참여자와 담당자의 협력은 활동의 성과를 높이는 데 필요한 조건이므로 충분히 논의해야 한다.',
    '2. 앞으로 책임을 맡기지 않기로 했다. 관리자는 다른 계획을 구체적으로 검토하고 필요한 사항을 설명했다.'
  ]) assert.equal(pre.repairInlineHeadingBoundaries(source).text, source, source);
});

test('separate existing headings, skipped chapter numbers and non-whitespace content remain intact', () => {
  const formatted = `${parent}\n\n${child}\n${body}\n\n${end}\n${conclusion}`;
  assert.equal(pre.auditAndSanitizeSource(formatted).text, formatted);
  assert.ok(!pre.auditAndSanitizeSource(input).text.includes('Ⅴ.'));
});
