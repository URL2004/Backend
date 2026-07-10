'use strict';

const { completeJson } = require('./openaiClient');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const { addUsage, emptyUsage } = require('./usageCost');
const { splitSentences } = require('../engine/koreanText');

const LEDGER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          evidence_text: { type: 'string' }
        },
        required: ['claim', 'evidence_text']
      }
    }
  },
  required: ['claims']
};

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    violations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['distortion', 'added_claim', 'omission'] },
          span: { type: 'string' },
          detail: { type: 'string' }
        },
        required: ['type', 'span', 'detail']
      }
    }
  },
  required: ['violations']
};

const REPAIR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outputText: { type: 'string' },
    repaired: { type: 'boolean' },
    notes: { type: 'array', items: { type: 'string' } }
  },
  required: ['outputText', 'repaired', 'notes']
};

async function loadConfig(config) {
  return config ? gptRuntimeConfig.publicConfig(config, config.source || 'inline') : gptRuntimeConfig.getRuntimeConfig({ force: false });
}

async function buildSoftClaimLedger(rawText, { lang = 'ko', signal, config, model, reasoningEffort, phase = 'ledger', safetyIdentifier = '' } = {}) {
  const cfg = await loadConfig(config);
  const source = String(rawText || '');
  const cap = Math.min(40, Math.max(12, Math.round(source.replace(/\s+/g, '').length / 300)));
  const system = lang === 'en'
    ? `Extract a closed-world claim ledger from SOURCE. evidence_text must be a verbatim substring. Return up to ${cap} claims.`
    : `SOURCE에서 재작성 검증용 닫힌세계 claim 원장을 추출한다. evidence_text는 SOURCE의 그대로 부분 문자열이어야 한다. 최대 ${cap}개까지 반환한다.`;
  const res = await completeJson({
    system,
    user: `[SOURCE]\n${source}`,
    schema: LEDGER_SCHEMA,
    schemaName: 'gpt_prod_soft_claim_ledger',
    model: model || cfg.models.judge,
    reasoningEffort: reasoningEffort || cfg.reasoning.judge,
    verbosity: 'low',
    maxOutputTokens: Math.min(8192, 2048 + cap * 180),
    config: cfg,
    signal,
    safetyIdentifier,
    meta: { task: 'judge', phase, mode: 'judge', profile: 'gpt_prod_judge' }
  });
  const claims = Array.isArray(res.json.claims) ? res.json.claims : [];
  const kept = claims.filter(c => evidenceMatches(source, c.evidence_text)).slice(0, cap);
  return {
    claims: kept,
    total: claims.length,
    dropped: claims.length - kept.length,
    gptMeta: responseMeta(res)
  };
}

async function semanticJudge(rawText, outputText, ledger, { lang = 'ko', signal, config, allowedExtra = '', mode = '', model, reasoningEffort, phase = 'semantic', safetyIdentifier = '' } = {}) {
  const cfg = await loadConfig(config);
  const claimsText = ledgerToText(ledger);
  const system = lang === 'en'
    ? 'You are a strict but fair fact checker. Use only SOURCE CLAIM LEDGER as ground truth. Flag fabricated facts, meaning reversals, and omitted material claims. Return JSON only.'
    : '너는 엄격하지만 공정한 사실 검수 엔진이다. SOURCE CLAIM LEDGER만 기준으로 삼아 새 사실 추가, 의미 왜곡, 핵심 주장 누락을 잡는다. JSON만 반환한다.';
  const user = [
    `[SOURCE]\n${rawText}`,
    `[SOURCE CLAIM LEDGER]\n${claimsText}`,
    allowedExtra ? `[ALLOWED EXTRA]\n${allowedExtra}` : '',
    `[MODE]\n${mode || 'assignment'}`,
    `[REWRITE]\n${outputText}`
  ].filter(Boolean).join('\n\n');
  const res = await completeJson({
    system,
    user,
    schema: JUDGE_SCHEMA,
    schemaName: 'gpt_prod_semantic_judge',
    model: model || cfg.models.judge,
    reasoningEffort: reasoningEffort || cfg.reasoning.judge,
    verbosity: 'low',
    maxOutputTokens: 6000,
    config: cfg,
    signal,
    safetyIdentifier,
    meta: { task: 'judge', phase, mode, profile: 'gpt_prod_judge' }
  });
  const violations = (res.json.violations || [])
    .filter(v => v && ['distortion', 'added_claim', 'omission'].includes(v.type) && (v.detail || v.span))
    .map(v => ({
      ...v,
      spanVerified: v.span ? outputText.includes(v.span) : false
    }));
  return { pass: violations.length === 0, violations, gptMeta: responseMeta(res) };
}

async function repairViolations(rawText, outputText, ledger, violations, {
  lang = 'ko', signal, config, safetyIdentifier = '', model, reasoningEffort, phase = 'judge_repair'
} = {}) {
  if (!violations || !violations.length) return { outputText, repaired: false, notes: [] };
  const cfg = await loadConfig(config);
  const system = lang === 'en'
    ? 'Repair only the listed violations while preserving the original rewrite as much as possible. Do not add facts.'
    : '아래 위반 부분만 고치고 나머지 문장은 최대한 유지한다. 새 사실을 추가하지 않는다.';
  const user = [
    `[SOURCE]\n${rawText}`,
    `[SOURCE CLAIM LEDGER]\n${ledgerToText(ledger)}`,
    `[CURRENT REWRITE]\n${outputText}`,
    `[VIOLATIONS]\n${JSON.stringify(violations, null, 2)}`
  ].join('\n\n');
  const res = await completeJson({
    system,
    user,
    schema: REPAIR_SCHEMA,
    schemaName: 'gpt_prod_judge_repair',
    model: model || cfg.models.repair,
    reasoningEffort: reasoningEffort || cfg.reasoning.repair,
    verbosity: 'medium',
    maxOutputTokens: Math.max(2400, Math.min(12000, Math.ceil(String(outputText || '').length * 2.4))),
    config: cfg,
    signal,
    safetyIdentifier,
    meta: { task: 'repair', phase, mode: 'repair', profile: 'gpt_prod_judge' }
  });
  return {
    outputText: String(res.json.outputText || outputText).trim() || outputText,
    repaired: res.json.repaired === true,
    notes: Array.isArray(res.json.notes) ? res.json.notes : [],
    gptMeta: responseMeta(res)
  };
}

async function judgeAndRepair(rawText, outputText, { lang = 'ko', signal, config, maxRounds = 1, allowedExtra = '', mode = '', safetyIdentifier = '' } = {}) {
  const cfg = await loadConfig(config);
  const primary = await judgeAndRepairWithModel(rawText, outputText, {
    lang,
    signal,
    config: cfg,
    maxRounds,
    allowedExtra,
    mode,
    judgeModel: cfg.models.judge,
    judgeReasoning: cfg.reasoning.judge,
    phasePrefix: 'primary',
    safetyIdentifier
  });
  if (primary.pass === true) return primary;

  const escalationModel = cfg.models.judgeEscalation || cfg.models.humanizeEscalation || cfg.models.judge;
  if (!escalationModel || escalationModel === cfg.models.judge) return primary;

  const escalated = await judgeAndRepairWithModel(rawText, primary.outputText || outputText, {
    lang,
    signal,
    config: cfg,
    maxRounds: Math.max(0, maxRounds - (primary.rounds || 0)),
    allowedExtra,
    mode,
    judgeModel: escalationModel,
    judgeReasoning: cfg.reasoning.escalation || cfg.reasoning.judge,
    phasePrefix: 'escalation',
    safetyIdentifier
  });
  return {
    ...escalated,
    escalated: true,
    rounds: (primary.rounds || 0) + (escalated.rounds || 0),
    primaryJudge: summarizeJudge(primary),
    usage: addUsage(primary.usage || emptyUsage(), escalated.usage)
  };
}

async function judgeAndRepairWithModel(rawText, outputText, {
  lang,
  signal,
  config,
  maxRounds,
  allowedExtra,
  mode,
  judgeModel,
  judgeReasoning,
  phasePrefix,
  safetyIdentifier
}) {
  let ledger = await buildSoftClaimLedger(rawText, {
    lang,
    signal,
    config,
    model: judgeModel,
    reasoningEffort: judgeReasoning,
    phase: `${phasePrefix}:ledger`,
    safetyIdentifier
  });
  let usage = addUsage(emptyUsage(), ledger?.gptMeta?.usage);
  const health = validateLedgerHealth(ledger, rawText);
  if (!health.healthy) {
    ledger = {
      ...buildDeterministicLedger(rawText),
      extractionFallbackReason: health.reason,
      gptMeta: ledger?.gptMeta || null
    };
  }
  let current = outputText;
  let judge = await semanticJudge(rawText, current, ledger, {
    lang,
    signal,
    config,
    allowedExtra,
    mode,
    model: judgeModel,
    reasoningEffort: judgeReasoning,
    phase: `${phasePrefix}:semantic`,
    safetyIdentifier
  });
  usage = addUsage(usage, judge?.gptMeta?.usage);
  let rounds = 0;
  while (!judge.pass && rounds < maxRounds) {
    rounds++;
    const repairModel = phasePrefix === 'escalation' ? judgeModel : config.models.repair;
    const repairReasoning = phasePrefix === 'escalation' ? config.reasoning.escalation : config.reasoning.repair;
    const repaired = await repairViolations(rawText, current, ledger, judge.violations, {
      lang,
      signal,
      config,
      safetyIdentifier,
      model: repairModel,
      reasoningEffort: repairReasoning,
      phase: `${phasePrefix}:repair`
    });
    usage = addUsage(usage, repaired?.gptMeta?.usage);
    current = repaired.outputText || current;
    judge = await semanticJudge(rawText, current, ledger, {
      lang,
      signal,
      config,
      allowedExtra,
      mode,
      model: judgeModel,
      reasoningEffort: judgeReasoning,
      phase: `${phasePrefix}:semantic_after_repair`,
      safetyIdentifier
    });
    usage = addUsage(usage, judge?.gptMeta?.usage);
  }
  return {
    outputText: current,
    pass: judge.pass,
    violations: judge.violations || [],
    ledger,
    rounds,
    selectedJudgeModel: judgeModel,
    usage
  };
}

function summarizeJudge(report) {
  return {
    pass: report?.pass === true,
    skipped: report?.skipped === true,
    reason: report?.reason || '',
    selectedJudgeModel: report?.selectedJudgeModel || '',
    violationCount: Array.isArray(report?.violations) ? report.violations.length : 0
  };
}

function validateLedgerHealth(ledger, rawText) {
  const claims = ledger?.claims?.length || 0;
  const total = ledger?.total || 0;
  const dropped = ledger?.dropped || 0;
  const rawLen = String(rawText || '').replace(/\s+/g, '').length;
  if (claims === 0) return { healthy: false, reason: 'no_claims' };
  if (total >= 3 && dropped / total > 0.5) return { healthy: false, reason: 'high_drop' };
  if (rawLen >= 1500 && claims < 3) return { healthy: false, reason: 'undercovered' };
  return { healthy: true, reason: 'ok' };
}

function buildDeterministicLedger(rawText) {
  const source = String(rawText || '');
  const cap = Math.min(40, Math.max(12, Math.round(source.replace(/\s+/g, '').length / 300)));
  const seen = new Set();
  const candidates = [];
  const add = value => {
    const exact = String(value || '').trim();
    if (exact.length < 4 || seen.has(exact)) return;
    seen.add(exact);
    candidates.push(exact);
  };
  splitSentences(source).forEach(add);
  source.split(/\n+/).forEach(add);
  const selected = evenlySample(candidates, cap);
  return {
    claims: selected.map(evidence => ({ claim: evidence, evidence_text: evidence })),
    total: selected.length,
    dropped: 0,
    sourceCandidateCount: candidates.length,
    deterministic: true
  };
}

function evenlySample(values, cap) {
  if (values.length <= cap) return values;
  const selected = [];
  const used = new Set();
  for (let i = 0; i < cap; i += 1) {
    const index = Math.round(i * (values.length - 1) / Math.max(1, cap - 1));
    if (used.has(index)) continue;
    used.add(index);
    selected.push(values[index]);
  }
  return selected;
}

function ledgerToText(ledger) {
  const claims = ledger?.claims || [];
  if (!claims.length) return '(none)';
  return claims.map((c, i) => `${i + 1}. ${c.claim}\n   근거(원문): "${String(c.evidence_text || '').trim()}"`).join('\n');
}

function evidenceMatches(rawText, ev) {
  const r = normWS(rawText);
  const e = normWS(ev);
  if (e.length < 4) return false;
  if (r.includes(e)) return true;
  return r.includes(e.slice(0, Math.min(24, e.length)));
}

function normWS(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function responseMeta(res) {
  return {
    selectedModel: res.model,
    cachedInputTokens: res.usage?.cachedInputTokens || 0,
    reasoningTokens: res.usage?.reasoningTokens || 0,
    estimatedUsd: res.usage?.estimatedUsd || 0,
    usage: res.usage
  };
}

module.exports = {
  buildSoftClaimLedger,
  semanticJudge,
  repairViolations,
  judgeAndRepair,
  validateLedgerHealth,
  evidenceMatches
};
