'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../engine-gpt-prod/sourcePreflight');
const f = require('../engine-gpt-prod/physicalProseLines');
const s = require('../engine-gpt-prod/structureChunk');
const prefix = '연구자는 여러 실험 조건을 차례대로 확인하고 충분한 관찰을 거쳐 ';
const bare = x => x.replace(/\s/gu, '');
test('source ending fragments with following prose are fixed before list ownership', () => {
  for (const ending of ['진행된','유도한','한']) {
    const source = `${prefix}${ending}\n다. 다음 단계에서는 관찰한 내용을 기록한다.`;
    const pre = p.auditAndSanitizeSource(source).text;
    assert.ok(pre.includes(ending+'다.'));
    assert.ok(!s.splitChunksForGpt(pre).chunks.some(c=>c.locked && /^다\./u.test(c.text)));
    const out = s.restoreFinalDocumentLayout({source:pre,fragmentSource:source,outputText:source.replace('\n','\n\n'),chunks:s.splitChunksForGpt(pre).chunks});
    assert.ok(out.text.includes(ending+'다.'));
    assert.equal(bare(out.text),bare(source));
  }
});
test('attested physical and intact source words remove introduced spaces and paragraph gaps', () => {
  for (const [a,b] of [['투여하','기'],['지','속되면'],['평','평한'],['최','대'],['경우','에도'],['질','서'],['자','본주의적'],['땅(구체','적'],['로마(헬레','니즘의']]) {
    const source = `${prefix}${a}\n${b} 내용을 기록한다.`;
    for (const gap of [' ', '\n\n']) {
      const output = source.replace('\n',gap), repaired = f.restoreSubmittedSourceSeams(source,output);
      assert.ok(repaired.text.includes(a+b),a+b);
      assert.equal(bare(repaired.text),bare(output));
      assert.equal(f.restoreSubmittedSourceSeams(source,repaired.text).text,repaired.text);
    }
  }
  assert.equal(f.restoreSubmittedSourceSeams('이 실험에서는 연결가능성을 확인했다.', '이 실험에서는 연결\n\n가능성을 확인했다.').text,'이 실험에서는 연결가능성을 확인했다.');
});
test('source-attested quote and agency name seams are repaired without deleting letters', () => {
  const source = `${prefix}“다른 이유가 아닐\n까” 하고 생각했다.\n\n${prefix}참고했다(교육부, 보건\n복지부). 보건복지부의 자료이다.`;
  const out = f.restoreSubmittedSourceSeams(source,source.replaceAll('\n',' '));
  assert.match(out.text,/아닐까/u);
  assert.match(out.text,/보건복지부/u);
  assert.equal(bare(out.text),bare(source));
});
test('ordinary word seams retain spacing and split URL parameters lose paragraph gaps', () => {
  const source = `${prefix}대립이\n발생했다.\n\nhttps://example.test/news?articleno=\n6506&mode=view`;
  const out = f.restoreSubmittedSourceSeams(source,source.replaceAll('\n','\n\n'));
  assert.match(out.text,/대립이\n발생했다/u);
  assert.ok(out.text.includes('articleno=6506'));
});
test('authored paragraphs, headings, list siblings, tables and code remain boundaries', () => {
  for (const source of [prefix+'한\n\n다. 다음 내용을 기록한다.',
    '연구 방법\n관련 자료를 검토한다.',
    '가. 첫 항목\n나. 다음 항목\n다. 마지막 항목',
    '구분\t설명\n최\t대', '```\n연결\n가능성\n```']) {
    assert.equal(f.restoreSubmittedSourceSeams(source,source).text,source);
  }
  const source = '연결가능성이라는 표기다.\n\n연결\n가능성을 검토한다.';
  assert.equal(f.restoreSubmittedSourceSeams(source,source).text,source);
});
test('superscript footnotes after sentence endings do not witness a broken word', () => {
  const source = '관찰한 결과를 기록한다.⁶다음 조사를 준비한다.';
  const output = source.replace('⁶다음','⁶\n\n다음');
  assert.equal(f.restoreSubmittedSourceSeams(source,output).text,output);
});
test('standalone nouns and modifiers at physical seams do not become compound words', () => {
  for (const [a,b] of [['뒤','변기를'],['큰','정사각형을'],['성','쌓기'],['새','주장을']]) {
    const source = `${prefix}${a}\n${b} 검토한다.`;
    const output = source.replace('\n',' ');
    assert.equal(f.restoreSubmittedSourceSeams(source,output).text,output);
  }
});
test('canonical source seams prevent the downstream duplicate-token repair from deleting a repeated root', () => {
  const source = `${prefix}평\n평한 모양을 기록한다.`;
  const candidate = source.replace('\n','');
  const refinement = require('../engine-gpt-prod/koreanRefinement');
  const repaired = refinement.applySafeDeterministicRepairs({
    source:p.auditAndSanitizeSource(source).text, outputText:candidate
  });
  assert.ok(repaired.text.includes('평평한'));
  assert.ok(!repaired.changeCodes.includes('introduced_token_duplication'));
});
