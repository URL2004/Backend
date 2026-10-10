'use strict';

const { splitSentences, splitSentenceSpans } = require('../engine/koreanText');
const { restoreSourceSentenceOrdinals } = require('./sourceSentenceRestore');
const {
  classifySentenceEnding,
  endingHistogram: sharedEndingHistogram
} = require('../engine/endingStyle');

const VERSION = 5;
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
  // 지원서처럼 짧은 소제목이 많은 문서는 각 절이 6문장에 못 미쳐도
  // 문서 전체의 격식은 충분히 명확할 수 있다. 절별 감사가 잡지 못한 경우에만
  // 전체 일반 문장으로 한 번 더 판정해 분류 실수가 종결체 변환으로 번지는
  // 것을 막는다. 원래 혼합 문체는 dominantRatio 기준에서 제외된다.
  let documentFallback = null;
  if (!issues.length) {
    const includeListBodies = compactRecordStyle || structuredNominalMemo;
    const sourceSentences = eligibleSentences(source, { includeListBodies });
    const outputSentences = eligibleSentences(output, { includeListBodies });
    const sourceHistogram = endingHistogram(sourceSentences);
    const outputHistogram = endingHistogram(outputSentences);
    const sourceRecognized = styleTotal(sourceHistogram);
    const dominant = dominantStyle(sourceHistogram);
    const dominantRatio = sourceRecognized ? sourceHistogram[dominant] / sourceRecognized : 0;
    const introducedStyles = [];
    let introducedOtherCount = 0;
    if (sourceSentences.length >= 6 && sourceRecognized >= 6 && dominantRatio >= 0.75) {
      for (const style of STYLES) {
        if (style === dominant) continue;
        const introduced = Math.max(0, Number(outputHistogram[style] || 0) - Number(sourceHistogram[style] || 0));
        if (introduced <= 0) continue;
        introducedOtherCount += introduced;
        introducedStyles.push({ style, count: introduced });
      }
    }
    documentFallback = {
      index: sourceSections.length,
      scope: 'document',
      heading: 'document',
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
      issue: introducedOtherCount >= 2
    };
    if (documentFallback.issue) issues.push(documentFallback);
  }
  return {
    version: VERSION,
    profile,
    pass: issues.length === 0,
    issueCodes: issues.length ? ['ending_style_mixed'] : [],
    issueCount: issues.length,
    introducedOtherCount: issues.reduce((sum, item) => sum + item.introducedOtherCount, 0),
    sections,
    documentFallback,
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

// ---------------------------------------------------------------------------
// 종결 변이형 혼용 관측값 (기록 전용, 경고·재시도·전달 상태에 연결하지 않음)
//
// 기존 ending_style_mixed는 격식(한다/합니다/해요/명사형)이 섞일 때만 올린다.
// 같은 격식 안의 변이형(하였다/했다, 되었다/됐다)이 반반으로 섞이는 손상은
// 잡지 못했다(2026-10-09 H0126 39:10→16:29, H0135, H0049). 원문과 결과의
// 소수형 비율을 문서·절 단위로 재서 "새로 생긴 혼용"의 크기를 숫자로 남긴다.
// ---------------------------------------------------------------------------
const VARIANT_VERSION = 1;
const LONG_PAST_ENDING = /(?:하였|되었|이었)(?:다|습니다|고|으며|지만|는데|음|기)$/u;
const SHORT_PAST_ENDING = /(?:했|됐|였)(?:다|습니다|고|으며|지만|는데|음|기)$/u;

function pastVariantOf(sentence) {
  const text = String(sentence || '').replace(/[.!?…。！？"'”’」』】)\]]+$/gu, '').trim();
  if (!text) return '';
  if (LONG_PAST_ENDING.test(text)) return 'long';
  if (SHORT_PAST_ENDING.test(text)) return 'short';
  return '';
}

function registerVariantOf(sentence) {
  const style = classifySentenceEnding(sentence);
  return style === 'plain' || style === 'polite' ? style : '';
}

function variantCounts(sentences, classify, keys) {
  const counts = Object.fromEntries(keys.map(key => [key, 0]));
  for (const sentence of sentences || []) {
    const key = classify(sentence);
    if (key && key in counts) counts[key] += 1;
  }
  return counts;
}

function minorityShare(counts, keys) {
  const values = keys.map(key => Number(counts[key] || 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  return total ? Math.min(...values) / total : 0;
}

function dominantKey(counts, keys, { minTotal = 4, minShare = 0.6 } = {}) {
  const total = keys.reduce((sum, key) => sum + Number(counts[key] || 0), 0);
  if (total < minTotal) return '';
  const best = keys.reduce((left, right) => (Number(counts[right] || 0) > Number(counts[left] || 0) ? right : left));
  return Number(counts[best] || 0) / total >= minShare ? best : '';
}

// 2:0→1:1처럼 표본이 몇 문장뿐이면 비율이 0.5까지 튄다. 원문·결과 모두 해당
// 계열 문장이 넷 이상일 때만 혼용 순증을 계산하고, 그 미만은 개수만 남긴다.
const MIN_VARIANT_EVIDENCE = 4;

function compareVariantPair(sourceSentences, outputSentences, classify, keys) {
  const source = variantCounts(sourceSentences, classify, keys);
  const output = variantCounts(outputSentences, classify, keys);
  const sourceTotal = keys.reduce((sum, key) => sum + Number(source[key] || 0), 0);
  const outputTotal = keys.reduce((sum, key) => sum + Number(output[key] || 0), 0);
  const enoughEvidence = sourceTotal >= MIN_VARIANT_EVIDENCE && outputTotal >= MIN_VARIANT_EVIDENCE;
  const sourceMinorityShare = minorityShare(source, keys);
  const outputMinorityShare = minorityShare(output, keys);
  const sourceDominant = dominantKey(source, keys);
  const outputDominant = dominantKey(output, keys);
  return {
    source,
    output,
    enoughEvidence,
    sourceMinorityShare: round4(sourceMinorityShare),
    outputMinorityShare: round4(outputMinorityShare),
    introducedMixShare: enoughEvidence ? round4(Math.max(0, outputMinorityShare - sourceMinorityShare)) : 0,
    dominantFlipped: Boolean(sourceDominant && outputDominant && sourceDominant !== outputDominant)
  };
}

/**
 * 원문·결과 두 문자열만 받는 순수 함수다. 문서 전체와 절(소제목 단위)마다
 * 하였다/했다 계열과 한다/합니다 계열의 소수형 비율을 비교한다.
 * `introducedMixShare`는 결과 소수형 비율에서 원문 소수형 비율을 뺀 값(0 이상)으로,
 * 원문에 없던 혼용이 얼마나 새로 생겼는지를 뜻한다. 값이 클수록 섞임이 커졌다.
 */
function measureEndingVariantMix(source, output) {
  const pastKeys = ['long', 'short'];
  const registerKeys = ['plain', 'polite'];
  const document = {
    pastVariant: compareVariantPair(eligibleSentences(source), eligibleSentences(output), pastVariantOf, pastKeys),
    register: compareVariantPair(eligibleSentences(source), eligibleSentences(output), registerVariantOf, registerKeys)
  };
  const sourceSections = splitSections(source);
  const outputSections = splitSections(output);
  let sectionMaxPastVariant = 0;
  let sectionMaxRegister = 0;
  for (let index = 0; index < sourceSections.length; index += 1) {
    const before = eligibleSentences(sourceSections[index].body);
    const after = eligibleSentences((outputSections[index] || { body: '' }).body);
    if (before.length < 4 || after.length < 4) continue;
    sectionMaxPastVariant = Math.max(
      sectionMaxPastVariant,
      compareVariantPair(before, after, pastVariantOf, pastKeys).introducedMixShare
    );
    sectionMaxRegister = Math.max(
      sectionMaxRegister,
      compareVariantPair(before, after, registerVariantOf, registerKeys).introducedMixShare
    );
  }
  return {
    version: VARIANT_VERSION,
    pastVariant: document.pastVariant,
    register: document.register,
    sectionMaxPastVariantMixIntroduced: round4(sectionMaxPastVariant),
    sectionMaxRegisterMixIntroduced: round4(sectionMaxRegister),
    mixIntroduced: round4(Math.max(
      document.pastVariant.introducedMixShare,
      document.register.introducedMixShare,
      sectionMaxPastVariant,
      sectionMaxRegister
    ))
  };
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
  restoreIntroducedEndingSentences,
  measureEndingVariantMix,
  pastVariantOf
};
