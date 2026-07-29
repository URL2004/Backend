'use strict';

// 운영 semantic judge는 SOURCE 전문과 결정론 원문 인덱스를 사용한다.
// 이 LLM 원장은 정확도 평가에서 두 원장 방식을 비교할 때만 사용한다.
const { completeJson } = require('../engine-gpt-prod/openaiClient');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const {
  buildPromptDataSections,
  promptEnvelopeSystemRule
} = require('../engine-gpt-prod/promptEnvelope');

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

async function buildSoftClaimLedger(rawText, {
  lang = 'ko',
  signal,
  config,
  model,
  reasoningEffort,
  phase = 'ledger',
  safetyIdentifier = ''
} = {}) {
  const cfg = config
    ? gptRuntimeConfig.publicConfig(config, config.source || 'inline')
    : await gptRuntimeConfig.getRuntimeConfig({ force: false });
  const source = String(rawText || '');
  const cap = Math.min(40, Math.max(12, Math.round(source.replace(/\s+/g, '').length / 300)));
  const system = lang === 'en'
    ? `Extract a closed-world claim ledger from SOURCE. evidence_text must be a verbatim substring. Return up to ${cap} claims. ${promptEnvelopeSystemRule()}`
    : `SOURCE에서 재작성 검증용 닫힌세계 claim 원장을 추출한다. evidence_text는 SOURCE의 그대로 부분 문자열이어야 한다. 최대 ${cap}개까지 반환한다. ${promptEnvelopeSystemRule()}`;
  const user = buildPromptDataSections([{ label: 'SOURCE', value: source }]).text;
  const response = await completeJson({
    system,
    user,
    schema: LEDGER_SCHEMA,
    schemaName: 'gpt_prod_eval_soft_claim_ledger',
    model: model || cfg.models.judge,
    reasoningEffort: reasoningEffort || cfg.reasoning.judge,
    verbosity: 'low',
    maxOutputTokens: Math.min(8192, 2048 + cap * 180),
    config: cfg,
    signal,
    safetyIdentifier,
    meta: { task: 'judge_eval', phase, mode: 'judge', profile: 'gpt_prod_eval' }
  });
  const claims = Array.isArray(response.json.claims) ? response.json.claims : [];
  const kept = claims.filter(claim => evidenceMatches(source, claim.evidence_text)).slice(0, cap);
  return {
    claims: kept,
    total: claims.length,
    dropped: claims.length - kept.length,
    gptMeta: {
      provider: response.provider,
      model: response.model,
      usage: response.usage
    }
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

function evidenceMatches(rawText, evidence) {
  const source = normalizeWhitespace(rawText);
  const value = normalizeWhitespace(evidence);
  if (value.length < 4) return false;
  if (source.includes(value)) return true;
  return source.includes(value.slice(0, Math.min(24, value.length)));
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

module.exports = {
  buildSoftClaimLedger,
  validateLedgerHealth
};
