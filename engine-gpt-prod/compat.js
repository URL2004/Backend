'use strict';

const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const engine = require('./index');
const judge = require('./judge');
const { completeJson } = require('./openaiClient');

function strictSchema(schema) {
  const src = schema && typeof schema === 'object' ? schema : {};
  const out = { ...src };
  if (out.type === 'object' || out.properties) {
    out.type = 'object';
    const props = out.properties && typeof out.properties === 'object' ? out.properties : {};
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, strictSchema(v)]));
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  } else if (out.type === 'array' || out.items) {
    out.type = 'array';
    out.items = strictSchema(out.items || { type: 'string' });
  }
  delete out.description;
  return out;
}

function schemaFromTool(tool) {
  return strictSchema(tool?.input_schema || tool?.parameters || {
    type: 'object',
    properties: { outputText: { type: 'string' } },
    required: ['outputText']
  });
}

function modelForTask(cfg, task = '', phase = '') {
  const t = String(task || '').toLowerCase();
  const p = String(phase || '').toLowerCase();
  if (t.includes('detect')) return p.includes('escalation') ? cfg.models.detectEscalation : cfg.models.detect;
  if (t.includes('evidence') || t.includes('search')) return p.includes('escalation') ? cfg.models.evidenceEscalation : cfg.models.evidenceSearch;
  if (p.includes('repair') || p.includes('refine') || p.includes('rewrite')) return cfg.models.repair;
  if (t.includes('coach') || t.includes('classify')) return cfg.models.classify;
  if (t.includes('judge')) return cfg.models.judge;
  if (t.includes('humanize') || t.includes('analyze')) return cfg.models.humanizePrimary;
  return cfg.models.judge;
}

function reasoningForTask(cfg, task = '', phase = '') {
  const t = String(task || '').toLowerCase();
  const p = String(phase || '').toLowerCase();
  if (t.includes('detect')) return cfg.reasoning.detect;
  if (t.includes('evidence') || t.includes('search')) return cfg.reasoning.evidenceSearch;
  if (p.includes('repair') || p.includes('refine') || p.includes('rewrite')) return cfg.reasoning.repair;
  if (t.includes('coach') || t.includes('classify')) return cfg.reasoning.classify;
  if (t.includes('judge')) return cfg.reasoning.judge;
  return cfg.reasoning.humanize;
}

async function loadConfig(config) {
  return config ? gptRuntimeConfig.publicConfig(config, config.source || 'inline') : gptRuntimeConfig.getRuntimeConfig({ force: false });
}

async function callGpt({
  userText,
  systemText,
  systemVolatile,
  tool,
  maxOutputTokens,
  signal,
  task,
  phase,
  mode,
  config,
  model,
  reasoningEffort,
  verbosity
} = {}) {
  const cfg = await loadConfig(config);
  const selectedModel = model || modelForTask(cfg, task, phase);
  const selectedReasoning = reasoningEffort || reasoningForTask(cfg, task, phase);
  const system = [systemText, systemVolatile].filter(Boolean).join('\n\n');
  const res = await completeJson({
    system,
    user: userText,
    schema: schemaFromTool(tool),
    schemaName: tool?.name || 'gpt_compat_result',
    model: selectedModel,
    reasoningEffort: selectedReasoning,
    verbosity: verbosity || 'medium',
    maxOutputTokens: maxOutputTokens || 4096,
    config: cfg,
    signal,
    meta: {
      task: task || 'gpt_compat',
      phase: phase || 'main',
      mode: mode || '',
      profile: 'gpt_compat',
      schemaName: tool?.name || 'gpt_compat_result'
    }
  });
  return {
    type: 'message',
    provider: 'openai',
    model: res.model,
    content: [{ type: 'tool_use', name: tool?.name || 'gpt_compat_result', input: res.json }],
    usage: res.usage,
    stop_reason: res.incompleteReason ? 'max_tokens' : 'end_turn',
    gptMeta: {
      selectedModel: res.model,
      cachedInputTokens: res.usage?.cachedInputTokens || 0,
      reasoningTokens: res.usage?.reasoningTokens || 0,
      estimatedUsd: res.usage?.estimatedUsd || 0
    },
    raw: res.raw
  };
}

function extractGptResult(data, toolName) {
  if (data?.json && typeof data.json === 'object') return data.json;
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const useBlock = blocks.find(b => b && b.type === 'tool_use' && (!toolName || b.name === toolName));
  if (!useBlock) throw new Error('GPT structured response was not returned.');
  return useBlock.input && typeof useBlock.input === 'object' ? useBlock.input : {};
}

async function runHumanize(opts = {}) {
  const out = await engine.run(opts);
  return out.result;
}

async function runHumanizeChunked(opts = {}) {
  return await engine.run(opts);
}

async function runDetect(text, lang = 'ko', opts = {}) {
  return await engine.detect({ text, lang, allowLocalFallback: false, ...opts });
}

async function suggestEvidence(opts = {}) {
  return await engine.suggestEvidence(opts);
}

async function rewriteSentence(opts = {}) {
  return await engine.rewriteSentence(opts);
}

async function judgeAndRepair(...args) {
  return await judge.judgeAndRepair(...args);
}

function buildDetectTool(lang = 'ko') {
  const isEn = lang === 'en';
  return {
    name: 'return_detection_result',
    description: 'AI generated probability result.',
    input_schema: {
      type: 'object',
      properties: {
        probability: { type: 'number' },
        summary: { type: 'string' },
        detail: { type: 'string' },
        signals: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
      },
      required: isEn
        ? ['probability', 'summary', 'detail', 'signals', 'confidence']
        : ['probability', 'summary', 'detail', 'signals', 'confidence']
    }
  };
}

module.exports = {
  callGpt,
  extractGptResult,
  runHumanize,
  runHumanizeChunked,
  runDetect,
  suggestEvidence,
  rewriteSentence,
  judgeAndRepair,
  buildSoftClaimLedger: judge.buildSoftClaimLedger,
  semanticJudge: judge.semanticJudge,
  repairViolations: judge.repairViolations,
  buildDetectTool,
  strictSchema
};
