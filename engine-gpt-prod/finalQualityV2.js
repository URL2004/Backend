'use strict';

const floor = require('../engine/floor');
const { computeEditMetrics, splitSentenceSpans } = require('../engine/koreanText');
const { auditVoice, buildVoiceProfile, POV_PATTERNS } = require('./voiceProfile');
const { compareNaturalnessShadow } = require('../engine/koreanQuality/naturalnessShadow');
const { judgeAndRepair } = require('./judge');
const { completeJson } = require('./openaiClient');
const { compareNumberMultiset } = require('./factAudit');
const discourse = require('./discourseAudit');
const humanizationDepth = require('./humanizationDepth');
const legalAudit = require('./legalAudit');

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

// polish는 오류 교정만 허용하므로 원문에 없던 가능·필요·중요성 같은 평가
// 어휘가 늘면 단순 문체 변화가 아니라 새로운 태도/판단이 추가된 것이다.
// naturalness shadow 점수와 분리된 보존 계약이며, 외부로는 문구가 아닌
// 고정된 범주 코드만 기록한다.
const POLISH_EVALUATIVE_PADDING_PATTERNS = [
  { code: 'ability_modal', pattern: /(?:할|볼)\s*수\s*있/gu },
  { code: 'necessity_label', pattern: /필요/gu },
  { code: 'importance_label', pattern: /중요/gu },
  { code: 'meaning_label', pattern: /의미/gu },
  { code: 'role_label', pattern: /역할/gu },
  { code: 'positive_evaluation', pattern: /긍정적/gu },
  { code: 'systematic_label', pattern: /체계/gu },
  { code: 'strategy_label', pattern: /전략/gu },
  { code: 'efficiency_label', pattern: /효율/gu }
];

const STRICT_CODES = new Set([
  'empty_output',
  'refusal',
  'prompt_instruction_leak',
  'encoding_corruption',
  'sentence_truncated',
  'polish_unchanged',
  'polish_excessive_change',
  'polish_evaluative_padding_added'
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
  'quote_content_changed',
  'list_structure_changed',
  'heading_structure_changed',
  'paragraph_structure_changed',
  'title_line_merged',
  'structural_line_loss',
  'line_structure_changed',
  'questionnaire_structure_changed',
  'creative_line_structure',
  'register_shift',
  'number_changed',
  'legal_relation_shift',
  'legal_article_structure_changed',
  ...discourse.VIOLATION_CODES
]);

function buildDeterministicAudit({ source, outputText, mode, contract, voiceProfile, documentProfile, structureAudit, protectedTerms = [], allowedExtra = '' }) {
  const warnings = [];
  const editMetrics = computeEditMetrics(source, outputText);
  const repetitionAudit = compareRepetitionDelta(source, outputText);
  const numberAudit = compareNumberMultiset(source, outputText, allowedExtra);
  let floorViolations = [];
  try {
    floorViolations = floor.collectFloorViolations({
      result: { outputText },
      rawText: source,
      povSeed: contract?.povSeed,
      optIn: contract?.optIn === true,
      mode,
      chunkLevel: false,
      allowedExtra
    }) || [];
    if (!repetitionAudit.increased) {
      floorViolations = floorViolations.filter(violation => String(violation?.type || violation?.gate || '') !== 'repetition');
    }
    // 결정론 경험 탐지는 의역을 실제 경험 추가로 오인할 수 있다. v2.4.8에서는
    // 새 화자·시점·행동 결합만 내부 후보로 보내고, 외부 경고는 의미 심사 확인 뒤에만 만든다.
    floorViolations = floorViolations.filter(violation => String(violation?.type || violation?.gate || '') !== 'experience_novelty');
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
  if (numberAudit.changed) {
    warnings.push(warning(
      'number_changed',
      '원문의 숫자나 수량 표기 일부가 추가되거나 누락됐을 수 있어요.',
      { addedCount: numberAudit.addedCount, removedCount: numberAudit.removedCount }
    ));
  }

  const voiceAudit = auditVoice(voiceProfile, outputText, {
    documentProfile: documentProfile || 'unknown',
    mode,
    sourceText: source,
    layoutPolicy: structureAudit?.layoutRepair?.paragraphs?.policy || '',
    layoutTargetCount: structureAudit?.layoutRepair?.paragraphs?.targetCount || 0,
    formattingParagraphRemovalCount: structureAudit?.layoutRepair?.formatting?.brokenParagraphBreakRepairCount || 0,
    formattingSentenceSpaceRepairCount: structureAudit?.layoutRepair?.formatting?.missingSentenceSpaceRepairCount || 0
  });
  warnings.push(...voiceAudit.warnings);
  const legalIntegrity = legalAudit.auditLegalIntegrity(source, outputText, documentProfile);
  if (legalIntegrity.issueCodes.includes('legal_relation_shift')) {
    warnings.push(warning('legal_relation_shift', '계약·약관의 권리·의무·부정·가능성 관계가 달라졌을 수 있어요.'));
  }
  if (legalIntegrity.issueCodes.includes('legal_article_structure_changed')) {
    warnings.push(warning('legal_article_structure_changed', '조문 번호나 순서가 원문과 달라졌을 수 있어요.'));
  }
  if (structureAudit?.lostLockedCount > 0) {
    warnings.push(warning('structure_lock_loss', '목차·참고문헌·제목 구조 일부가 달라졌을 수 있어요.', { count: structureAudit.lostLockedCount }));
  }
  if (structureAudit?.lockedOrderChanged) {
    const questionnaire = documentProfile?.formatProfile?.flags?.includes?.('questionnaire');
    warnings.push(questionnaire
      ? warning('questionnaire_structure_changed', '질문 또는 답변 경계의 순서가 달라졌을 수 있어요.', { count: structureAudit.lockedOutOfOrderCount || 0 })
      : warning('structure_lock_loss', '잠긴 제목이나 구조의 순서가 달라졌을 수 있어요.', { count: structureAudit.lockedOutOfOrderCount || 0 }));
  }
  if (structureAudit?.unsafeBoundaryCount > 0) {
    warnings.push(warning('unsafe_chunk_boundary', '청크 경계에서 문장이 자연스럽게 이어지지 않을 수 있어요.', { count: structureAudit.unsafeBoundaryCount }));
  }
  if (structureAudit?.sectionPathErrorCount > 0) {
    warnings.push(warning('section_path_mismatch', '본문 일부가 잘못된 절 경로에 연결됐을 수 있어요.', { count: structureAudit.sectionPathErrorCount }));
  }
  const discourseAudit = discourse.compareDiscourse(source, outputText);
  for (const violation of discourseAudit.violations || []) {
    warnings.push(warning(
      violation.code,
      discourseWarningMessage(violation.code),
      { count: violation.count || 1, discourseVersion: discourseAudit.version }
    ));
  }
  const naturalnessShadow = compareNaturalnessShadow(source, outputText);
  return {
    version: 2,
    editMetrics,
    voiceAudit,
    legalIntegrity,
    floorViolations,
    warnings: dedupeWarnings(warnings),
    naturalnessShadow,
    discourseAudit,
    repetitionAudit,
    numberAudit,
    protectedFactCount: countProtectedFacts(source),
    structureSignals: detectStructureSignals(source)
  };
}

function compareRepetitionDelta(source, outputText) {
  const before = floor.measureRepetition(source);
  const after = floor.measureRepetition(outputText);
  const delta = {
    exactGroups: (after.count || 0) - (before.count || 0),
    maxRepeat: (after.maxRepeat || 1) - (before.maxRepeat || 1),
    fuzzyPairs: (after.fuzzyCount || 0) - (before.fuzzyCount || 0),
    shortFragmentGroups: (after.shortFragCount || 0) - (before.shortFragCount || 0),
    total: (after.total || 0) - (before.total || 0)
  };
  return {
    before: compactRepetition(before),
    after: compactRepetition(after),
    delta,
    increased: delta.exactGroups > 0 || delta.maxRepeat > 0 || delta.fuzzyPairs > 0 || delta.shortFragmentGroups > 0
  };
}

function compactRepetition(value) {
  return {
    exactGroups: Number(value?.count) || 0,
    maxRepeat: Number(value?.maxRepeat) || 1,
    fuzzyPairs: Number(value?.fuzzyCount) || 0,
    shortFragmentGroups: Number(value?.shortFragCount) || 0,
    total: Number(value?.total) || 0
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
  const sensitiveProfiles = new Set([
    String(documentProfile?.profile || ''),
    ...(documentProfile?.safetyProfiles || []).map(value => String(value || ''))
  ]);
  if (documentProfile?.formatProfile?.flags?.includes?.('questionnaire')
      || documentProfile?.riskFlags?.includes?.('questionnaire_answer_boundary')) {
    return { run: true, reason: 'questionnaire' };
  }
  if ([...sensitiveProfiles].some(profile => [
    'academic_paper',
    'legal_contract',
    'student_record_teacher',
    'student_self_assessment',
    'resume_application',
    'creative'
  ].includes(profile)) && (documentProfile?.confidence >= 0.75 || (documentProfile?.safetyProfiles || []).length > 0)) {
    return { run: true, reason: 'sensitive_profile' };
  }
  return { run: false, reason: 'not_required' };
}

async function runSemanticDocumentAudit({ source, outputText, lang = 'ko', signal, config, allowedExtra = '', mode = '', discourseSignals = [], safetyIdentifier = '' }) {
  const pairs = buildReviewPairs(source, outputText);
  const outputs = [];
  const reports = [];
  let remainingRepairRounds = 1;
  for (const pair of pairs) {
    try {
      const pairDiscourseSignals = pairs.length === 1
        ? discourseSignals
        : discourse.compareDiscourse(pair.sourceContext, pair.output).codes;
      const report = await judgeAndRepair(pair.sourceContext, pair.output, {
        lang,
        signal,
        config,
        maxRounds: remainingRepairRounds,
        allowedExtra,
        mode,
        discourseSignals: pairDiscourseSignals,
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
        initialViolations: report.initialViolations || [],
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
    initialViolations: reports.flatMap(report => report.initialViolations || []),
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
  const lengthPolicy = floor.polishLengthPolicy(source);
  const limits = short
    ? { minEdit: 0.02, maxEdit: 0.45, minLength: lengthPolicy.min, maxLength: lengthPolicy.max }
    : { minEdit: 0.01, maxEdit: 0.25, minLength: lengthPolicy.min, maxLength: lengthPolicy.max };
  // 수정 의무는 청크가 아니라 문서 전체에 적용한다. 긴 문서에서 실제 오류 한
  // 곳만 고친 결과를 비율 하한 때문에 무변환으로 오판하지 않는다.
  const noSafeChange = metrics.charEditRatio <= 0;
  const belowRecommendedChange = !noSafeChange && metrics.charEditRatio < limits.minEdit;
  const excessiveChange = metrics.charEditRatio > limits.maxEdit || metrics.lengthRatio < limits.minLength || metrics.lengthRatio > limits.maxLength;
  return { pass: !noSafeChange && !excessiveChange, noSafeChange, belowRecommendedChange, excessiveChange, metrics, limits };
}

function discourseWarningMessage(code) {
  const messages = {
    scope_expansion: '원문보다 주제 범위가 넓어졌을 수 있어요.',
    new_evaluation: '원문에 없던 교훈이나 평가성 결론이 추가됐을 수 있어요.',
    intensity_amplification: '원문보다 강한 수식이나 단정이 추가됐을 수 있어요.',
    duplicate_conclusion: '여러 문단이 비슷한 결론으로 반복 마무리됐을 수 있어요.',
    repeated_reflection_conclusion: '비슷한 성찰형 결론 표현이 반복됐을 수 있어요.',
    overstructured_causality: '문단마다 인과와 결론이 지나치게 같은 구조로 정리됐을 수 있어요.',
    rhetorical_role_shift: '설명·활동 문단이 새 성찰이나 결론 문단으로 바뀌었을 수 있어요.',
    topic_restart: '결론 뒤에 새로운 글처럼 주제가 다시 시작됐을 수 있어요.',
    personal_balance_shift: '원문의 실제 활동보다 일반 설명 비중이 커졌을 수 있어요.'
  };
  return messages[code] || '원문의 문서 전개 방식과 달라졌을 수 있어요.';
}

function comparePolishEvaluativePadding(source, outputText) {
  const introduced = [];
  for (const item of POLISH_EVALUATIVE_PADDING_PATTERNS) {
    const beforeCount = countRegex(source, item.pattern);
    const afterCount = countRegex(outputText, item.pattern);
    if (afterCount > beforeCount) {
      introduced.push({
        code: item.code,
        addedCount: afterCount - beforeCount
      });
    }
  }
  return {
    increased: introduced.length > 0,
    introducedCount: introduced.reduce((sum, item) => sum + item.addedCount, 0),
    introducedCodes: introduced.map(item => item.code)
  };
}

function countRegex(value, pattern) {
  return (String(value || '').match(new RegExp(pattern.source, pattern.flags)) || []).length;
}

function restorePolishEvaluativePaddingSentences(source, outputText) {
  const before = String(outputText || '');
  const initialPadding = comparePolishEvaluativePadding(source, before);
  if (!initialPadding.increased) {
    return { text: before, applied: false, restoredSentenceCount: 0, reason: 'not_needed' };
  }
  const sourceSpans = splitSentenceSpans(source);
  const outputSpans = splitSentenceSpans(before);
  if (!sourceSpans.length || sourceSpans.length !== outputSpans.length) {
    return { text: before, applied: false, restoredSentenceCount: 0, reason: 'sentence_alignment_mismatch' };
  }
  if (paragraphCountLocal(source) !== paragraphCountLocal(before)) {
    return { text: before, applied: false, restoredSentenceCount: 0, reason: 'paragraph_alignment_mismatch' };
  }

  const replacementIndices = new Set();
  sourceSpans.forEach((span, index) => {
    const sentencePadding = comparePolishEvaluativePadding(span.text, outputSpans[index].text);
    if (!sentencePadding.increased) return;
    const similarity = computeEditMetrics(span.text, outputSpans[index].text).fiveGramSimilarity;
    if (similarity >= 0.2) replacementIndices.add(index);
  });
  if (!replacementIndices.size) {
    return { text: before, applied: false, restoredSentenceCount: 0, reason: 'no_safe_alignment' };
  }

  let candidate = before;
  for (const index of [...replacementIndices].sort((a, b) => b - a)) {
    const target = outputSpans[index];
    candidate = candidate.slice(0, target.start) + sourceSpans[index].text + candidate.slice(target.end);
  }
  const policy = polishEditPolicy(source, candidate);
  const remainingPadding = comparePolishEvaluativePadding(source, candidate);
  const numberBefore = compareNumberMultiset(source, before);
  const numberAfter = compareNumberMultiset(source, candidate);
  const numberRiskBefore = numberBefore.addedCount + numberBefore.removedCount;
  const numberRiskAfter = numberAfter.addedCount + numberAfter.removedCount;
  if (remainingPadding.increased
      || policy.noSafeChange
      || policy.excessiveChange
      || splitSentenceSpans(candidate).length !== sourceSpans.length
      || paragraphCountLocal(candidate) !== paragraphCountLocal(before)
      || numberRiskAfter > numberRiskBefore) {
    return { text: before, applied: false, restoredSentenceCount: 0, reason: 'post_repair_validation_failed' };
  }
  return {
    text: candidate,
    applied: candidate !== before,
    restoredSentenceCount: replacementIndices.size,
    reason: 'restored'
  };
}

// polish는 화자를 새로 쓰는 대신 원문을 최소 교정해야 한다. 의미 수리나
// 레이아웃 복원 뒤 1인칭 종류가 완전히 사라졌다면, 문장 수가 그대로이고
// 대응 문장이 충분히 유사한 경우에만 그 문장을 원문으로 되돌린다. 원문 문장을
// 복원하는 방식이라 새 사실을 만들지 않으며, 다른 문장의 교정은 유지된다.
function restoreMissingPolishSpeaker({
  source,
  outputText,
  documentProfile = 'unknown',
  allowLayoutOnlyParagraphChange = false
} = {}) {
  const before = String(outputText || '');
  const sourceProfile = buildVoiceProfile(source, { documentProfile });
  const outputProfile = buildVoiceProfile(before, { documentProfile });
  const missingKinds = [];
  if ((sourceProfile.pov?.firstSingular || 0) > 0 && (outputProfile.pov?.firstSingular || 0) === 0) {
    missingKinds.push('firstSingular');
  }
  if ((sourceProfile.pov?.firstPlural || 0) > 0 && (outputProfile.pov?.firstPlural || 0) === 0) {
    missingKinds.push('firstPlural');
  }
  if (!missingKinds.length) return speakerRestoreResult(before, false, [], 0, 'not_needed');

  const sourceSpans = splitSentenceSpans(source);
  const outputSpans = splitSentenceSpans(before);
  if (!sourceSpans.length || sourceSpans.length !== outputSpans.length) {
    return speakerRestoreResult(before, false, missingKinds, 0, 'sentence_alignment_mismatch');
  }
  const outputParagraphCount = paragraphCountLocal(before);
  if (!allowLayoutOnlyParagraphChange && paragraphCountLocal(source) !== outputParagraphCount) {
    return speakerRestoreResult(before, false, missingKinds, 0, 'paragraph_alignment_mismatch');
  }

  const replacementIndices = new Set();
  for (const kind of missingKinds) {
    const pattern = POV_PATTERNS[kind];
    sourceSpans.forEach((span, index) => {
      if (!patternMatches(pattern, span.text)) return;
      const similarity = computeEditMetrics(span.text, outputSpans[index].text).fiveGramSimilarity;
      if (similarity >= 0.25) replacementIndices.add(index);
    });
  }
  if (!replacementIndices.size) {
    return speakerRestoreResult(before, false, missingKinds, 0, 'no_safe_alignment');
  }

  let candidate = before;
  for (const index of [...replacementIndices].sort((a, b) => b - a)) {
    const target = outputSpans[index];
    candidate = candidate.slice(0, target.start) + sourceSpans[index].text + candidate.slice(target.end);
  }
  const repairedProfile = buildVoiceProfile(candidate, { documentProfile });
  const stillMissing = missingKinds.some(kind => (repairedProfile.pov?.[kind] || 0) === 0);
  const numberBefore = compareNumberMultiset(source, before);
  const numberAfter = compareNumberMultiset(source, candidate);
  const numberRiskBefore = numberBefore.addedCount + numberBefore.removedCount;
  const numberRiskAfter = numberAfter.addedCount + numberAfter.removedCount;
  if (stillMissing
      || splitSentenceSpans(candidate).length !== sourceSpans.length
      || paragraphCountLocal(candidate) !== outputParagraphCount
      || numberRiskAfter > numberRiskBefore) {
    return speakerRestoreResult(before, false, missingKinds, 0, 'post_repair_validation_failed');
  }
  return speakerRestoreResult(candidate, candidate !== before, missingKinds, replacementIndices.size, 'restored');
}

function patternMatches(pattern, value) {
  if (!pattern) return false;
  pattern.lastIndex = 0;
  return pattern.test(String(value || ''));
}

function paragraphCountLocal(value) {
  return String(value || '').replace(/\r\n?/gu, '\n').split(/\n[ \t]*\n+/u).map(item => item.trim()).filter(Boolean).length;
}

function speakerRestoreResult(text, applied, restoredKinds, restoredSentenceCount, reason) {
  return { text, applied, restoredKinds, restoredSentenceCount, reason };
}

async function retryPolishSurface({ source, currentOutput, policy, reason = '', config, signal, safetyIdentifier = '' }) {
  const taskInstruction = reason === 'evaluative_padding'
    ? 'CURRENT에 SOURCE에 없던 평가성 표현이 붙었다. 그 평가를 모두 제거하고 SOURCE에 실제로 있는 표면 오류만 최소 한 곳 고친다. 안전한 다른 교정이 없으면 safeChangeFound=false로 답한다.'
    : 'CURRENT가 SOURCE와 실질적으로 같다. SOURCE에서 실제로 안전하게 고칠 수 있는 표면 오류를 최소 한 곳만 고친다. 고칠 곳이 정말 없으면 safeChangeFound=false로 답한다.';
  const system = [
    '너는 한국어 보존형 윤문 수리기다.',
    '원문의 주장, 예시, 수치, 기관명, 인용, 화자, 문단 수와 순서를 바꾸지 않는다.',
    '비문, 띄어쓰기, 접속, 완전 중복, 말투 혼합 중 실제 오류만 수정한다.',
    '원문에 없던 가능성·필요성·중요성·의미·역할·긍정성·체계성·전략성·효율성 평가를 새로 붙이지 않는다.',
    '새 문장이나 새 문단을 만들지 않는다.',
    taskInstruction,
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

async function retryGeneralSurface({ source, currentOutput, humanizationPlan = null, humanizationDepthReport = null, config, signal, safetyIdentifier = '', model = '', reasoningEffort = '', phase = 'humanization_depth_retry' }) {
  const plan = humanizationPlan || {};
  const strengthLabel = plan.requestStrength === 'advanced' ? '고급' : '기본';
  const resumeProfile = plan.profile === 'resume_application';
  const targetOrdinals = buildGeneralRetryTargetOrdinals(source, currentOutput, plan, humanizationDepthReport);
  const targetText = targetOrdinals.length ? targetOrdinals.join(', ') : '서버가 표시한 현재 문장 중 안전하게 재구성 가능한 한 곳';
  const remediationLow = (humanizationDepthReport?.reasons || []).includes('rhetorical_remediation_low');
  const resumeRepetitionLow = (humanizationDepthReport?.reasons || []).includes('resume_semantic_repetition_low');
  const structuralLow = (humanizationDepthReport?.reasons || []).includes('structural_rewrite_coverage_low');
  const paragraphLow = (humanizationDepthReport?.reasons || []).includes('paragraph_rewrite_coverage_low');
  const noEffectRecovery = phase === 'humanization_no_effect_retry';
  const untouchedParagraphs = (humanizationDepthReport?.metrics?.untouchedTargetParagraphIndices || [])
    .filter(Number.isInteger)
    .map(index => index + 1);
  const system = [
    '너는 한국어 실질 휴머나이징 국소 수리기다. 교정·다듬기만 한 결과를 만드는 작업이 아니다.',
    'SOURCE의 주장, 예시, 수치, 기관명, 인용, 화자, 제목, 목록, 질문, 문단 수와 내용 순서를 보존한다.',
    resumeRepetitionLow
      ? 'CURRENT를 기준으로 하되, 같은 지원 전제가 반복된 표시 문장이 여러 문단에 있으면 그 문장들은 문단별 역할에 맞춰 함께 재구성한다. 표시되지 않은 문장과 문단 순서는 그대로 둔다.'
      : 'CURRENT는 보존 검사를 통과했거나 원문으로 안전 복귀한 후보이므로 CURRENT를 기준으로 작업한다. 문서 전체를 다시 쓰지 않는다.',
    '띄어쓰기, 쉼표, 인용부호, 조사 한 곳, 단순 축약이나 동의어 한두 개만 바꾼 결과는 실패다.',
    `${strengthLabel} 모드의 변화량은 서버가 결과에서 계산한다. 숫자를 맞추기 위한 새 설명이나 동의어 나열 대신 지정된 문장의 절 순서·주어 위치·연결·호흡을 다시 구성한다.`,
    noEffectRecovery
      ? '앞선 회복도 공백·구두점·동의어 수준에 머물렀다. 이미 조금 바뀐 한 문장만 다시 만지지 말고, 아직 그대로 남은 지정 문장 가운데 최소 두 곳을 골라 각각 절 배치나 문장 호흡을 실질적으로 다시 구성한다.'
      : '',
    `수정 대상 문장 번호=${targetText}. 번호는 SOURCE와 CURRENT의 일반 문장 순서 기준이다.`,
    paragraphLow
      ? `현재 한쪽 문단에만 변화가 몰렸다. 아직 대상 문장이 실질적으로 바뀌지 않은 일반 산문 문단=${untouchedParagraphs.join(',') || '서버 표시 문단'}. 이 문단들을 빠뜨리지 말고 각 문단 안의 지정 문장을 고르게 재구성한다.`
      : '',
    plan.requestStrength === 'advanced'
      ? '고급 모드에서 수정 대상이 여러 문단에 걸치면 첫 문단만 고치고 멈추지 않는다. 각 문단의 역할과 순서는 유지하면서 지정된 대상 전체에 절 배치·주어 위치·연결·호흡 변화를 분산한다.'
      : '',
    '장르와 무관하게 SOURCE의 전문 개념 정확도를 낮추지 않는다. SOURCE에 공정 최적화·상관관계·원인 분석·재현성 검증·정량/수치화·데이터 해석이 있으면 같은 주장 안에 남기고, 조정·관계·짚기·확인하는 일 같은 더 약하거나 구어적인 말로 낮추지 않는다.',
    '“데이터를 보고서·논문에 작성하다”, “피드백을 반복하다” 같은 주어·목적어·연어 오류를 만들지 않는다.',
    resumeProfile
      ? '역량을 길렀다·능력을 키웠다·노력했다가 반복되면 SOURCE의 실제 행동과 확인 가능한 결과로 직접 서술한다.'
      : '',
    resumeRepetitionLow
      ? '현재 지원서는 같은 지원 전제·진로 고민·탐색 의도를 표현만 바꿔 여러 문단에서 되풀이했다. 첫 문단에는 지원 동기를 온전히 남기고, 뒤 문단에서는 그 전제를 짧게 받은 뒤 SOURCE에 원래 있던 어려움, 확인할 항목, 실행 계획을 문단의 중심으로 앞세운다. 같은 뜻의 문장을 단순 삭제하지 말고 고유 정보가 남도록 합치거나 재배치한다.'
      : '',
    resumeRepetitionLow
      ? '구체성을 만든다는 이유로 SOURCE에 없는 전공 관심, 학교 프로그램, 과거 조사·활동, 교수·재학생에게 물을 새 질문을 추가하지 않는다.'
      : '',
    '수정 대상의 앞뒤 한 문장은 같은 문단 안에서 같은 설명·활동·결론 역할을 공유할 때만 함께 묶어 고칠 수 있다. 다른 역할이나 다른 문단으로 내용은 옮기지 않는다.',
    structuralLow
      ? '현재 결과는 단어는 바뀌었지만 문장 구조 변화가 부족하다. 이미 조금 바뀐 대상도 절 배치·주어 위치·연결·문장 경계를 다시 구성해 표면 교체를 넘어선다.'
      : '',
    remediationLow
      ? '현재 결과에는 SOURCE부터 있던 정형 성찰 결론·반복 결론 표지·과도하게 완결된 인과 구조가 충분히 개선되지 않았다. 주장과 사실은 모두 남기고 해당 표현 방식만 직접적이고 덜 정형적으로 바꾼다.'
      : '',
    '대상 문장의 주장 범위, 문단 역할, 결론 여부는 바꾸지 않는다. 설명을 교훈·감상·결론으로 바꾸거나 주제를 넓혀 변화량을 채우지 않는다.',
    '문장 수는 지정된 문장 안의 의미 단위를 자연스럽게 합치거나 나누는 경우에만 조정하고, 문단·제목·목록·질문·인용 구조는 바꾸지 않는다.',
    '새 사실·평가·감정·경험·수치·기관·인용·예시를 만들지 않는다.',
    '이 보존 조건 안에서 실질 변화 기준을 만족할 수 없을 때만 safeChangeFound=false로 답한다.'
  ].filter(Boolean).join('\n');
  const response = await completeJson({
    system,
    user: `[SOURCE - 의미 확인용]\n${source}\n\n[CURRENT - 여기서 국소 수정]\n${currentOutput}`,
    schema: POLISH_REPAIR_SCHEMA,
    schemaName: 'gpt_prod_general_surface_retry',
    model: model || config.models.repair,
    reasoningEffort: reasoningEffort || config.reasoning.repair,
    verbosity: 'low',
    maxOutputTokens: Math.max(2400, Math.min(12000, Math.ceil(String(source || '').length * 3.2))),
    config,
    signal,
    safetyIdentifier,
    meta: { task: 'repair', phase, mode: 'humanize', profile: 'gpt_prod_v2' }
  });
  return {
    outputText: String(response.json.outputText || '').trim() || currentOutput,
    safeChangeFound: response.json.safeChangeFound === true,
    notes: response.json.notes || [],
    usage: response.usage,
    model: response.model,
    targetOrdinals,
    targetSentenceCount: targetOrdinals.length
  };
}

function buildGeneralRetryTargetOrdinals(source, currentOutput, plan = {}, depthReport = null) {
  const measured = humanizationDepth.measureSubstantiveEdit(source, currentOutput);
  const rows = measured.sentenceEdits || [];
  if (!rows.length) return [];
  const targetSet = new Set((plan.targetIndices || []).filter(index => Number.isInteger(index)));
  const untouchedTargetParagraphs = new Set((depthReport?.metrics?.untouchedTargetParagraphIndices || [])
    .filter(index => Number.isInteger(index) && index >= 0));
  const unchanged = rows.filter(row => !row.substantiveChanged);
  const shallowChanged = rows.filter(row => row.substantiveChanged
    && (!row.structuralChanged || Number(row.ratio || 0) < 0.12));
  const deepChangedTargets = rows.filter(row => row.substantiveChanged
    && row.structuralChanged
    && targetSet.has(row.index));
  const remediationLow = (depthReport?.reasons || []).includes('rhetorical_remediation_low');
  const resumeRepetitionLow = (depthReport?.reasons || []).includes('resume_semantic_repetition_low');
  const untouchedParagraphSeeds = firstRowPerParagraph([
    ...unchanged.filter(row => targetSet.has(row.index) && untouchedTargetParagraphs.has(row.sourceParagraphIndex)),
    ...shallowChanged.filter(row => targetSet.has(row.index) && untouchedTargetParagraphs.has(row.sourceParagraphIndex))
  ]);
  const ordered = uniqueRows([
    ...untouchedParagraphSeeds,
    ...unchanged.filter(row => targetSet.has(row.index) && untouchedTargetParagraphs.has(row.sourceParagraphIndex)),
    ...shallowChanged.filter(row => targetSet.has(row.index) && untouchedTargetParagraphs.has(row.sourceParagraphIndex)),
    ...unchanged.filter(row => targetSet.has(row.index)),
    ...shallowChanged.filter(row => targetSet.has(row.index)),
    ...((remediationLow || resumeRepetitionLow) ? deepChangedTargets : []),
    ...unchanged.filter(row => !targetSet.has(row.index)),
    ...shallowChanged.filter(row => !targetSet.has(row.index))
  ]);
  if (!ordered.length) return [];

  const currentChangedCount = Number(depthReport?.metrics?.substantiveChangedSentenceCount ?? measured.substantiveChangedSentenceCount) || 0;
  const currentTargetChangedCount = Number(depthReport?.metrics?.targetChangedCount) || 0;
  const currentStructuralCount = Number(depthReport?.metrics?.structurallyChangedSentenceCount ?? measured.structurallyChangedSentenceCount) || 0;
  const totalDeficit = Math.max(1, Number(plan.requiredChangedSentenceCount || 1) - currentChangedCount);
  const targetDeficit = Math.max(0, Number(plan.requiredTargetChangedCount || 0) - currentTargetChangedCount);
  const structuralDeficit = Math.max(0, Number(plan.requiredStructuralChangedSentenceCount || 0) - currentStructuralCount);
  const paragraphDeficit = Math.max(0,
    Number(plan.requiredTargetChangedParagraphCount || 0)
      - Number(depthReport?.metrics?.targetChangedParagraphCount || 0));
  const remediationDeficit = remediationLow
    ? Math.max(1, Number(depthReport?.metrics?.remediation?.residualTargetCount || 1))
    : 0;
  const resumeRepetitionDeficit = resumeRepetitionLow
    ? Math.max(1, Number(depthReport?.metrics?.resumeRepetition?.requiredReduction || 1)
      - Number(depthReport?.metrics?.resumeRepetition?.achievedReduction || 0))
    : 0;
  const sourceChars = Math.max(1, Number(plan.sourceChars) || String(source || '').replace(/\s+/gu, '').length);
  const averageSentenceChars = sourceChars / Math.max(1, rows.length);
  const editDeficitChars = Math.max(0,
    (Number(plan.minSubstantiveEditRatio || 0) * sourceChars) - Number(measured.substantiveDistance || 0));
  // 지정된 한 문장을 다시 구성하면 평균적으로 그 문장 길이의 약 18%가
  // 실질 편집된다고 보고, 최소선에 닿는 데 필요한 범위만 보수적으로 고른다.
  const editDeficitCount = Math.ceil(editDeficitChars / Math.max(6, averageSentenceChars * 0.18));
  const desiredCount = Math.min(ordered.length, Math.max(
    totalDeficit,
    targetDeficit,
    structuralDeficit,
    remediationDeficit,
    resumeRepetitionDeficit,
    editDeficitCount,
    paragraphDeficit
  ));
  return ordered
    .slice(0, Math.max(1, desiredCount))
    .map(row => row.index + 1);
}

function firstRowPerParagraph(rows) {
  const seen = new Set();
  return (rows || []).filter(row => {
    const paragraphIndex = Number(row?.sourceParagraphIndex);
    if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0 || seen.has(paragraphIndex)) return false;
    seen.add(paragraphIndex);
    return true;
  });
}

async function retryKoreanRefinement({
  source,
  currentOutput,
  refinementAudit,
  documentProfile = null,
  mode = '',
  config,
  signal,
  safetyIdentifier = '',
  model = '',
  reasoningEffort = ''
}) {
  const profile = String(documentProfile?.profile || documentProfile || 'unknown');
  const issues = (refinementAudit?.repairableIssues || [])
    .filter(item => item.afterCount > 0 && item.deterministicSafe !== true)
    .slice(0, 8);
  if (!issues.length) {
    return {
      outputText: currentOutput,
      safeChangeFound: false,
      notes: [],
      usage: null,
      model: '',
      issueCodes: []
    };
  }
  const issueLines = issues.map(item => {
    const ordinals = (item.sentenceOrdinals || []).slice(0, 12).join(',');
    const details = refinementIssueInstruction(item);
    return `- ${item.code}${ordinals ? ` (문장 ${ordinals})` : ''}: ${item.message}${details ? ` ${details}` : ''}`;
  });
  const system = [
    '너는 한국어 문장 국소 수리기다. CURRENT에서 아래에 열거한 한국어 결합·빈도·초점·격식 문제만 최소 범위로 고친다.',
    'SOURCE는 의미와 사실 확인용이다. SOURCE의 주장, 수치, 기관명, 인용, 화자, 경험, 평가 강도, 제목, 목록, 질문, 문단 수와 내용 순서를 그대로 보존한다.',
    '과학·법률·게임이론 등 외부 사실의 옳고 그름을 추정해 수정하지 않는다. 원문에 없던 설명이나 예시도 추가하지 않는다.',
    '문제가 있는 문장과 같은 문단의 바로 인접한 문장만 문법상 꼭 필요할 때 함께 손본다. 나머지는 CURRENT를 그대로 둔다.',
    '원문의 장르와 전문성 하한을 지킨다. 자연스럽게 만든다는 이유로 전문 개념을 일상적인 말로 낮추지 않는다. 연구개발 문맥의 최적화·상관관계·원인 분석·재현성 검증·수치화·데이터 해석은 같은 주장 안에서 정확도를 유지한다.',
    '자기소개서·업무 글의 개선 필요·업무 수행·기준 숙지 같은 격식 표현을 손보다·그냥 하다·익히다 같은 가벼운 말로 낮추지 않는다. 객관적으로와 직접적으로처럼 의미 기능이 다른 부사는 서로 바꾸지 않는다.',
    '직접 인용 내부는 한 글자도 고치지 않는다. 인용 뒤 조사가 어색하면 인용 밖의 “라는 입장·이라고 설명” 같은 연결만 바로잡는다.',
    '“나는 …은/는”처럼 주제를 겹치거나 “저는지”처럼 성립하지 않는 어미를 만들지 않는다. 가치에는 동참하고, 소비·수요·이용 범위는 확대되거나 늘어난다고 표현한다.',
    '데이터를 보고서나 논문에 “작성”한다고 쓰지 않는다. SOURCE가 데이터의 활용을 뜻하면 “반영”으로, 본인이 문서를 써서 낸 것이 분명하면 “보고서·논문 원고를 작성”으로 주어와 목적어를 바로잡는다. 피드백은 문맥에 맞게 주고받았다고 쓴다.',
    profile === 'resume_application'
      ? '역량을 길렀다·능력을 키웠다·노력했다 계열이 반복되면 실제 행동과 SOURCE에 있는 결과를 직접 서술한다. 새 성과나 수치를 만들어 반복을 피하지 않는다.'
      : '',
    ['academic_paper', 'report_assignment', 'legal_contract'].includes(profile)
      ? '학술·보고서의 개념어와 격식을 유지하고 구어체나 감탄형 표현을 새로 넣지 않는다.'
      : '',
    '수리할 문제가 실제로 남아 있지 않거나 보존 조건 안에서 안전하게 고칠 수 없으면 safeChangeFound=false로 답한다.',
    '[수리 대상]',
    ...issueLines
  ].filter(Boolean).join('\n');
  const response = await completeJson({
    system,
    user: `[SOURCE - 의미 확인용]\n${source}\n\n[CURRENT - 국소 수리 대상]\n${currentOutput}`,
    schema: POLISH_REPAIR_SCHEMA,
    schemaName: 'gpt_prod_korean_refinement_retry',
    model: model || config.models.repair,
    reasoningEffort: reasoningEffort || config.reasoning.repair,
    verbosity: 'low',
    maxOutputTokens: Math.max(1800, Math.min(12000, Math.ceil(String(currentOutput || '').length * 2.2))),
    config,
    signal,
    safetyIdentifier,
    meta: { task: 'repair', phase: 'korean_refinement_retry', mode: String(mode || ''), profile }
  });
  return {
    outputText: String(response.json.outputText || '').trim() || currentOutput,
    safeChangeFound: response.json.safeChangeFound === true,
    notes: response.json.notes || [],
    usage: response.usage,
    model: response.model,
    issueCodes: issues.map(item => item.code)
  };
}

function refinementIssueInstruction(item) {
  if (item?.code === 'professional_register_downgrade') {
    const losses = Array.isArray(item?.details?.alignedLosses) ? item.details.alignedLosses : [];
    const hints = losses.slice(0, 8).map(loss => `${loss.sourceOrdinal}번 주장의 ${loss.concept}=${(loss.preferred || []).join('/')}`);
    return hints.length ? `SOURCE의 같은 주장에 남겨야 할 전문 표현: ${hints.join('; ')}.` : '';
  }
  if (item?.code === 'data_document_collocation') {
    return '데이터 활용이면 보고서·논문에 반영했다고 쓰고, SOURCE에서 문서 집필이 분명한 경우만 원고를 작성했다고 쓴다.';
  }
  if (item?.code === 'feedback_exchange_collocation') return '피드백을 반복했다고 쓰지 말고 주고받은 과정을 서술한다.';
  if (item?.code === 'quote_attribution_particle_mismatch') return '인용 내부는 그대로 두고 바깥 연결만 “라는 입장·이라고 설명”처럼 문맥에 맞게 고친다.';
  if (item?.code === 'double_topic_chain') return '원문의 화자를 지우지 말고 겹친 주제 조사 하나만 자연스러운 주어·목적어 관계로 고친다.';
  if (item?.code === 'malformed_question_ending') return '원문과 앞뒤 문맥을 확인해 “달라졌는지·생겼는지·나타났는지”처럼 실제 서술어에 맞는 간접의문 어미로 복원한다.';
  if (item?.code === 'value_participation_collocation') return '가치·취지에는 동참한다고 쓰되 원문의 행동과 평가 강도는 바꾸지 않는다.';
  if (item?.code === 'scope_expansion_collocation') return '소비·수요·이용의 양이나 범위가 확대·증가·늘어나는 원문 의미 중 맞는 표현만 선택한다.';
  if (item?.code === 'self_evaluation_repetition') return '반복된 자기평가 결론을 SOURCE에 있는 행동·결과 서술로 옮기되 새 성과를 만들지 않는다.';
  if (item?.code === 'overloaded_research_action_chain') return '원인 분석·조건 조정·반복 실험·재현성 검증의 순서는 유지하고, 필요하면 두 문장으로 나눈다.';
  if (item?.code === 'formal_register_residual') {
    return '직접 인용이나 정식 용어는 보존한다. 그 밖의 게임·군사·신체 은유와 구어적 별칭은 같은 행위·상태·절차를 뜻하는 중립적 공식 표현으로 바꾼다. 지원서의 디딤돌·든든한 동행자·따뜻한 조력자 같은 장식적 결론은 SOURCE에 있는 실제 행동 계획으로만 정리한다.';
  }
  if (item?.code === 'purpose_modifier_collocation') return '정책·제도가 지향하는 목적이면 “~을 만들기 위한 정책·제도”처럼 목적 관계를 분명히 한다.';
  if (item?.code === 'metacognitive_predicate_stack') return 'SOURCE의 생각·고민 범위를 유지하면서 “고민할 수 있다고 생각했다” 또는 “더 깊이 고민하게 되었다” 중 실제 의미에 맞는 한 구조만 쓴다.';
  if (item?.code === 'dialogue_give_collocation') return '말은 건넬 수 있지만 대화는 나누는 상호행위다. SOURCE의 참여 주체와 방향을 유지해 고친다.';
  if (item?.code === 'sampling_subject_mismatch') return 'SOURCE에서 연구자가 표집한 대상이라면 대상을 목적어로 두고 연구자 생략 주어의 능동문 또는 적절한 피동문으로 고친다.';
  if (item?.code === 'tool_personification') return '도구의 기능은 “연결한다·제공한다·표시한다”처럼 중립적으로 쓰고 SOURCE의 기능 범위를 넘기지 않는다.';
  if (item?.code === 'benefit_help_predicate_redundancy') return 'SOURCE의 지원 범위는 유지하고 “도움을 받을 수 있게 돕다”의 겹친 서술어 하나만 자연스럽게 정리한다.';
  if (item?.code === 'contrast_clause_attachment') return 'SOURCE의 비교 방향과 절 순서를 확인해 “~하기보다”가 실제 비교 대상에 바로 연결되도록 고친다.';
  return '';
}

async function retryFingerprintAudit({
  source,
  currentOutput,
  fingerprintAudit,
  documentProfile = null,
  config,
  signal,
  safetyIdentifier = ''
}) {
  const issues = (fingerprintAudit?.violations || []).slice(0, 8);
  if (!issues.length) return { outputText: currentOutput, safeChangeFound: false, notes: [], usage: null, model: '' };
  const profile = String(documentProfile?.profile || documentProfile || 'unknown');
  const issueLines = issues.map(item => {
    if (item.code === 'contrast_relation_shift') {
      return `- contrast_relation_shift: SOURCE의 부정·배제 관계를 인정·가산 관계로 바꾸지 말고 문장 ${item.sentenceOrdinals?.join(',') || '해당 위치'}의 논리 방향을 복원한다.`;
    }
    if (item.code === 'semantic_relation_shift') {
      return `- semantic_relation_shift/${item.family}: 문장 ${item.sentenceOrdinals?.join(',') || '해당 위치'}에서 SOURCE의 목적·근거·대조·가능성·행위 방향과 강도를 정확히 복원한다.`;
    }
    return `- engine_phrase_fingerprint/${item.family}: CURRENT에 새로 반복 주입된 상투구를 문서당 1회 이하로 줄인다.`;
  });
  const system = [
    '너는 엔진 상투구와 논리 방향만 국소 수리하는 한국어 편집기다.',
    'SOURCE는 의미와 논리 관계 확인용이고 CURRENT가 편집 대상이다. 표시된 문제 문장과 바로 인접한 문장 외에는 바꾸지 않는다.',
    'SOURCE의 주장, 목적, 근거 틀, 부정·배제·대조·인정·가능성 관계, 행위 방향과 강도, 수치, 기관명, 인용, 화자, 문단·제목·목록 순서를 그대로 보존한다.',
    '증명을 확인으로, 재발견을 되살리기로, 적극적 태도를 바로·직접으로, 연구를 통해 확인한 내용을 근거 없는 단정으로 바꾸지 않는다. SOURCE에 없던 즉시성도 제거한다.',
    '새 주장·예시·평가·경험·결론을 만들지 않고, 상투구를 다른 상투구로 치환하지 않는다.',
    ['academic_paper', 'report_assignment', 'legal_contract'].includes(profile)
      ? '학술·보고서의 개념어와 평서문 격식을 유지한다. 구어체·명령형·도구 의인화를 새로 넣지 않는다.'
      : '',
    '안전하게 고칠 수 없거나 문제가 이미 없다면 safeChangeFound=false로 답한다.',
    '[수리 대상]',
    ...issueLines
  ].filter(Boolean).join('\n');
  const response = await completeJson({
    system,
    user: `[SOURCE - 논리 확인용]\n${source}\n\n[CURRENT - 국소 수리 대상]\n${currentOutput}`,
    schema: POLISH_REPAIR_SCHEMA,
    schemaName: 'gpt_prod_fingerprint_retry',
    model: config.models.repair,
    reasoningEffort: config.reasoning.repair,
    verbosity: 'low',
    maxOutputTokens: Math.max(1800, Math.min(12000, Math.ceil(String(currentOutput || '').length * 2.2))),
    config,
    signal,
    safetyIdentifier,
    meta: { task: 'repair', phase: 'fingerprint_retry', mode: 'humanize', profile: 'gpt_prod_v2' }
  });
  return {
    outputText: String(response.json.outputText || '').trim() || currentOutput,
    safeChangeFound: response.json.safeChangeFound === true,
    notes: response.json.notes || [],
    usage: response.usage,
    model: response.model
  };
}

async function retryEndingStyleAudit({
  source,
  currentOutput,
  endingAudit,
  documentProfile = null,
  config,
  signal,
  safetyIdentifier = ''
}) {
  const issues = (endingAudit?.issues || []).slice(0, 8);
  if (!issues.length) return { outputText: currentOutput, safeChangeFound: false, notes: [], usage: null, model: '' };
  const profile = String(documentProfile?.profile || documentProfile || 'unknown');
  const issueLines = issues.map(item => {
    const styles = (item.introducedStyles || []).map(style => `${style.style} ${style.count}문장`).join(', ');
    return `- 섹션 ${item.index + 1}${item.heading ? `(${item.heading})` : ''}: 원문 지배 종결체=${item.dominantStyle}, 새 혼용=${styles || item.introducedOtherCount}`;
  });
  const system = [
    '너는 한국어 종결체 혼용만 국소 수리하는 편집기다.',
    'SOURCE에서 한 종결체가 지배적인 섹션에 CURRENT가 새로 만든 다른 종결체만 원문의 지배 종결체로 되돌린다.',
    '원래 혼합 문체인 섹션은 통일하지 않는다. 문제 없는 문장과 다른 섹션은 그대로 둔다.',
    '어미 외의 핵심 어휘·주장·수치·기관명·인용·화자·문장 수·문단·제목·목록 순서는 바꾸지 않는다.',
    profile === 'student_record_teacher' ? '세특의 관찰형 명사 종결은 평서문으로 바꾸지 않는다.' : '',
    '안전하게 고칠 수 없거나 문제가 이미 없다면 safeChangeFound=false로 답한다.',
    '[수리 대상]',
    ...issueLines
  ].filter(Boolean).join('\n');
  const response = await completeJson({
    system,
    user: `[SOURCE - 종결체 확인용]\n${source}\n\n[CURRENT - 국소 수리 대상]\n${currentOutput}`,
    schema: POLISH_REPAIR_SCHEMA,
    schemaName: 'gpt_prod_ending_style_retry',
    model: config.models.repair,
    reasoningEffort: config.reasoning.repair,
    verbosity: 'low',
    maxOutputTokens: Math.max(1800, Math.min(12000, Math.ceil(String(currentOutput || '').length * 2.2))),
    config,
    signal,
    safetyIdentifier,
    meta: { task: 'repair', phase: 'ending_style_retry', mode: 'humanize', profile: 'gpt_prod_v2' }
  });
  return {
    outputText: String(response.json.outputText || '').trim() || currentOutput,
    safeChangeFound: response.json.safeChangeFound === true,
    notes: response.json.notes || [],
    usage: response.usage,
    model: response.model
  };
}

async function retryResumeCoverage({
  source,
  currentOutput,
  coverageAudit,
  config,
  signal,
  safetyIdentifier = ''
}) {
  const omissions = (coverageAudit?.omissions || []).slice(0, 8);
  if (!omissions.length) return { outputText: currentOutput, safeChangeFound: false, notes: [], usage: null, model: '' };
  const issueLines = omissions.map(item => [
    `- 원문 문장 ${item.sourceOrdinal}; 유형=${(item.types || []).join(',')}; 회수율=${item.contentRecall}`,
    item.previousContext ? `  앞 문맥: ${item.previousContext}` : '',
    `  복원할 원문 주장: ${item.sourceSentence}`,
    item.nextContext ? `  뒤 문맥: ${item.nextContext}` : ''
  ].filter(Boolean).join('\n'));
  const system = [
    '너는 자기소개서 핵심 주장 누락만 복원하는 한국어 편집기다.',
    'SOURCE의 행동·역량·성과·직무 연결 문장이 CURRENT에서 빠지거나 핵심 내용어가 사라진 항목만 원래 위치에 복원한다.',
    '각 항목에 제공된 원문 문장과 앞뒤 문맥만 사용한다. 새 경험·성과·수치·역량·직무 연결을 추정하거나 만들지 않는다.',
    '문단 순서와 화자·시점을 유지하고, 이미 보존된 다른 문장은 바꾸지 않는다. 별도 요약·결론 문단을 만들지 않는다.',
    '복원 문장은 원문의 격식과 전문 개념어를 유지하며 지나친 구어체로 낮추지 않는다.',
    '안전하게 원래 위치를 찾을 수 없거나 누락이 이미 없다면 safeChangeFound=false로 답한다.',
    '[복원 대상]',
    ...issueLines
  ].join('\n');
  const response = await completeJson({
    system,
    user: `[SOURCE - 주장과 위치 확인용]\n${source}\n\n[CURRENT - 누락 복원 대상]\n${currentOutput}`,
    schema: POLISH_REPAIR_SCHEMA,
    schemaName: 'gpt_prod_resume_coverage_retry',
    model: config.models.repair,
    reasoningEffort: config.reasoning.repair,
    verbosity: 'low',
    maxOutputTokens: Math.max(1800, Math.min(12000, Math.ceil(String(currentOutput || '').length * 2.2))),
    config,
    signal,
    safetyIdentifier,
    meta: { task: 'repair', phase: 'resume_coverage_retry', mode: 'humanize', profile: 'gpt_prod_v2' }
  });
  return {
    outputText: String(response.json.outputText || '').trim() || currentOutput,
    safeChangeFound: response.json.safeChangeFound === true,
    notes: response.json.notes || [],
    usage: response.usage,
    model: response.model
  };
}

function uniqueRows(rows) {
  const seen = new Set();
  return (rows || []).filter(row => {
    const index = Number(row?.index);
    if (!Number.isInteger(index) || seen.has(index)) return false;
    seen.add(index);
    return true;
  });
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
  for (const code of [...codes].filter(value => SEMANTIC_WARNING_TYPES.has(value))) {
    if (['added_claim', 'distortion', 'omission'].includes(code)) continue;
    out.push(warning(code, discourseWarningMessage(code)));
  }
  if (!out.length) out.push(warning('semantic_review_failed', '자동 의미 심사가 결론을 확정하지 못해 원문 대조를 권장해요.'));
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
    number_changed: '원문의 숫자나 수량 표기 일부가 추가되거나 누락됐을 수 있어요.',
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
  comparePolishEvaluativePadding,
  restorePolishEvaluativePaddingSentences,
  restoreMissingPolishSpeaker,
  compareRepetitionDelta,
  retryPolishSurface,
  retryGeneralSurface,
  retryKoreanRefinement,
  retryFingerprintAudit,
  retryEndingStyleAudit,
  retryResumeCoverage,
  buildGeneralRetryTargetOrdinals,
  warningsFromSemantic
};
