'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../engine-gpt-prod/layoutStructure');
const structure = require('../engine-gpt-prod/structureChunk');
const delivered = require('../engine-gpt-prod/deliveredLayoutAudit');
const { buildHumanizeContract } = require('../engine-gpt-prod/humanizeContract');
const bare = text => text.replace(/\s/gu, '');

const cited = '조사 기관은 지역별 자료를 수집하고 있으며 관련 통계를 제공하고 있다.';
const body = '연구팀은 지역마다 다른 관찰 조건을 비교하고 자료를 검토하였다. 담당자는 기록에 나타난 차이를 확인하면서 다음 조사에서 필요한 절차와 지원 방안을 자세하게 정리하였다.';

for (const suffix of ['¹', '⁶', '⁷', '¹²', '[1]', '[1, 3]', '[^2]', '¹[2]', '\u00a0⁶', '\u2009[2]']) {
  test(`numeric citation tails do not turn complete prose into headings: ${suffix}`, () => {
    const line = cited + suffix;
    assert.equal(layout.isSentenceComplete(line), true);
    for (const gap of ['\n', '\n\n', '\n\n\n']) {
      for (const prefix of ['', '1. 조사 개요' + gap, body + gap]) {
        const text = prefix + line + gap + body;
        const record = layout.buildLineRecords(text).find(r => r.text === line);
        assert.equal(record.role, 'prose', JSON.stringify({ suffix, gap, prefix }));
      }
    }
  });
}

test('citation-aware sentence endings preserve real numbered headings and lists', () => {
  const text = '1. 조사 개요¹\n' + cited + '¹\n\n'
    + '- ' + body + '²\n\n2. 후속 계획[2]\n' + body;
  const records = layout.buildLineRecords(text).filter(r => !r.blank);
  assert.equal(records[0].role, 'heading');
  assert.equal(records[1].role, 'prose');
  assert.equal(records[2].role, 'list');
  assert.equal(records[3].role, 'heading');
  assert.equal(layout.isSentenceComplete('지역별 조사 계획¹'), false);
  assert.equal(layout.isSentenceComplete('통계에는 48%와 400만 단위가 있다¹'), false);
});

function reportOptions() {
  const source = 'Ⅰ. 조사 보고서\n1. 자료 현황\n' + cited + '⁷\n' + body
    + '\n2. 조사 인력\n' + body + '\n'
    + '조사 기관은 지역별 자료의 검토와 함께 관찰 조건을 이해하고 장비와 절차를 안전하게 관리할 수 있는 전문 인력을 양성하는 교육 사업을 추진하고 있다.⁶\n' + body
    + '\n3. 후속 계획\n' + body + '\n\n각주\n주 6) 조사 기관, 인력양성 자료, 2025.\n주 7) 조사 기관, 통계 자료, 2025.';
  const outputText = source.replace('조사 기관은 지역별 자료의 검토와 함께 관찰 조건을 이해하고 장비와 절차를 안전하게 관리할 수 있는 전문 인력을 양성하는 교육 사업을 추진하고 있다.⁶',
    '지역별 자료의 검토와 함께, 조사 기관도 관찰 조건을 이해하고 장비와 절차를 안전하게 관리할 수 있는 전문 인력을 양성하는 교육 사업을 추진하고 있다.⁶')
    .replace(cited, '지역별 자료를 수집하는 조사 기관은 관련 통계도 제공하고 있다.');
  const documentProfile = { profile: 'report_assignment' };
  const humanizeContract = buildHumanizeContract({ mode: 'formal', documentProfile });
  const plan = structure.splitChunksForGpt(source, { coalesceEditable: true, humanizeContract });
  return { source, outputText, chunks: plan.chunks, plan, documentProfile, humanizeContract,
    mode: 'formal', normalizeVisualGaps: true };
}

test('cited report reflow is accepted after candidate selection and remains stable', async () => {
  const options = reportOptions();
  const layoutRepair = {};
  const result = await delivered.settleDeliveredLayout({ ...options, layoutRepair });
  assert.equal(result.accepted, true, JSON.stringify(layoutRepair));
  assert.equal(result.applied, true);
  assert.equal(bare(result.text), bare(options.outputText));
  assert.match(result.text, /있다\.⁶\n\n/);
  const audit = structure.buildStructureAudit({ ...options, outputText: result.text });
  assert.equal(audit.pass, true, JSON.stringify(audit));
  assert.equal(audit.sourceLineAnchorAdditionCount, 0);
  assert.equal(audit.structuralRoleAdditionCount, 0);
  delivered.refreshDeliveredLayoutAudit({ ...options, outputText: result.text, layoutRepair });
  assert.equal(layoutRepair.finalDelivered.readabilityPass, true);
  assert.equal((await delivered.settleDeliveredLayout({ ...options, outputText: result.text })).text, result.text);
  assert.equal((result.text.match(/⁶/gu) || []).length, 1);
  assert.equal((result.text.match(/⁷/gu) || []).length, 1);
});

test('real missing or added report headings still fail the structure guard', () => {
  const options = reportOptions();
  for (const outputText of [options.outputText.replace('2. 조사 인력\n', ''),
    options.outputText + '\n\n4. 새로운 결론\n' + body]) {
    assert.equal(structure.buildStructureAudit({ ...options, outputText }).pass, false);
  }
});

test('long cited numbered sentences stay editable lists across visual gaps', () => {
  const lines = ['1. ' + cited + '¹', '2. ' + body + '²', '3. 다음 조사 계획'];
  const source = lines.join('\n');
  const chunks = structure.splitChunksForGpt(source).chunks;
  for (const gap of ['\n', '\n\n', '\n\n\n']) {
    const outputText = lines.join(gap);
    assert.deepEqual(layout.buildLineRecords(outputText).filter(r => !r.blank).map(r => r.role),
      ['list', 'list', 'heading']);
    const audit = structure.buildStructureAudit({ source, outputText, chunks });
    assert.equal(audit.pass, true, JSON.stringify(audit));
    assert.equal(audit.sourceLineAnchorAdditionCount, 0);
  }
});

test('numeric units and exponents are not sentence endings', () => {
  for (const text of ['면적은 30m²', '가속도는 9.8m/s²',
    '연구팀은 관찰 구역의 면적을 계산하기 위해 측정한 반지름을 다음 식에 대입하였다: r²']) {
    assert.equal(layout.isSentenceComplete(text), false);
  }
});

test('an internal citation before wrapped prose cannot invent a title', () => {
  for (const marker of ['⁶', '[2]', '[^2]']) {
    const text = '측정 조건을 일정하게 유지하였다.' + marker + ' 보편\n\n적인 현상은 같은 조건에서 관찰된다.';
    assert.ok(layout.buildLineRecords(text).filter(r => !r.blank).every(r => r.role === 'prose'));
  }
});

test('cited nominal headings, abbreviations, labels and tables keep their roles', () => {
  for (const title of ['자료 현황¹', 'U.S.[1] 정책의 의의']) {
    const record = layout.buildLineRecords(title + '\n\n' + body)[0];
    assert.ok(['heading', 'title'].includes(record.role), title);
  }
  assert.equal(layout.buildLineRecords('결과: ' + cited + '¹ 추가 자료를 검토하였다.')[0].role, 'label_inline');
  assert.equal(layout.buildLineRecords('| 항목 | 내용 |\n|---|---|\n| 관찰 | ' + cited + '[1] |')[2].role, 'table');
});

test('malformed superscript runs do not stall classification', () => {
  const { execFileSync } = require('node:child_process');
  const modulePath = require.resolve('../engine-gpt-prod/layoutStructure');
  execFileSync(process.execPath, ['-e', `
    const layout = require(${JSON.stringify(modulePath)});
    for (const tail of ['²'.repeat(5000) + '가', '¹ '.repeat(5000) + 'x', '¹'.repeat(5000),
      '[1]'.repeat(5000) + 'x', '[' + '1,'.repeat(5000) + ']']) {
      const text = '관찰 자료를 검토하였다.' + tail;
      layout.isSentenceComplete(text);
      layout.buildLineRecords(text + '\\n다음 조사에서는 여러 조건의 차이를 검토한다.');
    }
  `], { timeout: 10000, stdio: 'pipe' });
});
