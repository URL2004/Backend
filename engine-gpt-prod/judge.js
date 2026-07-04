'use strict';

const { completeJson } = require('./openaiClient');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');

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
          type: { type: 'string', enum: ['distortion', 'added_claim'] },
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

async function buildSoftClaimLedger(rawText, { lang = 'ko', signal, config } = {}) {
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
    model: cfg.models.judge,
    reasoningEffort: cfg.reasoning.judge,
    verbosity: 'low',
    maxOutputTokens: Math.min(8192, 2048 + cap * 180),
    config: cfg,
    signal,
    meta: { task: 'judge', phase: 'ledger', mode: 'judge', profile: 'gpt_prod_judge' }
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

async function semanticJudge(rawText, outputText, ledger, { lang = 'ko', signal, config, allowedExtra = '', mode = '' } = {}) {
  const cfg = await loadConfig(config);
  const claimsText = ledgerToText(ledger);
  const system = lang === 'en'
    ? 'You are a strict but fair fact checker. Use only SOURCE CLAIM LEDGER as ground truth. Flag fabricated external facts and meaning reversals. Return JSON only.'
    : '너는 엄격하지만 공정한 사실 검수 엔진이다. SOURCE CLAIM LEDGER만 기준으로 삼아, 새 사실 추가와 의미 왜곡만 잡는다. JSON만 반환한다.';
  const user = [
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
    model: cfg.models.judge,
    reasoningEffort: cfg.reasoning.judge,
    verbosity: 'low',
    maxOutputTokens: 2400,
    config: cfg,
    signal,
    meta: { task: 'judge', phase: 'semantic', mode, profile: 'gpt_prod_judge' }
  });
  const violations = (res.json.violations || []).filter(v => v && outputText.includes(v.span || ''));
  return { pass: violations.length === 0, violations, gptMeta: responseMeta(res) };
}

async function repairViolations(rawText, outputText, ledger, violations, { lang = 'ko', signal, config } = {}) {
  if (!violations || !violations.length) return { outputText, repaired: false, notes: [] };
  const cfg = await loadConfig(config);
  const system = lang === 'en'
    ? 'Repair only the listed violations while preserving the original rewrite as much as possible. Do not add facts.'
    : '아래 위반 부분만 고치고 나머지 문장은 최대한 유지한다. 새 사실을 추가하지 않는다.';
  const user = [
    `[SOURCE CLAIM LEDGER]\n${ledgerToText(ledger)}`,
    `[CURRENT REWRITE]\n${outputText}`,
    `[VIOLATIONS]\n${JSON.stringify(violations, null, 2)}`
  ].join('\n\n');
  const res = await completeJson({
    system,
    user,
    schema: REPAIR_SCHEMA,
    schemaName: 'gpt_prod_judge_repair',
    model: cfg.models.repair,
    reasoningEffort: cfg.reasoning.repair,
    verbosity: 'medium',
    maxOutputTokens: Math.max(1200, Math.min(8192, Math.ceil(String(outputText || '').length * 1.8))),
    config: cfg,
    signal,
    meta: { task: 'repair', phase: 'judge_repair', mode: 'repair', profile: 'gpt_prod_judge' }
  });
  return {
    outputText: String(res.json.outputText || outputText).trim() || outputText,
    repaired: res.json.repaired === true,
    notes: Array.isArray(res.json.notes) ? res.json.notes : [],
    gptMeta: responseMeta(res)
  };
}

async function judgeAndRepair(rawText, outputText, { lang = 'ko', signal, config, maxRounds = 1, allowedExtra = '', mode = '' } = {}) {
  const ledger = await buildSoftClaimLedger(rawText, { lang, signal, config });
  const health = validateLedgerHealth(ledger, rawText);
  if (!health.healthy) {
    return { outputText, pass: false, skipped: true, reason: health.reason, ledger };
  }
  let current = outputText;
  let judge = await semanticJudge(rawText, current, ledger, { lang, signal, config, allowedExtra, mode });
  let rounds = 0;
  while (!judge.pass && rounds < maxRounds) {
    rounds++;
    const repaired = await repairViolations(rawText, current, ledger, judge.violations, { lang, signal, config });
    current = repaired.outputText || current;
    judge = await semanticJudge(rawText, current, ledger, { lang, signal, config, allowedExtra, mode });
  }
  return {
    outputText: current,
    pass: judge.pass,
    violations: judge.violations || [],
    ledger,
    rounds
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
