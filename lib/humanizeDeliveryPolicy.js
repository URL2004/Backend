'use strict';

const TECHNICAL_GATES = new Set([
  'gpt_all_chunks_fallback',
  'gpt_noop_unchanged',
  'noop_unchanged',
  'empty_or_meta_output',
  'prompt_instruction_leak',
  'encoding_corruption',
  'sentence_truncated',
  'refusal',
  'quality_pipeline_error',
  'floor_report_error',
  'openai_schema_error',
  'no_approved_model_chunks'
]);

const POLISH_TECHNICAL_GATES = new Set([
  'polish_unchanged',
  'polish_excessive_change',
  'polish_evaluative_padding_added'
]);

const EFFECT_ONLY_GATES = new Set([
  'humanization_depth_no_effect',
  'humanization_depth_below_minimum',
  'humanization_carryover_high',
  'rhetorical_remediation_incomplete',
  'resume_semantic_repetition_remaining',
  'weak_transform',
  'quality_pattern_low_effect',
  // v2 이전 관측기가 남긴 값은 결과 안전성 판단의 소유자가 아니다.
  // 과거 작업/관리자 shadow 자료를 읽더라도 검토 필요로 승격하지 않는다.
  'surface_risk_regression',
  'korean_quality_final',
  'nikl_quality',
  'quality_pattern_lab'
]);

const TECHNICAL_PATTERN = /empty|meta_output|prompt_instruction_leak|encoding_corruption|sentence_truncated|refus(?:al|ed)|schema|pipeline_error/iu;

function gateOf(item) {
  if (typeof item === 'string') return item.trim();
  return String(item?.gate || item?.type || item?.code || item?.action || '').trim();
}

function isEffectOnly(item) {
  return EFFECT_ONLY_GATES.has(gateOf(item));
}

function isTechnicalCritical(item, { mode = '' } = {}) {
  const gate = gateOf(item);
  if (TECHNICAL_GATES.has(gate) || TECHNICAL_PATTERN.test(gate)) return true;
  return POLISH_TECHNICAL_GATES.has(gate);
}

function ensureReport(report) {
  if (report && typeof report === 'object') {
    report.criticals = Array.isArray(report.criticals) ? report.criticals : [];
    report.warnings = Array.isArray(report.warnings) ? report.warnings : [];
    if (report.status === 'error') {
      report.status = 'blocked';
      if (!report.criticals.some(item => gateOf(item) === 'floor_report_error')) {
        report.criticals.push({
          gate: 'floor_report_error',
          detail: '필수 품질 감사 결과를 만들지 못했습니다.'
        });
      }
    }
    return report;
  }
  return {
    status: 'blocked',
    criticals: [{ gate: 'quality_pipeline_error', detail: '필수 품질 감사 결과가 없습니다.' }],
    warnings: []
  };
}

function applyDeliveryPolicy(inputReport, { mode = '' } = {}) {
  const report = ensureReport(inputReport);
  const technical = [];
  const reviewable = [];

  for (const critical of report.criticals) {
    if (isTechnicalCritical(critical, { mode })) technical.push(critical);
    else reviewable.push(critical);
  }

  if (reviewable.length) {
    report.warnings.push(...reviewable.map(item => ({
      ...item,
      softenedFromCritical: true,
      deliveryPolicy: 'v3'
    })));
  }
  report.criticals = technical;

  const safetyWarnings = report.warnings.filter(item => !isEffectOnly(item));
  if (technical.length) report.status = 'blocked';
  else if (safetyWarnings.length) report.status = 'needs_review';
  else report.status = 'clean';

  const decision = technical.length
    ? 'block_technical'
    : report.status === 'needs_review'
      ? 'deliver_review'
      : 'deliver_clean';
  const reasonCodes = [...new Set((decision === 'block_technical' ? technical : safetyWarnings)
    .map(gateOf)
    .filter(Boolean))];

  return {
    report,
    decision,
    reasonCodes,
    effectItems: report.warnings.filter(isEffectOnly)
  };
}

function buildAllowedExtra({ evidence = '', userNotes = '' } = {}) {
  const parts = [];
  const evidenceText = String(evidence || '').trim();
  const noteText = String(userNotes || '').trim();
  if (evidenceText) parts.push(`[사용자 제공 근거]\n${evidenceText}`);
  if (noteText) parts.push(`[사용자 메모]\n${noteText}`);
  return parts.join('\n\n');
}

module.exports = {
  TECHNICAL_GATES,
  POLISH_TECHNICAL_GATES,
  EFFECT_ONLY_GATES,
  gateOf,
  isEffectOnly,
  isTechnicalCritical,
  applyDeliveryPolicy,
  buildAllowedExtra
};
