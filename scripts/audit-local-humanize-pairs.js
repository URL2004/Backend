'use strict';

// 운영 원문·결과는 로컬 파일에서만 읽고, 집계와 익명 표본 ID만 출력한다.
// 원문·결과·UID·작업 ID는 stdout이나 저장소 파일에 기록하지 않는다.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { buildContract } = require('../engine/contract');
const inputRouting = require('../engine/inputrouting');
const {
  applyDocumentProfileOverride,
  applyTargetRegister,
  detectDocumentProfile
} = require('../engine-gpt-prod/documentProfile');
const quality = require('../engine-gpt-prod/finalQualityV2');
const discourse = require('../engine-gpt-prod/discourseAudit');
const depth = require('../engine-gpt-prod/humanizationDepth');
const korean = require('../engine-gpt-prod/koreanRefinement');
const structure = require('../engine-gpt-prod/structureChunk');
const { buildVoiceProfile } = require('../engine-gpt-prod/voiceProfile');

function parseArgs(argv) {
  const options = { input: '', engineVersion: '', details: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');
    if (value === '--input') options.input = String(argv[++index] || '');
    else if (value === '--engine-version') options.engineVersion = String(argv[++index] || '');
    else if (value === '--details') options.details = true;
  }
  if (!options.input) throw new Error('--input <local-json-path> is required');
  return options;
}

function increment(target, key, amount = 1) {
  const normalized = String(key || 'unknown');
  target[normalized] = Number(target[normalized] || 0) + amount;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : 0;
}

function median(values) {
  const rows = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!rows.length) return 0;
  const middle = Math.floor(rows.length / 2);
  const value = rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
  return Math.round(value * 10000) / 10000;
}

function anonymousId(value, index) {
  return crypto.createHash('sha256')
    .update(`humanize-local-audit-v1:${String(value || index)}`)
    .digest('hex')
    .slice(0, 12);
}

function normalizeMode(row) {
  return String(
    row?.engineMeta?.effectiveMode
    || row?.requestedMode
    || row?.mode
    || 'assignment'
  ).toLowerCase();
}

function normalizeStrength(row) {
  const value = String(row?.engineMeta?.requestStrength || '').toLowerCase();
  if (value === 'advanced' || value === 'polish') return value;
  const mode = normalizeMode(row);
  if (mode === 'polish') return 'polish';
  return mode === 'formal' ? 'advanced' : 'basic';
}

function auditRow(row, index) {
  const source = String(row?.inputText ?? row?.sourceText ?? row?.source ?? row?.input ?? '').trim();
  const outputText = String(row?.outputText ?? row?.output ?? '').trim();
  if (!source || !outputText) throw new Error('empty source or output');
  const meta = row?.engineMeta || {};
  const mode = normalizeMode(row);
  const requestStrength = normalizeStrength(row);
  const basicStyle = String(meta.basicStyle || '');
  const detected = detectDocumentProfile(source, { basicStyle });
  const documentProfile = applyTargetRegister(
    applyDocumentProfileOverride(detected, meta.requestedDocumentProfile),
    { requestStrength, basicStyle }
  );
  const voiceProfile = buildVoiceProfile(source, { documentProfile, mode });
  const chunkPlan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveLineBoundaries: String(voiceProfile?.lineBoundaryPolicy || 'none'),
    formatProfile: documentProfile.formatProfile
  });
  const restoredLayout = structure.restorePostSemanticLayout({
    source,
    outputText,
    chunks: chunkPlan.chunks,
    mode,
    requestStrength,
    documentProfile,
    profileConfidence: documentProfile.confidence
  });
  const structureAudit = structure.buildStructureAudit({
    source,
    integritySource: source,
    outputText,
    chunks: chunkPlan.chunks,
    plan: chunkPlan,
    layoutRepair: restoredLayout
  });
  const contract = buildContract(source, {
    mode,
    lang: 'ko',
    optIn: false,
    documentProfile
  });
  const deterministic = quality.buildDeterministicAudit({
    source,
    outputText,
    mode,
    contract,
    voiceProfile,
    documentProfile,
    structureAudit,
    protectedTerms: [],
    allowedExtra: ''
  });
  const koreanAudit = korean.analyzeKoreanRefinement({
    source,
    outputText,
    documentProfile,
    mode
  });
  const deterministicKoreanRepair = korean.applySafeDeterministicRepairs({
    source,
    outputText,
    documentProfile
  });
  const deterministicKoreanAudit = korean.analyzeKoreanRefinement({
    source,
    outputText: deterministicKoreanRepair.text,
    documentProfile,
    mode
  });
  const safeFallbackRepair = korean.restoreIntroducedIntegritySentences({
    source,
    outputText: deterministicKoreanRepair.text,
    audit: deterministicKoreanAudit
  });
  const fallbackKoreanAudit = korean.analyzeKoreanRefinement({
    source,
    outputText: safeFallbackRepair.text,
    documentProfile,
    mode
  });
  const discourseBeforeRepair = discourse.compareDiscourse(source, safeFallbackRepair.text);
  const discourseRestore = discourse.restoreIntroducedIntensitySentences(
    source,
    safeFallbackRepair.text,
    discourseBeforeRepair
  );
  const simulatedFinalText = discourseRestore.applied
    ? discourseRestore.text
    : safeFallbackRepair.text;
  const simulatedFinalDiscourse = discourse.compareDiscourse(source, simulatedFinalText);
  const simulatedFinalDeterministic = quality.buildDeterministicAudit({
    source,
    outputText: simulatedFinalText,
    mode,
    contract,
    voiceProfile,
    documentProfile,
    structureAudit,
    protectedTerms: [],
    allowedExtra: ''
  });
  const depthPlan = depth.buildHumanizationPlan(source, {
    requestStrength,
    documentProfile
  });
  const depthAudit = depth.evaluateHumanizationDepth(source, outputText, depthPlan);
  const unsupportedEnglish = inputRouting.isEnglishInput(source);
  const professionalDowngrade = korean.detectProfessionalDowngrade(
    source,
    outputText,
    documentProfile.profile
  );
  const introducedKoreanCodes = koreanAudit.issues
    .filter(item => Number(item.introducedCount || 0) > 0)
    .map(item => item.code);
  const koreanRepairableCodes = [...new Set(koreanAudit.repairableCodes || [])];
  const sourceReviewCodes = [...new Set((koreanAudit.sourceReviewWarnings || []).map(item => item.code))];
  const deterministicWarningCodes = deterministic.warnings.map(item => item.code);
  const currentProfile = String(documentProfile.profile || 'unknown');
  const storedProfile = String(meta.documentProfile || row?.documentProfile || 'unknown');
  const substantiveEditRatio = Number(depthAudit?.metrics?.substantiveEditRatio || 0);
  const literalEditRatio = Number(depthAudit?.metrics?.literalNormalizedEditRatio || 0);
  return {
    sampleId: anonymousId(row?.docId || row?.caseId, index),
    engineVersion: String(meta.engineVersion || row?.engineVersion || 'unknown'),
    mode,
    requestStrength,
    storedProfile,
    detectedProfile: String(detected.profile || 'unknown'),
    currentProfile,
    profileDecisionSource: String(documentProfile.profileDecisionSource || 'content_only'),
    profileChangedFromStored: storedProfile !== currentProfile,
    languageKind: unsupportedEnglish ? 'english_blocked' : 'accepted',
    depthApplicable: depthAudit.applicable === true,
    depthPass: depthAudit.pass === true,
    minimumEffectPass: depthAudit.minimumEffectPass !== false,
    effectStatus: String(depthAudit.effectStatus || 'not_applicable'),
    depthReasons: depthAudit.reasons || [],
    substantiveEditRatio: Math.round(substantiveEditRatio * 10000) / 10000,
    literalEditRatio: Math.round(literalEditRatio * 10000) / 10000,
    changedSentenceCount: Number(depthAudit?.metrics?.substantiveChangedSentenceCount || 0),
    introducedKoreanCodes,
    introducedKoreanCount: koreanAudit.issues.reduce(
      (sum, item) => sum + Number(item.introducedCount || 0),
      0
    ),
    koreanPass: koreanAudit.pass === true,
    koreanRepairableCodes,
    sourceReviewCodes,
    simulatedDeterministicRepairCount: Number(deterministicKoreanRepair.changeCount || 0),
    simulatedSourceRestoreCount: Number(safeFallbackRepair.restoredSentenceCount || 0),
    simulatedResidualIntroducedCount: Number(fallbackKoreanAudit.introducedIssueCount || 0),
    simulatedResidualIntroducedCodes: fallbackKoreanAudit.issues
      .filter(item => Number(item.introducedCount || 0) > 0)
      .map(item => item.code),
    simulatedDiscourseIntensityRestoreCount: Number(discourseRestore.restoredSentenceCount || 0),
    simulatedResidualDiscourseCodes: simulatedFinalDiscourse.codes || [],
    simulatedFinalWarningCodes: simulatedFinalDeterministic.warnings.map(item => item.code),
    professionalDowngrade: Boolean(professionalDowngrade),
    deterministicWarningCodes,
    structurePass: structureAudit.pass === true,
    structureSignaturePass: structureAudit.structureSignaturePass === true,
    originalStructurePass: structureAudit.originalStructurePass === true,
    paragraphPass: restoredLayout.paragraphs?.pass !== false,
    paragraphRepairWouldChange: restoredLayout.text !== outputText.replace(/\r\n?/gu, '\n').trim(),
    paragraphPolicy: String(restoredLayout.paragraphs?.policy || 'none'),
    paragraphTargetConstrained: restoredLayout.paragraphs?.targetConstrained === true,
    outputContentPreservedByLayout: restoredLayout.text.replace(/\s+/gu, '') === outputText.replace(/\s+/gu, ''),
    storedQualityStatus: String(row?.qualityStatus || 'unknown')
  };
}

function summarize(rows, errors) {
  const summary = {
    schemaVersion: 1,
    rowCount: rows.length,
    errorCount: errors.length,
    engineVersions: {},
    modes: {},
    requestStrengths: {},
    currentProfiles: {},
    profileDecisionSources: {},
    languageKinds: {},
    effectStatuses: {},
    depthReasons: {},
    introducedKoreanCodes: {},
    koreanRepairableCodes: {},
    sourceReviewCodes: {},
    simulatedResidualIntroducedCodes: {},
    simulatedResidualDiscourseCodes: {},
    simulatedFinalWarningCodes: {},
    deterministicWarningCodes: {},
    paragraphPolicies: {}
  };
  for (const row of rows) {
    increment(summary.engineVersions, row.engineVersion);
    increment(summary.modes, row.mode);
    increment(summary.requestStrengths, row.requestStrength);
    increment(summary.currentProfiles, row.currentProfile);
    increment(summary.profileDecisionSources, row.profileDecisionSource);
    increment(summary.languageKinds, row.languageKind);
    increment(summary.effectStatuses, row.effectStatus);
    increment(summary.paragraphPolicies, row.paragraphPolicy);
    for (const code of row.depthReasons) increment(summary.depthReasons, code);
    for (const code of row.introducedKoreanCodes) increment(summary.introducedKoreanCodes, code);
    for (const code of row.koreanRepairableCodes) increment(summary.koreanRepairableCodes, code);
    for (const code of row.sourceReviewCodes) increment(summary.sourceReviewCodes, code);
    for (const code of row.simulatedResidualIntroducedCodes) increment(summary.simulatedResidualIntroducedCodes, code);
    for (const code of row.simulatedResidualDiscourseCodes) increment(summary.simulatedResidualDiscourseCodes, code);
    for (const code of row.simulatedFinalWarningCodes) increment(summary.simulatedFinalWarningCodes, code);
    for (const code of row.deterministicWarningCodes) increment(summary.deterministicWarningCodes, code);
  }
  const depthRows = rows.filter(row => row.depthApplicable);
  return {
    ...summary,
    unsupportedLanguageDocumentCount: rows.filter(row => row.languageKind === 'english_blocked').length,
    profileChangedFromStoredCount: rows.filter(row => row.profileChangedFromStored).length,
    depthApplicableDocumentCount: depthRows.length,
    depthPassDocumentCount: depthRows.filter(row => row.depthPass).length,
    depthPassRatio: ratio(depthRows.filter(row => row.depthPass).length, depthRows.length),
    minimumEffectFailureCount: depthRows.filter(row => !row.minimumEffectPass).length,
    medianSubstantiveEditRatio: median(depthRows.map(row => row.substantiveEditRatio)),
    medianLiteralEditRatio: median(depthRows.map(row => row.literalEditRatio)),
    introducedKoreanIssueDocumentCount: rows.filter(row => row.introducedKoreanCount > 0).length,
    koreanRepairableDocumentCount: rows.filter(row => !row.koreanPass).length,
    sourceReviewDocumentCount: rows.filter(row => row.sourceReviewCodes.length > 0).length,
    simulatedDeterministicRepairDocumentCount: rows.filter(row => row.simulatedDeterministicRepairCount > 0).length,
    simulatedSourceRestoreDocumentCount: rows.filter(row => row.simulatedSourceRestoreCount > 0).length,
    simulatedDiscourseIntensityRestoreDocumentCount: rows.filter(
      row => row.simulatedDiscourseIntensityRestoreCount > 0
    ).length,
    simulatedResidualIntroducedIssueDocumentCount: rows.filter(row => row.simulatedResidualIntroducedCount > 0).length,
    simulatedResidualDiscourseIssueDocumentCount: rows.filter(
      row => row.simulatedResidualDiscourseCodes.length > 0
    ).length,
    simulatedFinalWarningDocumentCount: rows.filter(row => row.simulatedFinalWarningCodes.length > 0).length,
    professionalDowngradeDocumentCount: rows.filter(row => row.professionalDowngrade).length,
    deterministicWarningDocumentCount: rows.filter(row => row.deterministicWarningCodes.length > 0).length,
    structureFailureCount: rows.filter(row => !row.structurePass).length,
    structureSignatureFailureCount: rows.filter(row => !row.structureSignaturePass).length,
    originalStructureFailureCount: rows.filter(row => !row.originalStructurePass).length,
    paragraphFailureCount: rows.filter(row => !row.paragraphPass).length,
    paragraphRepairOpportunityCount: rows.filter(row => row.paragraphRepairWouldChange).length,
    paragraphRepairContentMismatchCount: rows.filter(row => !row.outputContentPreservedByLayout).length
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const raw = fs.readFileSync(inputPath, 'utf8');
  const payload = path.extname(inputPath).toLowerCase() === '.jsonl'
    ? raw.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
    : JSON.parse(raw);
  const sourceRows = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.rows) ? payload.rows : (Array.isArray(payload?.pairs) ? payload.pairs : []));
  const selected = sourceRows.filter(row => (
    !options.engineVersion
    || String(row?.engineMeta?.engineVersion || row?.engineVersion || '') === options.engineVersion
  ));
  if (!selected.length) throw new Error('선택 조건에 맞는 원문·결과 쌍이 없습니다.');
  const rows = [];
  const errors = [];
  selected.forEach((row, index) => {
    try {
      rows.push(auditRow(row, index));
    } catch (error) {
      errors.push({
        sampleId: anonymousId(row?.docId, index),
        code: String(error?.code || 'AUDIT_ERROR').slice(0, 80)
      });
    }
  });
  const notable = rows.filter(row => (
    row.languageKind === 'english_blocked'
    || row.profileChangedFromStored
    || !row.minimumEffectPass
    || row.introducedKoreanCount > 0
    || !row.koreanPass
    || row.professionalDowngrade
    || !row.structurePass
    || !row.paragraphPass
    || row.paragraphRepairWouldChange
  ));
  const result = {
    inputFile: path.basename(inputPath),
    engineVersionFilter: options.engineVersion || null,
    privacy: 'raw_text_uid_and_job_id_omitted',
    summary: summarize(rows, errors),
    errors,
    notable: options.details ? notable : undefined,
    details: options.details ? rows : undefined
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
