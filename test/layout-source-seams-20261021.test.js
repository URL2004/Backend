'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const structure = require('../engine-gpt-prod/structureChunk');
const { restoreMissingOrdinalMarkers: restoreOrdinals } = require('../engine-gpt-prod/koreanOrdinal');
const { repairPhysicalProseLines, codeRunLineIndices } = require('../engine-gpt-prod/physicalProseLines');
const { repairForcedProseWraps, repairMissingSentenceSpacing } = require('../engine-gpt-prod/sourcePreflight');
const { repairMissingSentenceSpacingLine: spacing } = require('../engine-gpt-prod/sentenceSpacing');
const bare = value => String(value).replace(/\s/gu, '');
// Fixtures sit after an opening paragraph: a document's first line is a title.
const OPENING = '이 글은 수업 중에 진행한 조사와 관찰의 결과를 차례대로 정리한 기록이다.\n\n';
const repair = (source, output) => {
  const result = structure.repairIntroducedMidSentenceParagraphBreaks(OPENING + source, OPENING + output, { witnessSource: OPENING + source });
  return { ...result, text: result.text.slice(OPENING.length) };
};

test('a physical source wrap promoted to a blank line joins only at a dependent seam', () => {
  const intro = '도서관 이용 실태를 조사한 이번 보고서는 지난 두 학기 동안 우리 학교 학생들이 평소 열람실을 자주 찾는 이유와';
  const source = `${intro}\n대출 빈도의 변화를 함께 정리하여 운영 개선의 근거로 삼는다.`;
  const output = '도서관 이용 실태를 살핀 이번 보고서는 지난 두 학기 동안 우리 학교 학생들이 평소 열람실을 자주 찾는 이유와\n\n대출 빈도의 변화를 함께 정리하여 운영 개선의 근거로 삼는다.';
  const result = repair(source, output);
  assert.equal(result.repairCount, 1);
  assert.equal(result.text, output.replace('이유와\n\n대출', '이유와 대출'));
  assert.equal(bare(result.text), bare(output));
  // The author's own paragraph boundary is kept.
  assert.equal(repair(source.replace('이유와\n', '이유와\n\n'), output).repairCount, 0);
});

test('quoted names and closing quotes split by a promoted wrap rejoin', () => {
  const lead = '동아리 회원들은 지난 학기부터 지역 서점과 협력하여 매주 낭독회를 여는 채널 \'Morning';
  const source = `${lead}\nBook Club\'를 운영하고 있으며 참여 인원도 꾸준히 늘었다.`;
  const output = `${lead}\n\nBook Club\'를 운영하고 있으며 참여 인원도 꾸준히 늘었다.`;
  assert.equal(repair(source, output).text, `${lead} Book Club'를 운영하고 있으며 참여 인원도 꾸준히 늘었다.`);
  const closing = '어제 열린 강연에서 발표자가 거듭 강조한 핵심은 \'익숙한 장면을 가장 낯선 시선으로 다시 바라보는 일';
  const closingSource = `${closing}\n\'이라는 점이며 청중 대부분이 이 대목에 공감했다.`;
  const closingOutput = `${closing}\n\n\'이라는 점이며 청중 대부분이 이 대목에 공감했다.`;
  assert.equal(repair(closingSource, closingOutput).repairCount, 1);
  const item = '- 검사 전에 활력징후를 측정하고 기록하였다.\n- 보호자에게 “지금 진행하는 검사는 통증이 거의 없으니 대기실';
  const itemSource = `${item}\n바깥에서 편하게 기다리셔도 됩니다.”라고 안내하였다.`;
  const itemOutput = `${item}\n\n바깥에서 편하게 기다리셔도 됩니다.”라고 안내하였다.`;
  assert.equal(repair(itemSource, itemOutput).text, `${item} 바깥에서 편하게 기다리셔도 됩니다.”라고 안내하였다.`);
});

test('title, heading and label wraps are not promoted-wrap seams', () => {
  const cases = [
    ['골목 상권에서 지역 명소로, 동네 빵집의 지역 브랜딩 성장 전략 분석', '희소성 있는 대표 메뉴와 진정성 있는 이야기로 단골을 만든 과정을 살핀다.'],
    ['2-1. 온라인 커뮤니티 확산과 혐오 표현의 일상화 과정에서 형성된 인식의 변화', '김가나(2021)의 연구는 온라인 공간의 혐오 표현이 일상화되는 과정을 분석했다.'],
    ['n 지역 보건 인프라와 디지털 안내 체계 연계', '§ 포장 전면에 표준 안내 코드를 고정 배치하고 복약 정보를 제공한다.']
  ];
  for (const [left, right] of cases) {
    const output = `${left}\n\n${right}`;
    assert.equal(repair(`${left}\n${right}`, output).text, output, left);
  }
});

test('a lost ordinal series beside a surviving series regains only its prefixes', () => {
  const source = [
    '첫 번째로, 이 수업은 관찰 기록을 통해 생태 감수성을 기른다.',
    '두 번째로, 모둠 토의를 통해 서로의 관점을 비교한다.',
    '이 활동의 교육적 의미는 세 가지이다. 첫째, 학생들이 주변 하천의 수질 변화를 직접 관찰하며 과학적 탐구 능력을 기를 수 있다. 둘째, 관찰 결과를 그림과 글로 표현하면서 자기표현 능력을 높일 수 있다. 셋째, 지역 환경 문제를 생활 습관과 연결하여 실천 의지를 다질 수 있다.'
  ].join('\n\n');
  const output = [
    '첫 번째로, 이 수업은 관찰 기록을 통해 생태 감수성을 기른다.',
    '두 번째로, 모둠 토의를 통해 서로의 관점을 비교한다.',
    '이 활동에서 학생들은 주변 하천의 수질 변화를 직접 관찰하며 과학적 탐구 능력을 기를 수 있다. 또 관찰 결과를 그림과 글로 표현하면서 자기표현 능력을 높일 수 있다. 지역 환경 문제를 생활 습관과 연결하면 실천 의지를 다질 수 있다.'
  ].join('\n\n');
  const result = restoreOrdinals(source, output);
  assert.equal(result.repairCount, 3);
  assert.match(result.text, /첫째, 이 활동에서 학생들은 .*둘째, 관찰 결과를 .*셋째, 지역 환경 문제를/u);
  assert.doesNotMatch(result.text, /이 활동의 교육적 의미는 세 가지이다/u);
  // Two equally similar candidates make the item ambiguous.
  const ambiguous = output.replace('또 관찰 결과를 그림과 글로 표현하면서 자기표현 능력을 높일 수 있다.',
    '또 관찰 결과를 그림과 글로 표현하면서 자기표현 능력을 높일 수 있다. 관찰 결과를 그림과 글로 표현하면서 자기표현 능력을 높일 수 있다.');
  assert.equal(restoreOrdinals(source, ambiguous).repairCount, 0);
});

test('unfenced code rows keep their lines while Korean prose wraps still join', () => {
  const code = ['`timescale 1ns/1ps', 'module tb_unit;', 'reg [7:0] a, b;', 'wire [7:0] sum;', 'integer i, errors;',
    'initial begin', 'a = 8\'d1; b = 8\'d2;', '#10;', '$display("SUM %0d", sum);', '$display("ERR %0d", errors);', 'end', 'endmodule'];
  assert.deepEqual([...codeRunLineIndices(code)], code.map((line, index) => index));
  const prose = '이 실험은 두 입력을 더한 결과가 기대값과 같은지 확인하기 위해\n테스트벤치에서 여러 입력 조합을 반복해서 적용하였다.';
  const joined = repairForcedProseWraps(`${prose}\n\n${code.join('\n')}`).text;
  assert.ok(joined.includes(code.join('\n')));
  assert.ok(joined.includes('확인하기 위해 테스트벤치에서'));
  assert.equal(repairPhysicalProseLines(code.join('\n')).text, code.join('\n'));
  // Wrapped English prose ending with commas is not a code run.
  assert.equal(codeRunLineIndices(['The survey asked students about library use,', 'reading habits, and study time,', 'then compared the answers by grade.']).size, 0);
  assert.equal(codeRunLineIndices(['for example, the first group read daily,', 'end of the term results improved,']).size, 0);
});

test('dot-separated short nouns and direct quotes keep their literal spacing', () => {
  assert.equal(spacing('“생산.분배.소비기능”과 “사회화기능”을 비교한다.'), '“생산.분배.소비기능”과 “사회화기능”을 비교한다.');
  assert.equal(spacing('①.생산.분배.소비기능②사회화기능'), '①.생산.분배.소비기능②사회화기능');
  assert.equal(spacing('그는 “좋았다.그래서 갔다.”그리고 돌아왔다.'), '그는 “좋았다.그래서 갔다.” 그리고 돌아왔다.');
  assert.equal(spacing('했다.그래서 갔다.'), '했다. 그래서 갔다.');
  assert.equal(spacing('갔다.왔다.잤다.'), '갔다. 왔다. 잤다.');
  assert.equal(repairMissingSentenceSpacing('과제는 “생산.분배.소비”를 다룬다.그래서 정리했다.').text,
    '과제는 “생산.분배.소비”를 다룬다. 그래서 정리했다.');
});
