'use strict';

const floor = require('../engine/floor');
const { computeEditMetrics, splitSentenceSpans } = require('../engine/koreanText');
const { hasPovKind } = require('../engine/pov');
const { auditVoice, buildVoiceProfile, auditDirectQuoteIntegrity } = require('./voiceProfile');
const { compareNaturalnessShadow } = require('./naturalnessShadow');
const { judgeAndRepair } = require('./judge');
const { completeJson } = require('./openaiClient');
const { compareNumberMultiset } = require('./factAudit');
const discourse = require('./discourseAudit');
const humanizationDepth = require('./humanizationDepth');
const legalAudit = require('./legalAudit');
const koreanRefinement = require('./koreanRefinement');
const endingStyle = require('./endingStyleAudit');
const {
  buildPromptDataSections,
  promptEnvelopeSystemRule
} = require('./promptEnvelope');

const POLISH_REQUIRED_ISSUE_CODES = new Set([
  'missing_sentence_space',
  'closed_quote_spacing',
  'closed_quote_particle_spacing',
  'message_spelling',
  'numeric_parenthesis_join',
  'deep_understanding_collocation',
  'practice_class_spacing',
  'frequency_quantifier_conflict',
  'double_topic_chain',
  'malformed_question_ending',
  'causal_predicate_stack',
  'nominal_predicate_collocation',
  'case_frame_corruption',
  'role_predicate_redundancy',
  'sampling_subject_mismatch',
  'functional_greeting_duplication',
  'introduced_token_duplication',
  'reciprocal_expression_redundancy',
  'missing_subject_particle',
  'repeated_clause_anchor',
  'purpose_case_frame'
]);

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

const CONSERVATIVE_SENTENCE_REPAIR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rewrittenSentence: { type: 'string' },
    safeChangeFound: { type: 'boolean' },
    notes: { type: 'array', items: { type: 'string' } }
  },
  required: ['rewrittenSentence', 'safeChangeFound', 'notes']
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
  'protected_block_changed',
  'table_column_ownership_lost',
  'protected_term_loss',
  'unsafe_chunk_boundary',
  'speaker_injected',
  'speaker_removed',
  'personal_scope_generalized',
  'quote_count_changed',
  'quote_content_changed',
  'list_structure_changed',
  'heading_structure_changed',
  'paragraph_structure_changed',
  'title_line_merged',
  'structural_line_loss',
  'line_structure_changed',
  'line_anchor_changed',
  'inline_label_body_split',
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
  if (structureAudit?.protectedBlockChangedCount > 0) {
    warnings.push(warning(
      'protected_block_changed',
      '참고문헌·표·인용처럼 그대로 보존해야 하는 블록 일부를 원문과 대조해 주세요.',
      { count: structureAudit.protectedBlockChangedCount }
    ));
  }
  if (structureAudit?.tableColumnOwnershipPass === false) {
    warnings.push(warning(
      'table_column_ownership_lost',
      '표의 행별 열 개수나 셀 대응이 원문과 달라졌을 수 있어요.',
      { count: structureAudit.tableColumnOwnershipLossCount || 1 }
    ));
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
  if (structureAudit?.originalStructuralMarkerLossCount > 0) {
    warnings.push(warning(
      'original_structure_marker_loss',
      '원문의 절 번호나 목록 기호 일부가 달라졌을 수 있어요.',
      { count: structureAudit.originalStructuralMarkerLossCount }
    ));
  }
  if (structureAudit?.introducedOrphanParticleBoundaryCount > 0) {
    warnings.push(warning(
      'orphan_particle_line_boundary',
      '한국어 조사 앞에서 문장이나 행이 잘못 나뉜 곳이 있을 수 있어요.',
      { count: structureAudit.introducedOrphanParticleBoundaryCount }
    ));
  }
  if (structureAudit?.lineAnchorLayoutPass === false) {
    warnings.push(warning(
      'line_anchor_changed',
      '원문의 제목·라벨·날짜가 다른 행과 합쳐지거나 분리됐을 수 있어요.',
      {
        count: Number(structureAudit.lineAnchorLossCount || 0)
          + Number(structureAudit.lineAnchorBoundaryChangeCount || 0)
      }
    ));
  }
  if (structureAudit?.inlineLabelBodyLayoutPass === false) {
    warnings.push(warning(
      'inline_label_body_split',
      '라벨 항목의 본문이 중간에서 다른 행이나 문단으로 나뉘었을 수 있어요.',
      { count: Number(structureAudit.inlineLabelBodySplitCount || 0) }
    ));
  }
  if (structureAudit?.exactLineStructureApplicable === true
      && structureAudit?.exactLineStructurePass === false) {
    const profile = String(documentProfile?.profile || documentProfile || 'unknown');
    warnings.push(warning(
      profile === 'creative' ? 'creative_line_structure' : 'line_structure_changed',
      profile === 'creative'
        ? '창작문의 행 구조를 확인해야 해요.'
        : '원문의 보존 대상 행 구조가 달라졌을 수 있어요.'
    ));
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
      || documentProfile?.formatProfile?.flags?.includes?.('assessment_item')
      || documentProfile?.riskFlags?.includes?.('questionnaire_answer_boundary')) {
    return {
      run: true,
      reason: documentProfile?.formatProfile?.flags?.includes?.('assessment_item')
        ? 'assessment_item'
        : 'questionnaire'
    };
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

async function runSemanticDocumentAudit({
  source,
  outputText,
  lang = 'ko',
  signal,
  config,
  allowedExtra = '',
  mode = '',
  discourseSignals = [],
  safetyIdentifier = '',
  documentProfile = null
}) {
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
        safetyIdentifier,
        documentProfile
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

function polishEditPolicy(source, outputText, { documentProfile = null } = {}) {
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
  const profile = String(documentProfile?.profile || documentProfile || 'unknown');
  const targetRegister = String(documentProfile?.targetRegister || documentProfile?.tonePolicy || '');
  const sourceIssues = koreanRefinement.detectTextIssues(source, {
    profile,
    targetRegister,
    includeSourceNotation: true
  }).filter(item => POLISH_REQUIRED_ISSUE_CODES.has(item.code));
  const outputIssues = new Map(koreanRefinement.detectTextIssues(outputText, {
    profile,
    targetRegister,
    includeSourceNotation: false
  }).map(item => [item.code, item]));
  const issueCoverage = sourceIssues.map(item => {
    const remainingCount = Math.min(
      Number(item.count || 0),
      Number(outputIssues.get(item.code)?.count || 0)
    );
    return {
      code: item.code,
      sourceCount: Number(item.count || 0),
      remainingCount,
      fixedCount: Math.max(0, Number(item.count || 0) - remainingCount)
    };
  });
  const endingCoverage = endingStyle.auditPolishEndingConsistency(source, outputText, documentProfile);
  const sourceIssueCount = issueCoverage.reduce((sum, item) => sum + item.sourceCount, 0)
    + Number(endingCoverage.sourceIssueCount || 0);
  const remainingSourceIssueCount = issueCoverage.reduce((sum, item) => sum + item.remainingCount, 0)
    + Number(endingCoverage.remainingIssueCount || 0);
  const fixedSourceIssueCount = Math.max(0, sourceIssueCount - remainingSourceIssueCount);
  const unresolvedSourceIssueCodes = [
    ...issueCoverage.filter(item => item.remainingCount > 0).map(item => item.code),
    ...(endingCoverage.remainingIssueCount > 0 ? ['ending_style_mixed'] : [])
  ];
  const needsIssueRecovery = sourceIssueCount > 0 && remainingSourceIssueCount > 0;
  return {
    pass: !noSafeChange && !excessiveChange && !needsIssueRecovery,
    noSafeChange,
    belowRecommendedChange,
    excessiveChange,
    needsIssueRecovery,
    sourceIssueCount,
    fixedSourceIssueCount,
    remainingSourceIssueCount,
    unresolvedSourceIssueCodes,
    issueCoverage,
    endingCoverage,
    metrics,
    limits
  };
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
    sourceSpans.forEach((span, index) => {
      if (!hasPovKind(span.text, kind)) return;
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
    system: withPromptDataRule(system),
    user: sourceCurrentPrompt(source, currentOutput),
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
  const commercialTargets = Number(plan.commercialTargetSentenceCount || 0) > 0;
  const noEffectRecovery = phase === 'humanization_no_effect_retry';
  const untouchedParagraphs = (humanizationDepthReport?.metrics?.untouchedTargetParagraphIndices || [])
    .filter(Number.isInteger)
    .map(index => index + 1);
  const system = [
    '너는 한국어 실질 휴머나이징 국소 수리기다. 교정·다듬기만 한 결과를 만드는 작업이 아니다.',
    'SOURCE의 주장, 예시, 수치, 기관명, 인용, 화자, 제목, 목록, 질문, 문단별 역할과 내용 순서를 보존한다.',
    '같은 문단 역할 안에서 지나치게 긴 산문을 읽기 좋게 나누거나 같은 의미 단위를 자연스럽게 이어 붙이는 것은 허용한다. 서로 다른 활동·근거·결론을 한 문단으로 합치거나 항목을 잘게 쪼개지는 않는다.',
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
    '항목명 뒤 본문을 다시 쓰면 원래 문장의 미완성 앞부분을 남기지 않는다. 한 줄이던 인용 내부나 닫는 인용부호와 귀속 표현 사이에 새 줄바꿈을 넣지 않는다.',
    '“기준이 …에 있다”처럼 뒤 서술어가 요구하는 주격 조사를 문장 첫 주제와 맞춘다는 이유로 “기준은”으로 바꾸지 않는다.',
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
      ? [
          '현재 결과에는 SOURCE부터 있던 정형 성찰 결론·반복 결론 표지·강한 수식 반복·과도하게 완결된 인과 구조가 충분히 개선되지 않았다. 주장과 사실은 모두 남기고 해당 표현 방식만 직접적이고 덜 정형적으로 바꾼다.',
          discourse.remediationPromptGuidance(plan.rhetoricalRemediationPlan || null)
        ].filter(Boolean).join('\n')
      : '',
    commercialTargets
      ? '후기·광고 혼합 문장에서는 가격·할인·무료 제공·픽업 범위·응답 시간 같은 사실과 숫자를 그대로 보존한다. 반복 감탄·과도한 추천·혜택 나열·행동 요청은 같은 문장 안에서 덜 정형적인 구조로 다시 쓰되, 협찬 고지·실제 체험·새 조건을 만들거나 원문의 주장 강도를 임의로 바꾸지 않는다.'
      : '',
    '대상 문장의 주장 범위, 문단 역할, 결론 여부는 바꾸지 않는다. 설명을 교훈·감상·결론으로 바꾸거나 주제를 넓혀 변화량을 채우지 않는다.',
    '문장 수는 지정된 문장 안의 의미 단위를 자연스럽게 합치거나 나누는 경우에만 조정하고, 문단의 역할·제목·목록·질문·인용 구조는 바꾸지 않는다.',
    '새 사실·평가·감정·경험·수치·기관·인용·예시를 만들지 않는다.',
    '이 보존 조건 안에서 실질 변화 기준을 만족할 수 없을 때만 safeChangeFound=false로 답한다.'
  ].filter(Boolean).join('\n');
  const response = await completeJson({
    system: withPromptDataRule(system),
    user: sourceCurrentPrompt(source, currentOutput),
    schema: POLISH_REPAIR_SCHEMA,
    schemaName: 'gpt_prod_general_surface_retry',
    model: model || config.models.repair,
    reasoningEffort: reasoningEffort || config.reasoning.repair,
    verbosity: 'low',
    // 짧은 문서라도 구조화 응답과 reasoning 토큰이 같은 예산을 사용한다.
    // 2,400 하한은 1,500자 안팎의 학술문 회복에서 반복적으로
    // openai_truncated_output을 만들며 다음 국소 회복까지 약화시켰다.
    maxOutputTokens: Math.max(
      5000,
      Math.min(12000, Math.ceil(2400 + (String(source || '').length * 3.2)))
    ),
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

// 문서 전체 재시도가 안전 감사에서 반복해서 원문으로 복귀할 때 쓰는 마지막
// 회복 경로다. 모델에는 한 문장만 보내고, 서버가 그 문장 span만 다시 끼워
// 넣는다. 이 방식은 모델이 다른 문단·수치·화자를 건드릴 여지를 구조적으로
// 차단하면서도 공백·구두점이 아닌 실제 어순/절 구조 변화를 누적할 수 있다.
async function retryConservativeSentenceSurface({
  source,
  currentOutput,
  targetOrdinal,
  humanizationPlan = null,
  documentProfile = null,
  mode = '',
  config,
  signal,
  safetyIdentifier = '',
  model = '',
  reasoningEffort = '',
  phase = 'conservative_sentence_recovery'
}) {
  const original = String(source || '').trim();
  const current = String(currentOutput || '').trim();
  const ordinal = Math.max(1, Number(targetOrdinal) || 1);
  const sourceSpans = meaningfulSentenceSpans(original);
  const currentSpans = meaningfulSentenceSpans(current);
  const measured = humanizationDepth.measureSubstantiveEdit(original, current);
  const alignment = (measured.sentenceEdits || []).find(row => row.index === ordinal - 1);
  const sourceSpan = sourceSpans[ordinal - 1];
  const outputStart = Number(alignment?.outputIndex);
  const outputEnd = Number(alignment?.outputEndIndex);
  const alignedOneSentence = Number.isInteger(outputStart)
    && outputStart >= 0
    && outputStart < currentSpans.length
    && (!Number.isInteger(outputEnd) || outputEnd === outputStart + 1);
  const currentSpan = alignedOneSentence
    ? currentSpans[outputStart]
    : (sourceSpans.length === currentSpans.length ? currentSpans[ordinal - 1] : null);

  if (!sourceSpan || !currentSpan) {
    return conservativeSentenceResult(current, false, ordinal, 'sentence_alignment_unavailable');
  }
  if (!isConservativeSentenceTarget(sourceSpan.text)
      || !isConservativeSentenceTarget(currentSpan.text)) {
    return conservativeSentenceResult(current, false, ordinal, 'protected_or_structural_sentence');
  }

  const profile = String(
    documentProfile?.profile
      || humanizationPlan?.profile
      || documentProfile
      || 'unknown'
  );
  const currentIndex = alignedOneSentence ? outputStart : ordinal - 1;
  const previous = currentIndex > 0 ? (currentSpans[currentIndex - 1]?.text || '') : '';
  const next = currentSpans[currentIndex + 1]?.text || '';
  const profileRule = conservativeProfileRule(profile);
  const targetRemediationCategories = (humanizationPlan?.rhetoricalRemediationPlan?.categories || [])
    .filter(item => (item.sentenceOrdinals || []).includes(ordinal));
  const remediationRule = targetRemediationCategories.length
    ? discourse.remediationPromptGuidance({
        ...humanizationPlan.rhetoricalRemediationPlan,
        categories: targetRemediationCategories
      })
    : '';
  const selectedStrongModifierTarget = targetRemediationCategories.some(item => (
    item.code === 'stacked_strong_modifiers'
  ));
  const remediationTargetTerms = discourse.remediationTargetTerms(
    currentSpan.text,
    targetRemediationCategories
  );
  const system = [
    '너는 한국어 휴머나이징의 안전한 단일 문장 재구성기다.',
    'CURRENT SENTENCE 한 문장만 다시 쓴다. 앞뒤 문장은 문맥 확인용이며 절대 출력하거나 수정하지 않는다.',
    'SOURCE SENTENCE의 주장, 행위 주체, 대상, 인과·대조·부정·가능성·의무, 시제, 수치, 기관명, 고유명사, 전문 용어를 모두 보존한다.',
    '새 사실·평가·감정·경험·성과·예시·결론을 추가하지 않고, 원래 있던 정보도 요약하거나 삭제하지 않는다.',
    '단순 동의어 치환, 조사·띄어쓰기·쉼표 한 곳 변경은 실패다. 같은 뜻 안에서 절 순서, 주어 위치, 연결 방식, 문장 호흡 가운데 하나 이상을 실제로 재구성한다.',
    '문장 수는 한 개로 유지하고 줄바꿈·목록·제목·인용을 새로 만들지 않는다.',
    '원문의 종결체와 격식을 유지한다.',
    profileRule,
    remediationRule,
    selectedStrongModifierTarget
      ? '이 문장은 문서 안에서 반복된 강한 수식의 감축 대상으로 선택됐다. 표시된 강한 수식어를 약한 동의어로만 바꾸거나 그대로 두지 말고, CURRENT와 SOURCE에 이미 있는 대상·행위·영향 관계를 문장의 중심으로 직접 서술한다. 원문의 부정·가능성·우려·평가 강도는 낮추거나 높이지 않는다.'
      : '',
    remediationTargetTerms.length
      ? `이번 문장에서 그대로 남기지 않을 반복 수식=${remediationTargetTerms.join(', ')}. 이 문자열을 출력에 복사하지 않고, SOURCE에 이미 있는 조건·대상·영향 관계로 같은 강도를 표현한다.`
      : '',
    '위 조건을 모두 지킬 수 없으면 rewrittenSentence에는 CURRENT SENTENCE를 그대로 넣고 safeChangeFound=false로 답한다.'
  ].filter(Boolean).join('\n');
  const response = await completeJson({
    system: withPromptDataRule(system),
    user: buildPromptDataSections([
      { label: 'DOCUMENT_PROFILE', value: profile },
      { label: 'SOURCE_SENTENCE', value: sourceSpan.text },
      { label: 'CURRENT_SENTENCE', value: currentSpan.text },
      { label: 'PREVIOUS_CONTEXT', value: previous },
      { label: 'NEXT_CONTEXT', value: next }
    ]).text,
    schema: CONSERVATIVE_SENTENCE_REPAIR_SCHEMA,
    schemaName: 'gpt_prod_conservative_sentence_retry',
    model: model || config.models.repair,
    reasoningEffort: reasoningEffort || config.reasoning.repair,
    verbosity: 'low',
    // 단문 JSON이라도 reasoning 토큰이 출력 한도를 함께 사용한다. 1,800은
    // 150~250자 학술문에서 간헐적으로 truncated를 만들었으므로 내용 길이는
    // 그대로 제한하면서 응답 예산만 넉넉히 둔다.
    maxOutputTokens: Math.max(1200, Math.min(2800, Math.ceil(currentSpan.text.length * 8))),
    config,
    signal,
    safetyIdentifier,
    meta: { task: 'repair', phase, mode: String(mode || 'humanize'), profile }
  });

  const rewrittenSentence = String(response.json.rewrittenSentence || '')
    .replace(/\r\n?/gu, '\n')
    .trim();
  const rejectionCodes = validateConservativeSentenceRewrite(
    sourceSpan.text,
    currentSpan.text,
    rewrittenSentence,
    {
      maxCharEditRatio: targetRemediationCategories.length ? 0.88 : 0.58,
      minLengthRatio: targetRemediationCategories.length ? 0.65 : 0.78,
      maxLengthRatio: targetRemediationCategories.length ? 1.40 : 1.24
    }
  );
  if (targetRemediationCategories.length && !rejectionCodes.length) {
    const remediationImproved = targetRemediationCategories.some(item => (
      discourse.remediationCategoryCount(rewrittenSentence, item.code)
        < discourse.remediationCategoryCount(currentSpan.text, item.code)
    ));
    if (!remediationImproved) rejectionCodes.push('rhetorical_target_not_improved');
  }
  const safeChangeFound = response.json.safeChangeFound === true && rejectionCodes.length === 0;
  if (!safeChangeFound) {
    return {
      ...conservativeSentenceResult(
        current,
        false,
        ordinal,
        rejectionCodes[0] || 'model_reported_no_safe_change'
      ),
      notes: response.json.notes || [],
      usage: response.usage,
      model: response.model,
      rejectionCodes
    };
  }

  const outputText = current.slice(0, currentSpan.start)
    + rewrittenSentence
    + current.slice(currentSpan.end);
  return {
    outputText,
    rewrittenSentence,
    safeChangeFound: true,
    applied: true,
    targetOrdinal: ordinal,
    currentOutputIndex: currentIndex,
    reason: 'sentence_recast',
    rejectionCodes: [],
    notes: response.json.notes || [],
    usage: response.usage,
    model: response.model
  };
}

function meaningfulSentenceSpans(value) {
  return splitSentenceSpans(String(value || ''))
    .filter(span => normalizeSentenceSubstance(
      String(span.text || '').replace(/ZXQLOCK\d+QXZ/giu, ' ')
    ).length >= 3);
}

function normalizeSentenceSubstance(value) {
  return String(value || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

function isConservativeSentenceTarget(value) {
  const sentence = String(value || '').trim();
  if (sentence.length < 18 || sentence.length > 700 || /[\r\n\t]/u.test(sentence)) return false;
  if (/ZXQLOCK\d+QXZ|```|~~~|`/iu.test(sentence)) return false;
  if (/^(?:#{1,6}\s|[-*+•▪◦·●○■□◆◇▶▷※]\s|\d{1,3}[.)]\s|[①-⑳]\s)/u.test(sentence)) return false;
  if (/^(?:제\s*\d{1,3}\s*조|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)．]?\s)/u.test(sentence)) return false;
  if (/^\|.+\|$/u.test(sentence)) return false;
  // 직접 인용과 독립 제목은 마지막 회복 단계에서도 원문 그대로 둔다.
  if (/["'“”‘’「」『』《》〈〉]/u.test(sentence)) return false;
  return !/^[가-힣A-Za-z][가-힣A-Za-z0-9 _/·()（）-]{0,30}:\s*\S/u.test(sentence);
}

function validateConservativeSentenceRewrite(
  sourceSentence,
  currentSentence,
  rewrittenSentence,
  {
    maxCharEditRatio = 0.58,
    minLengthRatio = 0.78,
    maxLengthRatio = 1.24
  } = {}
) {
  const codes = [];
  const rewritten = String(rewrittenSentence || '').trim();
  if (!rewritten) return ['empty_sentence'];
  if (/[\r\n\t]/u.test(rewritten)) codes.push('line_structure_changed');
  if (meaningfulSentenceSpans(rewritten).length !== 1) codes.push('sentence_count_changed');
  const substantive = humanizationDepth.measureSubstantiveEdit(currentSentence, rewritten);
  if (substantive.substantiveChangedSentenceCount < 1
      || Number(substantive.substantiveEditRatio || 0) < 0.065) {
    codes.push('sentence_change_too_shallow');
  }
  const surface = computeEditMetrics(currentSentence, rewritten);
  if (surface.charEditRatio > maxCharEditRatio) codes.push('sentence_change_too_large');
  if (surface.lengthRatio < minLengthRatio || surface.lengthRatio > maxLengthRatio) {
    codes.push('sentence_length_shift');
  }
  if (compareNumberMultiset(sourceSentence, rewrittenSentence).changed) codes.push('number_changed');
  if (/[`|]/u.test(rewritten) && !/[`|]/u.test(currentSentence)) codes.push('structure_token_added');
  return [...new Set(codes)];
}

function conservativeProfileRule(profile) {
  if (profile === 'student_record_teacher') {
    return '교사가 학생을 관찰해 기록하는 세특 문체를 유지한다. “저는·제가·나는·우리”를 넣지 말고, 원문이 명사형 종결이면 명사형 종결을 유지한다.';
  }
  if (profile === 'student_self_assessment') {
    return '학생 본인의 자기평가 화자와 기존 종결체를 유지하고, 교사 관찰 문체로 바꾸지 않는다.';
  }
  if (profile === 'resume_application') {
    return '지원자의 실제 행동과 담당 범위를 원문보다 과장하거나 약화하지 않고, 직무 문서의 격식을 유지한다.';
  }
  if (['academic_paper', 'report_assignment', 'long_explainer', 'clinical_record', 'legal_contract'].includes(profile)) {
    return '학술·보고서·임상·법률 문서의 전문 용어와 격식을 유지하며 구어체, 감탄형, 친근한 표현을 새로 넣지 않는다.';
  }
  return '원문 화자와 종결체를 그대로 유지한다.';
}

function conservativeSentenceResult(outputText, applied, targetOrdinal, reason) {
  return {
    outputText,
    rewrittenSentence: '',
    safeChangeFound: false,
    applied,
    targetOrdinal,
    currentOutputIndex: -1,
    reason,
    rejectionCodes: reason ? [reason] : [],
    notes: [],
    usage: null,
    model: ''
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
  const unresolvedRemediationOrdinals = remediationLow
    ? discourse.unresolvedRemediationSentenceOrdinals(
        source,
        currentOutput,
        plan.rhetoricalRemediationPlan || null
      )
    : [];
  const unresolvedRemediationIndices = new Set(
    unresolvedRemediationOrdinals.map(ordinal => ordinal - 1)
  );
  const unresolvedRemediationRows = rows.filter(row => (
    unresolvedRemediationIndices.has(row.index)
  ));
  const untouchedParagraphSeeds = firstRowPerParagraph([
    ...unchanged.filter(row => targetSet.has(row.index) && untouchedTargetParagraphs.has(row.sourceParagraphIndex)),
    ...shallowChanged.filter(row => targetSet.has(row.index) && untouchedTargetParagraphs.has(row.sourceParagraphIndex))
  ]);
  const ordered = uniqueRows([
    ...unresolvedRemediationRows,
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
  // 수리기가 최소선에 간신히 닿는 문장 수만 고르면 사용자는 여전히
  // 다듬기 수준으로 느낀다. 차단 기준(min)이 아니라 체감 목표(targetMin)에
  // 필요한 문장까지 지정하되, 새 내용 추가 없이 원래 대상 안에서 해결한다.
  const retryEditGoal = Math.max(
    Number(plan.minSubstantiveEditRatio || 0),
    Number(plan.targetSubstantiveEditMin || 0)
  );
  const editDeficitChars = Math.max(0,
    (retryEditGoal * sourceChars) - Number(measured.substantiveDistance || 0));
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

async function retryCollapsedKoreanSpacing({
  source,
  config,
  signal,
  safetyIdentifier = '',
  model = '',
  reasoningEffort = '',
  phase = 'collapsed_korean_spacing_retry'
}) {
  const original = String(source || '').trim();
  if (!original) {
    return {
      outputText: original,
      safeChangeFound: false,
      applied: false,
      beforeCount: 0,
      afterCount: 0,
      reason: 'empty_source',
      notes: [],
      usage: null,
      model: ''
    };
  }
  const beforeAudit = koreanRefinement.analyzeKoreanRefinement({
    source: original,
    outputText: original,
    documentProfile: 'unknown',
    mode: 'polish'
  });
  const beforeCount = koreanIssueAfterCount(beforeAudit, 'collapsed_korean_spacing_run');
  if (beforeCount <= 0) {
    return {
      outputText: original,
      safeChangeFound: false,
      applied: false,
      beforeCount,
      afterCount: beforeCount,
      reason: 'not_applicable',
      notes: [],
      usage: null,
      model: ''
    };
  }
  const system = [
    '너는 한국어 무띄어쓰기 복원기다. 입력의 문자와 순서를 한 글자도 바꾸지 않고 공백만 삽입한다.',
    '한글이 36자 이상 붙은 모든 일반 산문 구간을 끝까지 처리한다. 일부 앞부분만 고치고 긴 무공백 구간을 남기지 않는다.',
    '글자, 숫자, 문장부호, 인용부호, 영문, 기호를 추가·삭제·교체하지 않는다. 문장부호가 빠져 보여도 새로 만들지 않는다.',
    '기존 공백·줄바꿈·문단 경계는 삭제하거나 이동하지 않는다. 새 줄바꿈도 만들지 않는다.',
    '직접 인용, 코드, URL, 이메일, 표기 문자열의 내부 공백은 바꾸지 않는다.',
    '서버가 공백을 제외한 문자열과 기존 경계를 대조하므로, 위 조건을 어긴 결과는 전부 폐기된다.'
  ].join('\n');
  const response = await completeJson({
    system: withPromptDataRule(system),
    user: buildPromptDataSections([{ label: 'SOURCE', value: original }]).text,
    schema: POLISH_REPAIR_SCHEMA,
    schemaName: 'gpt_prod_collapsed_korean_spacing_retry',
    model: model || config.models.repair,
    reasoningEffort: reasoningEffort || config.reasoning.repair,
    verbosity: 'low',
    maxOutputTokens: Math.max(1800, Math.min(12000, Math.ceil(original.length * 2.2))),
    config,
    signal,
    safetyIdentifier,
    meta: { task: 'repair', phase }
  });
  const candidate = String(response.json.outputText || '').trim() || original;
  const validation = validateCollapsedKoreanSpacingCandidate(original, candidate);
  return {
    outputText: validation.pass ? candidate : original,
    safeChangeFound: validation.pass,
    applied: validation.pass,
    beforeCount,
    afterCount: validation.afterCount,
    reason: validation.reason,
    notes: response.json.notes || [],
    usage: response.usage,
    model: response.model
  };
}

function validateCollapsedKoreanSpacingCandidate(source, candidate) {
  const original = String(source || '').normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  const output = String(candidate || '').normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  const beforeAudit = koreanRefinement.analyzeKoreanRefinement({
    source: original,
    outputText: original,
    documentProfile: 'unknown',
    mode: 'polish'
  });
  const afterAudit = koreanRefinement.analyzeKoreanRefinement({
    source: original,
    outputText: output,
    documentProfile: 'unknown',
    mode: 'polish'
  });
  const beforeCount = koreanIssueAfterCount(beforeAudit, 'collapsed_korean_spacing_run');
  const afterCount = koreanIssueAfterCount(afterAudit, 'collapsed_korean_spacing_run');
  if (!original || !output || original === output) {
    return { pass: false, reason: 'unchanged', beforeCount, afterCount };
  }
  if (beforeCount <= 0) return { pass: false, reason: 'not_applicable', beforeCount, afterCount };

  const originalProjection = whitespaceProjection(original);
  const outputProjection = whitespaceProjection(output);
  if (originalProjection.characters.join('') !== outputProjection.characters.join('')) {
    return { pass: false, reason: 'non_whitespace_changed', beforeCount, afterCount };
  }
  if (originalProjection.gaps.length !== outputProjection.gaps.length) {
    return { pass: false, reason: 'character_alignment_failed', beforeCount, afterCount };
  }
  for (let index = 0; index < originalProjection.gaps.length; index += 1) {
    const beforeGap = originalProjection.gaps[index];
    const afterGap = outputProjection.gaps[index];
    const beforeNewlines = (beforeGap.match(/\n/gu) || []).length;
    const afterNewlines = (afterGap.match(/\n/gu) || []).length;
    if (beforeNewlines !== afterNewlines) {
      return { pass: false, reason: 'line_boundary_changed', beforeCount, afterCount };
    }
    if (beforeGap && !afterGap) {
      return { pass: false, reason: 'existing_whitespace_removed', beforeCount, afterCount };
    }
    if (!beforeGap && afterGap) {
      const previous = originalProjection.characters[index - 1] || '';
      const next = originalProjection.characters[index] || '';
      if (!/[가-힣]/u.test(previous) || !/[가-힣]/u.test(next) || /\n/u.test(afterGap)) {
        return { pass: false, reason: 'spacing_outside_korean_run', beforeCount, afterCount };
      }
    }
  }
  const quoteAudit = auditDirectQuoteIntegrity(original, output);
  if (quoteAudit?.pass === false) {
    return { pass: false, reason: 'quote_content_changed', beforeCount, afterCount };
  }
  if (afterCount >= beforeCount || afterCount > 0) {
    return { pass: false, reason: 'collapsed_spacing_remaining', beforeCount, afterCount };
  }
  return { pass: true, reason: 'spacing_restored', beforeCount, afterCount };
}

function whitespaceProjection(value) {
  const characters = [];
  const gaps = [''];
  for (const character of Array.from(String(value || ''))) {
    if (/\s/u.test(character)) {
      gaps[gaps.length - 1] += character;
    } else {
      characters.push(character);
      gaps.push('');
    }
  }
  return { characters, gaps };
}

function koreanIssueAfterCount(audit, code) {
  return Number((audit?.issues || []).find(item => item?.code === code)?.afterCount || 0);
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
  const candidates = (refinementAudit?.repairableIssues || [])
    .filter(item => item.afterCount > 0 && item.deterministicSafe !== true);
  // 전역 분포 문제는 코드 순서상 뒤에 있어도 반드시 수리기에 전달한다.
  // 앞쪽 국소 오류 8개가 장문 접속어 과주입을 굶기던 문제를 없앤다.
  const globalCodes = new Set(['sequential_connector_inflation', 'discourse_connector_inflation']);
  const globalIssues = candidates.filter(item => globalCodes.has(item.code));
  const localIssues = koreanRefinement.prioritizeRepairIssues(
    candidates.filter(item => !globalCodes.has(item.code)),
    { limit: 8 }
  );
  const issues = [
    ...globalIssues.slice(0, 2),
    ...localIssues.slice(0, Math.max(0, 8 - globalIssues.length))
  ].slice(0, 8);
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
    ['academic_paper', 'report_assignment', 'long_explainer', 'clinical_record', 'legal_contract'].includes(profile)
      ? '학술·보고서의 개념어와 격식을 유지하고 구어체나 감탄형 표현을 새로 넣지 않는다.'
      : '',
    ['personal_essay', 'general_essay', 'student_self_assessment'].includes(profile)
      ? '성찰문의 구체적인 감정, 내적 질문, 인정 욕구, 자기 의심을 일반적인 성장 교훈으로 축약하지 않는다. SOURCE에 있는 감정만 같은 강도로 복원하고 새 감정이나 극적인 장면은 만들지 않는다.'
      : '',
    '수리할 문제가 실제로 남아 있지 않거나 보존 조건 안에서 안전하게 고칠 수 없으면 safeChangeFound=false로 답한다.',
    '[수리 대상]',
    ...issueLines
  ].filter(Boolean).join('\n');
  const response = await completeJson({
    system: withPromptDataRule(system),
    user: sourceCurrentPrompt(source, currentOutput),
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
  if (item?.code === 'collapsed_korean_spacing_run') {
    return '붙어 있는 한글 구간 전체의 의미와 단어 순서는 그대로 두고, 문맥에 맞는 띄어쓰기와 필요한 문장 경계만 복원한다. 앞부분만 고치고 나머지 무공백 구간을 남기지 않는다.';
  }
  if (item?.code === 'focus_particle_redundancy') {
    return '“만의 노력만으로는”처럼 한 구 안에서 겹친 초점 조사 하나만 제거한다. SOURCE의 강조 범위와 주체는 유지한다.';
  }
  if (item?.code === 'subject_experiencer_case_frame') {
    return '일·상황이 주어이면 “부담스럽게 느껴진 경험”, 사람이 느낀 것이면 “부담스럽다고 느낀 경험”처럼 SOURCE의 주체에 맞춰 복원한다.';
  }
  if (item?.code === 'professional_register_downgrade') {
    const losses = Array.isArray(item?.details?.alignedLosses) ? item.details.alignedLosses : [];
    const hints = losses.slice(0, 8).map(loss => (
      `CURRENT ${loss.outputOrdinal || '?'}번(SOURCE ${loss.sourceOrdinal || '?'}번) 주장의 ${loss.concept}=${(loss.preferred || []).join('/')}`
    ));
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
  if (item?.code === 'academic_purpose_chain_overloaded') return '연구 목적, 핵심 단서·변수, 작동 과정, 검증 조건을 논리 역할별 두세 문장으로 나눈다. 따옴표 속 구성개념과 Fit·Cue 같은 표기, 인과 방향, 평가 강도는 그대로 두고 “해소 과정”을 임의로 “해석 과정” 같은 다른 개념으로 바꾸지 않는다.';
  if (item?.code === 'formal_register_residual') {
    return '직접 인용이나 정식 용어는 보존한다. 그 밖의 게임·군사·신체 은유와 구어적 별칭은 같은 행위·상태·절차를 뜻하는 중립적 공식 표현으로 바꾼다. 학술문의 “~라는 건데·~라는 게·이게 바로·나중에 보니까·딱 보고·꿀리다·기가 죽다” 같은 대화형 서술은 주장과 평가 강도를 그대로 둔 공식 문장으로 고친다. 학술문의 “뜬금없는 결합”은 원문이 뜻하는 예상 밖·비전형적 관계 범위 안에서만 중립화하고, “폭발적인 반응”은 반응 강도를 낮추지 않는 공식 표현으로 고친다. 학술문의 “확대됐다·확인됐다” 같은 축약형은 “확대되었다·확인되었다”로 맞춘다. 이론 구성개념은 추정해 이름을 바꾸지 않는다. “시험해 보니”는 “시험·검증한 결과”로, “함께 놓고 비교”는 “비교 검토”처럼 원문 격식에 맞춘다. 학술·보고서에서 “결제를 끝내다”처럼 가벼운 완료 동사를 새로 만들지 말고 SOURCE의 정확한 기능 동사를 유지한다. 지원서의 디딤돌·든든한 동행자·따뜻한 조력자 같은 장식적 결론은 SOURCE에 있는 실제 행동 계획으로만 정리한다.';
  }
  if (item?.code === 'role_definition_inversion') return '기관이 역할이라고 쓰지 말고, SOURCE의 기관·직무가 어떤 역할을 하는지 주어와 보어 관계를 복원한다.';
  if (item?.code === 'purpose_modifier_collocation') return '정책·제도가 지향하는 목적이면 “~을 만들기 위한 정책·제도”처럼 목적 관계를 분명히 한다.';
  if (item?.code === 'metacognitive_predicate_stack') return 'SOURCE의 생각·고민 범위를 유지하면서 “고민할 수 있다고 생각했다” 또는 “더 깊이 고민하게 되었다” 중 실제 의미에 맞는 한 구조만 쓴다.';
  if (item?.code === 'dialogue_give_collocation') return '말은 건넬 수 있지만 대화는 나누는 상호행위다. SOURCE의 참여 주체와 방향을 유지해 고친다.';
  if (item?.code === 'sampling_subject_mismatch') return 'SOURCE에서 연구자가 표집한 대상이라면 대상을 목적어로 두고 연구자 생략 주어의 능동문 또는 적절한 피동문으로 고친다.';
  if (item?.code === 'tool_personification') return '도구의 기능은 “연결한다·제공한다·표시한다”처럼 중립적으로 쓰고 SOURCE의 기능 범위를 넘기지 않는다.';
  if (item?.code === 'passive_causative_stack') return '피동과 사동을 겹치지 말고 SOURCE의 행위 주체와 작용 방향에 맞는 서술어 하나로 고친다.';
  if (item?.code === 'double_object_time_expenditure') return '매체·콘텐츠를 접하거나 이용한 시간 관계가 드러나도록 목적어를 하나로 정리하되 SOURCE의 시간량과 행동은 유지한다.';
  if (item?.code === 'persistent_state_tense_regression') return '아직도·여전히·지금도 이어지는 SOURCE의 상태를 과거에 끝난 상태로 바꾸지 말고 현재 지속 시제를 복원한다.';
  if (item?.code === 'orphan_structural_particle') return '제목·항목명은 독립 구조다. 제목을 본문의 주어나 목적어로 재사용하지 말고, 다음 행 첫머리에 “은·는·이·가·을·를·에서는” 같은 조사만 남기지 않는다.';
  if (item?.code === 'benefit_help_predicate_redundancy') return 'SOURCE의 지원 범위는 유지하고 “도움을 받을 수 있게 돕다”의 겹친 서술어 하나만 자연스럽게 정리한다.';
  if (item?.code === 'contrast_clause_attachment') return 'SOURCE의 비교 방향과 절 순서를 확인해 “~하기보다”가 실제 비교 대상에 바로 연결되도록 고친다.';
  if (item?.code === 'student_record_fragment') return '짧게 떨어진 명사형 조각을 SOURCE의 같은 관찰 문맥에 다시 연결하되, 세특의 관찰형 종결과 내용 순서는 유지한다.';
  if (item?.code === 'functional_greeting_duplication') return '첫 인사의 의미는 유지하고 같은 역할의 연속 인사 하나만 제거한다. 날짜·기관·직책·서명 줄은 바꾸지 않는다.';
  if (item?.code === 'adjacent_semantic_repetition') return '두 문장의 고유 정보는 모두 남기고, 새로 생긴 중복 주장만 한 번 말하도록 절을 재구성한다.';
  if (item?.code === 'directional_growth_collocation') return '태도·역량의 변화 내용을 유지하면서 “~쪽으로 성장했다” 대신 장르에 맞는 정확한 변화 서술로 고친다.';
  if (item?.code === 'causal_predicate_stack') return '결과를 주제로 두면 “~에서 비롯됐다”로, 원인을 주제로 두면 “가장 큰 원인은 ~이다”로 한 인과 서술만 사용한다.';
  if (item?.code === 'nominal_predicate_collocation') return '분석·조사·검토는 수행하거나 그 결과를 제시하고, 추상적 지위·입지는 확립·강화·공고화하는 등 SOURCE의 개념에 맞는 서술어로 연결한다.';
  if (item?.code === 'case_frame_corruption') return 'SOURCE의 주제·목적어 조사와 범위 시작·끝을 유지한다. “A에서 B에 이르는 범위·과정” 또는 “A는 B가 적용된 예다”처럼 서술어가 요구하는 논항을 복원한다.';
  if (item?.code === 'condition_commitment_mismatch') return '“~하려면”이 연 조건과 뒤의 다짐을 논리적으로 연결하되 SOURCE의 실제 행동·목표만 사용한다.';
  if (item?.code === 'content_identity_predicate_mismatch') return '책·작품 자체를 설명하는지, 그 내용을 요약하는지 구분해 주어와 서술어의 범위를 맞춘다. SOURCE에 없는 장르·줄거리를 추가하지 않는다.';
  if (item?.code === 'prejudiced_gaze_collocation') return '편견과 타인의 시선을 별개로 말한 것인지 “편견 어린 시선”인지 SOURCE 문맥에서 확인해 하나의 명확한 관계로 정리한다.';
  if (item?.code === 'negative_goal_commitment') return '없애고 싶은 편견·상처 자체가 헌신의 대상이 되지 않게 한다. SOURCE의 핵심 대조와 제목 의미를 유지하면서 화자가 바라는 사회·행동의 방향을 성립하게 복원한다.';
  if (item?.code === 'reflexive_subject_attachment') return '“자신도 모르게”가 누구를 가리키는지 SOURCE에서 확인하고, 그 인물을 주어로 두어 마음·태도의 변화를 자연스럽게 연결한다.';
  if (item?.code === 'meta_nominalization_injection') return '“느낀 것은 ~하는 점이었다”로 늘이지 말고 SOURCE의 직접적인 깨달음·판단 문장을 자연스럽게 유지한다.';
  if (item?.code === 'role_predicate_redundancy') return '맡다·담당하다 중 문맥에 맞는 서술어 하나만 남기고 업무 범위는 줄이거나 넓히지 않는다.';
  if (item?.code === 'analytic_object_recast') return '접수·수집된 요구사항·자료 자체를 분석 대상으로 두고, 같은 대상을 “내용”으로 다시 받아 모호하게 만들지 않는다.';
  if (item?.code === 'borrowed_standard_case_frame') return '“기준을 가져와 평가하다”로 쓰지 말고 SOURCE의 평가 주체와 대상을 유지한 채 “그 기준으로 평가하다”처럼 조사와 서술어의 논항을 바로잡는다.';
  if (item?.code === 'goal_direction_reference_mismatch') return '앞에서 정한 것이 목표라면 “그 목표를 향해”, 방향이라면 “그 방향으로”처럼 같은 지시 대상을 유지한다.';
  if (item?.code === 'priority_first_redundancy') return 'SOURCE의 우선순위 판단은 유지하고 “우선순위를 먼저”의 겹친 순서 표현만 하나로 줄인다.';
  if (item?.code === 'hands_feet_speed_collocation') return 'SOURCE의 민첩함은 유지하되 “손과 발이 빠르다”를 장르에 맞는 “손발이 빠르다” 또는 정확한 행동 표현으로 고친다.';
  if (item?.code === 'technical_circuit_action_collocation') return '실제 담당 범위를 추정해 넓히지 않는다. SOURCE가 회로 설계를 뜻하면 “회로를 설계”, 도면 산출물 작성을 뜻하면 “회로도를 작성”으로 구분하고, 불확실하면 주변 문맥의 원래 행위 범위를 유지한다.';
  if (item?.code === 'role_allocation_collocation') return '과업을 맡을 역할이라고 쓰지 말고 SOURCE의 과업 목록과 담당 주체를 유지해 “과업별로 역할을 나누다”처럼 관계를 바로잡는다.';
  if (item?.code === 'trust_entrust_subject_collocation') return '누가 무엇을 맡기는지 추정하지 않는다. SOURCE가 신뢰 관계를 말하면 원래 주체를 복원하고, 아이가 의지할 대상을 뜻한 경우에만 “믿고 의지할 수 있는”으로 고친다.';
  if (item?.code === 'academic_scope_collocation') return 'SOURCE의 “연구 영역”과 “적용 환경을 일부 공유한다”는 범위·조사 관계를 복원하고 새 범위를 만들지 않는다.';
  if (item?.code === 'domain_stay_collocation') return '질환·현상이 스스로 연구에 머문다고 쓰지 말고 SOURCE의 “연구가 해당 대상에 한정되다”라는 주체와 범위를 복원한다.';
  if (item?.code === 'exceptional_noteworthy_redundancy') return '예외적이라는 판단과 주목할 근거를 한 번만 표현하되 SOURCE의 평가 강도는 낮추지 않는다.';
  if (item?.code === 'ambiguous_research_result_reference') return '문장을 나눈 뒤 생긴 “연구 결과”가 본 연구인지 인용 연구인지 SOURCE에 맞게 명시한다. 저자나 연구 주체를 새로 만들지 않는다.';
  if (item?.code === 'dangling_inference_predicate') return '“~을 시사한다”의 주체를 SOURCE에서 복원한다. 새 결론을 만들지 말고 필요하면 앞 문장과 다시 연결한다.';
  if (item?.code === 'completion_scope_strengthening') return 'SOURCE의 단순한 “작업 후”를 작업 전체 완료로 강화하지 말고 원래 단계 범위를 복원한다.';
  if (item?.code === 'analysis_stage_weakened') return 'SOURCE에서 실제로 분석을 수행했다면 “분석 대상으로 삼았다”로 약화하지 말고 분석 행위를 복원한다.';
  if (item?.code === 'bureaucratic_growth_aspect_stack') return '“성장세를 나타내기 시작했다”처럼 변화와 시작을 겹쳐 명사화하지 말고 SOURCE의 직접적인 성장·증가 서술을 장르 격식에 맞게 복원한다.';
  if (item?.code === 'infrastructure_action_weakened') return 'SOURCE가 시설·망·시스템을 구축·확충·설치한 행위를 단순한 “마련”으로 낮추지 말고 실제 인프라 행위를 복원한다.';
  if (item?.code === 'temporal_anchor_detachment') return 'SOURCE에서 특정 주체나 사건 뒤에 붙은 “이후”를 문장 앞으로 옮겨 앞 문장의 연도·사건에 걸리게 하지 말고 원래 시간 기준을 분명히 한다.';
  if (item?.code === 'causal_connector_strengthening') return 'SOURCE의 시간·맥락 연결인 “이때·뒤·후”를 “따라서·그 결과·~자” 같은 인과 결론으로 강화하지 말고 원래 논리 강도를 복원한다.';
  if (item?.code === 'sequential_connector_inflation') return '새로 반복된 “뒤·후·다음”을 줄이고 같은 업무 묶음은 자연스럽게 연결한다. 실제 수행 순서는 그대로 유지한다.';
  if (item?.code === 'discourse_connector_inflation') return 'SOURCE에 없던 “또한·따라서·이러한·이를 통해·한편” 같은 정형 접속어를 여러 문장에 새로 붙이지 않는다. 논리 관계는 유지하되 주어와 서술어를 직접 연결하고, 필요한 접속어만 남긴다.';
  if (item?.code === 'affective_anchor_omission') {
    const omissions = Array.isArray(item?.details?.omissions) ? item.details.omissions : [];
    const anchors = omissions.slice(0, 6).map(value => `${value.sourceOrdinal}번=${value.sourceSentence}`);
    return `SOURCE의 감정 범위를 일반론으로 바꾸지 말고 같은 위치에 자연스럽게 되살린다.${anchors.length ? ` 보존할 감정 문장: ${anchors.join(' / ')}` : ''}`;
  }
  if (item?.code === 'enumeration_parallelism') return '첫째·둘째·셋째 항목의 명사구/서술문 역할과 종결 형식을 맞추되 각 항목의 사실과 순서는 유지한다.';
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
      return `- semantic_relation_shift/${item.family}: 문장 ${item.sentenceOrdinals?.join(',') || '해당 위치'}에서 SOURCE의 목적·근거·대조·가능성·행위 방향·책임 범위와 강도를 정확히 복원한다.`;
    }
    return `- engine_phrase_fingerprint/${item.family}: CURRENT에 새로 주입된 상투구를 허용 횟수 ${Number(item.allowedIntroducedCount ?? 1)}회 이하로 줄인다.`;
  });
  const system = [
    '너는 엔진 상투구와 논리 방향만 국소 수리하는 한국어 편집기다.',
    'SOURCE는 의미와 논리 관계 확인용이고 CURRENT가 편집 대상이다. 표시된 문제 문장과 바로 인접한 문장 외에는 바꾸지 않는다.',
    'SOURCE의 주장, 목적, 근거 틀, 부정·배제·대조·인정·가능성 관계, 행위 방향과 강도, 수치, 기관명, 인용, 화자, 문단·제목·목록 순서를 그대로 보존한다.',
    '증명을 확인으로, 재발견을 되살리기로, 적극적 태도를 바로·직접으로, 연구를 통해 확인한 내용을 근거 없는 단정으로 바꾸지 않는다. SOURCE에 없던 즉시성도 제거한다.',
    '새 주장·예시·평가·경험·결론을 만들지 않고, 상투구를 다른 상투구로 치환하지 않는다.',
    ['academic_paper', 'report_assignment', 'long_explainer', 'clinical_record', 'legal_contract'].includes(profile)
      ? '학술·보고서의 개념어와 평서문 격식을 유지한다. 구어체·명령형·도구 의인화를 새로 넣지 않는다.'
      : '',
    '안전하게 고칠 수 없거나 문제가 이미 없다면 safeChangeFound=false로 답한다.',
    '[수리 대상]',
    ...issueLines
  ].filter(Boolean).join('\n');
  const response = await completeJson({
    system: withPromptDataRule(system),
    user: sourceCurrentPrompt(source, currentOutput),
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
    system: withPromptDataRule(system),
    user: sourceCurrentPrompt(source, currentOutput),
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
  const omissions = (coverageAudit?.repairTargets || coverageAudit?.omissions || []).slice(0, 8);
  if (!omissions.length) return { outputText: currentOutput, safeChangeFound: false, notes: [], usage: null, model: '' };
  const issueLines = omissions.map(item => [
    `- 원문 문장 ${item.sourceOrdinal}; 유형=${(item.types || []).join(',')}; 회수율=${item.contentRecall}${item.strengthShift ? '; 문제=학습을 보유 역량으로 강화함' : ''}`,
    item.previousContext ? `  앞 문맥: ${item.previousContext}` : '',
    `  복원할 원문 주장: ${item.sourceSentence}`,
    item.nextContext ? `  뒤 문맥: ${item.nextContext}` : ''
  ].filter(Boolean).join('\n'));
  const system = [
    '너는 자기소개서 핵심 주장 누락만 복원하는 한국어 편집기다.',
    'SOURCE의 행동·역량·성과·직무 연결 문장이 CURRENT에서 빠지거나, “배웠다” 같은 학습 경험이 “역량을 갖추었다” 같은 보유 주장으로 강해진 항목만 원래 위치에 복원한다.',
    '각 항목에 제공된 원문 문장과 앞뒤 문맥만 사용한다. 새 경험·성과·수치·역량·직무 연결을 추정하거나 만들지 않는다.',
    '문단 순서와 화자·시점을 유지하고, 이미 보존된 다른 문장은 바꾸지 않는다. 별도 요약·결론 문단을 만들지 않는다.',
    '복원 문장은 원문의 격식과 전문 개념어를 유지하며 지나친 구어체로 낮추지 않는다.',
    '안전하게 원래 위치를 찾을 수 없거나 누락이 이미 없다면 safeChangeFound=false로 답한다.',
    '[복원 대상]',
    ...issueLines
  ].join('\n');
  const response = await completeJson({
    system: withPromptDataRule(system),
    user: sourceCurrentPrompt(source, currentOutput),
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

function sourceCurrentPrompt(source, currentOutput) {
  return buildPromptDataSections([
    { label: 'SOURCE', value: source },
    { label: 'CURRENT', value: currentOutput }
  ]).text;
}

function withPromptDataRule(system) {
  return [String(system || ''), promptEnvelopeSystemRule()].filter(Boolean).join('\n');
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
  POLISH_REQUIRED_ISSUE_CODES,
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
  retryConservativeSentenceSurface,
  retryCollapsedKoreanSpacing,
  validateCollapsedKoreanSpacingCandidate,
  retryKoreanRefinement,
  retryFingerprintAudit,
  retryEndingStyleAudit,
  retryResumeCoverage,
  buildGeneralRetryTargetOrdinals,
  warningsFromSemantic
};
