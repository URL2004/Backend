'use strict';

// Request-local semantic section receipts.
//
// A receipt records that ONE completed judge verdict passed for an exact
// review pair. It is reused only when a later audit in the SAME request would
// issue an equivalent judge request: identical source context, identical
// candidate text (exact, never a whitespace/layout projection), identical
// document segmentation, identical neighbour edges, identical pair signals,
// identical prior obligations, identical judge route and model/reasoning
// configuration. Anything else is a miss and the section is judged fresh.
//
// Only digests and a minimal verdict are stored. The store lives in a closure
// created per request, is never exported globally, and never serialised.
// Similarity, restored source text or a failed/uncertain/skipped verdict can
// never create or satisfy a receipt.

const { createHash } = require('node:crypto');
const { VERSION: PROVENANCE_VERSION } = require('./semanticProvenance');

const RECEIPT_VERSION = 'semantic-segment-receipt-v1';
const RELATION_CONTRACT = 'semantic-relations-v2';
const CONTROL_SIGNALS = new Set(['final_semantic_revalidation', 'prior_failed_semantic_confirmation']);
const MAX_RECEIPTS = 256;

const digest = value => createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');

function stableJson(value, seen = new WeakSet()) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') return '"[fn]"';
    if (typeof value === 'bigint') return JSON.stringify(String(value));
    return JSON.stringify(value);
  }
  if (seen.has(value)) throw new Error('cyclic_receipt_input');
  seen.add(value);
  const out = Array.isArray(value)
    ? `[${value.map(item => stableJson(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return out;
}

// Judge identity. Without explicit model and reasoning configuration the
// identity is unknown and reuse is disabled (fail closed to a fresh judge).
function policyIdentity(config) {
  const models = config?.models, reasoning = config?.reasoning;
  if (!models || typeof models !== 'object' || !models.judge) return '';
  return digest(stableJson({
    judge: models.judge || '',
    judgeEscalation: models.judgeEscalation || '',
    humanizeEscalation: models.humanizeEscalation || '',
    repair: models.repair || '',
    reasoning: reasoning && typeof reasoning === 'object' ? {
      judge: reasoning.judge || '', escalation: reasoning.escalation || '', repair: reasoning.repair || ''
    } : null
  }));
}

// Mirror of judge.js hasMappingReviewCandidate. It is used only to PREDICT
// the route of a new request. The minted route always comes from the actual
// judge report, so any drift between the two lists can only cause a miss.
const MAPPING_ROUTE_SIGNALS = new Set([
  'explicit_mapping_candidate', 'number_ownership_candidate',
  'argument_ownership_candidate', 'definition_target_candidate',
  'procedure_order_candidate', 'concession_scope_candidate', 'comparison_negation_candidate',
  'antecedent_link_loss_candidate', 'alias_owner_binding_candidate'
]);
function expectedRoute(signals, maxRounds, config) {
  const models = config?.models || {};
  const escalation = models.judgeEscalation || models.humanizeEscalation || models.judge;
  const list = Array.isArray(signals) ? signals : [];
  const control = maxRounds === 0
    && list.includes('final_semantic_revalidation') && list.includes('prior_failed_semantic_confirmation');
  return escalation !== models.judge && (control || list.some(code => MAPPING_ROUTE_SIGNALS.has(code)))
    ? 'confirmation_first' : 'primary_first';
}

function mintedRoute(report) {
  return report?.relationConfirmationFirst === true ? 'confirmation_first' : 'primary_first';
}

// Pure control markers only select the judge route (judge.js) and are not
// interpreted by the judge prompt; the route is enforced separately as a
// verdict tier. Every other signal is bound exactly as the judge prompt sees
// it: currentReviewHints(signals, SOURCE, REWRITE), the same filter used by
// semanticJudge for DETERMINISTIC_DISCOURSE_SIGNALS.
function promptHints(signals, sourceContext, candidate) {
  const list = (Array.isArray(signals) ? signals : [])
    .filter(value => !(typeof value === 'string' && CONTROL_SIGNALS.has(value)));
  return require('./currentReviewHints').currentReviewHints(list, sourceContext, candidate);
}

// Raw signal codes (before the prompt's pairing filter) decide judge routing.
// Binding them makes two requests with identical prompt hints but different
// routing inputs distinct keys, so the mirror above can never admit a
// weaker-tier verdict because of an unpaired, filtered-out routing code.
function routingCodes(signals) {
  const codes = new Set();
  for (const value of Array.isArray(signals) ? signals : []) {
    if (typeof value !== 'string' || CONTROL_SIGNALS.has(value)) continue;
    let item = null;
    try { item = JSON.parse(value); } catch { item = null; }
    codes.add(item && typeof item === 'object' && !Array.isArray(item) ? String(item.code ?? '') : value);
  }
  return [...codes].sort();
}

// Code-policy fingerprint of the judge prompt, obligation, hint and relation
// detector modules loaded in this process. A deploy that changes any of them
// changes every key; within one request code cannot change.
let policyFingerprintCache = '';
function policyFingerprint() {
  if (policyFingerprintCache) return policyFingerprintCache;
  const fs = require('node:fs'), path = require('node:path');
  const files = ['judge.js', 'semanticObligations.js', 'currentReviewHints.js', 'relationAudit.js',
    'semanticOperatorReview.js', 'clauseCoverage.js', 'discourseAudit.js', 'promptEnvelope.js',
    'entityParentheticalIntegrity.js', 'semanticSegmentReceipts.js',
    'semanticAuditPayload.js', 'semanticReviewEnvelope.js'];
  policyFingerprintCache = digest(files.map(file => {
    try { return `${file}:${digest(fs.readFileSync(path.join(__dirname, file)))}`; } catch { return `${file}:absent`; }
  }).join('\n'));
  return policyFingerprintCache;
}

// Whole neighbouring outputs are bound: a changed antecedent anywhere in an
// adjacent section invalidates this section's receipt.
function neighbours(pairs, index) {
  return {
    previous: index > 0 ? digest(pairs[index - 1]?.output) : null,
    next: index + 1 < pairs.length ? digest(pairs[index + 1]?.output) : null
  };
}

// Returns '' when a trustworthy key cannot be built (reuse disabled).
function receiptKey({
  source, pairs, index, signals, lang = '', mode = '',
  allowedExtra = '', documentProfile = null, safetyIdentifier = '', config
} = {}) {
  const pair = pairs?.[index];
  if (!pair || typeof pair.sourceContext !== 'string' || typeof pair.output !== 'string') return '';
  const policy = policyIdentity(config);
  if (!policy) return '';
  try {
    return digest(stableJson({
      version: RECEIPT_VERSION,
      provenance: PROVENANCE_VERSION,
      relationContract: RELATION_CONTRACT,
      code: policyFingerprint(),
      policy,
      document: digest(source),
      segmentation: pairs.map(p => digest(p?.sourceContext)),
      index,
      count: pairs.length,
      alignment: String(pair.alignment || 'whole_document'),
      repairSafe: pair.repairSafe !== false,
      sourceContext: digest(pair.sourceContext),
      candidate: digest(pair.output),
      neighbours: neighbours(pairs, index),
      hints: promptHints(signals, pair.sourceContext, pair.output),
      routingCodes: routingCodes(signals),
      lang: String(lang || ''),
      mode: String(mode || ''),
      allowedExtra: digest(allowedExtra),
      documentProfile: digest(stableJson(documentProfile)),
      safetyIdentifier: digest(safetyIdentifier)
    }));
  } catch {
    return '';
  }
}

const escalationModelOf = config => {
  const models = config?.models || {};
  return models.judgeEscalation || models.humanizeEscalation || models.judge || '';
};
// Tier of the judge that produced the final verdict. A confirming verdict is
// the configured escalation model (with escalation reasoning, bound by the
// policy identity). The report's actual selected model must agree.
function verdictTier(report, config) {
  const model = String(report?.selectedJudgeModel || '');
  const escalation = escalationModelOf(config);
  if (!model) return '';
  if (report.relationConfirmationFirst === true || report.escalated === true) {
    return model === escalation ? 'confirming' : '';
  }
  if (model === config?.models?.judge) return escalation === model ? 'confirming' : 'primary';
  return '';
}
const requiredTier = route => route === 'confirmation_first' ? 'confirming' : 'primary';
const tierSatisfies = (have, need) => have === 'confirming' || (have === 'primary' && need === 'primary');

function obligationDigests(obligations = []) {
  const { obligationId } = require('./semanticObligations');
  const out = Object.create(null);
  for (const finding of obligations) out[obligationId(finding)] = digest(stableJson(finding));
  return out;
}

// A verdict is receipt-worthy only when the judge completed a pass on
// EXACTLY the candidate being receipted, proven by the judge's own bound
// provenance, by an identifiable model tier, with every obligation it was
// given explicitly adjudicated. Repaired candidates qualify only through that
// same proof; restored-source similarity never does.
function isReceiptWorthy(report, { sourceContext, candidate, obligations = [], config } = {}) {
  if (!report || typeof report !== 'object' || typeof candidate !== 'string' || typeof sourceContext !== 'string') return false;
  const v = report.validation;
  const reviewed = new Set((report.obligationReviews || [])
    .filter(r => ['resolved', 'not_error'].includes(r?.status)).map(r => r.id));
  const ids = Object.keys(obligationDigests(obligations));
  return report.pass === true
    && report.uncertain !== true
    && report.skipped !== true
    && report.verificationCompleted !== false
    && report.repairRejected !== true
    && report.escalationFailed !== true
    && report.partialSemanticRepairRetained !== true
    && report.confirmedRelationRestoreRejected !== true
    && !(report.violations || []).length
    && (report.outputText == null || report.outputText === candidate)
    && v?.version === PROVENANCE_VERSION && v.status === 'validated_pass'
    && v.sourceDigest === digest(sourceContext) && v.candidateDigest === digest(candidate)
    && Boolean(verdictTier(report, config))
    && ids.every(id => reviewed.has(id));
}

function createReceiptStore() {
  const receipts = new Map();
  const stats = { minted: 0, reused: 0, misses: 0 };
  return Object.freeze({
    // key: receiptKey of the exact candidate judged. obligations: the prior
    // obligation findings this verdict's judge was given (all adjudicated).
    record(key, report, { sourceContext, candidate, obligations = [], config } = {}) {
      if (!key || !isReceiptWorthy(report, { sourceContext, candidate, obligations, config })) return false;
      if (receipts.size >= MAX_RECEIPTS && !receipts.has(key)) receipts.delete(receipts.keys().next().value);
      const list = receipts.get(key) || [];
      list.push(Object.freeze({
        pass: true,
        tier: verdictTier(report, config),
        selectedJudgeModel: String(report.selectedJudgeModel || '').slice(0, 80),
        obligations: Object.freeze(obligationDigests(obligations)),
        relationContract: String(report.relationContract || ''),
        // Reviews quote the same request's exact candidate; they are needed so
        // explicitly adjudicated obligations stay adjudicated on reuse.
        obligationReviews: Object.freeze((report.obligationReviews || []).map(r => Object.freeze({ ...r })))
      }));
      receipts.set(key, list.slice(-4));
      stats.minted += 1;
      return true;
    },
    // route: expected route of the new request. obligations: the findings the
    // new request would give its judge; each must have been adjudicated with
    // identical content (id and questions) by the receipted verdict.
    lookup(key, { route = 'primary_first', obligations = [] } = {}) {
      const need = requiredTier(route);
      const current = obligationDigests(obligations);
      const hit = (key ? receipts.get(key) || [] : []).find(receipt => tierSatisfies(receipt.tier, need)
        && Object.entries(current).every(([id, value]) => receipt.obligations[id] === value)) || null;
      if (hit) stats.reused += 1; else stats.misses += 1;
      return hit;
    },
    has(key, options) {
      if (!key || !receipts.has(key)) return false;
      const before = { ...stats };
      const hit = this.lookup(key, options);
      Object.assign(stats, before);
      return Boolean(hit);
    },
    invalidate(key) { return receipts.delete(key); },
    get size() { return receipts.size; },
    stats() { return { ...stats, size: receipts.size }; }
  });
}

function isReceiptStore(value) {
  return Boolean(value) && typeof value.lookup === 'function' && typeof value.record === 'function'
    && typeof value.has === 'function';
}

// Section report for a reused receipt. Cost and call count are zero: no model
// request is made, so usage is null and rounds/escalation counters are zero.
function reusedSectionReport(pair, receipt) {
  return {
    index: pair.index,
    sourceId: pair.sourceId,
    sourceStart: pair.sourceStart,
    sourceEnd: pair.sourceEnd,
    outputStart: pair.outputStart,
    outputEnd: pair.outputEnd,
    alignment: pair.alignment || 'whole_document',
    repairSafe: pair.repairSafe !== false,
    verificationCompleted: true,
    started: false,
    receiptReused: true,
    elapsedMs: 0,
    pass: true,
    uncertain: false,
    skipped: false,
    reason: 'section_receipt_reused',
    rounds: 0,
    confirmedRelationRestoreCount: 0,
    confirmedRelationRestoreRejected: false,
    repairRejected: false,
    repairRejectReasons: [],
    repairStyleWarnings: [],
    unchangedRepairCount: 0,
    escalated: false,
    initialViolations: [],
    restorationNominationReports: [],
    violations: [],
    sourceIssues: [],
    relationContract: receipt.relationContract || RELATION_CONTRACT,
    obligationReviews: receipt.obligationReviews.map(r => ({ ...r })),
    selectedJudgeModel: receipt.selectedJudgeModel,
    usage: null
  };
}

// Chooses between two already-valid segmentations only for verdict-only
// audits. The alternative is used when it reuses at least one receipt and
// leaves no more fresh sections than the default plan and at most two
// (the existing concurrency), so no extra queueing is introduced.
function preferReusableSegmentation(defaultPairs, alternativePairs, countFresh) {
  if (!Array.isArray(alternativePairs) || alternativePairs === defaultPairs || !alternativePairs.length) return defaultPairs;
  const alt = countFresh(alternativePairs), base = countFresh(defaultPairs);
  if (alt.reused > 0 && alt.fresh <= 2 && alt.fresh <= base.fresh && alt.reused > base.reused) return alternativePairs;
  return defaultPairs;
}

module.exports = {
  RECEIPT_VERSION,
  CONTROL_SIGNALS,
  createReceiptStore,
  isReceiptStore,
  isReceiptWorthy,
  receiptKey,
  promptHints,
  policyFingerprint,
  verdictTier,
  expectedRoute,
  mintedRoute,
  policyIdentity,
  reusedSectionReport,
  preferReusableSegmentation
};
