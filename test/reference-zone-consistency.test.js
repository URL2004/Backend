'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fb = require('../engine/freezeblocks');
const depth = require('../engine-gpt-prod/humanizationDepth');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const structure = require('../engine-gpt-prod/documentStructure');
const refinement = require('../engine-gpt-prod/koreanRefinement');
const { dependentQuoteLayout } = require('../engine-gpt-prod/dependentQuoteLayout');
const body = '지역의 측정 자료를 살펴보고 조사에 참여한 주민들의 의견을 정리하였다. 서로 다른 조건을 비교하면서 다음 조사에서 확인해야 할 사항을 자세히 기록하였다.';
const entry = '가상연구자. (2031). 지역 측정 자료의 분석. 가상연구학회, 12(3), 20-30.';
const middle = ['1. 연구 배경', body, '', '참고문헌', entry, '', '2. 후속 조사', body, '', body].join('\n');
for (const newline of ['\n', '\r\n', '\r']) {
 test(`reference ownership resumes body after bibliography with ${JSON.stringify(newline)}`, () => {
  const value = middle.replace(/\n/g, newline);
  assert.equal(depth.eligibleProseSentences(value).length, 6);
  assert.equal(depth.buildSentenceParagraphMap(value).eligibleParagraphCount, 3);
  const doc = structure.buildDocument(value);
  assert.equal(doc.blocks.filter(b => b.text === body && b.kind === 'paragraph' && !b.reference).length, 3);
  assert.ok(doc.blocks.some(b => b.text.includes(entry) && b.reference && b.kind === 'protected'));
 });
}
test('TOC reference heading cannot suppress depth, punctuation repair, or source notices in later prose', () => {
 const text = ['Ⅰ. 서론', 'Ⅱ. 본론', '참고문헌', '', 'Ⅰ. 서론', body, '', 'Ⅱ. 본론', body.slice(0,-1), '', '참고문헌', entry].join('\n');
 assert.equal(depth.eligibleProseSentences(text).length, 4);
 const result = preflight.auditAndSanitizeSource(text);
 assert.ok(result.text.includes(body));
 assert.ok(result.issueCodes.includes('source_terminal_punctuation_restored'));
 assert.ok(!result.issueCodes.includes('source_truncated_reference'));
 assert.ok(result.text.endsWith(entry));
});
test('bibliography flags retain blank-row coordinates and protect a real trailing bibliography', () => {
 const source = body + '\n\n## IV. 참고문헌 ##\n\n' + entry + '\n';
 const flags = fb.referenceLineFlags(source);
 assert.equal(flags.length, source.split('\n').length);
 assert.deepEqual(flags.slice(0,5), [false,false,true,true,true]);
 assert.equal(depth.eligibleProseSentences(source).length, 2);
 assert.equal(preflight.auditAndSanitizeSource('참고문헌\n가상연구자, 「가상 연구」, 가상학술지, 2031,').issueCodes.includes('source_truncated_reference'),true);
});
test('dependent quotes resume after a bibliography and heading without bibliography is ordinary prose', () => {
 const fragment = '처음의 질문은\n\n“자료의 기준은 무엇인가?”\n\n라는 물음이었다.';
 const fixed = '처음의 질문은 “자료의 기준은 무엇인가?”라는 물음이었다.';
 const prefix = middle + '\n\n3. 해석\n\n';
 assert.ok(dependentQuoteLayout(prefix + fragment).text.endsWith(fixed));
 assert.equal(dependentQuoteLayout('참고문헌\n' + fragment).text, '참고문헌\n' + fixed);
});
test('safe refinement guards release body spelling after references while retaining bibliography literals', () => {
 const prefix = ['1. 배경', body, '참고문헌', entry.replace('지역', '해낼수 있는 지역'), '2. 후속 조사'].join('\n');
 const text = prefix + '\n\n이번 조사에서는 해낼수 있는 조건을 구분하여 서로 다른 결과가 나타나는 이유를 검토하였다.';
 const result = refinement.applySafeFormattingRepairs({source:text,outputText:text,documentProfile:'report_assignment'});
 assert.ok(result.text.includes('해낼 수 있는 조건'));
 assert.ok(result.text.includes('해낼수 있는 지역'));
});
test('numeric chart after an intervening bibliography retains numeric series ownership', () => {
 const chart = '지역별 측정값\n0.30\n\n0.20\n\n0.10\n2020\t2021\t2022';
 const text = middle + '\n\n' + chart;
 const doc = structure.buildDocument(text);
 assert.equal(doc.blocks.find(b => b.layoutRole === 'numeric_series')?.text, chart);
});
