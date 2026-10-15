'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const physical = require('../engine-gpt-prod/physicalProseLines');
const seam = require('../engine-gpt-prod/koreanEndingSeam');
const labels = require('../engine-gpt-prod/inlineLabelParagraphs');
const ordinal = require('../engine-gpt-prod/koreanOrdinal');
const preflight = require('../engine-gpt-prod/sourcePreflight').auditAndSanitizeSource;
const bare = text => String(text).replace(/\s/gu, '');

// Wrap synthetic prose at word spaces, as a PDF extractor does.
function wrap(text, width = 46) {
  const rows = []; let row = '';
  for (const word of text.split(' ')) {
    if (row && (row + ' ' + word).length > width) { rows.push(row); row = word; } else row = row ? row + ' ' + word : word;
  }
  return [...rows, row];
}
const paragraph = [
  '도시 공원은 주민이 일상에서 쉽게 쉴 수 있는 공간으로 오랫동안 이용되어 왔다. 최근에는 공원의 역할이 휴식을 넘어 지역 공동체의 만남을 돕는 방향으로 넓어지고 있다.',
  '조사 대상 공원은 주거 지역과 학교 사이에 있어 하루 내내 다양한 연령층이 찾는다. 오전에는 산책하는 노인이 많고 오후에는 하교한 학생들이 운동 시설을 이용한다.',
  '관리 기관은 이용 시간대별 수요를 파악하기 위해 두 달 동안 방문객 수를 기록하였다. 그 결과 저녁 시간대의 이용이 가장 많았으나 조명 시설은 부족한 것으로 나타났다.',
  '주민 설문에서는 안전한 보행로와 그늘 쉼터를 늘려 달라는 의견이 가장 많았다. 또한 행사 공간을 정기적으로 개방하면 이웃 간 교류가 늘어날 것이라는 응답도 적지 않았다.',
  '이러한 결과는 공원 계획이 시설의 수보다 실제 이용 흐름을 반영해야 함을 보여 준다. 앞으로는 시간대별 이용 자료를 바탕으로 조명과 쉼터를 단계적으로 보완할 필요가 있다.'
];

test('a ㅆ-final stem split before 다 is one predicate, not a 가나다 item', () => {
  for (const stem of ['배웠', '갔', '졌', '했', '있었', '하겠']) {
    assert.equal(physical.wordSeam('어울리는 법을 ' + stem, '다. 이처럼 변화는 시작되었다.', new Set()), true, stem);
  }
  assert.equal(seam.hasSsangSiotFinal('배웠'), true);
  for (const noun of ['가방', '학교', '권한', '공간']) assert.equal(seam.hasSsangSiotFinal(noun), false, noun);
  assert.equal(seam.isEndingSeam('함께 웃고 떠드는 과정에서 사람들과 어울리는 법을 배웠', '다. 이처럼 시작되었다.'), true);
  assert.equal(seam.isEndingSeam('함께 웃고 떠드는 과정에서 사람들과 나눈 이야기와 공간', '다. 이처럼 시작되었다.'), false);
});

test('a dense PDF census wrapped at word spaces rejoins blank and single row seams', () => {
  const rows = [...paragraph, ...paragraph].flatMap(p => wrap(p, 36));
  const single = ['2-1. 공원 이용 실태와 주민 인식 조사 결과', ...rows.slice(0, 10), '', ...rows.slice(10)].join('\n');
  const r = physical.repairPhysicalProseLines(single);
  assert.equal(r.changed, true);
  assert.equal(bare(r.text), bare(single));
  assert.match(r.text, /^2-1\. 공원 이용 실태와 주민 인식 조사 결과\n/u);
  assert.ok(r.text.split('\n').filter(Boolean).length < rows.length / 2);
  // Double-spaced rows (every physical row followed by a blank row).
  const spaced = rows.join('\n\n');
  const d = physical.repairPhysicalProseLines(spaced);
  assert.equal(d.changed, true);
  assert.equal(bare(d.text), bare(spaced));
});

test('dense reflow leaves nominal item lists, headings, tables and bullets alone', () => {
  const items = Array.from({ length: 24 }, (_, i) =>
    `지역 주민 참여형 공원 관리 프로그램 ${i + 1}단계 운영 및 홍보 체계 구축`);
  for (const text of [items.join('\n'), items.join('\n\n')]) {
    assert.equal(physical.repairPhysicalProseLines(text).changed, false);
  }
  const rows = paragraph.flatMap(p => wrap(p));
  const mixed = [...rows.slice(0, 12), '• 조명 시설 — 저녁 이용이 많은 구간부터 보완한다', '구분\t오전\t오후',
    '5-3. 시간대별 이용 흐름과 쉼터 배치 방향 검토', ...rows.slice(12)].join('\n');
  const m = physical.repairPhysicalProseLines(mixed).text;
  assert.match(m, /\n• 조명 시설 — 저녁 이용이 많은 구간부터 보완한다\n구분\t오전\t오후\n5-3\. 시간대별 이용 흐름과 쉼터 배치 방향 검토\n/u);
});

test('numbered colon-label rows join their wrapped body through a complete row', () => {
  const s = [
    '1. 조사 목적: 근대 초기부터 현대에 이르기까지 지역 신문의 표기 방식은 한국어의 역사적',
    '변화와 기록 전통을 보여 주는 자료이다. 이번 조사는 시립 도서관의 『지역신보(地域新報)』',
    '실물을 열람하고, 당시 표기법의 특징을 살펴보는 것을 목적으로 한다.',
    '2. 조사 일시 및 장소: 2026년 3월 2일, 시립 도서관 지하 열람실과 기록 보관실을 직접',
    '방문하여 조사를 진행하였다.'
  ].join('\n');
  const r = labels.repairInlineLabelContinuations(s);
  assert.equal(r.text.split('\n').length, 2);
  assert.equal(r.contentPreserved, true);
  assert.match(r.text, /역사적 변화와/u);
  assert.match(r.text, /\n2\. 조사 일시/u);
  assert.equal(labels.repairInlineLabelContinuations(r.text).applied, false);
  assert.equal(preflight(s).text.includes('역사적\n'), false);
  const [head, ...body] = s.split('\n').slice(0, 3);
  for (const bad of [
    head + '\n\n' + body.join('\n'),                      // authored paragraph gap
    head + '\n가. 다음 항목\n' + body.slice(1).join('\n'), // next item is a barrier
    '1. 조사 목적: 오래된 지역 신문의 표기 방식과 기록 전통을 함께 살펴보는 일의\n' +
      '“의미와 범위를\n정리하는 것”이다.',                   // quotation owns a seam
    '1. 조사 목적: 오래된 지역 신문의 표기 방식과 기록 전통을 함께 살펴보는\n' +
      ['첫째 행', '둘째 행', '셋째 행', '넷째 행', '다섯째 행에서 끝난다.'].join('\n') // no complete row nearby
  ]) assert.equal(labels.repairInlineLabelContinuations(bad).text, bad);
  // A short numbered title is not a label body.
  const title = '1. 서론: 연구 배경\n이 연구는 지역 신문의 표기를 다룬다.';
  assert.equal(labels.repairInlineLabelContinuations(title).text, title);
});

test('ordinal noun frames and inline series items do not create false warnings', () => {
  const marks = (text, source) => ordinal.ordinalMarkers(text, source == null ? {} : { source }).map(m => m.number);
  const s1 = '장점은 두 가지다. 세 번째로 비판할 점은 해석이 과도하다는 것이다.';
  assert.deepEqual(marks(s1), marks('장점은 두 가지다. 세 번째 비판점은 해석이 과도하다는 것이다.', s1));
  assert.deepEqual(marks('사례가 있다. 두 번째로 소개되는 강한 전통의 마을은 피해가 컸다.'), []);
  // Real adverbial enumerators remain counted.
  assert.deepEqual(marks('첫째로 우리는 시간이 부족했다. 둘째로 정부는 예산을 줄였다.'), [1, 2]);
  const s4 = '읽기 능력을 키우는 방법은 다섯 가지이다. 첫째, 소리 단위를 구별하는 음운 인식, 둘째, 글자 규칙을 아는 해독력, 셋째, 알맞은 속도로 읽는 유창성이다.';
  const o4 = '읽기 능력을 키우는 방법은 다섯 가지이다. 첫째는 소리 단위를 구별하는 음운 인식이고, 둘째는 글자 규칙을 아는 해독력이다. 셋째는 알맞은 속도로 읽는 유창성이다.';
  assert.deepEqual(marks(o4, s4), marks(s4));
  assert.deepEqual(marks(o4), [1, 3]);
  const o5 = '읽기 능력을 키우는 방법은 다섯 가지이다. 첫째는 소리 단위를 구별하는 음운 인식이다. 넷째는 알맞은 속도로 읽는 유창성이다.';
  assert.deepEqual(marks(o5, s4), [1, 4]);
});

test('a pasted assistant reply at the boundary is excluded; ordinary openings stay', () => {
  const body = '인공지능 영상 분석과 보안 업무의 변화\n저는 보안 관리를 전공하고 있습니다. 전공 수업에서 사람의 안전을 지키려면 주변을 잘 살피고 위험한 상황에 빠르게 대응해야 한다는 점을 배웠습니다.';
  const reply = '좋아. 너무 잘 쓴 티가 나지 않으면서도 과제답게 다시 다듬어볼게. 반복되는 표현을 줄이고 네가 직접 쓴 느낌이 나도록 바꿨어.';
  const r = preflight(reply + '\n' + body);
  assert.ok(r.text.startsWith('인공지능'));
  assert.ok(r.issueCodes.includes('source_assistant_reply_artifact'));
  assert.ok(preflight('좋아. 오늘은 내가 겪은 일을 차분히 정리해볼게.\n' + body).text.startsWith('좋아.'));
  const middle = body + '\n좋아. 과제답게 다시 다듬어볼게. 네가 쓴 느낌이 나도록 바꿨어.\n' + body;
  assert.ok(preflight(middle).text.includes('다듬어볼게'));
});
