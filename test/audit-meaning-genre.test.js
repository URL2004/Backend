'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const voice = require('../engine-gpt-prod/voiceProfile');
const depth = require('../engine-gpt-prod/humanizationDepth');
const relation = require('../engine-gpt-prod/relationAudit');
const operator = require('../engine-gpt-prod/semanticOperatorReview');
const duplicates = require('../engine-gpt-prod/adjacentDuplicateReview');

test('source-owned present opinions retain implicit first person across general profiles', () => {
  const source = '저는 다른 사람의 의견을 먼저 듣는 태도가 중요하다고 생각합니다. 서로의 차이를 존중해야 한다는 의견에도 동의합니다.';
  const output = source.replace('저는 ', '');
  for (const profile of ['general', 'general_essay', 'personal_essay']) {
    const report = voice.auditVoice(voice.buildVoiceProfile(source, { documentProfile: profile }), output,
      { sourceText: source, documentProfile: profile, mode: 'blog' });
    assert.equal(report.warnings.some(w => w.code === 'speaker_removed'), false, profile);
  }
});
test('polite statements and another speaker do not certify implicit first person', () => {
  const source = '저는 다양한 의견을 경청하는 태도가 중요하다고 생각합니다.';
  for (const output of ['다양한 의견을 경청하는 태도가 중요합니다.', '그는 다양한 의견을 경청하는 태도가 중요하다고 생각합니다.',
    '연구자는 다양한 의견을 경청하는 태도가 중요하다고 생각합니다.',
    '민수는 다양한 의견을 경청하는 태도가 중요하다고 생각합니다.']) {
    assert.ok(voice.auditVoice(voice.buildVoiceProfile(source, { documentProfile: 'general' }), output,
      { sourceText: source, documentProfile: 'general', mode: 'blog' }).warnings.some(w => w.code === 'speaker_removed'));
  }
});
test('local relation questions carry exact evidence and require adjudication', () => {
  const cases = [
    ['qualification_strength_candidate', '저는 대학에서 기계공학과와 경제학과를 공부했습니다.', '저는 대학에서 기계공학과와 경제학과를 전공했습니다.'],
    ['force_direction_candidate', '반죽의 모양은 손의 압력과 도구의 각도에 따라 달라진다.', '반죽의 모양은 손에 가하는 압력과 도구의 각도에 따라 달라진다.'],
    ['reflection_attribution_candidate', '이번 강의를 듣고 교육은 학생의 자립을 돕는 데 있다고 배웠다.', '교육은 학생의 자립을 돕는 데 있다.'],
    ['parallel_result_candidate', '학생들은 자료를 검토하며 자신만의 아이디어를 발전시킬 수 있다.', '학생들은 자료를 검토해 자신만의 아이디어로 발전시킬 수 있다.'],
    ['retrospective_tense_candidate', '새롭게 알게 된 점은 여러 조건을 함께 비교해야 한다는 것이다.', '여러 조건을 함께 비교해야 한다는 것을 새롭게 알게 된다.'],
    ['introduced_nominal_grammar_candidate', '이 활동은 어려운 이웃에게 음식을 나눠 주는 일이 중심이다.', '이 활동은 어려운 이웃에게 음식을 나눠 주는 뜻이 중심이다.'],
    ['antecedent_value_candidate', '문제 해결 능력이 부족해도 그것이 곧 나에게 가치가 없는 것은 아니다.', '문제 해결 능력이 부족해도 그렇다고 나에게 가치가 없는 것은 아니다.']
  ];
  for (const [code, source, output] of cases) {
    assert.ok(relation.auditRelationCandidates(source, output).codes.includes(code), code);
    const target = operator.targets(source, output).find(t => t.codes.includes(code));
    assert.ok(target, code);
    assert.equal(source.includes(target.sourceSpan), true);
    assert.equal(output.includes(target.candidateSpan), true);
    assert.equal(operator.assess([target], [], [], source, output).pending[0].repairable, false);
    assert.equal(operator.assess([target], [{ ...target, status: 'preserved', detail: 'The surrounding source supports this equivalent statement.' }], [], source, output).pending.length, 0);
    assert.equal(relation.auditRelationCandidates(output, output).codes.includes(code), false);
  }
});
test('paragraph reflection remains a question when another paragraph retains first person', () => {
  const first = '저는 이번 수업에서 모둠 활동에 참여했다.\n\n';
  const source = first + '학생들이 서로를 이해하도록 돕는 것이 교육의 역할이라고 배웠다.';
  const output = first + '학생들이 서로를 이해하도록 돕는 것이 교육의 역할이다.';
  assert.ok(operator.targets(source, output).some(t => t.codes.includes('reflection_attribution_candidate')));
});
test('poem and nominal titles have no minimum rewrite pressure; prose still does', () => {
  const poem = '아아, 오래된 등불\n창가에 꼬박꼬박 고이는 바람\n\n빈 골목을 건너는 이름\n아직 남아 있는 그림자';
  for (const strength of ['basic', 'advanced']) {
    const plan = depth.buildHumanizationPlan(poem, { requestStrength: strength, documentProfile: 'creative' });
    assert.equal(plan.preservationOnly, true);
    assert.equal(depth.evaluateHumanizationDepth(poem, poem, plan).pass, true);
    assert.equal(plan.requiredChangedSentenceCount, 0);
    assert.match(depth.buildHumanizationPromptBlock(plan), /최소 목표는 없다/u);
    const distributed = depth.buildDistributedHumanizationPlans([{ index: 0, text: poem.split('\n')[0] }], plan);
    // 호출부(엔진)는 일반 경로와 같은 모양({ aligned, plans })을 읽는다.
    assert.equal(distributed.plans.get(0).preservationOnly, true);
    assert.equal(distributed.aligned, true);
    assert.equal(distributed.plans instanceof Map, true);
  }
  assert.equal(depth.isPreservationOnly('늦은 오후의 풍경\n여름 끝의 기록\n도시와 기억\n조용한 약속'), true);
  assert.equal(depth.isPreservationOnly('탐구 결과\n실험의 결과를 확인했다.'), false);
  assert.equal(depth.isPreservationOnly('모두 협력한다.\n서로의 의견을 존중한다.'), false);
  assert.equal(depth.isPreservationOnly('자료를 분석하여\n결과를 비교하며'), false);
  const profile = voice.buildVoiceProfile(poem, { documentProfile: 'creative' });
  assert.ok(voice.auditVoice(profile, poem.replace('아아, ', '').replace('꼬박꼬박', '꼬박'),
    { sourceText: poem, documentProfile: 'creative' }).warnings.some(w => w.code === 'creative_sound_repetition_changed'));
  assert.equal(voice.auditVoice(profile, poem, { sourceText: poem, documentProfile: 'creative' }).warnings.some(w => w.code === 'creative_sound_repetition_changed'), false);
});
test('ambiguous first-person poems retain acoustic and no-op protection without changing genre labels', () => {
  const poem = '아아, 저문 들판\n다시 꼬박꼬박 남는 소리\n\n나는 물결을 기억하고\n창가의 빈 의자를 바라보네\n\n어제의 이름은 멀어지고\n남은 빛은 내 손에 고이네';
  const documentProfile = { profile: 'personal_essay', formatProfile: { flags: ['line_sensitive'] } };
  assert.equal(depth.isPreservationOnly(poem, { documentProfile }), true);
  const profile = voice.buildVoiceProfile(poem, { documentProfile });
  assert.equal(profile.documentProfile, 'personal_essay');
  assert.equal(profile.lineBreakSensitive, true);
  assert.ok(voice.auditVoice(profile, poem.replace('아아, ', ''), { sourceText: poem, documentProfile }).warnings
    .some(w => w.code === 'creative_sound_repetition_changed'));
  assert.equal(depth.isPreservationOnly('처음에는 어려웠다.\n그래도 연습을 이어갔다.\n\n매주 기록을 남겼다.\n시간에 맞추어 완성했다.\n\n꼬박꼬박 목표를 확인했다.\n마침내 성과를 얻었다.', { documentProfile }), false);
});
test('new adjacent explanatory replay is nominated, inherited or distinct claims are not', () => {
  const source = '세 부품은 같은 규격과 연결 구조를 공유하지만 각각 독립적인 위치와 고유한 기능을 가진다.';
  const output = source + '\n\n세 부품은 같은 규격과 연결 구조를 공유하며 각각 독립적인 위치와 고유한 기능을 가지고 있다.';
  const rows = duplicates.introducedCandidates(source, output);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outputSpan, output);
  assert.ok(operator.targets(source, output).some(t => t.codes.includes('introduced_adjacent_duplicate_candidate')));
  assert.equal(duplicates.introducedCandidates(output, output).length, 0);
  assert.equal(duplicates.introducedCandidates(output, output.replace('가지고 있다', '갖고 있다')).length, 0);
  assert.equal(duplicates.introducedCandidates(source, output.replace('세 부품은 같은 규격', '세 부품은 서로 다른 규격')).length, 0);
});
test('split replay across adjacent paragraphs is reviewed without confusing a quoted term between them', () => {
  const source = '세 장치는 동일한 규격과 연결 구조를 공유하며 각각 독립적인 위치와 고유한 기능을 가진다. 원리는 안내서에 자세히 설명되어 있다.';
  const output = '세 장치는 동일한 규격과 연결 구조를 공유한다. 각각 독립적인 위치와 고유한 기능을 가진다.\n\n안내서에서는 이를 ‘분산 구조’라고 부른다. 세 장치는 동일한 규격과 연결 구조를 공유하며 각각 독립적인 위치와 고유한 기능을 가지고 있다.';
  const found = duplicates.introducedCandidates(source, output);
  assert.equal(found.length, 1);
  assert.ok(found[0].outputSpan.includes('분산 구조'));
  assert.equal(duplicates.introducedCandidates(output, output).length, 0);
});

// 2026-10-11 운영 실패 재발 방지: 형태를 지키는 글(시·명사형 제목 나열)도 엔진 전체 실행이
// 끝까지 가야 한다. 10/8~10/11에는 구간 계획을 읽는 자리에서 TypeError로 전부 실패했다.
test('a preservation-only document runs through the whole engine instead of crashing', async t => {
  const { load } = require('./helpers/judge-effort-capture.cjs');
  const names = ['OPENAI_API_KEY', 'OPENAI_SAFETY_SALT'];
  const old = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => (old[i] === undefined ? delete process.env[name] : process.env[name] = old[i])));
  process.env.OPENAI_API_KEY = 'offline-test-key';
  process.env.OPENAI_SAFETY_SALT = 'x'.repeat(40);
  const poem = ['아아, 오래된 등불', '창가에 꼬박꼬박 고이는 바람', '', '빈 골목을 건너는 이름', '아직 남아 있는 그림자', '',
    '늦은 오후의 풍경', '여름 끝의 기록', '', '도시와 기억', '조용한 약속'].join('\n');
  assert.equal(depth.isPreservationOnly(poem, { documentProfile: 'creative' }), true);
  const runtime = load('lib/gptRuntimeConfig.js');
  const ledger = load('engine-gpt-prod/callLedger.js');
  const client = load('engine-gpt-prod/openaiClient.js', {
    './callLedger': ledger,
    '../lib/logger': { logger: { info() {}, warn() {}, error() {} } },
    '../lib/outboundPolicy': { outboundFetch: async (_provider, _url, init) => {
      const body = JSON.parse(init.body);
      const name = body.text?.format?.name || '';
      const json = name === 'gpt_prod_humanize_result' ? { outputText: poem }
        : { outputText: poem, safeChangeFound: false, notes: [], violations: [], pass: true };
      return Response.json({ status: 'completed', output_text: JSON.stringify(json),
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } });
    } }
  });
  const judge = load('engine-gpt-prod/judge.js', { './openaiClient': client, '../lib/gptRuntimeConfig': runtime });
  const quality = load('engine-gpt-prod/finalQualityV2.js', { './judge': judge, './openaiClient': client });
  const engine = load('engine-gpt-prod/index.js', { './openaiClient': client, '../lib/gptRuntimeConfig': runtime, './finalQualityV2': quality });
  let failure = null;
  const out = await engine.run({ text: poem, mode: 'blog', lang: 'ko', documentProfileOverride: 'creative',
    config: runtime.sanitizeConfig({}) }).catch(error => { failure = error; return null; });
  // 엔진이 정책상 변환을 거절하는 것은 허용한다. 코드 오류(TypeError)로 죽으면 안 된다.
  assert.equal(failure instanceof TypeError, false, failure && failure.message);
  assert.doesNotMatch(String(failure?.message || ''), /Cannot read properties/u);
  if (out) assert.equal((out.engineMeta || out.result?.engineMeta || {}).humanizationPlanDistributionAligned, true);
});
