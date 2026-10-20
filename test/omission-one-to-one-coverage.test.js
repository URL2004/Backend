'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { restoreConfirmedSemanticOmissions: restore, isMateriallyMissing } = require('../engine-gpt-prod/omissionRestore');
const { groundViolation } = require('../engine-gpt-prod/judge');

// Synthetic fixture: a local premise (P) whose claim the source restates far
// away (R, three sentences past the judge's context window). The result drops P and keeps R, so R alone still looks like
// coverage of P under the global test.
const S = [
  '올해 봄에는 새로운 부원 열두 명이 들어와 활동이 크게 늘었다.',
  '선배들은 신입 부원에게 실험 장비 사용법을 차근차근 알려 주었다.',
  '우리 동아리는 매주 금요일 저녁 과학관 세미나실에서 정기 모임을 연다.',
  '모임에서는 각자 읽은 논문을 짧게 발표하고 질문을 주고받는다.',
  '발표가 끝나면 다음 주에 할 실험 계획을 함께 정리한다.',
  '발표 자료는 동아리 공유 폴더에 올려 두고 누구나 다시 볼 수 있게 한다.',
  '가끔은 다른 학과 학생들도 찾아와 함께 이야기를 나눈다.',
  '과학관 세미나실 정기 모임은 늘 붐빈다.',
  '그래서 내년에는 더 넓은 강의실을 빌리려고 한다.'
];
const P = S[2], R = S[7];
const join = rows => rows.join(' ');
const source = join(S);
const dropped = join(S.filter(row => row !== P));
const omission = (src, out, extra = {}) => groundViolation({ type: 'omission', span: P,
  sourceSpan: `${S[1]} ${P}`, candidateSpan: `${S[1]} ${S[3]}`,
  detail: '정기 모임의 요일과 장소라는 전제가 사라졌습니다.', relation: 'premise', origin: 'introduced', ...extra }, src, out);
const run = (src, out, finding) => restore({ source: src, outputText: out,
  semanticReport: { pass: false, uncertain: false, violations: [finding] } });

test('a remote restatement owned by another source sentence does not cover the dropped local premise', () => {
  assert.equal(isMateriallyMissing(P, dropped), false, 'the established global test sees coverage');
  const finding = omission(source, dropped);
  assert.equal(finding.repairable, true);
  const result = run(source, dropped, finding);
  assert.equal(result.applied, true);
  assert.equal(result.text, source);
  assert.equal(result.text.split(P).length, 2);
  assert.equal(result.restored[0].coverageOwnedElsewhere, true);
  assert.equal(result.restored[0].sourceSentenceIndex, 2);
});

test('the result keeping both sentences is unchanged', () => {
  const finding = omission(source, source, { candidateSpan: `${S[1]} ${P}` });
  const result = run(source, source, finding);
  assert.equal(result.applied, false);
  assert.equal(result.text, source);
});

test('an ungrounded or unconfirmed finding keeps the established coverage test', () => {
  const raw = { type: 'omission', span: P, detail: '전제가 사라졌습니다.', origin: 'introduced' };
  assert.equal(run(source, dropped, raw).text, dropped);
  const grounded = omission(source, dropped);
  assert.equal(run(source, dropped, { ...grounded, origin: 'unconfirmed' }).text, dropped);
});

test('identical repeated source claims with ambiguous ownership stay unchanged', () => {
  const rows = S.map((row, index) => index === 7 ? '우리 동아리는 매주 금요일 저녁 과학관 세미나실에서 정기 모임을 열고 있다.' : row);
  const src = join(rows), out = join(rows.filter((row, index) => index !== 2));
  assert.equal(isMateriallyMissing(P, out), false);
  const finding = omission(src, out);
  assert.equal(finding.repairable, true);
  assert.equal(run(src, out, finding).text, out);
});

test('a restatement next to the premise is local redundancy, not a remote owner', () => {
  const near = '금요일 저녁 과학관 세미나실 정기 모임은 늘 붐빈다.';
  const rows = [...S.slice(0, 3), near, ...S.slice(3, 7), S[8]];
  const src = join(rows), out = join(rows.filter(row => row !== P));
  const finding = omission(src, out, { candidateSpan: `${S[1]} ${near}` });
  assert.equal(finding.repairable, true);
  assert.equal(run(src, out, finding).text, out);
});

test('a source that already says the premise in the sentence before keeps its compression', () => {
  const near = '우리 동아리는 금요일 저녁마다 과학관 세미나실에 모인다.';
  const rows = [S[0], near, ...S.slice(2)];
  const src = join(rows), out = join(rows.filter(row => row !== P));
  assert.equal(isMateriallyMissing(P, out), false);
  const finding = omission(src, out, { sourceSpan: `${near} ${P}`, candidateSpan: `${near} ${S[3]}` });
  assert.equal(finding.repairable, true);
  assert.equal(run(src, out, finding).text, out);
});

test('a kept sentence that merged the premise into the restatement still covers it', () => {
  const merged = '우리 동아리가 금요일 저녁마다 여는 과학관 세미나실 정기 모임은 늘 붐빈다.';
  const out = join(S.filter(row => row !== P).map(row => row === R ? merged : row));
  assert.equal(isMateriallyMissing(P, out), false);
  const finding = omission(source, out);
  assert.equal(finding.repairable, true);
  assert.equal(run(source, out, finding).text, out);
});

test('without both source neighbours side by side the premise is not inserted', () => {
  const rewritten = '모임에서 부원들은 읽은 논문을 짧게 소개하고 서로 질문을 던진다.';
  const out = join(S.filter(row => row !== P).map(row => row === S[3] ? rewritten : row));
  assert.equal(isMateriallyMissing(P, out), false);
  const finding = omission(source, out, { candidateSpan: `${S[1]} ${rewritten}` });
  assert.equal(finding.repairable, true);
  assert.equal(run(source, out, finding).text, out);
});

test('a quotation of the whole sentence without its final period is not a paired partial', () => {
  const s = join([S[0], S[1], P, S[3]]), o = join([S[0], S[1], S[3]]);
  const finding = omission(s, o, { span: P.slice(0, -1) });
  assert.equal(finding.repairable, true);
  const result = run(s, o, finding);
  assert.equal(result.applied, true);
  assert.equal(result.text, s);
});
