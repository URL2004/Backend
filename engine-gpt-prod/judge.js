'use strict';

const { completeJson } = require('./openaiClient');
const gptRuntimeConfig = require('../lib/gptRuntimeConfig');
const { addUsage, emptyUsage } = require('./usageCost');
const floor = require('../engine/floor');
const { splitSentences, computeEditMetrics } = require('../engine/koreanText');
const { buildVoiceProfile, sentenceDistributionShift } = require('./voiceProfile');

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
    ? 'You are a strict but fair fact checker. SOURCE is the sole ground truth. SOURCE CLAIM LEDGER is a verified, non-exhaustive index of source passages. Compare the entire SOURCE and flag fabricated facts, meaning reversals, and omitted material claims. Return JSON only.'
    : '너는 엄격하지만 공정한 사실 검수 엔진이다. SOURCE 전체를 유일한 사실 기준으로 삼는다. SOURCE CLAIM LEDGER는 원문 구절을 그대로 뽑은 검증 인덱스이며 완전한 목록은 아니다. SOURCE 전체와 비교해 새 사실 추가, 의미 왜곡, 핵심 주장 누락을 잡는다. JSON만 반환한다.';
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
    repairRejected: primary.repairRejected === true || escalated.repairRejected === true,
    repairRejectReasons: [...new Set([...(primary.repairRejectReasons || []), ...(escalated.repairRejectReasons || [])])],
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
  // 원문 구절을 그대로 균등 추출한 결정론 원장을 mini와 상위 판정기가
  // 공통 사용한다. 판정 모델은 SOURCE 전체를 함께 받으므로 원장은 단지
  // 검토 인덱스이며, 승격 때 같은 원장을 GPT로 다시 추출하지 않는다.
  // 이 경로는 정확도를 낮추는 캐시가 아니라 중복 모델 호출 제거다.
  const ledger = buildDeterministicLedger(rawText);
  let usage = emptyUsage();
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
  const initialViolations = [...(judge.violations || [])];
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
    const candidate = repaired.outputText || current;
    const repairSafety = assessRepairCandidate(rawText, current, candidate, { mode, allowedExtra });
    if (!repairSafety.pass) {
      return {
        outputText: current,
        pass: false,
        violations: initialViolations,
        initialViolations,
        ledger,
        rounds,
        repairRejected: true,
        repairRejectReasons: repairSafety.reasons,
        reason: 'repair_candidate_rejected',
        selectedJudgeModel: judgeModel,
        usage
      };
    }
    current = candidate;
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
    initialViolations,
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
    repairRejected: report?.repairRejected === true,
    repairRejectReasons: report?.repairRejectReasons || [],
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

function assessRepairCandidate(rawText, beforeText, candidateText, { mode = '', allowedExtra = '' } = {}) {
  const source = String(rawText || '');
  const before = String(beforeText || '');
  const candidate = String(candidateText || '');
  const reasons = [];
  if (!candidate.trim()) reasons.push('empty_candidate');
  const beforeMetrics = computeEditMetrics(source, before);
  const candidateMetrics = computeEditMetrics(source, candidate);
  const relativeLength = before.length ? candidate.length / before.length : 0;
  const polish = mode === 'polish';
  const minSourceLength = polish ? 0.9 : 0.82;
  const maxSourceLength = polish ? 1.1 : 1.25;
  if (candidateMetrics.lengthRatio < minSourceLength) reasons.push('source_length_short');
  if (candidateMetrics.lengthRatio > maxSourceLength) reasons.push('source_length_overrun');
  if (relativeLength < 0.82) reasons.push('repair_collapsed');
  if (relativeLength > 1.2) reasons.push('repair_expanded');

  const beforeLost = floor.measureLostFacts(source, before).count;
  const candidateLost = floor.measureLostFacts(source, candidate).count;
  const beforeNovelty = floor.measureNovelty(source, before, allowedExtra).count;
  const candidateNovelty = floor.measureNovelty(source, candidate, allowedExtra).count;
  if (candidateLost > beforeLost) reasons.push('lost_facts_worsened');
  if (candidateNovelty > beforeNovelty) reasons.push('novelty_worsened');
  const compact = value => String(value || '').normalize('NFC').replace(/\s+/gu, '');
  if (compact(candidate) === compact(source)
      && compact(before) !== compact(source)
      && beforeLost === 0
      && beforeNovelty === 0) {
    reasons.push('repair_erased_transform');
  }

  const sourceStructure = repairStructureSignature(source);
  const beforeStructure = repairStructureSignature(before);
  const candidateStructure = repairStructureSignature(candidate);
  for (const key of ['paragraphs', 'headings', 'listItems', 'quotes']) {
    const beforeDelta = Math.abs(beforeStructure[key] - sourceStructure[key]);
    const candidateDelta = Math.abs(candidateStructure[key] - sourceStructure[key]);
    if (candidateDelta > beforeDelta) reasons.push(`${key}_worsened`);
  }
  const beforeSentenceShape = sentenceShapeDistance(source, before);
  const candidateSentenceShape = sentenceShapeDistance(source, candidate);
  if (beforeSentenceShape.comparable
      && candidateSentenceShape.comparable
      && candidateSentenceShape.maxRelativeError > Math.max(0.35, beforeSentenceShape.maxRelativeError + 0.15)) {
    reasons.push('sentence_shape_worsened');
  }
  const sourceSentenceDistribution = buildVoiceProfile(source).sentence;
  const beforeDistributionShift = sentenceDistributionShift(sourceSentenceDistribution, buildVoiceProfile(before).sentence);
  const candidateDistributionShift = sentenceDistributionShift(sourceSentenceDistribution, buildVoiceProfile(candidate).sentence);
  if (!beforeDistributionShift.shift && candidateDistributionShift.shift) {
    reasons.push('sentence_distribution_worsened');
  }
  return {
    pass: reasons.length === 0,
    reasons: [...new Set(reasons)],
    beforeMetrics,
    candidateMetrics,
    beforeLost,
    candidateLost,
    beforeNovelty,
    candidateNovelty,
    beforeSentenceShape,
    candidateSentenceShape,
    beforeDistributionShift,
    candidateDistributionShift
  };
}

function sentenceShapeDistance(sourceText, candidateText) {
  const sourceLengths = splitSentences(sourceText).map(value => value.replace(/\s+/gu, '').length).filter(value => value >= 3);
  const candidateLengths = splitSentences(candidateText).map(value => value.replace(/\s+/gu, '').length).filter(value => value >= 3);
  if (sourceLengths.length < 4 || sourceLengths.length !== candidateLengths.length || sourceLengths.length > 40) {
    return { comparable: false, maxRelativeError: 0, averageRelativeError: 0 };
  }
  const errors = sourceLengths.map((length, index) => Math.abs(candidateLengths[index] - length) / Math.max(1, length));
  return {
    comparable: true,
    maxRelativeError: Math.max(...errors),
    averageRelativeError: errors.reduce((sum, value) => sum + value, 0) / errors.length
  };
}

function repairStructureSignature(value) {
  const text = String(value || '');
  return {
    paragraphs: text.split(/\n{2,}/u).map(item => item.trim()).filter(Boolean).length,
    headings: (text.match(/^\s*(?:#{1,6}\s+|제\s*\d+\s*(?:장|절|항)|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?|\d+(?:\.\d+){1,3}[.)]?)\s*\S.*$/gmu) || []).length,
    listItems: (text.match(/^\s*(?:[-*•▪◦]|\d+[.)]|[가-하][.)]|[①②③④⑤⑥⑦⑧⑨⑩])\s+/gmu) || []).length,
    quotes: (text.match(/["“”'‘’]/gu) || []).length
  };
}

function buildDeterministicLedger(rawText) {
  const source = String(rawText || '');
  const cap = Math.min(40, Math.max(12, Math.round(source.replace(/\s+/g, '').length / 300)));
  const seen = new Set();
  const candidates = [];
  const add = value => {
    const exact = String(value || '').trim();
    // SOURCE 전체가 한 줄인 문서는 그 줄 자체를 원장에 다시 넣으면 입력을
    // 통째로 중복한다. 긴 구절은 SOURCE 본문에서 직접 판정하고, 원장에는
    // 검토 위치를 찾는 데 유용한 짧은 원문 구절만 둔다.
    if (exact.length < 4 || exact.length > 600 || seen.has(exact)) return;
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
