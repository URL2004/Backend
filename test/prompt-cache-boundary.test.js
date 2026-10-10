'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const client = require('../engine-gpt-prod/openaiClient');
const prompts = require('../engine-gpt-prod/prompts/humanize');
const { buildHumanizeContract } = require('../engine-gpt-prod/humanizeContract');
const { buildVoiceProfile } = require('../engine-gpt-prod/voiceProfile');
const { humanizeCacheableSystem, repairCacheableSystem } = require('../engine-gpt-prod/promptCachePolicy');
const config = require('../lib/gptRuntimeConfig').DEFAULT_CONFIG;
const source = '자료를 비교하여 차이가 발생한 원인을 자세히 분석했다. 여러 조건에서 실험한 결과를 표로 정리했다. 다음 시간에는 분석 방법을 다시 검토했다.';
const profiles = ['unknown', 'academic_paper', 'resume_application', 'personal_essay', 'student_record_teacher', 'blog_review', 'legal_contract'];
const digest = values => crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };

function mockTransport(t, reply = () => ({ value: 'ok' })) {
  const bodies = [];
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'offline-test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  t.mock.method(global, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    bodies.push(body);
    return Response.json({ status: 'completed', output_text: JSON.stringify(reply(body, bodies.length)),
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  });
  return bodies;
}

function instructionText(body) {
  return body.input.filter(item => item.role === 'developer').map(item => (
    typeof item.content === 'string' ? item.content : item.content.map(part => part.text).join('')
  )).join('');
}

test('252 humanize assemblies preserve f9fed94 bytes and share a prefix across profiles, modes, strengths and voices', () => {
  const systems = [], prefixes = new Map();
  for (const profile of profiles) for (const mode of ['assignment', 'blog', 'polish'])
    for (const strength of ['basic', 'advanced', 'polish']) for (const promptVariant of ['full', 'compact_v1'])
      for (const relationGuard of ['off', 'clear_relations_v1']) {
        const documentProfile = { profile, formatProfile: { flags: profile === 'legal_contract' ? ['compressed_multicolumn'] : [] } };
        const voiceProfile = buildVoiceProfile(source + (mode === 'blog' ? ' 나는 결과를 확인했다.' : ''), { documentProfile });
        const hp = prompts.buildHumanizePrompt(mode, 'ko', { documentProfile, voiceProfile, requestStrength: strength,
          promptVariant, relationGuard, register: mode === 'blog' ? 'polite' : 'plain', lengthPolicy: { min: .9, max: 1.12 } });
        systems.push(hp.stable);
        const key = `${promptVariant}/${relationGuard}`;
        if (prefixes.has(key)) assert.equal(hp.cacheableSystem, prefixes.get(key));
        prefixes.set(key, hp.cacheableSystem);
        assert.ok(hp.cacheableSystem.endsWith('\n\n'));
        assert.ok(hp.stable.slice(hp.cacheableSystem.length).startsWith('[불변 계약]'));
        assert.deepEqual(Buffer.concat([Buffer.from(hp.cacheableSystem), Buffer.from(hp.stable.slice(hp.cacheableSystem.length))]), Buffer.from(hp.stable));
        assert.equal(prompts.validateHumanizePrompt(hp.stable).pass, true);
      }
  // Generated from the untouched f9fed94 builder, never from the new prefix.
  assert.equal(digest(systems), 'ee9bddb7174b3361df8e52200333b12e0937d68115161de763de53d688a115fe');
  assert.deepEqual([...prefixes.values()].map(s => s.length), [5009, 5326, 3845, 4162]);
});

test('humanize preserves Luna chunk reuse and keeps retry reasons after the Sol boundary', async t => {
  const bodies = mockTransport(t);
  for (const model of ['gpt-6-luna', 'gpt-6-luna-2026-09-22', 'gpt-6.1-sol', 'gpt-6-sol']) {
    for (const reason of ['noop_unchanged', 'structure_boundary', 'number_fact']) {
      const hp = prompts.buildHumanizePrompt('assignment');
      const phase = model.startsWith('gpt-6-luna') ? 'primary' : 'escalation';
      const system = [hp.stable, phase === 'escalation' ? prompts.buildEscalationInstruction(reason) : ''].filter(Boolean).join('\n\n');
      const cacheableSystem = humanizeCacheableSystem(hp, { model, phase });
      await client.completeJson({ system, cacheableSystem, user: source, model, schema, config,
        maxOutputTokens: 4321, reasoningEffort: 'high', meta: { task: 'humanize', phase } });
      const body = bodies.at(-1);
      assert.deepEqual(Buffer.from(instructionText(body)), Buffer.from(system));
      assert.equal(body.input.length, 2);
      assert.equal(body.input[0].content.length, phase === 'primary' ? 1 : 2);
      assert.equal(body.input[0].content[0].text, cacheableSystem || system);
      assert.equal(body.model, model);
      assert.equal(body.reasoning.effort, 'high');
      assert.equal(body.max_output_tokens, 4321);
      assert.equal(body.prompt_cache_key, client.promptCacheKey(config, { model, task: 'humanize', phase }));
      assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
    }
  }
});

test('repair callers preserve all 189 baseline assemblies and put the measured boundary in actual request bodies', async t => {
  const bodies = mockTransport(t, body => body.text.format.name === 'gpt_prod_conservative_sentence_retry'
    ? { rewrittenSentence: source.split('. ')[0] + '.', safeChangeFound: false, notes: [] } : { outputText: source, safeChangeFound: false, notes: [] });
  const stop = new Error('offline capture complete');
  const original = client.completeJson;
  const calls = [];
  t.mock.method(client, 'completeJson', async options => {
    calls.push(options);
    await original(options);
    throw stop;
  });
  const filename = require.resolve('../engine-gpt-prod/finalQualityV2');
  delete require.cache[filename];
  const quality = require(filename);
  t.after(() => { delete require.cache[filename]; });
  const byFamily = {}, common = new Map();
  for (const profile of profiles) for (const strength of ['basic', 'advanced', 'polish']) {
    const documentProfile = { profile, formatProfile: { flags: [] } };
    const base = { source, currentOutput: source, documentProfile, mode: strength === 'polish' ? 'polish' : 'assignment', config,
      humanizationPlan: { profile, requestStrength: strength }, humanizeContract: buildHumanizeContract({ documentProfile, requestStrength: strength }),
      humanizationDepthReport: { reasons: profile === 'resume_application' ? ['resume_semantic_repetition_low', 'paragraph_rewrite_coverage_low'] : ['structural_rewrite_coverage_low'] } };
    const cases = [
      ['retryGeneralSurface', base],
      ['retryGeneralSurface', { ...base, phase: 'humanization_no_effect_retry', model: 'gpt-6.1-sol' }],
      ['retryPolishSurface', { ...base, reason: strength === 'polish' ? 'evaluative_padding' : '', policy: { limits: { minEdit: .01, maxEdit: .2, minLength: .9, maxLength: 1.1 } } }],
      ['retryKoreanRefinement', { ...base, refinementAudit: { repairableIssues: [{ code: 'focus_particle_redundancy', afterCount: 1, message: '합성 검사', sentenceOrdinals: [1] }] } }],
      ['retryFingerprintAudit', { ...base, fingerprintAudit: { violations: [{ code: 'contrast_relation_shift', sentenceOrdinals: [1] }] } }],
      ['retryEndingStyleAudit', { ...base, endingAudit: { issues: [{ index: 0, dominantStyle: 'formal', introducedStyles: [{ style: 'polite', count: 2 }], introducedOtherCount: 2 }] } }],
      ['retryResumeCoverage', { ...base, coverageAudit: { omissions: [{ sourceOrdinal: 1, sourceSentence: source, types: ['omission'], contentRecall: .4 }] } }],
      ['retryConservativeSentenceSurface', { ...base, targetOrdinal: 1 }],
      ['retryCollapsedKoreanSpacing', { ...base, source: '우리는자료를비교하여차이가발생한원인을자세히분석하고여러조건에서실험한결과를표로정리한뒤다음시간에는분석방법을다시검토했다.' }]
    ];
    for (const [fn, args] of cases) {
      await assert.rejects(quality[fn](args), error => error === stop);
      const options = calls.at(-1), body = bodies.at(-1);
      (byFamily[fn] ||= []).push(options.system);
      assert.deepEqual(Buffer.from(instructionText(body)), Buffer.from(options.system));
      assert.equal(body.input.length, 2);
      assert.equal(body.model, options.model);
      assert.equal(body.max_output_tokens, options.maxOutputTokens);
      assert.equal(body.reasoning.effort, options.reasoningEffort);
      assert.equal(body.prompt_cache_key, client.promptCacheKey(options.config, { ...options.meta, model: options.model, schemaName: options.schemaName }));
      if (options.cacheableSystem === false) {
        assert.doesNotMatch(JSON.stringify(body), /prompt_cache_breakpoint/);
        assert.equal(body.input[0].content.length, 1);
      } else if (typeof options.cacheableSystem === 'string') {
        assert.equal(body.input[0].content[0].text, options.cacheableSystem);
        assert.equal(body.input[0].content.length, 2);
        assert.equal(body.input[0].content[1].prompt_cache_breakpoint, undefined);
        assert.deepEqual(body.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
        if (common.has(fn)) assert.equal(options.cacheableSystem, common.get(fn));
        common.set(fn, options.cacheableSystem);
      } else {
        assert.equal(body.input[0].content[0].text, options.system);
      }
    }
  }
  assert.equal(calls.length, 189);
  const expected = {
    retryGeneralSurface: '7ac288c98e6adc9eb48ab4b425d648f75d12863fde2556bf18bcf49e1e022c8b',
    retryPolishSurface: '777a84bc24a3dde0a3ae68b3674c444f82cdb72c79fbca236445712548c75130',
    retryKoreanRefinement: 'eb0a0aab3cad78ec384eea4ef8958b6ed8b2497d14497e71c196c801fd60281e',
    retryFingerprintAudit: 'cb557c702d25af84371507e1bc87c47223002e0fa7c77fbfaf3ad429eb1f1456',
    retryEndingStyleAudit: 'c5738849675e94079f492e73c962da8a1bcb13201a226a0ed84993aca5a51d00',
    retryResumeCoverage: 'db8b5fa9b78cb60a87be9b7968bc86e640d31dfbfb33663d56bfbc2bd4a22715',
    retryConservativeSentenceSurface: '295abf0a08b5944d066bc4bf8d5e86c5addfebf0e21c5e9bbaa453f214770221',
    retryCollapsedKoreanSpacing: '40bcf480513511a07fddbeb0ad2b73847d45772a58bd3ad72153bd096c36d9db'
  };
  for (const [fn, systems] of Object.entries(byFamily)) assert.equal(digest(systems), expected[fn], fn);
  assert.equal(common.get('retryGeneralSurface').length, 2845);
  assert.equal(common.get('retryEndingStyleAudit').length, 3218);
});

test('schema retry follows the complete original instructions, including the uncached tail', async t => {
  const bodies = mockTransport(t, (_body, count) => count % 2 ? { wrong: true } : { value: 'ok' });
  for (const task of ['humanize', 'repair']) {
    await client.completeJson({ system: 'common\n\nvariable rule', cacheableSystem: 'common\n\n', user: source,
      model: 'gpt-6.1-sol', schema, meta: { task } });
    const first = bodies.at(-2), retry = bodies.at(-1);
    assert.deepEqual(retry.input[0], first.input[0]);
    assert.equal(instructionText(first), 'common\n\nvariable rule');
    assert.match(retry.input[1].content, /^\[구조화 출력 재시도\]/u);
    assert.equal(retry.input.at(-1).content, source);
  }
});

test('judge retains its exact developer-message layout and retry ordering', async t => {
  const bodies = mockTransport(t, (_body, count) => count === 1 ? { wrong: true } : { value: 'ok' });
  await client.completeJson({ system: 'judge common\nconditional', cacheableSystem: 'judge common', user: source,
    model: 'gpt-6-luna', schema, meta: { task: 'judge' } });
  assert.deepEqual(bodies[0].input, [
    { role: 'developer', content: [{ type: 'input_text', text: 'judge common', prompt_cache_breakpoint: { mode: 'explicit' } }] },
    { role: 'developer', content: '\nconditional' }, { role: 'user', content: source }
  ]);
  assert.deepEqual(bodies[1].input[0], bodies[0].input[0]);
  assert.deepEqual(bodies[1].input.slice(2), bodies[0].input.slice(1));
});

test('disabled short prefixes never fall back to writing the whole system; non-GPT-6 format stays unchanged', async t => {
  const bodies = mockTransport(t);
  for (const model of ['gpt-6-luna', 'gpt-5.6-luna']) {
    await client.completeJson({ system: 'short', cacheableSystem: false, user: source, model, schema, meta: { task: 'repair' } });
  }
  assert.doesNotMatch(JSON.stringify(bodies[0]), /prompt_cache_breakpoint/);
  assert.ok(bodies[0].prompt_cache_key);
  assert.deepEqual(bodies[0].input, [{ role: 'developer', content: [{ type: 'input_text', text: 'short' }] }, { role: 'user', content: source }]);
  assert.equal(bodies[1].instructions, 'short');
  assert.equal(bodies[1].input, source);
});

test('unrecognized boundaries fail closed and observed profitable whole-prompt paths stay intact', () => {
  assert.equal(repairCacheableSystem('unexpected assembly', { family: 'general_surface' }), false);
  assert.equal(repairCacheableSystem('unexpected assembly', { family: 'ending_style' }), false);
  assert.equal(repairCacheableSystem('unchanged', { family: 'fingerprint' }), undefined);
  assert.equal(repairCacheableSystem('unchanged', { family: 'resume_coverage' }), undefined);
  assert.equal(repairCacheableSystem('unchanged', { family: 'general_surface', phase: 'humanization_role_recovery', model: 'gpt-6-luna' }), undefined);
});
