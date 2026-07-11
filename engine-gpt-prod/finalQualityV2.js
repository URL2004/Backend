'use strict';

const floor = require('../engine/floor');
const { computeEditMetrics } = require('../engine/koreanText');
const { auditVoice } = require('./voiceProfile');
const { compareNaturalnessShadow } = require('../engine/koreanQuality/naturalnessShadow');
const { judgeAndRepair } = require('./judge');
const { completeJson } = require('./openaiClient');

const POLISH_REPAIR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outputText: { type: 'string' },
    safeChangeFound: { type: 'boolean' },
    notes: { type: 'array', items: { type: 'string' } }
  },
  required: ['outputText', 'safeChangeFound', 'notes']
};

const STRICT_CODES = new Set([
  'empty_output',
  'refusal',
  'prompt_instruction_leak',
  'encoding_corruption',
  'sentence_truncated',
  'polish_unchanged'
]);

const SEMANTIC_WARNING_TYPES = new Set([
  'novelty',
  'lost_facts',
  'pov',
  'experience_novelty',
  'length_short',
  'length_overrun',
  'fake_ref',
  'section_anchor_loss',
  'structure_lock_loss',
  'protected_term_loss',
  'unsafe_chunk_boundary',
  'speaker_injected',
  'speaker_removed',
  'quote_count_changed',
  'list_structure_changed',
  'heading_structure_changed',
  'paragraph_structure_changed',
  'creative_line_structure',
  'register_shift'
]);

function buildDeterministicAudit({ source, outputText, mode, contract, voiceProfile, documentProfile, structureAudit, protectedTerms = [], allowedExtra = '' }) {
  const warnings = [];
  const editMetrics = computeEditMetrics(source, outputText);
  let floorViolations = [];
  try {
    floorViolations = floor.collectFloorViolations({
      result: { outputText },
      rawText: source,
      povSeed: contract?.povSeed,
      optIn: false,
      mode,
      chunkLevel: false,
      allowedExtra
    }) || [];
  } catch (error) {
    warnings.push(warning('audit_error', `결정론적 품질 감사 일부를 실행하지 못했어요: ${safeMessage(error)}`));
  }
  for (const violation of floorViolations) {
    const code = normalizeFloorCode(violation.type || violation.gate);
    warnings.push(warning(code, warningMessage(code, violation.detail), { detail: violation.detail || '' }));
  }

  const missingProtected = (protectedTerms || []).filter(term => !containsProtectedTerm(outputText, term));
  if (missingProtected.length) {
    warnings.push(warning('protected_term_loss', '보호해야 할 명칭이나 표현 일부가 누락됐을 수 있어요.', { terms: missingProtected.slice(0, 16) }));
  }

  const voiceAudit = auditVoice(voiceProfile, outputText, { documentProfile: documentProfile?.profile || 'unknown', mode });
  warnings.push(...voiceAudit.warnings);
  if (structureAudit?.lostLockedCount > 0) {
    warnings.push(warning('structure_lock_loss', '목차·참고문헌·제목 구조 일부가 달라졌을 수 있어요.', { count: structureAudit.lostLockedCount }));
  }
  if (structureAudit?.unsafeBoundaryCount > 0) {
    warnings.push(warning('unsafe_chunk_boundary', '청크 경계에서 문장이 자연스럽게 이어지지 않을 수 있어요.', { count: structureAudit.unsafeBoundaryCount }));
  }
  const naturalnessShadow = compareNaturalnessShadow(source, outputText);
  return {
    version: 2,
    editMetrics,
    voiceAudit,
    floorViolations,
    warnings: dedupeWarnings(warnings),
    naturalnessShadow,
    protectedFactCount: countProtectedFacts(source),
    structureSignals: detectStructureSignals(source)
  };
}

function shouldRunSemanticJudge({ requestedMode, effectiveMode, source, documentProfile, audit }) {
  const requested = String(requestedMode || '').toLowerCase();
  if (requested === 'formal' || requested === 'polish' || effectiveMode === 'polish') return { run: true, reason: 'mode' };
  if (String(source || '').length >= 1500 && requested === 'blog') return { run: true, reason: 'long_blog' };
  if ((audit?.protectedFactCount || 0) >= 8) return { run: true, reason: 'protected_facts' };
  if (audit?.structureSignals?.semanticRequired) return { run: true, reason: 'structure' };
  if ((audit?.editMetrics?.fiveGramSimilarity ?? 1) < 0.25) return { run: true, reason: 'low_similarity' };
  if ((audit?.warnings || []).some(item => SEMANTIC_WARNING_TYPES.has(item.code))) return { run: true, reason: 'deterministic_warning' };
  if (['academic_paper', 'student_record', 'resume_application', 'creative'].includes(documentProfile?.profile) && documentProfile.confidence >= 0.75) {
    return { run: true, reason: 'sensitive_profile' };
  }
  return { run: false, reason: 'not_required' };
}

async function runSemanticDocumentAudit({ source, outputText, lang = 'ko', signal, config, allowedExtra = '', mode = '', safetyIdentifier = '' }) {
  const pairs = buildReviewPairs(source, outputText);
  const outputs = [];
  const reports = [];
  let remainingRepairRounds = 1;
  for (const pair of pairs) {
    try {
      const report = await judgeAndRepair(pair.sourceContext, pair.output, {
        lang,
        signal,
        config,
        maxRounds: remainingRepairRounds,
        allowedExtra,
        mode,
        safetyIdentifier
      });
      outputs.push(report.outputText || pair.output);
      remainingRepairRounds = Math.max(0, remainingRepairRounds - (report.rounds || 0));
      reports.push({
        index: pair.index,
        pass: report.pass === true,
        skipped: report.skipped === true,
        reason: report.reason || '',
        rounds: report.rounds || 0,
        repairRejected: report.repairRejected === true,
        repairRejectReasons: report.repairRejectReasons || [],
        escalated: report.escalated === true,
        violations: report.violations || [],
        selectedJudgeModel: report.selectedJudgeModel || '',
        usage: report.usage || null
      });
    } catch (error) {
      outputs.push(pair.output);
      reports.push({ index: pair.index, pass: false, uncertain: true, reason: safeMessage(error), rounds: 0, violations: [] });
    }
  }
  const repairedText = outputs.join('');
  const residual = reports.filter(report => report.pass !== true);
  return {
    outputText: repairedText,
    ran: true,
    pass: residual.length === 0,
    uncertain: residual.some(report => report.uncertain || report.skipped),
    repairCount: reports.reduce((sum, report) => sum + (report.rounds || 0), 0),
    repairRejected: reports.some(report => report.repairRejected),
    escalated: reports.some(report => report.escalated),
    sectionCount: reports.length,
    reports,
    usage: reports.reduce((acc, report) => addUsageLocal(acc, report.usage), null),
    violations: residual.flatMap(report => report.violations || [])
  };
}

function buildReviewPairs(source, outputText, maxChars = 9000, overlap = 600) {
  const rawSource = String(source || '');
  const rawOutput = String(outputText || '');
  if (rawSource.length <= 12000 && rawOutput.length <= 12000) {
    return [{ index: 0, sourceContext: rawSource, output: rawOutput }];
  }
  const sectionCount = Math.max(2, Math.ceil(Math.max(rawSource.length, rawOutput.length) / maxChars));
  const outputParts = splitIntoSectionCount(rawOutput, sectionCount);
  return outputParts.map((part, index) => {
    const relativeStart = rawOutput.length ? part.start / rawOutput.length : 0;
    const relativeEnd = rawOutput.length ? part.end / rawOutput.length : 1;
    const start = Math.max(0, Math.floor(rawSource.length * relativeStart) - overlap);
    const end = Math.min(rawSource.length, Math.ceil(rawSource.length * relativeEnd) + overlap);
    return { index, sourceContext: rawSource.slice(start, end), output: part.text };
  });
}

function splitIntoSectionCount(value, count) {
  const text = String(value || '');
  if (count <= 1) return [{ start: 0, end: text.length, text }];
  if (text.length < count) {
    return Array.from({ length: count }, (_, index) => {
      const start = Math.floor(text.length * index / count);
      const end = Math.floor(text.length * (index + 1) / count);
      return { start, end, text: text.slice(start, end) };
    });
  }
  const boundaries = [0];
  for (let index = 1; index < count; index += 1) {
    const target = Math.floor(text.length * index / count);
    const min = boundaries[boundaries.length - 1] + 1;
    const max = text.length - (count - index);
    boundaries.push(nearestSectionBoundary(text, target, min, max));
  }
  boundaries.push(text.length);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    return { start, end, text: text.slice(start, end) };
  });
}

function nearestSectionBoundary(text, target, min, max) {
  const window = 1600;
  const candidates = [];
  for (const marker of ['\n\n', '. ', '다. ', '요. ']) {
    const beforeRaw = text.lastIndexOf(marker, Math.min(max, target));
    const before = beforeRaw >= 0 ? beforeRaw + marker.length : -1;
    const afterRaw = text.indexOf(marker, Math.max(min, target));
    const after = afterRaw >= 0 ? afterRaw + marker.length : -1;
    if (before >= min && before <= max && target - before <= window) candidates.push(before);
    if (after >= min && after <= max && after - target <= window) candidates.push(after);
  }
  if (!candidates.length) return Math.max(min, Math.min(max, target));
  return candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
}

function splitByParagraphBudget(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return [{ start: 0, end: text.length, text }];
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const paragraph = text.lastIndexOf('\n\n', end);
      const sentence = text.lastIndexOf('. ', end);
      const candidate = Math.max(paragraph >= start + maxChars * 0.55 ? paragraph + 2 : -1, sentence >= start + maxChars * 0.7 ? sentence + 2 : -1);
      if (candidate > start) end = candidate;
    }
    out.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return out;
}

function polishEditPolicy(source, outputText) {
  const metrics = computeEditMetrics(source, outputText);
  const short = String(source || '').length <= 120;
  const limits = short
    ? { minEdit: 0.02, maxEdit: 0.45, minLength: 0.85, maxLength: 1.15 }
    : { minEdit: 0.01, maxEdit: 0.25, minLength: 0.9, maxLength: 1.1 };
  const noSafeChange = metrics.charEditRatio < limits.minEdit;
  const excessiveChange = metrics.charEditRatio > limits.maxEdit || metrics.lengthRatio < limits.minLength || metrics.lengthRatio > limits.maxLength;
  return { pass: !noSafeChange && !excessiveChange, noSafeChange, excessiveChange, metrics, limits };
}

async function retryPolishSurface({ source, currentOutput, policy, config, signal, safetyIdentifier = '' }) {
  const needsMinimalChange = policy?.noSafeChange === true;
  const system = [
    '너는 한국어 보존형 윤문 수리기다.',
    '원문의 주장, 예시, 수치, 기관명, 인용, 화자, 문단 수와 순서를 바꾸지 않는다.',
    '비문, 띄어쓰기, 접속, 완전 중복, 말투 혼합 중 실제 오류만 수정한다.',
    '새 문장이나 새 문단을 만들지 않는다.',
    needsMinimalChange
      ? 'CURRENT가 SOURCE와 실질적으로 같다. SOURCE에서 실제로 안전하게 고칠 수 있는 표면 오류를 최소 한 곳만 고친다. 고칠 곳이 정말 없으면 safeChangeFound=false로 답한다.'
      : 'CURRENT가 허용 편집 범위를 넘었다. SOURCE에 가깝게 되돌리면서 실제 표면 오류만 최소한으로 고친다.',
    `허용 범위: 문자 편집률 ${policy?.limits?.minEdit ?? 0.01}~${policy?.limits?.maxEdit ?? 0.25}, 길이비 ${policy?.limits?.minLength ?? 0.9}~${policy?.limits?.maxLength ?? 1.1}.`
  ].join('\n');
  const response = await completeJson({
    system,
    user: `[SOURCE]\n${source}\n\n[CURRENT]\n${currentOutput}`,
    schema: POLISH_REPAIR_SCHEMA,
    schemaName: 'gpt_prod_polish_surface_retry',
    model: config.models.repair,
    reasoningEffort: config.reasoning.repair,
    verbosity: 'low',
    maxOutputTokens: Math.max(800, Math.min(12000, Math.ceil(String(source || '').length * 1.5))),
    config,
    signal,
    safetyIdentifier,
    meta: { task: 'repair', phase: 'polish_surface_retry', mode: 'polish', profile: 'gpt_prod_v2' }
  });
  return {
    outputText: String(response.json.outputText || '').trim() || currentOutput,
    safeChangeFound: response.json.safeChangeFound === true,
    notes: response.json.notes || [],
    usage: response.usage,
    model: response.model
  };
}

async function retryGeneralSurface({ source, currentOutput, config, signal, safetyIdentifier = '' }) {
  const system = [
    '너는 이미 자연스러운 한국어 문서의 최소 표면 교정기다.',
    'SOURCE의 주장, 예시, 수치, 기관명, 인용, 화자, 문장 수, 줄바꿈, 문단 수와 순서를 그대로 보존한다.',
    'CURRENT가 SOURCE와 실질적으로 같으므로, 기존 문장 한 곳에서만 조사·띄어쓰기·어순·중복 표현 중 안전한 표면 수정을 만든다.',
    '새 사실·평가·감정·예시·문장·문단을 만들지 않고, 다른 문장은 그대로 둔다.',
    '안전한 수정이 정말 불가능할 때만 safeChangeFound=false로 답한다.'
  ].join('\n');
  const response = await completeJson({
    system,
    user: `[SOURCE]\n${source}\n\n[CURRENT]\n${currentOutput}`,
    schema: POLISH_REPAIR_SCHEMA,
    schemaName: 'gpt_prod_general_surface_retry',
    model: config.models.repair,
    reasoningEffort: config.reasoning.repair,
    verbosity: 'low',
    maxOutputTokens: Math.max(800, Math.min(12000, Math.ceil(String(source || '').length * 1.5))),
    config,
    signal,
    safetyIdentifier,
    meta: { task: 'repair', phase: 'general_surface_retry', mode: 'surface', profile: 'gpt_prod_v2' }
  });
  return {
    outputText: String(response.json.outputText || '').trim() || currentOutput,
    safeChangeFound: response.json.safeChangeFound === true,
    notes: response.json.notes || [],
    usage: response.usage,
    model: response.model
  };
}

function warningsFromSemantic(report) {
  if (!report?.ran || report.pass) return [];
  const codes = new Set((report.violations || []).map(item => item.type));
  const out = [];
  if (report.repairRejected) out.push(warning('semantic_repair_rejected', '자동 수리 결과가 원문 보존 기준을 악화시켜 적용하지 않았어요.'));
  if (report.uncertain) out.push(warning('semantic_judge_uncertain', '의미 보존 자동 심사가 불확실해 결과를 직접 확인해 주세요.'));
  if (codes.has('added_claim')) out.push(warning('semantic_addition', '원문에 없는 내용이 추가됐을 가능성이 있어요.'));
  if (codes.has('distortion')) out.push(warning('semantic_distortion', '원문의 의미 일부가 달라졌을 가능성이 있어요.'));
  if (codes.has('omission')) out.push(warning('semantic_omission', '원문 내용 일부가 축약됐을 수 있어요.'));
  if (!out.length) out.push(warning('semantic_review_failed', '자동 의미 심사를 완전히 통과하지 못했어요.'));
  return out;
}

function countProtectedFacts(source) {
  try {
    const facts = floor.extractFacts(String(source || ''), /[가-힣]/u.test(String(source || '')));
    return new Set((facts || []).map(floor.factKey)).size;
  } catch {
    return 0;
  }
}

function detectStructureSignals(source) {
  const text = String(source || '');
  const hasTable = /^\s*\|.+\|\s*$|\t.+\t/gmu.test(text) || /^(?:표|Table)\s*\d+/gimu.test(text);
  const hasToc = /(?:^|\n)\s*(?:목\s*차|차례|Table\s+of\s+Contents)\s*(?:\n|$)/iu.test(text);
  const hasReferences = /(?:^|\n)\s*(?:참고\s*문헌|참고\s*자료|References|Bibliography)\s*(?:\n|$)/iu.test(text);
  const headingCount = (text.match(/^\s*(?:제\s*\d+\s*(?:장|절|항)|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?|\d+(?:\.\d+){1,3})\s*\S.*$/gmu) || []).length;
  return { hasTable, hasToc, hasReferences, headingCount, semanticRequired: hasTable || hasToc || hasReferences || headingCount >= 3 };
}

function normalizeFloorCode(code) {
  const value = String(code || '').toLowerCase();
  if (value === 'lostfacts') return 'lost_facts';
  if (value === 'pov_inject') return 'pov';
  return value || 'quality_warning';
}

function warningMessage(code, detail) {
  const messages = {
    novelty: '원문에 없는 수치·기관·사실이 추가됐을 수 있어요.',
    lost_facts: '원문의 수치·기관·사실 일부가 누락됐을 수 있어요.',
    pov: '원문에 없던 화자가 추가됐을 수 있어요.',
    experience_novelty: '원문이나 사용자 메모에 없는 경험이 추가됐을 수 있어요.',
    length_short: '원문 내용 일부가 축약됐을 수 있어요.',
    length_overrun: '원문보다 과도하게 늘어난 부분이 있을 수 있어요.',
    repetition: '유사한 문장이 반복될 수 있어요.',
    meta_leak: '내부 작업 지시가 결과에 노출됐을 수 있어요.',
    coined_term: '원문에 없는 용어가 만들어졌을 수 있어요.'
  };
  return messages[code] || `품질 확인이 필요한 항목이 있어요${detail ? `: ${String(detail).slice(0, 120)}` : '.'}`;
}

function containsNormalized(haystack, needle) {
  const clean = value => String(value || '').replace(/\s+/gu, '').toLowerCase();
  return clean(haystack).includes(clean(needle));
}

function containsProtectedTerm(haystack, term) {
  if (containsNormalized(haystack, term)) return true;
  const paren = String(term || '').trim().match(/\(([^)）]{2,60})\)$/u);
  return paren ? containsNormalized(haystack, paren[1]) : false;
}

function warning(code, message, extra = {}) {
  return { code, severity: 'warning', message, ...extra };
}

function dedupeWarnings(items) {
  const seen = new Set();
  return (items || []).filter(item => {
    const key = `${item.code}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeMessage(error) {
  return String(error?.message || error || 'unknown_error').slice(0, 180);
}

function addUsageLocal(acc, usage) {
  const base = acc || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, webSearchRequests: 0, webSearchEstimatedUsd: 0, estimatedUsd: 0 };
  if (!usage) return base;
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'webSearchRequests', 'webSearchEstimatedUsd', 'estimatedUsd']) {
    base[key] += Number(usage[key]) || 0;
  }
  base.estimatedUsd = Math.round(base.estimatedUsd * 1000000) / 1000000;
  base.webSearchEstimatedUsd = Math.round(base.webSearchEstimatedUsd * 1000000) / 1000000;
  return base;
}

module.exports = {
  STRICT_CODES,
  SEMANTIC_WARNING_TYPES,
  buildDeterministicAudit,
  shouldRunSemanticJudge,
  runSemanticDocumentAudit,
  buildReviewPairs,
  splitIntoSectionCount,
  polishEditPolicy,
  retryPolishSurface,
  retryGeneralSurface,
  warningsFromSemantic
};
