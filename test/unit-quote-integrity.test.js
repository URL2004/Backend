'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { syntaxSpans } = require('../engine/textSyntax');
const { splitSentenceSpans } = require('../engine/koreanText');
const { analyzeKoreanRefinement, removeIntroducedGroundedDuplicateSentences } = require('../engine-gpt-prod/koreanRefinement');
const { auditFragmentIntegrity } = require('../engine-gpt-prod/fragmentIntegrity');
const quotes = text => syntaxSpans(text).filter(s => s.spanType === 'quote').map(s => text.slice(s.start, s.end));

for (const notation of ["위도 36°24'", '각도 36°24\'15"', "폭 6'", '높이 72"', '크기 6\' 2"', '크기 6\'2"', "f'(x)", "g''(t)"]) {
  test('unit/derivative mark does not swallow following quotes: ' + notation, () => {
    const text = notation + "이다. 조건을 기록했다. '관찰 기준'을 비교했다. '실험 범위'를 명시했다.";
    assert.deepEqual(quotes(text), ["'관찰 기준'", "'실험 범위'"]);
    const s = splitSentenceSpans(text);
    assert(s.some(x => x.text === '조건을 기록했다.'));
    for (const span of s) assert.equal(text.slice(span.start, span.end), span.text);
  });
}
test('numeric and single-symbol quotations remain quotes, including adjacent argument', () => {
  for (const q of ["'2026'", "'36°24'", '"72"', "'f'", "'A. B.'", '“측정값 12”', '‘검증’을']) {
    const text = `기록 ${q}(설명)을 보존한다.`;
    assert.equal(quotes(text).length, 1, q);
  }
  assert.deepEqual(quotes("'위도 36°24\'15\"를 기록한다.' 다음은 '결과'다."), ["'위도 36°24\'15\"를 기록한다.'", "'결과'"]);
  assert.deepEqual(quotes("'36°24\'15\"를 기록한다.' 다음은 '결과'다."), ["'36°24\'15\"를 기록한다.'", "'결과'"]);
});
test('inline/fenced code and Latin contractions do not shift the next quote', () => {
  const text = "don't change `f'(x)`\n```js\nconst x = 6'\n```\n'실제 인용'을 보존한다.";
  assert.deepEqual(quotes(text), ["'실제 인용'"]);
  assert.equal(syntaxSpans(text).filter(s => s.spanType === 'code').length, 2);
});
test('all shared offsets stay in the original CRLF source, no notation rewriting', () => {
  const text = "위도 36°24'\r\n설명을 남긴다.\r\n'인용 A. B.'를 유지한다.";
  assert.deepEqual(quotes(text), ["'인용 A. B.'"]);
  assert.equal(syntaxSpans(text).find(x => x.spanType === 'quote').start, text.indexOf("'인용"));
});

test('PDF-like prose after an angular minute mark is reflowed without changing tables or quotes', () => {
  const { auditAndSanitizeSource } = require('../engine-gpt-prod/sourcePreflight');
  const paragraphs = Array.from({length:5},(_,i)=>[
    `관찰 ${i+1}에서는 참가자들이 작업 방법을 충분히 이해했는지 자세히 검토했습니`,
    '다. 관찰 기준과 적용 범위를 별도의 항목으로 구분하여 기록했습니다.',
    '검토자는 주어진 조건을 확인하면서 작업 과정의 변화를 기록하고 이',
    '러한 기록을 활용해 다음 과정에 필요한 자료를 충분히 준비했습니다.'
  ].join('\n')).join('\n\n');
  const table = "항목\t위치\n기준점\t36°24'";
  const tail = '이러한 선택은 단일한 답을 정하기보다 제약 조건을 인정하고 절차로 보완하는\n\n방식처럼 보였다.';
  const source = table+'\n\n[본문]\n'+paragraphs+'\n\n'+tail+"\n\n'관찰 기준'을 유지했다.";
  const fixed = auditAndSanitizeSource(source).text;
  assert(fixed.includes(table));
  assert(fixed.includes('절차로 보완하는 방식처럼 보였다.'));
  assert(fixed.includes("'관찰 기준'"));
  assert.equal(fixed.replace(/\s/g,''),source.replace(/\s/g,''));
  assert.equal(auditAndSanitizeSource(fixed).text,fixed);
  const appendix = '\n\n참고문헌\n\n' + paragraphs;
  assert.equal(require('../engine-gpt-prod/physicalProseLines').repairPhysicalProseLines(source + appendix).text.split('참고문헌')[1], appendix.split('참고문헌')[1]);
});

test('detector eligibility no longer excludes prose between a unit mark and a real quotation', () => {
  const { buildDetectInputDocument } = require('../lib/detectInputDocument');
  const text = "기준점은 36°24'에 있다. 실제 관측 결과를 비교했다. 원문은 'A. B.'를 인용했다.";
  const doc = buildDetectInputDocument(text);
  assert(doc.sentences.some(s=>s.eligibleForDetection && s.text.includes('실제 관측 결과')));
  for(const s of doc.sentences) assert.equal(text.slice(s.start,s.end),s.text);
  assert.equal(doc.protectedSpans.filter(s=>s.spanType==='quote').some(s=>text.slice(s.start,s.end).includes('실제 관측 결과')),false);
});

test('qualified PDF rows join past-tense endings but keep actual 가나다 items', () => {
  const { repairPhysicalProseLines } = require('../engine-gpt-prod/physicalProseLines');
  const body = Array.from({length:5},()=> '조사자는 주어진 조건과 결과를 자세히 비교하면서 전체 기록을 다시 검토했\n다. 이를 바탕으로 다음 단계에서 사용할 자료를 충분히 정리했습니\n다. 확인된 자료는 검토 과정에서 빠진 내용이 없는지 다시 확인했다.\n검토자는 주어진 조건을 확인하면서 작업 과정의 변화를 기록하고 이\n러한 기록을 활용해 다음 과정에 필요한 자료를 충분히 준비했습니다.').join('\n\n');
  const source = body + '\n\n가. 조사 항목\n나. 결과 항목\n다. 평가 항목';
  const result = repairPhysicalProseLines(source).text;
  assert(result.includes('검토했다. 이를'));
  assert(result.includes('정리했습니다.'));
  assert(result.endsWith('가. 조사 항목\n나. 결과 항목\n다. 평가 항목'));
  assert.equal(result.replace(/\s/g,''),source.replace(/\s/g,''));
});

test('dependent tab cells in complete prose are not frozen as a table', () => {
  const { proseTabLineIndices } = require('../engine-gpt-prod/proseTabLayout');
  const { buildLineRecords } = require('../engine-gpt-prod/layoutStructure');
  const prose = [
    '다만 조사 결과를 같은 기준으로 비교하기에는 자료의 한계도 분명했다.',
    '연구자는\t자료만\t주어진\t기준이라는\t조건을',
    '확인했을 뿐 결과를 전체 집단으로 확대하기에는 근거가 부족했다.',
    '따라서 이번 비교에서는 조건과 절차를 확인하는 수준에 머물렀다고',
    '판단한다. 그럼에도 이 방법이 가진 의미를 함께 살펴볼 필요가 있다.',
    '참여자들이 제시한 의견을 비교하며 적용할 수 있는 범위를 기록했다.'
  ].join('\n');
  assert.deepEqual([...proseTabLineIndices(prose)],[1]);
  assert.notEqual(buildLineRecords(prose)[1].role,'table');
  const pdf = Array.from({length:5},()=>[
    '검토자는 주어진 조건을 확인하면서 작업 과정의 변화를 기록하고 이',
    '러한 기록을 활용해 다음 과정에 필요한 자료를 충분히 준비했습니',
    '다. 관찰 기준과 적용 범위를 별도의 항목으로 구분하여 기록했습니다.'
  ].join('\n')).join('\n\n');
  const withReferences = pdf + '\n\n참고문헌\n\n' + prose;
  assert.equal(require('../engine-gpt-prod/physicalProseLines').repairPhysicalProseLines(withReferences).text.split('참고문헌')[1], '\n\n' + prose);
  for(const table of [prose.replace('연구자는\t자료만','구분\t자료만'),prose.replace('연구자는\t자료만','연구자는\t\t자료만'),'항목\t값\n관측\t12']) {
    assert.equal(proseTabLineIndices(table).size,0);
  }
});

const original = '외측 환기통로는 과열을 방지하는 역할을 하며, 내측 마감층은 열용량을 늘리려는 목적이라고 설명된다.';

test('decimal fact ownership is whitespace invariant but still detects value and sign changes', () => {
  const { measureNovelty, measureLostFacts, extractFacts } = require('../engine/floor');
  const source = '항목 A는 62.17 을, B는 34.28 을 기록했다. 변화량은 -0.64 였다.';
  const output = '항목 A는 62.17을, B는 34.28을 기록했다. 변화량은 -0.64였다.';
  assert.equal(measureNovelty(source,output).count,0);
  assert.equal(measureLostFacts(source,output).count,0);
  assert(measureNovelty(source,output.replace('62.17','62.71')).count>0);
  assert(measureNovelty(source,output.replace('-0.64','0.64')).count>0);
  assert.deepEqual(extractFacts('관측값은 23.5 % 였다.',true), extractFacts('관측값은 23.5%였다.',true));
});
const rewrite = '외측 환기통로는 과열을 막고, 내측 마감층은 열용량을 늘리기 위한 것이라고 설명한다.';
const issue = (source, outputText) => analyzeKoreanRefinement({ source, outputText, documentProfile: 'long_explainer', mode: 'assignment' }).issues.find(i => i.code === 'adjacent_semantic_repetition');
test('source replay beside a rewrite is flagged without speculative deletion', () => {
  const output = rewrite + ' ' + original;
  const audit = issue(original, output);
  assert.equal(audit?.introducedCount, 1);
  assert.deepEqual(audit.details.safeRemovalOrdinals, []);
  assert.equal(removeIntroducedGroundedDuplicateSentences({source:original,outputText:output}).text, output);
  assert.equal(issue(original, rewrite), undefined);
  assert.equal(issue(output, output), undefined);
});
test('different facts and existing adjacent source claims do not use the replay warning', () => {
  for (const left of [rewrite.replace('과열을 막고', '과열을 막지 않고'), rewrite.replace('열용량을', '열용량 35를')]) {
    assert.equal(issue(original, left + ' ' + original)?.details?.pairs?.some(x => x.kind === 'source_restatement_candidate') || false, false);
  }
  const preceding = rewrite.replace('막고', '줄이고');
  assert.equal(issue(preceding + ' ' + original, rewrite + ' ' + original)?.details?.pairs?.some(x=>x.kind==='source_restatement_candidate') || false, false);
  assert.equal(issue(original, '“' + rewrite + '” ' + original)?.details?.pairs?.some(x=>x.kind==='source_restatement_candidate') || false, false);
});
test('rewriting only the owner of a retained page-split dependent tail is reviewed', () => {
  const source = '이러한 선택은 제약 조건을 인정하고 절차로 보완하는\n\n방식처럼 보였다.';
  const output = '제약 조건을 인정하고 절차로 보완하려는 선택은\n\n방식처럼 보였다.';
  assert.deepEqual(auditFragmentIntegrity(source,output).codes,['introduced_dependent_tail_owner_shift']);
  assert.equal(auditFragmentIntegrity(source,source).pass,true);
  assert.equal(auditFragmentIntegrity(source,'제약 조건을 인정하고 절차로 보완하는 방식처럼 보였다.').pass,true);
  assert.equal(auditFragmentIntegrity('선택은\n\n방식처럼 보였다.',output).pass,true);
  assert.equal(auditFragmentIntegrity('“'+source+'”','“'+output+'”').pass,true);
});
