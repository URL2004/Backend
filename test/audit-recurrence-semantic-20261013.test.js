'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { bindSemanticValidation } = require('../engine-gpt-prod/semanticProvenance');
const { confirmedOmissions, explainConfirmedOmissions: explain,
  sanitizeOmissionGateDiagnostics: sanitize } = require('../engine-gpt-prod/confirmedDeliveryIntegrity');
const { droppedSourceSentences } = require('../engine-gpt-prod/deliveryIntegrityWitnesses');
const { prepareFinalRelationRepair, reinstateDroppedSentences } = require('../engine-gpt-prod/finalRelationRepair');
const { addedRestatements } = require('../engine-gpt-prod/restatementGuard');

// 2026-10-13 audit recurrence, F02/F05/F10. Synthetic sentences only.
const omission = (sourceSpan, candidateSpan, extra = {}) => ({ type: 'omission', origin: 'introduced', repairable: true,
  relationGrounded: true, grounding: 'unique_exact_span', sourceSpanVerified: true, sourceSpan, candidateSpan, ...extra });
const failed = (violations, extra = {}) => ({ ran: true, pass: false, verificationCompleted: true, violations, ...extra });
const final = (source, candidate, violations, extra = {}) => bindSemanticValidation(failed(violations, extra), source, candidate);
const hasHangul = value => /[ㄱ-ㆎ가-힣]/u.test(JSON.stringify(value));

// A list of material tests whose last sentence was deleted.
const M = ['여러 시편을 준비해 재료 실험을 진행했다.', '인장 시험으로 재료가 늘어나는 정도를 측정했다.',
  '굴곡 시험으로 재료가 휘어지는 한계를 살폈다.', '압축 시험으로 재료가 견디는 하중을 확인했다.'];
const materials = M.join(' ');
const keptMaterials = ['시편을 여러 개 준비해 재료 실험을 진행했다.', '인장 시험에서는 재료가 늘어나는 정도를 측정했다.',
  '굴곡 시험에서는 재료가 휘어지는 한계를 살폈다.'];
const shortened = keptMaterials.join(' ');
// A middle sentence was deleted, so the following reference lost its antecedent.
const R = ['연구자 민호는 첫 방법을 발견했다.', '몇 년 뒤, 연구자 지훈은 그 방법을 확장하며 새로운 성질을 확인했다.',
  '바로 자신의 제자 수진이 찾아낸 보완 방법이었다.'];
const researchers = R.join(' ');
const unlinked = `연구자 민호가 첫 방법을 발견했다. ${R[2]}`;

test('F02: a sentence dropped whole is confirmed by the final verdict plus its textual witness', () => {
  for (const [source, candidate, dropped, beside] of [[materials, shortened, M[3], keptMaterials[2]],
    [researchers, unlinked, R[1], R[2]]]) {
    const report = final(source, candidate, [omission(dropped, beside)]);
    assert.equal(confirmedOmissions(source, candidate, report, []).length, 1, 'no earlier finding is needed');
    const record = explain(source, candidate, report, []);
    assert.deepEqual([record.state, record.confirmedCount, record.droppedSentenceWitnessCount], ['evaluated', 1, 1]);
    assert.deepEqual([record.rows[0].priorSameSpan, record.rows[0].droppedSentenceWitness, record.rows[0].firstFailedCondition],
      [false, true, '']);
    assert.equal(hasHangul(record), false);
    const stored = sanitize(record);
    assert.deepEqual([stored.droppedSentenceWitnessCount, stored.rows[0].droppedSentenceWitness], [1, true]);
    // The verdict must still be final, complete, certain and about this text.
    for (const other of [{ ...report, uncertain: true }, { ...report, verificationCompleted: false },
      { ...report, nominationOnly: true }, final(source, candidate + ' 덧붙인 문장이다.', [omission(dropped, beside)])]) {
      assert.equal(confirmedOmissions(source, candidate, other, []).length, 0);
    }
    // The witness alone, or a verdict about another kind of problem, blocks nothing.
    assert.equal(confirmedOmissions(source, candidate, final(source, candidate, [{ ...omission(dropped, beside), type: 'distortion' }]), []).length, 0);
    assert.equal(confirmedOmissions(source, candidate, bindSemanticValidation({ ran: true, pass: true, verificationCompleted: true,
      violations: [] }, source, candidate), []).length, 0);
  }
});

test('F02: rewording, reordering and removal of a repeated claim are not witnessed as a dropped sentence', () => {
  const reworded = `${shortened} 눌러 보는 검사로 시편이 버티는 힘도 살폈다.`;
  assert.equal(droppedSourceSentences(materials, reworded).length, 0);
  assert.equal(confirmedOmissions(materials, reworded, final(materials, reworded, [omission(M[3], keptMaterials[2])]), []).length, 0,
    'a single fail on a reworded sentence is still not a hard gate');
  const rewordedMiddle = `연구자 민호가 첫 방법을 발견했다. 수년 후 학자 지훈이 이를 넓혀 다른 특성을 밝혔다. ${R[2]}`;
  assert.equal(droppedSourceSentences(researchers, rewordedMiddle).length, 0);
  assert.equal(confirmedOmissions(researchers, rewordedMiddle, final(researchers, rewordedMiddle, [omission(R[1], R[2])]), []).length, 0);
  const reordered = [M[0], M[3], M[1], M[2]].join(' ');
  assert.equal(droppedSourceSentences(materials, reordered).length, 0);
  assert.equal(confirmedOmissions(materials, reordered, final(materials, reordered, [omission(M[3], M[1])]), []).length, 0);
  // The source itself says the claim twice; keeping one of them is not a loss.
  const D = ['도서관은 주말에도 문을 연다.', '이용자는 책을 세 권까지 빌릴 수 있다.', '주말에도 도서관은 문을 연다는 점이 중요하다.',
    '반납은 무인 반납함으로도 가능하다.'];
  const once = [D[0], D[1], D[3]].join(' ');
  assert.equal(droppedSourceSentences(D.join(' '), once).length, 0);
  assert.equal(confirmedOmissions(D.join(' '), once, final(D.join(' '), once, [omission(D[2], D[3])]), []).length, 0);
  // Merged into its neighbour: the neighbour grew, so nothing is witnessed.
  const merged = `${keptMaterials[0]} ${keptMaterials[1]} 굴곡 시험에서는 재료가 휘어지는 한계를 살폈고 눌렀을 때 버티는 힘도 함께 살펴 기록으로 남겼다.`;
  assert.equal(droppedSourceSentences(materials, merged).length, 0);
  // Both neighbours fused into one sentence: adjacency cannot be shown, so this stays a review finding.
  const fused = '연구자 민호가 첫 방법을 발견했는데, 그것은 바로 자신의 제자 수진이 찾아낸 보완 방법이었다.';
  assert.equal(droppedSourceSentences(researchers, fused).length, 0);
  assert.equal(confirmedOmissions(researchers, fused, final(researchers, fused, [omission(R[1], fused)]), []).length, 0);
  // A verdict quoting a different sentence does not borrow the witness.
  assert.equal(confirmedOmissions(materials, shortened, final(materials, shortened, [omission(M[1], keptMaterials[2])]), []).length, 0);
  assert.equal(droppedSourceSentences(materials, materials).length, 0);
});

const opts = { deadlineMs: 120000, now: () => 0, assessLiteral: () => ({ pass: true }), assessPatch: () => ({ pass: true }),
  structurePreserved: () => true };

test('F02/F10: the witnessed sentence is proposed in its exact source wording without a model patch', async () => {
  const noModel = { ...opts, repair: () => assert.fail('a settled omission must not be patched again') };
  const last = await prepareFinalRelationRepair(materials, shortened, failed([omission(M[3], keptMaterials[2])]), noModel);
  assert.equal(last.text, `${shortened} ${M[3]}`);
  assert.deepEqual([last.applied, last.restoredCount, last.reinstatedCount, last.patchAttempted, last.pass],
    [true, 1, 1, false, undefined]);
  // Inside a longer report; a three-sentence text is over the insertion bound and is only blocked.
  const frame = body => `수학사 수업에서 방정식 풀이의 역사를 조사했다. ${body} 이 사례는 발견이 여러 사람을 거쳐 완성된다는 점을 보여 준다.`;
  const middle = await prepareFinalRelationRepair(frame(researchers), frame(unlinked), failed([omission(R[1], R[2])]), noModel);
  assert.equal(middle.text, frame(`연구자 민호가 첫 방법을 발견했다. ${R[1]} ${R[2]}`));
  // The restored text is no longer witnessed, so the same sentence is not added twice.
  assert.equal(droppedSourceSentences(frame(researchers), middle.text).length, 0);
  assert.equal(reinstateDroppedSentences(frame(researchers), middle.text, failed([omission(R[1], R[2])])).applied, false);
  assert.equal(reinstateDroppedSentences(researchers, unlinked, failed([omission(R[1], R[2])])).applied, false);
  // Paragraph position follows the source.
  const paragraphs = `${M[0]} ${M[1]}\n\n${M[2]} ${M[3]}\n\n마지막으로 결과를 표로 정리해 보고서에 실었다.`;
  const cut = `${keptMaterials[0]} ${keptMaterials[1]}\n\n${keptMaterials[2]}\n\n마지막으로 결과를 표로 정리해 보고서에 실었다.`;
  const placed = await prepareFinalRelationRepair(paragraphs, cut, failed([omission(M[3], keptMaterials[2])]), noModel);
  assert.equal(placed.text, cut.replace(keptMaterials[2], `${keptMaterials[2]} ${M[3]}`));
});

test('F02: the proposal still passes every existing gate and never stands in for a verdict', async () => {
  const report = failed([omission(M[3], keptMaterials[2])]);
  const quiet = { ...opts, repair: async () => ({ repaired: false }) };
  for (const veto of [{ assessLiteral: () => ({ pass: false, reasons: ['fragment'] }) }, { structurePreserved: () => false }]) {
    const out = await prepareFinalRelationRepair(materials, shortened, report, { ...quiet, ...veto });
    assert.deepEqual([out.applied, out.text], [false, shortened]);
  }
  for (const unusable of [{ ...report, verificationCompleted: false }, { ...report, pass: true }, { ...report, uncertain: true },
    failed([omission(M[3], keptMaterials[2], { origin: 'unconfirmed', repairable: false })])]) {
    assert.equal(reinstateDroppedSentences(materials, shortened, unusable).applied, false);
  }
  // A reworded sentence is not overwritten with source text; the patch route is unchanged.
  const reworded = `${shortened} 눌러 보는 검사로 시편이 버티는 힘도 살폈다.`;
  let calls = 0;
  const out = await prepareFinalRelationRepair(materials, reworded, report, { ...opts,
    repair: async () => { calls += 1; return { repaired: false }; } });
  assert.deepEqual([calls, out.applied, out.text, out.patchReason], [1, false, reworded, 'patch_rejected']);
  // A quotation is never copied in by this route.
  const quoted = [M[0], M[1], '그는 "압축 시험이 가장 까다로웠다"고 실험 일지에 적었다.'];
  assert.equal(reinstateDroppedSentences(quoted.join(' '), `${keptMaterials[0]} ${keptMaterials[1]}`,
    failed([omission(quoted[2], keptMaterials[1])])).applied, false);
});

// F05. An activity record, an automation record and a book commentary.
const activity = '시장 구조를 조사하며 국제 원유 시장의 가격 결정 방식을 학습했다. 이 과정에서 에너지 분야 진로를 탐색했다. 발표 자료도 직접 만들었다.';
const macro = '반복 입력을 줄이려고 매크로를 구현했다. 팀에 배포한 뒤 오류를 수정했다. 사용 매뉴얼도 제작했다.';

test('F05: a repair may not add a sentence that only restates the sentences beside it', async () => {
  const summary = '국제 원유 시장을 학습하고 진로를 탐색했다.';
  const repeated = activity.replace(' 발표', ` ${summary} 발표`);
  assert.deepEqual(addedRestatements(activity, activity, repeated), [{ code: 'restatement_added', chars: 19 }]);
  assert.equal(addedRestatements(macro, macro, `${macro} 매크로를 구현하고 배포했으며 오류를 수정하고 매뉴얼을 제작했다.`).length, 1);
  // Declined as a whole: the earlier, more specific sentences are all still there.
  const report = failed([{ type: 'distortion', origin: 'introduced', repairable: true, relationGrounded: true,
    grounding: 'unique_exact_span', spanVerified: true, relation: 'other', span: '이 과정에서 에너지 분야 진로를 탐색했다.',
    sourceSpan: '이 과정에서 에너지 분야 진로를 탐색했다.', candidateSpan: '이 과정에서 에너지 분야 진로를 탐색했다.' }]);
  const out = await prepareFinalRelationRepair(activity, activity, report, { ...opts,
    repair: async () => ({ repaired: true, outputText: repeated }) });
  assert.deepEqual([out.applied, out.text, out.patchReason, out.patchedCount], [false, activity, 'patch_restatement_added', 0]);
  // A patch that adds nothing of the kind is accepted as before.
  const specific = activity.replace('탐색했다.', '탐색하고 정유 공정 견학도 신청했다.');
  const accepted = await prepareFinalRelationRepair(activity, activity, report, { ...opts,
    repair: async () => ({ repaired: true, outputText: specific }) });
  assert.deepEqual([accepted.applied, accepted.text, accepted.patchReason], [true, specific, 'proposed']);
});

test('F05: the source\'s own repetition, reordering, rewording and new specifics are left alone', () => {
  const closing = '결국 국제 원유 시장을 학습하고 진로를 탐색한 셈이다.';
  const rhetorical = activity.replace(' 발표', ` ${closing} 발표`);
  assert.equal(addedRestatements(rhetorical, activity, rhetorical).length, 0, 'restoring the source\'s own closing line');
  assert.equal(addedRestatements(rhetorical, rhetorical, rhetorical).length, 0);
  assert.equal(addedRestatements(activity, activity,
    '이 과정에서 에너지 분야 진로를 탐색했다. 시장 구조를 조사하며 국제 원유 시장의 가격 결정 방식을 학습했다. 발표 자료도 직접 만들었다.').length, 0);
  assert.equal(addedRestatements(activity, activity, activity.replace('학습했다', '익혔다')).length, 0);
  const result = `${macro} 그 결과 처리 시간이 크게 줄었다.`;
  assert.equal(addedRestatements(result, macro, result).length, 0);
  assert.equal(addedRestatements(macro, macro, `${macro} 이후 다른 부서에서도 같은 도구를 요청했다.`).length, 0);
});

test('F05 known limit: a restatement in different words is not detected here', () => {
  const book = '주인공의 선택은 좋지 않은 결말로 이어졌다. 그래도 선택에 이르는 과정과 스스로 정할 권리가 더 중요하다.';
  const added = book.replace(' 그래도', ' 나는 결과만으로 옳고 그름을 판단할 수 없다고 본다. 그래도');
  assert.equal(addedRestatements(book, book, added).length, 0);
});

// Follow-up: a list of tests whose last explanation was dropped, where the source
// closes with one unanswered edit request and a neighbour changed only its endings.
const T = ['나무 시편으로 건조시험과 질량시험을 실시하였다.',
  '건조시험은 시편을 일정 온도에서 말려 수분 변화를 관찰하였으며, 질량시험은 저울로 무게를 측정하는 과정으로 진행하였다.',
  '이후 완충재를 대상으로 발열시험, 굽힘 파괴시험 및 인장시험을 실시하였다.',
  '발열시험에서는 완충재가 얼마나 뜨거워지는지 확인하였으며, 굽힘 파괴시험에서는 완충재가 얼마나 많은 힘을 버티다가 파괴되는지 확인하였다.',
  '마지막으로 인장시험을 통해 완충재를 당겨 재료의 탄성을 확인하였다.',
  '여기에 완충재에 흡수량을 측정하고 다음날 결과가 나온다는것도 적어줘'];
const K = ['나무 시편으로 건조시험과 질량시험을 실시했다.',
  '건조시험에서는 시편을 일정 온도로 말려 수분 변화를 살피고, 질량시험에서는 저울로 무게를 쟀다.',
  '이어 완충재를 대상으로 발열시험, 굽힘 파괴시험 및 인장시험을 진행했다.',
  '발열시험으로 완충재가 어느 정도 뜨거워지는지 확인했으며, 굽힘 파괴시험에서는 완충재가 파괴되기 전까지 견디는 힘을 확인했다.'];
const trials = T.join(' '), keptTrials = K.join(' ');
// The same neighbour with more endings changed: below the plain match bound in one direction.
const inflected = '발열시험으로는 완충재가 어느 정도 뜨거워지는지 살폈으며, 굽힘 파괴시험으로는 완충재가 파괴되기 전까지 견디는 힘을 확인했다.';
const witnessed = (source, candidate) => droppedSourceSentences(source, candidate).map(w => w.sourceWitness);

test('F02 follow-up: the claim before an unanswered closing edit request is witnessed; the request is not', async () => {
  const { sentenceSimilarity } = require('../engine-gpt-prod/sentenceAlignment');
  assert.ok(sentenceSimilarity(inflected, T[3]) < 0.55, 'the fixture must exercise the stem anchor');
  for (const candidate of [keptTrials, [...K.slice(0, 3), inflected].join(' ')]) {
    assert.deepEqual(witnessed(trials, candidate), [T[4]]);
    assert.deepEqual(witnessed(`${trials}.`, candidate), [T[4]], 'a punctuated request is still not body prose');
    const report = final(trials, candidate, [omission(T[4], candidate.slice(-40))]);
    assert.equal(confirmedOmissions(trials, candidate, report, []).length, 1);
    // Restored after the last kept sentence; the request is never written into the result.
    const out = await prepareFinalRelationRepair(trials, candidate, failed([omission(T[4], candidate.slice(-40))]),
      { ...opts, repair: () => assert.fail('settled without a patch') });
    assert.equal(out.text, `${candidate} ${T[4]}`);
    assert.equal(witnessed(trials, out.text).length, 0);
  }
  // The request was carried out or kept: the dropped claim is then an ordinary middle sentence.
  const answered = `${keptTrials} 완충재의 흡수량도 측정했으며 결과는 다음날 나온다.`;
  assert.deepEqual(witnessed(trials, answered), [T[4]]);
  assert.deepEqual(witnessed(trials, `${keptTrials} ${T[5]}`), [T[4]]);
  // Nothing was lost but the request: no witness, so nothing is blocked or inserted.
  const whole = `${keptTrials} 끝으로 인장시험에서 완충재를 당겨 재료의 탄성을 확인했다.`;
  assert.equal(witnessed(`${trials}.`, whole).length, 0);
  assert.equal(witnessed(trials, `${whole} 완충재의 흡수량도 측정했으며 결과는 다음날 나온다.`).length, 0);
});

test('F02 follow-up: the wider anchor does not witness rewording, merging, moving or a heavier rewrite', () => {
  const head = K.slice(0, 3).join(' ');
  for (const [label, candidate] of [
    ['reworded as its own sentence', `${keptTrials} 끝으로 잡아 늘이는 검사로 얼마나 늘었다 돌아오는지 살폈다.`],
    ['moved earlier', [K[0], K[1], K[2], '끝으로 인장시험에서 완충재를 당겨 재료의 탄성을 확인했다.', K[3]].join(' ')],
    ['merged, neighbour grew', `${head} 발열시험으로 완충재가 어느 정도 뜨거워지는지 확인했으며, 굽힘 파괴시험에서는 견디는 힘을, 잡아 늘이는 검사에서는 늘었다 돌아오는 정도를 확인했다.`],
    ['merged within the length bound', `${head} 발열시험에서는 완충재가 얼마나 뜨거워지는지, 굽힘 파괴시험에서는 얼마나 버티다가 파괴되는지 확인하였고 늘여서 되돌아오는 성질도 봤다.`],
    ['merged before a shared verb', `${head} 발열시험에서는 완충재가 얼마나 뜨거워지는지 확인하였으며, 굽힘 파괴시험에서는 얼마나 버티는지, 끝으로 늘림 검사에서는 복원력을 확인하였다.`],
    ['neighbour rewritten beyond its stems', `${head} 발열시험으로는 완충재의 온도 상승을 살폈고, 굽힘 파괴시험으로는 부서지기 전까지 견디는 힘을 봤다.`],
    ['two sentences dropped in a row', head]]) {
    assert.equal(witnessed(trials, candidate).length, 0, label);
  }
  // Two body sentences plus a request stay below the minimum; three are enough.
  assert.equal(witnessed([T[3], T[4], T[5]].join(' '), K[3]).length, 0);
  assert.deepEqual(witnessed(T.slice(2).join(' '), `${K[2]} ${K[3]}`), [T[4]]);
  // Requests that are the body (a notice) are ordinary sentences: only the dropped one is named.
  const notice = ['회의 자료를 보냅니다.', '일정은 첨부 파일에 정리했습니다.', '빠진 항목이 있으면 표에 적어 주세요.',
    '예산안은 다음 주까지 검토 의견을 적어 주세요.'];
  assert.deepEqual(witnessed(notice.join(' '), notice.slice(0, 3).join(' ')), [notice[3]]);
  assert.equal(witnessed(notice.join(' '), notice.join(' ')).length, 0);
});

test('F02 follow-up: a two-word clause in a neighbour is not independent proof of deletion', () => {
  const folded = `${K.slice(0, 3).join(' ')} 발열시험에서 완충재가 뜨거워지는 정도를, 굽힘 파괴시험에서 버티는 힘을 확인하였고 복원력도 쟀다.`;
  assert.equal(witnessed(trials, folded).length, 0);
  assert.equal(confirmedOmissions(trials, folded, bindSemanticValidation({ ran: true, pass: true, verificationCompleted: true,
    violations: [] }, trials, folded), []).length, 0);
});

test('F05: the existing final judge prompt asks about an added restatement without a new call', async t => {
  const { semanticJudge } = require('../engine-gpt-prod/judge'), runtime = require('../lib/gptRuntimeConfig');
  const old = global.fetch, key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  t.after(() => { global.fetch = old; if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key; });
  const requests = [];
  global.fetch = async (_url, init) => {
    requests.push(require('./helpers/responses-request.cjs')(init.body));
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
      text: JSON.stringify({ violations: [] }) }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } });
  };
  const book = '주인공의 선택은 좋지 않은 결말로 이어졌다. 그래도 선택에 이르는 과정과 스스로 정할 권리가 더 중요하다.';
  await semanticJudge(book, book.replace(' 그래도', ' 나는 결과만으로 옳고 그름을 판단할 수 없다고 본다. 그래도'), null,
    { config: runtime.publicConfig(runtime.DEFAULT_CONFIG, 'test') });
  assert.equal(requests.length, 1);
  const instructions = requests[0].instructions;
  assert.match(instructions, /이미 전달한 주장을 화자 견해\(“나는 …라고 본다”\)나 한 문장 요약으로 다시 말하는 새 문장이 원문 대응 없이 생겼는지/u);
  // The normal cases stay allowed and nothing more specific may be asked to go.
  assert.match(instructions, /원문에도 같은 재확인·결론 문장이 있거나, 새 문장이 구체적 대상·수치·성과를 더하면 위반이 아니다/u);
  assert.match(instructions, /duplicate_conclusion으로, sourceSpan에는 이미 그 주장을 담은 원문 문장, candidateSpan에는 기존 문장과 새 문장을 함께/u);
  assert.match(instructions, /더 구체적인 문장을 지우라고 요구하지 않는다/u);
  assert.equal(instructions.split('화자 견해(“나는').length, 2, 'stated once');
  // A warning-level type, as before: this sentence does not make it a delivery block.
  const policy = require('../lib/humanizeDeliveryPolicy');
  assert.deepEqual([policy.isEffectOnly('duplicate_conclusion'), policy.isTechnicalCritical('duplicate_conclusion')], [true, false]);
});
