'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const helper = require('../engine-gpt-prod/sourceArtifactRelations');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const relation = require('../engine-gpt-prod/relationAudit');
const review = require('../engine-gpt-prod/semanticOperatorReview');

const source = '첫 자료에서는 지역별 관측 결과를 자세하게 설명하고 서로 다른 조건의 영향을 정리했다. Example Archive\n다음 비교에서는 자료의 차이를 새롭게 검토했다.\n두 번째 자료에서도 실제 관측값과 확인 과정을 제시하고 남은 제한점을 구체적으로 정리했다. Example Archive\n마지막 비교에서는 설명의 차이를 따로 기록했다.';
const changed = source.replace('Example Archive\n마지막', 'Example Archive의 마지막');

test('document-attested repeated nominal tails protect only original line seams without deleting or locking prose', () => {
  assert.equal(helper.trailingLabels(source).length, 1);
  assert.deepEqual([...helper.labelSeamLines(source)], [0, 2]);
  const result = preflight.repairForcedProseWraps(source);
  assert.equal(result.text, source);
  assert.equal(result.changes.length, 0);
  assert.equal(preflight.auditAndSanitizeSource(source).integrityText, source);
  const crlf = source.replace(/\n/gu, '\r\n');
  assert.equal(helper.trailingLabels(crlf).length, 1);
  assert.deepEqual([...helper.labelSeamLines(crlf)], [0, 2]);
});

test('new label possessive and subject bindings are contextual review candidates, not verdicts', () => {
  for (const suffix of ['의', '은', '이']) {
    const candidate = source.replace('Example Archive\n마지막', `Example Archive${suffix} 마지막`);
    const rows = helper.candidates(source, candidate);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].code, 'source_label_binding_candidate');
    assert.equal(rows[0].advisory, true);
    assert(source.includes(rows[0].sourceSpan) && candidate.includes(rows[0].outputSpan));
    const targets = review.targets(source, candidate).filter(t => t.codes.includes(rows[0].code));
    assert.equal(targets.length, 1);
    const absent = review.assess(targets, [], [], source, candidate);
    assert.equal(absent.pending.length, 1);
    assert.equal(absent.pending[0].origin, 'unconfirmed');
    assert.equal(absent.pending[0].repairable, false);
    assert.equal(review.assess(targets, targets.map(t => ({ ...t, status: 'preserved', detail: '가상 검토에서 해당 표식이 문맥상 본래 주체임을 확인했다.' })), [], source, candidate).pending.length, 0);
  }
});

test('full-document repeated evidence survives a section-local review via current paired hints', () => {
  const local = source.slice(source.indexOf('두 번째'));
  const output = local.replace('Example Archive\n마지막', 'Example Archive의 마지막');
  assert.equal(helper.candidates(local, output).length, 0);
  const signals = relation.auditRelationCandidates(local, output, { documentSource: source });
  const rows = signals.candidates.filter(c => c.code === 'source_label_binding_candidate');
  assert.equal(rows.length, 1);
  assert.equal(review.targets(local, output, rows.map(JSON.stringify)).filter(t => t.codes.includes('source_label_binding_candidate')).length, 1);
  assert.equal(review.targets(local, output + ' 수정', rows.map(c => JSON.stringify({ ...c, outputSpan: '이전 결과의 현재 없는 문장이다.' }))).filter(t => t.codes.includes('source_label_binding_candidate')).length, 0);
});

test('single labels, legitimate actors, lower-case continuations, quotations and code do not infer reference ownership', () => {
  for (const text of [source.replaceAll('Example Archive', 'example continuation'), source.replace('Example Archive', 'Other Archive'),
    source.replaceAll('Example Archive\n', 'Example Archive는 설명했다.\n'), `\`\`\`\n${source}\n\`\`\``, `“${source}”`]) {
    assert.equal(helper.trailingLabels(text).length, 0);
    assert.equal(helper.candidates(text, text.replaceAll('Archive', 'Archive의')).length, 0);
  }
  assert.equal(helper.candidates(source, source).length, 0);
  assert.equal(helper.candidates(source, source.replace('마지막 비교', '최종 비교')).length, 0);
});

test('anchored incremental parentheses nominate the current multi-line context without an automatic edit', () => {
  const original = '참고 설명의 보충 자료(해당 기관에서 확인한 여러 기록의 출처 목록\n추가 확인): 이 자료는 검토 과정을 거쳐 별도로 보관하고 있다.';
  const output = original.replace('목록\n', '목록)\n');
  assert.deepEqual(helper.unmatchedParentheses(original), []);
  assert.equal(helper.unmatchedParentheses(output).length, 1);
  const rows = helper.candidates(original, output);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 'introduced_delimiter_imbalance_candidate');
  assert.equal(rows[0].advisory, true);
  const targets = review.targets(original, output).filter(t => t.codes.includes(rows[0].code));
  assert.equal(targets.length, 1);
  assert.equal(review.assess(targets, [], [], original, output).pending[0].relation, 'other');
  assert.equal(helper.candidates(original, original).length, 0);
  assert.equal(helper.candidates(output, original).length, 0, 'repairing an original imbalance is not new damage');
});

test('existing defects are not multiplied by a separate new unmatched parenthesis', () => {
  const old = '원래부터 이 부분에는 짝이 없는 닫는 괄호가 있다) 이 문장은 수정하지 않는다.\n\n';
  const a = old + '다른 항목의 보충 설명(여러 기록의 출처 목록\n추가 확인): 검토한 자료의 세부 내용은 별도로 남겨 두었다.';
  const b = a.replace('목록\n', '목록)\n');
  assert.equal(helper.candidates(a, b).filter(c => c.code === 'introduced_delimiter_imbalance_candidate').length, 1);
});

test('code, quotes, formula lines, URLs, list ordinals and unanchored differences are not new delimiter evidence', () => {
  for (const text of ['1) 첫 번째 관찰을 기록했다.\n2) 두 번째 관찰을 기록했다.',
    '```\ncall(value));\n```', '“괄호 예시)는 직접 인용 안에 있다.”', 'f(x) = sin(x))',
    '참고 URL https://example.test/path) 뒤의 설명을 검토했다.']) assert.deepEqual(helper.unmatchedParentheses(text), []);
  assert.deepEqual(helper.candidates('처음 문장이다.', '전혀 다른 문장과 설명)이다.'), []);
});

test('artifact policy module is part of the semantic receipt fingerprint', () => {
  const fs = require('node:fs');
  assert.match(fs.readFileSync(require.resolve('../engine-gpt-prod/semanticSegmentReceipts'), 'utf8'), /'sourceArtifactRelations\.js'/u);
});
