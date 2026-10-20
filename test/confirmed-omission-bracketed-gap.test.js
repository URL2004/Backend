'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bindSemanticValidation } = require('../engine-gpt-prod/semanticProvenance');
const { groundViolation } = require('../engine-gpt-prod/judge');
const { confirmedOmissions, explainConfirmedOmissions: explain, sanitizeOmissionGateDiagnostics: sanitize } =
  require('../engine-gpt-prod/confirmedDeliveryIntegrity');

// 2026-10-21 (H0260 class). Synthetic sentences only. The source states one
// claim twice, in two passages (S[2], and S[6] after the break before S[5]);
// the result kept S[6]'s statement in S[6]'s slot and left S[2]'s slot empty
// between its verbatim neighbours. No prior finding and no dropped-sentence
// witness exist (the claim has no words of its own), so only the bracketed
// empty-slot witness can confirm the final verdict.
const S = ['우리 동네 도서관은 지난해 봄에 새로 문을 열었다.',
  '하지만 1층 열람실을 쓰는 방식이 장점만 있는 것은 아니라고 느꼈다.',
  '나는 매일 저녁 창가 자리에 앉는데, 그 자리가 출입문 바로 옆에 붙어 있다.',
  '드나드는 사람이 많아서 책에 집중하기 어려울 때가 많다.',
  '그래서 관리실에 자리 배치를 바꿔 달라고 건의했다.',
  '두 번째로 불편한 점은 열람실의 소음이다.',
  '나는 매일 저녁 창가 자리에 앉는데, 그 자리 바로 옆이 출입문이다.',
  '사람들이 오갈 때마다 문소리가 크게 울려서 신경이 쓰인다.',
  '결국 다른 층으로 자리를 옮기는 것도 고민하고 있다.'];
const O = ['동네 도서관은 작년 봄에 새로 개관했다.', S[1], S[3], '그래서 관리실에 좌석 배치를 바꿔 달라고 요청했다.', S[5],
  '매일 저녁 나는 창가 자리에 앉고, 그 자리 바로 옆에는 출입문이 있다.',
  '사람들이 드나들 때마다 문소리가 크게 울려 신경이 쓰인다.', '결국 다른 층으로 자리를 옮길지도 고민하고 있다.'];
const join = rows => {
  const at = rows.indexOf(S[5]);
  return at < 0 ? rows.join(' ') : `${rows.slice(0, at).join(' ')}\n\n${rows.slice(at).join(' ')}`;
};
const verdict = (src, out, { sourceSpan = join(S.slice(1, 4)), candidateSpan = `${S[1]} ${S[3]}`, ...extra } = {}) => {
  const finding = groundViolation({ type: 'omission', origin: 'introduced', relation: 'premise', detail: 'synthetic',
    span: S[2], sourceSpan, candidateSpan }, src, out);
  return bindSemanticValidation({ ran: true, pass: false, verificationCompleted: true, violations: [finding], ...extra }, src, out);
};
const gate = (src, out, report = verdict(src, out)) => {
  const record = explain(src, out, report, []);
  const blocked = confirmedOmissions(src, out, report, []).length;
  assert.equal(record.confirmedCount, blocked, 'the record agrees with the gate');
  return { blocked, record };
};
const hasHangul = value => /[ㄱ-ㆎ가-힣]/u.test(JSON.stringify(value));

test('an empty slot between verbatim neighbours is witnessed although the claim recurs elsewhere', () => {
  const src = join(S), out = join(O);
  const report = verdict(src, out);
  assert.equal(report.violations[0].relationGrounded, true);
  const { blocked, record } = gate(src, out, report);
  assert.equal(blocked, 1);
  assert.deepEqual([record.state, record.droppedSentenceWitnessCount, record.bracketedGapWitnessCount], ['evaluated', 0, 1]);
  assert.deepEqual([record.rows[0].priorSameSpan, record.rows[0].droppedSentenceWitness, record.rows[0].bracketedGapWitness,
    record.rows[0].firstFailedCondition], [false, false, true, '']);
  assert.equal(hasHangul(record), false, 'no quotation in the record');
  const stored = sanitize(record);
  assert.deepEqual([stored.bracketedGapWitnessCount, stored.rows[0].bracketedGapWitness], [1, true]);
  assert.equal(hasHangul(stored), false);
  // The other statement kept verbatim is owned by its own source sentence.
  const verbatim = join([...O.slice(0, 5), S[6], ...O.slice(6)]);
  assert.equal(gate(src, verbatim).blocked, 1);
  // A quote of the missing sentence with one neighbour is the same witness.
  assert.equal(gate(src, out, verdict(src, out, { sourceSpan: join(S.slice(1, 3)), candidateSpan: S[1] })).blocked, 1);
});

test('a restatement within the same passage makes dropping one statement deduplication', () => {
  // The same texts as one passage (no blank or heading line): nothing is witnessed.
  const flat = rows => rows.join(' ');
  assert.equal(gate(flat(S), flat(O)).blocked, 0);
  assert.equal(gate(flat(S), flat([...O.slice(0, 5), S[6], ...O.slice(6)])).blocked, 0);
  // A heading line separates passages as a blank line does.
  const headed = rows => `${rows.slice(0, rows.indexOf(S[5])).join(' ')}\n둘째 문제\n${rows.slice(rows.indexOf(S[5])).join(' ')}`;
  assert.equal(gate(headed(S), headed(O)).blocked, 1);
  // PDF-style physical wraps within one passage do not create new sections.
  const wrapped = flat(S).replace('그래서 관리실에 자리 배치를', '그래서 관리실에\n자리 배치를')
    .replace('두 번째로 불편한 점은', '두 번째로\n불편한 점은');
  assert.equal(gate(wrapped, flat(O)).blocked, 0);
});

test('only a current completed fail verdict can use it', () => {
  const src = join(S), out = join(O);
  for (const extra of [{ uncertain: true }, { verificationCompleted: false }, { nominationOnly: true }]) {
    const { blocked, record } = gate(src, out, verdict(src, out, extra));
    assert.equal(blocked, 0, JSON.stringify(extra));
    assert.equal(record.confirmedCount, 0);
  }
  // Bound to another result text: stale.
  const stale = verdict(src, `${out} 덧붙인 문장이다.`);
  const record = explain(src, out, stale, []);
  assert.deepEqual([record.state, confirmedOmissions(src, out, stale, []).length], ['final_verdict_stale', 0]);
  const unconfirmed = verdict(src, out);
  unconfirmed.violations[0].origin = 'unconfirmed';
  assert.equal(gate(src, out, unconfirmed).blocked, 0);
});

test('a claim merged into the other slot or into a neighbour is not an empty slot', () => {
  const src = join(S);
  // The other statement took the missing sentence's own words (붙어).
  const slot = [...O]; slot[5] = '매일 저녁 나는 창가 자리에 앉고, 그 자리는 출입문 바로 옆에 붙어 있다.';
  assert.equal(gate(src, join(slot)).blocked, 0);
  // The preceding neighbour absorbed the claim, so it is no longer verbatim.
  const merged = S[1].replace('느꼈다.', '느꼈고, 창가 자리도 출입문 바로 옆에 붙어 있다.');
  const neighbour = [...O]; neighbour[1] = merged;
  const out = join(neighbour), report = verdict(src, out, { candidateSpan: `${merged} ${S[3]}` });
  assert.equal(report.violations[0].relationGrounded, true);
  assert.equal(gate(src, out, report).blocked, 0);
});

test('a neighbour that already restates the claim is benign local redundancy', () => {
  // Below the similarity bound (it is a rewording), but it holds half the words.
  const near = '창가 자리가 출입문 바로 옆이라 저녁마다 사람이 많이 오간다.';
  const src = join([...S.slice(0, 3), near, ...S.slice(4)]);
  const out = join([O[0], S[1], near, ...O.slice(3)]);
  const report = verdict(src, out, { sourceSpan: `${S[1]} ${S[2]} ${near}`, candidateSpan: `${S[1]} ${near}` });
  assert.equal(report.violations[0].relationGrounded, true);
  assert.equal(gate(src, out, report).blocked, 0);
});

test('ambiguous or unowned anchors abstain', () => {
  const src = join(S);
  // A neighbour repeated in the result is no longer a unique anchor.
  assert.equal(gate(src, join([...O, S[1]])).blocked, 0);
  // The missing sentence was moved, reworded, to the end: no slot owns it.
  assert.equal(gate(src, join([...O, '매일 저녁 내가 앉는 창가 자리 바로 옆에 출입문이 있다.'])).blocked, 0);
  // The other statement's own verbatim copy also survives: the rewrite is unowned.
  assert.equal(gate(src, join([...O, S[6]])).blocked, 0);
  // The other statement's far neighbour is verbatim but is not its neighbour in
  // the source (S[7] is gone): which slot the rewrite fills is ambiguous.
  const across = [...O.slice(0, 6), S[8]];
  assert.equal(gate(src, join(across)).blocked, 0);
  // The other statement grew by a clause its source sentence lacks.
  const grown = [...O]; grown[5] = '매일 저녁 나는 창가 자리에 앉고, 그 자리 바로 옆에는 출입문이 있으며 앉는 곳이 문과 맞닿은 위치라서 바람이 든다.';
  assert.equal(gate(src, join(grown)).blocked, 0);
  // Grounding already rejects the next three shapes; the witness does on its own too.
  const grounded = (out, sourceSpan, candidateSpan) => bindSemanticValidation({ ran: true, pass: false, verificationCompleted: true,
    violations: [{ type: 'omission', origin: 'introduced', repairable: true, relationGrounded: true, grounding: 'unique_exact_span',
      sourceSpanVerified: true, sourceSpan, candidateSpan }] }, src, out);
  assert.equal(gate(src, join(O), grounded(join(O), join(S.slice(1, 4)), `${S[1]} ${S[3]}`)).blocked, 1, 'control');
  // The quoted window is the missing sentence and a sentence beyond its neighbour.
  const kept = [...O]; kept[3] = S[4];
  assert.equal(gate(src, join(kept), grounded(join(kept), `${S[2]} ${S[3]} ${S[4]}`, S[3])).blocked, 0);
  // The context quote lies outside the bracket.
  assert.equal(gate(src, join(O), grounded(join(O), join(S.slice(1, 4)), O[3])).blocked, 0);
  // Something stands between the neighbours: it may be the sentence rewritten.
  const between = join([O[0], S[1], '그해 여름에는 비가 유난히 많이 내렸다.', ...O.slice(2)]);
  assert.equal(gate(src, between, grounded(between, join(S.slice(1, 4)), S[1])).blocked, 0);
});

test('the witness is bounded by sentence count', () => {
  const filler = n => Array.from({ length: n }, (_, i) => `채움 문장 번호 ${i}번은 따로 떨어진 내용을 담는다.`);
  let started = Date.now();
  assert.equal(gate(join([...S, ...filler(390)]), join([...O, ...filler(390)])).blocked, 1, 'at the bound: still witnessed');
  assert.ok(Date.now() - started < 3000);
  started = Date.now();
  assert.equal(gate(join([...S, ...filler(400)]), join([...O, ...filler(400)])).blocked, 0, 'past 400 sentences: abstains');
  assert.ok(Date.now() - started < 3000);
});
