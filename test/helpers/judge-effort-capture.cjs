'use strict';
// Offline request-body capture. The real routers, prompts and transport body
// builder run; the outbound boundary always returns synthetic responses.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const source = '조사팀은 지역별 자료를 검토했다. 결과 보고서는 기록실에 보관했다. 담당자는 조사 과정을 문서로 정리했다. 관련 자료는 다음 조사에 활용했다.';
const candidate = source.replace('지역별 자료를 검토했다', '지역별 자료를 수집했다')
  .replace('결과 보고서는 기록실에 보관했다.', '기록실에는 결과 보고서를 보관했다.');
const finding = { type: 'distortion', origin: 'introduced', relation: 'other',
  sourceSpan: source.split('. ')[0] + '.', candidateSpan: candidate.split('. ')[0] + '.',
  span: candidate.split('. ')[0] + '.', detail: '합성 사례: 자료를 검토한 행위가 수집한 행위로 바뀌었다.' };

function load(relative, overrides = {}, readSource = file => fs.readFileSync(file, 'utf8'), append = '') {
  const file = path.join(root, relative), req = createRequire(file), module = { exports: {} };
  vm.runInNewContext(readSource(file) + append, { module, exports: module.exports,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : req(name),
    __dirname: path.dirname(file), __filename: file, process, Buffer, console,
    Date, AbortSignal, AbortController, setTimeout, clearTimeout, URL, Response
  }, { filename: file });
  return module.exports;
}

async function capture(reasoning = {}, readSource) {
  const requests = [], logs = [];
  let scenario = '', ordinal = 0;
  const runtime = load('lib/gptRuntimeConfig.js', {}, readSource);
  const config = runtime.sanitizeConfig({ reasoning });
  const ledger = load('engine-gpt-prod/callLedger.js', {}, readSource);
  const { extractPromptDataSection } = require('../../engine-gpt-prod/promptEnvelope');
  const client = load('engine-gpt-prod/openaiClient.js', {
    './callLedger': ledger,
    '../lib/logger': { logger: { info: (event, data) => logs.push({ event, ...data }), warn() {} } },
    '../lib/outboundPolicy': { outboundFetch: async (_provider, _url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ scenario, body }); ordinal++;
      const prompt = Array.isArray(body.input) ? body.input.at(-1).content : body.input;
      const name = body.text.format.name;
      let json;
      if (name.includes('judge') && !name.includes('repair')) {
        json = require('./semantic-review-fixture.cjs')({ violations:
          (['escalation', 'confirmation-repair'].includes(scenario) && ordinal === 1)
            || (scenario === 'escalation-repair' && ordinal <= 2) ? [finding] : [] }, prompt);
      } else if (name === 'gpt_prod_relation_patch') {
        json = { patches: JSON.parse(extractPromptDataSection(prompt, 'TARGETS')).map(t => ({
          id: t.id, replacement: finding.sourceSpan })) };
      } else if (name === 'gpt_prod_humanize_result') json = { outputText: ordinal === 1 ? '' : source };
      else if (name === 'gpt_compat_result') json = { outputText: source };
      else json = { outputText: source, safeChangeFound: false, notes: [] };
      return Response.json({ status: 'completed', output_text: JSON.stringify(json),
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } });
    } }
  }, readSource);
  const judge = load('engine-gpt-prod/judge.js', { './openaiClient': client, '../lib/gptRuntimeConfig': runtime }, readSource);
  const quality = load('engine-gpt-prod/finalQualityV2.js', { './judge': judge, './openaiClient': client }, readSource);
  const engine = load('engine-gpt-prod/index.js', { './openaiClient': client,
    '../lib/gptRuntimeConfig': runtime, './finalQualityV2': quality }, readSource, '\nmodule.exports.captureProcessChunk = processChunk;');
  const compat = load('engine-gpt-prod/compat.js', { './openaiClient': client, './index': engine,
    './judge': judge, '../lib/gptRuntimeConfig': runtime }, readSource);
  const oldKey = process.env.OPENAI_API_KEY;
  const crypto = require('node:crypto'), oldRandom = crypto.randomBytes;
  process.env.OPENAI_API_KEY = 'offline-test-key';
  crypto.randomBytes = n => Buffer.alloc(n, 1); // Only the nonce is fixed for byte comparison.
  const run = async (name, fn) => { scenario = name; ordinal = 0; return fn(); };
  let callLedger;
  try {
    await ledger.run(async () => {
      for (const name of ['confirmation', 'escalation', 'confirmation-repair', 'escalation-repair', 'primary']) {
        await run(name, () => judge.judgeAndRepair(source, candidate, { config,
          requireConfirmation: name.startsWith('confirmation'),
          stagedConfirmation: name === 'escalation-repair', maxRounds: name.endsWith('repair') ? 1 : 0 }));
      }
      for (const [name, options] of [
        ['final-revalidation', { discourseSignals: ['final_semantic_revalidation', 'prior_failed_semantic_confirmation'] }],
        ['restoration-verification', { auditStage: 'final_relation_restoration_verification' }]
      ]) await run(name, () => quality.runSemanticDocumentAudit({ source, outputText: source, config, allowRepair: false, ...options }));
      await run('staging-sweep', async () => {
        const staging = require('../../engine-gpt-prod/semanticStaging');
        const pairs = [{ sourceContext: source, output: source, index: 0, alignment: 'shared_unique_heading' }];
        await staging.runConfirmationSweep({ source, pairs, outputs: [source], reports: [{ pass: true }], obligations: [],
          diagnostics: staging.createStagingDiagnostics(true), buildPairs: () => pairs,
          signalsFor: () => [], keyFor: () => 'synthetic', store: { lookup: () => null, has: () => false, record() {} },
          config, judge: judge.judgeAndRepair, pairMaxRounds: () => 0, restoreBoundary: (_before, after) => after,
          addUsage: require('../../engine-gpt-prod/usageCost').addUsage,
          mapWithConcurrency: async (items, _n, fn) => { for (const item of items) await fn(item); } });
      });
      await run('draft-escalation', async () => {
        const chunk = { text: source, index: 0, locked: false };
        await engine.captureProcessChunk({ chunk, chunks: [chunk], index: 0, source,
          contract: require('../../engine/contract').buildContract(source), cfg: config,
          mode: 'assignment', lang: 'ko' });
      });
      await run('repair-escalation', () => quality.retryGeneralSurface({ source, currentOutput: candidate, config,
        model: config.models.humanizeEscalation, reasoningEffort: config.reasoning.escalation,
        phase: 'section_depth_escalation' }));
      for (const [name, task, phase] of [
        ['compat-confirmation', 'judge', 'escalation:semantic'],
        ['compat-judge-repair', 'judge', 'escalation:repair'],
        ['detect-escalation', 'detect', 'escalation'], ['evidence-escalation', 'evidence', 'escalation']
      ]) await run(name, () => compat.callGpt({ config, task, phase, systemText: 'Synthetic instructions', userText: source }));
    }, (_result, snapshot) => { callLedger = snapshot; });
    return JSON.parse(JSON.stringify({ requests, logs, callLedger }));
  } finally {
    crypto.randomBytes = oldRandom;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
}
module.exports = { capture, load, source, candidate, finding };
