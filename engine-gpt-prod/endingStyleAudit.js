'use strict';

const { splitSentences, splitSentenceSpans } = require('../engine/koreanText');
const { restoreSourceSentenceOrdinals } = require('./sourceSentenceRestore');
const {
  classifySentenceEnding,
  endingHistogram: sharedEndingHistogram
} = require('../engine/endingStyle');

const VERSION = 4;
const STYLES = Object.freeze(['plain', 'polite', 'haeyo', 'nominal']);

function auditEndingStyle(source, output, documentProfile = null) {
  const profile = profileName(documentProfile);
  const compactRecordStyle = ['clinical_record', 'student_record_teacher'].includes(profile);
  const structuredNominalMemo = isStructuredNominalMemo(documentProfile);
  const sourceSections = splitSections(source);
  const outputSections = splitSections(output);
  const sections = [];
  const issues = [];
  for (let index = 0; index < sourceSections.length; index += 1) {
    const before = sourceSections[index];
    const after = outputSections[index] || { heading: '', body: '' };
    const includeListBodies = compactRecordStyle || structuredNominalMemo;
    const sourceSentences = eligibleSentences(before.body, { includeListBodies });
    const outputSentences = eligibleSentences(after.body, { includeListBodies });
    const sourceHistogram = endingHistogram(sourceSentences);
    const outputHistogram = endingHistogram(outputSentences);
    const sourceRecognized = styleTotal(sourceHistogram);
    const dominant = dominantStyle(sourceHistogram);
    const dominantRatio = sourceRecognized ? sourceHistogram[dominant] / sourceRecognized : 0;
    let introducedOtherCount = 0;
    const introducedStyles = [];
    const nominalMemoSection = structuredNominalMemo && dominant === 'nominal';
    const enoughEvidence = compactRecordStyle
      ? sourceSentences.length >= 3 && sourceRecognized >= 2 && dominantRatio >= 0.66
      : nominalMemoSection
        ? sourceSentences.length >= 3 && sourceRecognized >= 2 && dominantRatio >= 0.75
      : sourceSentences.length >= 6 && sourceRecognized >= 6 && dominantRatio >= 0.75;
    if (enoughEvidence) {
      for (const style of STYLES) {
        if (style === dominant) continue;
        const introduced = Math.max(0, Number(outputHistogram[style] || 0) - Number(sourceHistogram[style] || 0));
        if (introduced <= 0) continue;
        introducedOtherCount += introduced;
        introducedStyles.push({ style, count: introduced });
      }
    }
    const issue = introducedOtherCount >= (compactRecordStyle || nominalMemoSection ? 1 : 2);
    const record = {
      index,
      heading: before.heading || `section_${index + 1}`,
      profile,
      sourceSentenceCount: sourceSentences.length,
      outputSentenceCount: outputSentences.length,
      sourceHistogram,
      outputHistogram,
      dominantStyle: dominantRatio >= 0.75 ? dominant : '',
      dominantRatio: round4(dominantRatio),
      structuredNominalMemo,
      introducedOtherCount,
      introducedStyles,
      issue
    };
    sections.push(record);
    if (issue) issues.push(record);
  }
  return {
    version: VERSION,
    profile,
    pass: issues.length === 0,
    issueCodes: issues.length ? ['ending_style_mixed'] : [],
    issueCount: issues.length,
    introducedOtherCount: issues.reduce((sum, item) => sum + item.introducedOtherCount, 0),
    sections,
    issues
  };
}

function auditPolishEndingConsistency(source, output, documentProfile = null) {
  const profile = profileName(documentProfile);
  const compactRecordStyle = ['clinical_record', 'student_record_teacher'].includes(profile);
  const sourceSections = splitSections(source);
  const outputSections = splitSections(output);
  const sections = [];
  for (let index = 0; index < sourceSections.length; index += 1) {
    const sourceSentences = eligibleSentences(sourceSections[index].body, {
      includeListBodies: compactRecordStyle
    });
    const sourceHistogram = endingHistogram(sourceSentences);
    const recognized = styleTotal(sourceHistogram);
    const dominant = dominantStyle(sourceHistogram);
    const dominantCount = Number(sourceHistogram[dominant] || 0);
    const dominantRatio = recognized ? dominantCount / recognized : 0;
    const sourceOutlierCount = recognized - dominantCount;
    const minimumEvidence = compactRecordStyle ? 3 : 6;
    if (sourceSentences.length < minimumEvidence
        || recognized < minimumEvidence
        || dominantRatio < 0.75
        || sourceOutlierCount < 1) continue;
    const outputSection = outputSections[index] || { body: '' };
    const outputHistogram = endingHistogram(eligibleSentences(outputSection.body, {
      includeListBodies: compactRecordStyle
    }));
    const remainingOutlierCount = STYLES
      .filter(style => style !== dominant)
      .reduce((sum, style) => sum + Number(outputHistogram[style] || 0), 0);
    sections.push({
      index,
      heading: sourceSections[index].heading || `section_${index + 1}`,
      dominantStyle: dominant,
      dominantRatio: round4(dominantRatio),
      sourceOutlierCount,
      remainingOutlierCount,
      sourceHistogram,
      outputHistogram
    });
  }
  const sourceIssueCount = sections.reduce((sum, item) => sum + item.sourceOutlierCount, 0);
  const remainingIssueCount = sections.reduce((sum, item) => sum + item.remainingOutlierCount, 0);
  return {
    version: VERSION,
    applicable: sections.length > 0,
    pass: remainingIssueCount === 0,
    sourceIssueCount,
    remainingIssueCount,
    fixedIssueCount: Math.max(0, sourceIssueCount - remainingIssueCount),
    sections
  };
}

function splitSections(value) {
  const lines = String(value || '').replace(/\r\n?/gu, '\n').split('\n');
  const sections = [];
  let current = { heading: '', lines: [] };
  const flush = () => {
    if (!current.lines.join('').trim() && !current.heading) return;
    sections.push({ heading: current.heading, body: current.lines.join('\n').trim() });
  };
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (isHeading(line)) {
      flush();
      current = { heading: line, lines: [] };
    } else {
      current.lines.push(rawLine);
    }
  }
  flush();
  return sections.length ? sections : [{ heading: '', body: String(value || '').trim() }];
}

function eligibleSentences(value, { includeListBodies = false } = {}) {
  const proseLines = String(value || '').split(/\r?\n/u)
    .map(line => line.trim())
    .map(line => includeListBodies ? stripListPrefix(line) : line)
    .filter(line => line && !isProtectedLine(line));
  return splitSentences(proseLines.join('\n'))
    .map(sentence => String(sentence || '').trim())
    .filter(sentence => sentence.replace(/[^가-힣A-Za-z0-9]/gu, '').length >= 3);
}

function stripListPrefix(line) {
  return String(line || '')
    .replace(/^(?:[-*+•▪◦·●○■□◆◇▶▷※]|\d{1,3}[.)]|[①-⑳])\s+/u, '')
    .replace(/^[A-Za-z가-힣][.)]\s+/u, '')
    .trim();
}

function profileName(documentProfile) {
  return String(documentProfile?.profile || documentProfile?.contentGenre || documentProfile || 'unknown');
}

/**
 * 번호 절과 라벨 행으로 구성된 강의·기획 요약은 일반 보고서보다 문장이
 * 짧다. 이 형식에서 원문의 `~함` 종결을 일부만 평서문으로 바꾸면 한 절에
 * 6문장이 되지 않아 기존 감사가 누락했다. 보고서 전체가 아니라 구조
 * 판정기가 sectioned + label_heavy로 확인한 경우에만 짧은 명사형 기준을
 * 적용해 일반 산문이나 원래 혼합된 보고서를 건드리지 않는다.
 */
function isStructuredNominalMemo(documentProfile) {
  const profile = profileName(documentProfile);
  if (profile !== 'report_assignment') return false;
  const formatProfile = documentProfile && typeof documentProfile === 'object'
    ? documentProfile.formatProfile
    : null;
  const flags = new Set(Array.isArray(formatProfile?.flags) ? formatProfile.flags : []);
  return flags.has('sectioned')
    && (flags.has('label_heavy') || String(formatProfile?.primary || '') === 'label_heavy');
}

function endingHistogram(sentences) {
  return sharedEndingHistogram(sentences);
}

function endingStyle(sentence) {
  const style = classifySentenceEnding(sentence);
  return style === 'unknown' ? 'other' : style;
}

function dominantStyle(histogram) {
  return STYLES.reduce((best, style) => Number(histogram[style] || 0) > Number(histogram[best] || 0) ? style : best, STYLES[0]);
}

function styleTotal(histogram) {
  return STYLES.reduce((sum, style) => sum + Number(histogram[style] || 0), 0);
}

function isHeading(line) {
  if (!line) return false;
  if (/^#{1,6}\s+\S/u.test(line)) return true;
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)．]?\s*\S/u.test(line) && line.length <= 140) return true;
  if (/^제\s*\d{1,3}\s*(?:장|절|항|조)(?:\s|$|[（(])/u.test(line)) return true;
  return /^\d{1,2}(?:\.\d{1,2}){0,3}\s*[.)]?\s+\S/u.test(line) && line.length <= 140;
}

function isProtectedLine(line) {
  if (/^(?:[-*+•▪◦·●○■□◆◇▶▷※]|\d{1,3}[.)]|[①-⑳])\s+/u.test(line)) return true;
  if (/^>\s*\S/u.test(line) || /^\|.+\|$/u.test(line) || /\t/u.test(line)) return true;
  if (/^\s*(?:`{3,}|~{3,})/u.test(line) || /(?<!`)`[^`\n]+`(?!`)/u.test(line)) return true;
  return /^["'“‘「『《〈].+["'”’」』》〉]$/u.test(line) && line.length <= 180;
}

function isImproved(before, after) {
  return Number(after?.issueCount || 0) < Number(before?.issueCount || 0)
    || Number(after?.introducedOtherCount || 0) < Number(before?.introducedOtherCount || 0);
}

/**
 * 종결체 전용 모델 수리가 실패하거나 안전 후보로 채택되지 못한 경우,
 * 문서 전체를 버리지 않고 새로 섞인 종결체 문장만 대응 원문으로 되돌린다.
 * 원문에도 정확히 존재하는 대화·선택지·인용은 대상에서 제외하고, 공통
 * 문장 정렬기가 안전하게 대응시킨 문장만 복원한다.
 */
function restoreIntroducedEndingSentences(source, outputText, audit = null, documentProfile = null) {
  const before = String(outputText || '');
  const report = audit || auditEndingStyle(source, before, documentProfile);
  if (report?.pass !== false || !(report?.introducedOtherCount > 0)) {
    return endingRestoreResult(before, false, [], report, 'not_applicable');
  }

  const sourceSentenceKeys = new Set(splitSentenceSpans(String(source || ''))
    .map(span => normalizedSentenceKey(span.text))
    .filter(Boolean));
  const maximum = Math.min(8, Math.max(1, Number(report.introducedOtherCount) || 1));
  let currentText = before;
  let currentAudit = report;
  let remainingBudget = maximum;
  const restoredOutputOrdinals = [];
  const restoredSourceOrdinals = [];
  let lastReason = 'no_safe_target';

  // 한 번에 여러 후보를 넘겨도 제목·라벨이 문장 span에 함께 붙어 있으면
  // 정렬기가 가장 확실한 한 문장만 고를 수 있다. 감사가 실제로 개선된
  // 동안에만 남은 신규 종결을 다시 계산해 최대 예산 안에서 반복 복원한다.
  while (remainingBudget > 0 && currentAudit?.pass === false) {
    const introducedStyles = new Set((currentAudit.issues || [])
      .flatMap(section => section.introducedStyles || [])
      .filter(item => Number(item?.count || 0) > 0)
      .map(item => String(item.style || ''))
      .filter(Boolean));
    if (!introducedStyles.size) {
      lastReason = 'no_introduced_style';
      break;
    }

    const ordinals = [];
    const outputSpans = splitSentenceSpans(currentText);
    for (let index = 0; index < outputSpans.length && ordinals.length < remainingBudget; index += 1) {
      const span = outputSpans[index];
      const style = classifySentenceEnding(span.text);
      if (!introducedStyles.has(style)) continue;
      if (sourceSentenceKeys.has(normalizedSentenceKey(span.text))) continue;
      // 문장 분리기가 번호 제목과 바로 뒤 첫 본문을 한 span으로 반환할 수
      // 있다. span 시작 행(제목)이 아니라 실제 종결이 있는 마지막 행으로
      // 보호 여부를 판단해야 편집 가능한 라벨 본문을 놓치지 않는다.
      const targetLine = String(span.text || '').split(/\r?\n/u)
        .map(line => line.trim())
        .filter(Boolean)
        .at(-1) || '';
      if (isProtectedLine(targetLine)) continue;
      ordinals.push(index + 1);
    }
    if (!ordinals.length) {
      lastReason = 'no_safe_target';
      break;
    }

    const restored = restoreSourceSentenceOrdinals(source, currentText, ordinals, {
      maxRestoreCount: remainingBudget,
      minSimilarity: 0.2,
      ordinalSpace: 'output',
      maxOutputGroup: 3
    });
    if (!restored.applied) {
      lastReason = restored.reason || 'no_safe_alignment';
      break;
    }
    const afterAudit = auditEndingStyle(source, restored.text, documentProfile);
    if (!isImproved(currentAudit, afterAudit)) {
      lastReason = 'audit_not_improved';
      break;
    }
    currentText = restored.text;
    currentAudit = afterAudit;
    restoredOutputOrdinals.push(...(restored.restoredSentenceOrdinals || []));
    restoredSourceOrdinals.push(...(restored.restoredSourceSentenceOrdinals || []));
    remainingBudget -= Math.max(1, Number(restored.restoredSentenceCount) || 0);
    lastReason = currentAudit.pass ? 'restored' : 'restored_with_residual';
  }

  if (!restoredOutputOrdinals.length) {
    return endingRestoreResult(before, false, [], report, lastReason);
  }
  return endingRestoreResult(
    currentText,
    true,
    restoredOutputOrdinals,
    currentAudit,
    lastReason,
    {
      restoredSourceSentenceOrdinals: restoredSourceOrdinals
    }
  );
}

function normalizedSentenceKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^가-힣a-z0-9]/gu, '');
}

function endingRestoreResult(text, applied, ordinals, audit, reason, extra = {}) {
  return {
    text,
    applied,
    restoredSentenceCount: ordinals.length,
    restoredSentenceOrdinals: ordinals,
    audit,
    reason,
    ...extra
  };
}

function round4(value) {
  const number = Number(value) || 0;
  return Math.round(number * 10000) / 10000;
}

module.exports = {
  VERSION,
  STYLES,
  auditEndingStyle,
  auditPolishEndingConsistency,
  splitSections,
  eligibleSentences,
  endingHistogram,
  endingStyle,
  isStructuredNominalMemo,
  isImproved,
  restoreIntroducedEndingSentences
};
