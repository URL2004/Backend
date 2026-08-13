'use strict';

// 운영 원문·결과를 문장·문단·행 단위로 대조하는 로컬 전용 감사기다.
// 원문 전체나 UID·작업 ID는 출력하지 않고, --include-snippets를 명시한
// 로컬 보고서에만 최대 180자의 비식별 문맥을 남긴다.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { buildContract } = require('../engine/contract');
const { splitSentences, ngramJaccard } = require('../engine/koreanText');
const {
  applyDocumentProfileOverride,
  applyTargetRegister,
  detectDocumentProfile
} = require('../engine-gpt-prod/documentProfile');
const discourse = require('../engine-gpt-prod/discourseAudit');
const quality = require('../engine-gpt-prod/finalQualityV2');
const korean = require('../engine-gpt-prod/koreanRefinement');
const layout = require('../engine-gpt-prod/layoutStructure');
const structure = require('../engine-gpt-prod/structureChunk');
const sourcePreflight = require('../engine-gpt-prod/sourcePreflight');
const { buildVoiceProfile } = require('../engine-gpt-prod/voiceProfile');

const TERMINAL_RE = /[.!?。！？…][”’」』》〉"')\]\uFF09]*$/u;
const CONTINUATION_START_RE = /^(?:의|은|는|이|가|을|를|와|과|에|에서|에게|으로|로|도|만|부터|까지|보다|처럼|라고|라며|라는|하며|하고|며|고)(?=\s|[‘“"'「『《〈(\[])/u;
const CONNECTIVE_FRAGMENT_RE = /^(?:그리고|그러나|하지만|또한|따라서|그런데|그래서|이를\s*통해|이\s*과정에서|그\s*결과|결국)(?=$|\s|[,，])/u;

function parseArgs(argv) {
  const options = { input: '', report: '', engineVersion: '', includeSnippets: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');
    if (value === '--input') options.input = String(argv[++index] || '');
    else if (value === '--report') options.report = String(argv[++index] || '');
    else if (value === '--engine-version') options.engineVersion = String(argv[++index] || '');
    else if (value === '--include-snippets') options.includeSnippets = true;
  }
  if (!options.input) throw new Error('--input <local-json-path> is required');
  if (!options.report) throw new Error('--report <local-md-path> is required');
  return options;
}

function anonymousId(value, index) {
  return crypto.createHash('sha256')
    .update(`humanize-local-audit-v1:${String(value || index)}`)
    .digest('hex')
    .slice(0, 12);
}

function normalizeMode(row) {
  return String(row?.engineMeta?.effectiveMode || row?.requestedMode || row?.mode || 'assignment').toLowerCase();
}

function normalizeStrength(row) {
  const value = String(row?.engineMeta?.requestStrength || '').toLowerCase();
  if (['advanced', 'polish'].includes(value)) return value;
  const mode = normalizeMode(row);
  return mode === 'polish' ? 'polish' : (mode === 'formal' ? 'advanced' : 'basic');
}

function cleanSentence(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function sentenceRows(value) {
  return splitSentences(String(value || ''))
    .map(cleanSentence)
    .filter(sentence => compact(sentence).length >= 3);
}

function explicitParagraphs(value) {
  return String(value || '')
    .replace(/\r\n?/gu, '\n')
    .split(/\n[ \t]*\n+/u)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
}

function compact(value) {
  return String(value || '').normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '').toLowerCase();
}

function snippet(value, maximum = 180) {
  const text = cleanSentence(value);
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function contentTokens(value) {
  const stop = new Set(['그리고', '하지만', '그러나', '또한', '따라서', '이러한', '이를', '통해', '위해', '대한', '관련', '경우', '과정']);
  return (String(value || '').normalize('NFKC').match(/[가-힣]{2,}|[A-Za-z]{2,}|\d+(?:[.,]\d+)?/gu) || [])
    .map(token => token.toLowerCase().replace(
      /(?:하였습니다|했습니다|되었습니다|에서는|으로는|에게는|이라는|으로|에서|에게|보다|처럼|하고|하며|하여|된|한|은|는|이|가|을|를|의|에|도|만|와|과|로)$/u,
      ''
    ))
    .filter(token => token.length >= 2 && !stop.has(token));
}

function tokenJaccard(left, right) {
  const a = new Set(contentTokens(left));
  const b = new Set(contentTokens(right));
  if (!a.size || !b.size) return ngramJaccard(compact(left), compact(right), 2);
  const shared = [...a].filter(token => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  const tokenScore = shared / Math.max(1, union);
  const charScore = ngramJaccard(compact(left), compact(right), 2);
  return Math.max(tokenScore, tokenScore * 0.72 + charScore * 0.28);
}

function bestSentenceMatches(sourceSentences, outputSentences) {
  const source = sourceSentences.map((text, index) => ({ index, text, bestScore: 0, bestIndex: -1 }));
  const output = outputSentences.map((text, index) => ({ index, text, bestScore: 0, bestIndex: -1 }));
  for (const sourceRow of source) {
    for (const outputRow of output) {
      const score = tokenJaccard(sourceRow.text, outputRow.text);
      if (score > sourceRow.bestScore) {
        sourceRow.bestScore = score;
        sourceRow.bestIndex = outputRow.index;
      }
      if (score > outputRow.bestScore) {
        outputRow.bestScore = score;
        outputRow.bestIndex = sourceRow.index;
      }
    }
  }
  return { source, output };
}

function collectBrokenLineBoundaries(value, documentProfile) {
  const profile = String(documentProfile || 'unknown');
  if (profile === 'creative') return [];
  const records = layout.buildLineRecords(value);
  const issues = [];
  let leftIndex = -1;
  for (let index = 0; index < records.length; index += 1) {
    const right = records[index];
    if (right.blank) continue;
    if (leftIndex < 0) {
      leftIndex = index;
      continue;
    }
    const left = records[leftIndex];
    const gap = Math.max(0, right.index - left.index - 1);
    const protectedRole = record => layout.isStructuralRole(record.role)
      || ['code', 'table', 'flow', 'quote', 'legal_clause', 'signature'].includes(String(record.role || ''));
    if (!protectedRole(left) && !protectedRole(right)) {
      const leftText = String(left.text || '').trim();
      const rightText = String(right.text || '').trim();
      const leftIncomplete = !TERMINAL_RE.test(leftText)
        && !/[:：;；] *$/u.test(leftText);
      const continuation = CONTINUATION_START_RE.test(rightText)
        || /(?:을|를|은|는|이|가|의|하는|되는|한|된|할|위한|대한|관한|,|，)$/u.test(leftText)
        || /^[a-z]/u.test(rightText);
      if (leftIncomplete && continuation) {
        issues.push({
          code: gap > 0 ? 'mid_sentence_paragraph_break' : 'mid_sentence_line_break',
          left: leftText,
          right: rightText,
          line: left.index + 1
        });
      }
    }
    const bothList = left.role === 'list' && right.role === 'list';
    const bothTable = left.role === 'table' && right.role === 'table'
      && Number(left.cellCount || 0) >= 2 && Number(right.cellCount || 0) >= 2;
    if (gap > 0 && (bothList || bothTable)) {
      issues.push({
        code: bothList ? 'list_rows_overseparated' : 'table_rows_overseparated',
        left: left.text,
        right: right.text,
        line: left.index + 1
      });
    }
    leftIndex = index;
  }
  return issues;
}

function collectParagraphIssues(source, outputText, documentProfile, requestStrength, mode) {
  const sourceExplicit = explicitParagraphs(source);
  const outputExplicit = explicitParagraphs(outputText);
  const readability = layout.measureParagraphReadability(outputExplicit, {
    documentProfile: { profile: documentProfile },
    profileName: documentProfile,
    requestStrength,
    mode
  });
  const issues = [];
  outputExplicit.forEach((paragraph, index) => {
    const sentences = sentenceRows(paragraph);
    const bareLength = compact(paragraph).length;
    if (sentences.length === 1
        && bareLength <= 48
        && CONNECTIVE_FRAGMENT_RE.test(sentences[0])
        && outputExplicit.length > sourceExplicit.length) {
      issues.push({ code: 'orphan_connective_paragraph', index, text: paragraph });
    }
  });
  if (readability.overlongCount > 0) {
    issues.push({
      code: 'paragraph_readability_overlong',
      count: readability.overlongCount,
      maxBare: readability.maxBare,
      maxSentences: readability.maxSentences
    });
  }
  return {
    sourceExplicitCount: sourceExplicit.length,
    outputExplicitCount: outputExplicit.length,
    sourceReadableCount: layout.splitReadableParagraphs(source).length,
    outputReadableCount: layout.splitReadableParagraphs(outputText).length,
    readability,
    issues
  };
}

function collectIntroducedDuplicates(source, outputText) {
  const sourceSentences = sentenceRows(source);
  const outputSentences = sentenceRows(outputText);
  const sourceKeys = new Set(sourceSentences.map(compact));
  const seen = new Map();
  const issues = [];
  outputSentences.forEach((sentence, index) => {
    const key = compact(sentence);
    if (key.length < 12) return;
    if (seen.has(key) && !sourceKeys.has(key)) {
      issues.push({ code: 'introduced_exact_sentence_duplicate', first: seen.get(key), second: index, text: sentence });
    } else if (!seen.has(key)) {
      seen.set(key, index);
    }
  });
  for (let index = 1; index < outputSentences.length; index += 1) {
    const left = outputSentences[index - 1];
    const right = outputSentences[index];
    if (compact(left) === compact(right)) continue;
    const score = tokenJaccard(left, right);
    if (score < 0.72) continue;
    const sourceHasPair = sourceSentences.some((sentence, sourceIndex) => (
      tokenJaccard(sentence, left) >= 0.55
      && sourceSentences.slice(Math.max(0, sourceIndex - 1), sourceIndex + 2)
        .some(candidate => tokenJaccard(candidate, right) >= 0.55)
    ));
    if (!sourceHasPair) issues.push({ code: 'introduced_adjacent_semantic_repeat', first: index - 1, second: index, score, left, right });
  }
  return issues;
}

function auditRow(row, index, includeSnippets) {
  const submittedSource = String(row?.inputText ?? row?.sourceText ?? row?.source ?? '').trim();
  const outputText = String(row?.outputText ?? row?.output ?? '').trim();
  if (!submittedSource || !outputText) throw new Error('empty source or output');
  const preflight = sourcePreflight.auditAndSanitizeSource(submittedSource);
  const source = String(preflight.integrityText || preflight.text || submittedSource).trim();
  const meta = row?.engineMeta || {};
  const mode = normalizeMode(row);
  const requestStrength = normalizeStrength(row);
  const detected = detectDocumentProfile(source, { basicStyle: meta.basicStyle || '' });
  const documentProfile = applyTargetRegister(
    applyDocumentProfileOverride(detected, meta.requestedDocumentProfile),
    { requestStrength, basicStyle: meta.basicStyle || '' }
  );
  const profileName = String(documentProfile.profile || 'unknown');
  const voiceProfile = buildVoiceProfile(source, { documentProfile, mode });
  const chunkPlan = structure.splitChunksForGpt(source, {
    coalesceEditable: true,
    preserveLineBoundaries: String(voiceProfile?.lineBoundaryPolicy || 'none'),
    formatProfile: documentProfile.formatProfile
  });
  const layoutRepair = structure.restorePostSemanticLayout({
    source,
    outputText,
    chunks: chunkPlan.chunks,
    mode,
    requestStrength,
    documentProfile,
    profileConfidence: documentProfile.confidence
  });
  const finalLayoutRepair = structure.restoreFinalDocumentLayout({
    source,
    outputText,
    chunks: chunkPlan.chunks,
    mode,
    requestStrength,
    documentProfile,
    profileConfidence: documentProfile.confidence,
    normalizeVisualGaps: mode !== 'polish' && profileName !== 'creative'
  });
  const structureAudit = structure.buildStructureAudit({
    source,
    integritySource: source,
    outputText,
    chunks: chunkPlan.chunks,
    plan: chunkPlan,
    layoutRepair
  });
  const contract = buildContract(source, { mode, lang: 'ko', optIn: false, documentProfile });
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
  const koreanAudit = korean.analyzeKoreanRefinement({ source, outputText, documentProfile, mode });
  const formattingRepair = korean.applySafeFormattingRepairs({ source, outputText, documentProfile });
  const discourseAudit = discourse.compareDiscourse(source, outputText);
  const sourceSentences = sentenceRows(source);
  const outputSentences = sentenceRows(outputText);
  const matches = bestSentenceMatches(sourceSentences, outputSentences);
  const sourceLow = matches.source.filter(item => item.bestScore < 0.14 && compact(item.text).length >= 18);
  const outputLow = matches.output.filter(item => item.bestScore < 0.14 && compact(item.text).length >= 18);
  const lineIssues = collectBrokenLineBoundaries(outputText, profileName);
  const paragraph = collectParagraphIssues(source, outputText, profileName, requestStrength, mode);
  const duplicateIssues = collectIntroducedDuplicates(source, outputText);
  const koreanIssues = koreanAudit.issues.filter(item => Number(item.introducedCount || 0) > 0);
  const warningCodes = deterministic.warnings.map(item => item.code);
  const issueCodes = unique([
    ...lineIssues.map(item => item.code),
    ...paragraph.issues.map(item => item.code),
    ...duplicateIssues.map(item => item.code),
    ...koreanIssues.map(item => item.code),
    ...(discourseAudit.codes || []),
    ...warningCodes,
    ...(finalLayoutRepair.text !== outputText.replace(/\r\n?/gu, '\n').trim() ? ['final_layout_repair_opportunity'] : []),
    ...(!structureAudit.pass ? ['structure_audit_failed'] : [])
  ]);
  const result = {
    sampleId: anonymousId(row?.docId || row?.caseId, index),
    engineVersion: String(meta.engineVersion || row?.engineVersion || 'unknown'),
    mode,
    requestStrength,
    profile: profileName,
    qualityStatus: String(row?.qualityStatus || 'unknown'),
    sourceLength: source.length,
    outputLength: outputText.length,
    sourceSentenceCount: sourceSentences.length,
    outputSentenceCount: outputSentences.length,
    paragraph,
    structurePass: structureAudit.pass === true,
    structureSignaturePass: structureAudit.structureSignaturePass === true,
    originalStructurePass: structureAudit.originalStructurePass === true,
    sourceArtifactRemovedCount: Number(preflight.removedArtifactCount || preflight.removedLineCount || 0),
    layoutRepairOpportunity: finalLayoutRepair.text !== outputText.replace(/\r\n?/gu, '\n').trim(),
    layoutRepairPolicy: String(layoutRepair.paragraphs?.policy || 'none'),
    layoutRepairCounts: {
      heading: Number(layoutRepair.heading?.restoredCount || 0),
      sourceBoundary: Number(layoutRepair.paragraphs?.sourceBoundaryRepairCount || 0),
      proseSplit: Number(layoutRepair.paragraphs?.proseSplitCount || 0),
      visualGap: Number(layoutRepair.paragraphs?.visualGapRepairCount || 0),
      inlineLabel: Number(layoutRepair.inlineLabels?.repairCount || 0)
    },
    formattingRepairCount: Number(formattingRepair.changeCount || 0),
    formattingRepairCodes: formattingRepair.changeCodes || [],
    lineIssues,
    duplicateIssues,
    koreanIssues,
    discourseViolations: discourseAudit.violations || [],
    warningCodes,
    sourceLowCoverageCount: sourceLow.length,
    outputLowGroundingCount: outputLow.length,
    issueCodes,
    snippets: includeSnippets ? {
      sourceLow: sourceLow.slice(0, 3).map(item => ({ ordinal: item.index + 1, score: round3(item.bestScore), text: snippet(item.text) })),
      outputLow: outputLow.slice(0, 3).map(item => ({ ordinal: item.index + 1, score: round3(item.bestScore), text: snippet(item.text) })),
      line: lineIssues.slice(0, 3).map(item => ({ code: item.code, line: item.line, before: snippet(item.left, 120), after: snippet(item.right, 120) })),
      duplicates: duplicateIssues.slice(0, 2).map(item => ({ code: item.code, left: snippet(item.left || item.text, 130), right: snippet(item.right || '', 130) })),
      korean: koreanIssues.slice(0, 4).map(item => ({ code: item.code, ordinals: item.sentenceOrdinals || [], message: item.message }))
    } : undefined
  };
  return result;
}

function summarize(rows, errors) {
  const byCode = {};
  const byProfile = {};
  const byMode = {};
  for (const row of rows) {
    increment(byProfile, row.profile);
    increment(byMode, `${row.mode}/${row.requestStrength}`);
    for (const code of row.issueCodes) increment(byCode, code);
  }
  return {
    rowCount: rows.length,
    errorCount: errors.length,
    issueDocumentCount: rows.filter(row => row.issueCodes.length).length,
    structureFailureCount: rows.filter(row => !row.structurePass).length,
    layoutRepairOpportunityCount: rows.filter(row => row.layoutRepairOpportunity).length,
    brokenLineDocumentCount: rows.filter(row => row.lineIssues.length).length,
    paragraphIssueDocumentCount: rows.filter(row => row.paragraph.issues.length).length,
    introducedDuplicateDocumentCount: rows.filter(row => row.duplicateIssues.length).length,
    introducedKoreanIssueDocumentCount: rows.filter(row => row.koreanIssues.length).length,
    discourseIssueDocumentCount: rows.filter(row => row.discourseViolations.length).length,
    lowSourceCoverageReviewCount: rows.filter(row => row.sourceLowCoverageCount > 0).length,
    lowOutputGroundingReviewCount: rows.filter(row => row.outputLowGroundingCount > 0).length,
    byProfile,
    byMode,
    byCode: Object.fromEntries(Object.entries(byCode).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])))
  };
}

function renderReport(summary, rows, options, inputPath) {
  const notable = rows
    .filter(row => row.issueCodes.length)
    .sort((left, right) => issueWeight(right) - issueWeight(left) || right.sourceLength - left.sourceLength);
  const lines = [
    '# 운영 원문–휴머나이징 문장·문단·줄바꿈 정밀 감사',
    '',
    `- 입력: \`${path.basename(inputPath)}\``,
    `- 감사 쌍: ${summary.rowCount}건 (오류 ${summary.errorCount}건)`,
    `- 원문 전체·UID·작업 ID: 보고서에 저장하지 않음`,
    `- 문맥 발췌: ${options.includeSnippets ? '최대 180자의 익명 검증용 발췌만 포함' : '제외'}`,
    '',
    '## 요약',
    '',
    `- 구조 감사 실패: ${summary.structureFailureCount}건`,
    `- 최종 레이아웃 재적용 시 개선 가능: ${summary.layoutRepairOpportunityCount}건`,
    `- 문장 중간 줄/문단 나눔 후보: ${summary.brokenLineDocumentCount}건`,
    `- 문단 가독성·고립 조각 문제: ${summary.paragraphIssueDocumentCount}건`,
    `- 신규 정확/인접 의미 중복: ${summary.introducedDuplicateDocumentCount}건`,
    `- 신규 한국어 문제: ${summary.introducedKoreanIssueDocumentCount}건`,
    `- 담화·의미 방향 경고: ${summary.discourseIssueDocumentCount}건`,
    '',
    '## 문제 코드별 문서 수',
    '',
    '| 코드 | 문서 수 |',
    '|---|---:|',
    ...Object.entries(summary.byCode).map(([code, count]) => `| ${code} | ${count} |`),
    '',
    '## 문서별 정밀 비교',
    ''
  ];
  notable.forEach(row => {
    lines.push(
      `### ${row.sampleId} · ${row.profile} · ${row.mode}/${row.requestStrength}`,
      '',
      `- 길이: ${row.sourceLength} → ${row.outputLength}자, 문장: ${row.sourceSentenceCount} → ${row.outputSentenceCount}개`,
      `- 명시 문단: ${row.paragraph.sourceExplicitCount} → ${row.paragraph.outputExplicitCount}개, 읽기 문단: ${row.paragraph.sourceReadableCount} → ${row.paragraph.outputReadableCount}개`,
      `- 구조: ${row.structurePass ? '통과' : '실패'}, 최종 레이아웃 후보: ${row.layoutRepairOpportunity ? '있음' : '없음'} (${row.layoutRepairPolicy})`,
      `- 문제: ${row.issueCodes.join(', ')}`,
      ''
    );
    if (options.includeSnippets) {
      for (const item of row.snippets.line || []) {
        lines.push(`- 줄바꿈 ${item.code} (L${item.line}): “${escapeMd(item.before)}” / “${escapeMd(item.after)}”`);
      }
      for (const item of row.snippets.duplicates || []) {
        lines.push(`- 중복 ${item.code}: “${escapeMd(item.left)}”${item.right ? ` / “${escapeMd(item.right)}”` : ''}`);
      }
      for (const item of row.snippets.korean || []) {
        lines.push(`- 한국어 ${item.code} (문장 ${item.ordinals.join(', ')}): ${escapeMd(item.message)}`);
      }
      for (const item of row.snippets.sourceLow || []) {
        lines.push(`- 원문 저대응 검토 S${item.ordinal} (${item.score}): “${escapeMd(item.text)}”`);
      }
      for (const item of row.snippets.outputLow || []) {
        lines.push(`- 결과 저근거 검토 O${item.ordinal} (${item.score}): “${escapeMd(item.text)}”`);
      }
      lines.push('');
    }
  });
  return `${lines.join('\n').trim()}\n`;
}

function issueWeight(row) {
  return (row.structurePass ? 0 : 50)
    + row.lineIssues.length * 20
    + row.duplicateIssues.length * 15
    + row.koreanIssues.length * 12
    + row.discourseViolations.length * 12
    + row.paragraph.issues.length * 8
    + (row.layoutRepairOpportunity ? 5 : 0);
}

function increment(target, key) {
  const value = String(key || 'unknown');
  target[value] = Number(target[value] || 0) + 1;
}

function unique(values) {
  return [...new Set((values || []).map(value => String(value || '')).filter(Boolean))];
}

function round3(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function escapeMd(value) {
  return String(value || '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const reportPath = path.resolve(options.report);
  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
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
      rows.push(auditRow(row, index, options.includeSnippets));
    } catch (error) {
      errors.push({ sampleId: anonymousId(row?.docId, index), code: String(error?.code || error?.message || 'AUDIT_ERROR').slice(0, 100) });
    }
  });
  const summary = summarize(rows, errors);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, renderReport(summary, rows, options, inputPath), 'utf8');
  process.stdout.write(`${JSON.stringify({ report: reportPath, summary, errors }, null, 2)}\n`);
}

main();
