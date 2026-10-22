'use strict';

const { textDigest, verifySemanticValidation } = require('./semanticProvenance');
const VERSION = 'semantic-evidence-v1';
// Hard validation ceiling, not a truncation target. Persistence compresses the
// complete trace and fails before billing if it cannot durably store it.
const MAX_BYTES = 8 * 1024 * 1024;
const code = value => /^[a-zA-Z0-9_.:-]{1,100}$/u.test(String(value || '')) ? String(value) : '';
const codes = values => [...new Set((Array.isArray(values) ? values : []).map(code).filter(Boolean))].slice(0, 64);
const digest = value => /^[a-f0-9]{64}$/u.test(String(value || '')) ? value : '';
const range = value => Number.isInteger(value?.start) && Number.isInteger(value?.end)
  && value.start >= 0 && value.end > value.start ? { start: value.start, end: value.end } : null;
function excerpt(value) {
  const text = typeof value === 'string' ? value : '';
  return { text, length: text.length, digest: textDigest(text), truncated: false };
}
function binding(value) {
  return { sourceDigest: digest(value?.sourceDigest), candidateDigest: digest(value?.candidateDigest),
    model: code(value?.model), phase: code(value?.phase), reasoningEffort: code(value?.reasoningEffort) };
}
function finding(value, stage) {
  return { stage, type: code(value?.type), origin: code(value?.origin), relation: code(value?.relation),
    grounding: code(value?.grounding), repairable: value?.repairable === true,
    uncertaintyReasons: codes(value?.uncertaintyReasons),
    source: excerpt(value?.sourceSpan), candidate: excerpt(value?.candidateSpan), problem: excerpt(value?.span),
    detail: excerpt(value?.detail), sourceRange: range(value?.sourceRange), candidateRange: range(value?.candidateRange),
    spanRange: range(value?.spanRange), evidence: binding(value?.evidence),
    // Ranges belong to this exact judge input, never implicitly to the PDF or
    // to the final output after a repair. Historical evidence keeps its binding.
    coordinateScope: 'judge_input_utf16' };
}
function review(value, kind) {
  return { kind, id: code(value?.id), status: code(value?.status),
    source: excerpt(value?.sourceSpan), candidate: excerpt(value?.candidateSpan), detail: excerpt(value?.detail),
    uncertaintyReasons: codes(value?.uncertaintyReasons), evidence: binding(value?.evidence),
    ...(value?.submittedReview ? { rejectedResponse: { status: code(value.submittedReview.status),
      source: excerpt(value.submittedReview.sourceSpan), candidate: excerpt(value.submittedReview.candidateSpan),
      detail: excerpt(value.submittedReview.detail) } } : {}) };
}
function buildTrace({ report, submittedSource, source, candidate, engineVersion, decisionReason = '', recovery = [], receipts = {} } = {}) {
  const validation = verifySemanticValidation(report, { source, candidate, requireDigest: true });
  const windows = Array.isArray(report?.reports) && report.reports.length ? report.reports : [report || {}];
  const trace = { version: VERSION, engineVersion: code(engineVersion),
    policyFingerprint: require('./semanticSegmentReceipts').policyFingerprint(),
    submittedSourceDigest: textDigest(submittedSource), sourceDigest: textDigest(source), candidateDigest: textDigest(candidate),
    status: code(validation.status), materialization: code(validation.materialization), ran: report?.ran === true,
    verificationCompleted: report?.ran === true && report.verificationCompleted !== false,
    decisionReason: code(decisionReason || report?.decisionReason || report?.reason),
    validation: binding(report?.validation),
    repairRejectReasons: codes([...(report?.repairRejectReasons || []), ...(report?.repairFullDocumentRejectCodes || [])]),
    windows: windows.map((r, i) => ({ index: Number.isInteger(r.index) ? r.index : i,
      status: report?.ran !== true ? 'skipped' : r.verificationCompleted === false || r.skipped ? 'incomplete' : r.uncertain ? 'uncertain' : r.pass ? 'pass' : 'fail',
      reason: code(r.reason), receiptReused: r.receiptReused === true, model: code(r.selectedJudgeModel),
      validation: binding(r.validation), repairRejectReasons: codes(r.repairRejectReasons),
      findings: [...(r.initialViolations || []).map(v => finding(v, 'initial')),
        ...(r.violations || []).map(v => finding(v, 'remaining')), ...(r.sourceIssues || []).map(v => finding(v, 'source_issue'))],
      reviews: [...(r.operatorReviews || []).map(v => review(v, 'operator')),
        ...(r.obligationReviews || []).map(v => review(v, 'prior_finding'))] })),
    recovery: Array.isArray(recovery) ? recovery : [],
    omittedRecoveryAttempts: 0,
    receipts: Object.fromEntries(['minted','reused','misses','unidentifiedMisses','contextMisses','tierMisses','obligationMisses']
      .map(key => [key, Math.max(0, Math.trunc(Number(receipts[key]) || 0))])),
    omittedFindings: 0, omittedReviews: 0, truncated: false };
  return trace;
}

// Storage is server-written. Validate identity on every read, including old
// histories and paragraph refinement, before exposing it as current evidence.
function forHistory(trace, source, candidate) {
  if (!trace || trace.version !== VERSION) return { available: false, reason: 'not_recorded' };
  if (trace.submittedSourceDigest !== textDigest(source) || trace.candidateDigest !== textDigest(candidate))
    return { available: false, reason: 'output_changed', version: VERSION };
  if (Buffer.byteLength(JSON.stringify(trace), 'utf8') > MAX_BYTES)
    return { available: false, reason: 'invalid_evidence_size', version: VERSION };
  const keys = ['version', 'engineVersion', 'policyFingerprint', 'omittedRecoveryAttempts', 'submittedSourceDigest', 'sourceDigest', 'candidateDigest', 'status',
    'materialization', 'ran', 'verificationCompleted', 'decisionReason', 'validation', 'repairRejectReasons',
    'windows', 'index', 'reason', 'receiptReused', 'model', 'phase', 'findings', 'reviews', 'stage', 'type', 'origin',
    'relation', 'grounding', 'repairable', 'uncertaintyReasons', 'source', 'candidate', 'problem', 'detail', 'text',
    'length', 'digest', 'truncated', 'sourceRange', 'candidateRange', 'spanRange', 'start', 'end', 'evidence',
    'coordinateScope', 'kind', 'id', 'rejectedResponse', 'recovery', 'tier', 'inputDigest', 'applied', 'reasoningEffort',
    'previousReason', 'marginalGain', 'elapsedMs', 'estimatedUsd', 'omittedFindings', 'omittedReviews',
    'receipts', 'minted', 'reused', 'misses', 'unidentifiedMisses', 'contextMisses', 'tierMisses', 'obligationMisses'];
  return { available: true, ...JSON.parse(JSON.stringify(trace, keys)) };
}
module.exports = { VERSION, MAX_BYTES, buildTrace, forHistory, binding };
