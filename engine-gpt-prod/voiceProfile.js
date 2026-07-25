'use strict';

const { splitSentences, normalizeCompact, mean, standardDeviation } = require('../engine/koreanText');
const { detectRegister, endingHistogram: sharedEndingHistogram } = require('../engine/endingStyle');
const { computePovSeed, countPovKind } = require('../engine/pov');
const layoutStructure = require('./layoutStructure');

const OUR_LEXICAL_NOUNS = Object.freeze([
  '나라', '학교', '사회', '집', '말', '몸', '지역', '동네', '회사', '팀', '반', '가족'
]);
const QUOTED_SPAN_RE = /“[^”\n]{2,}”|‘[^’\n]{2,}’|"[^"\n]{2,}"|'[^'\n]{2,}'|「[^」\n]{2,}」|『[^』\n]{2,}』|《[^》\n]{2,}》|〈[^〉\n]{2,}〉/gu;

function buildVoiceProfile(source, { documentProfile = 'unknown', safetyProfiles = [], formatProfile = null, mode = '' } = {}) {
  const context = normalizeDocumentContext(documentProfile, safetyProfiles, formatProfile);
  const profileName = context.profile;
  const text = String(source || '');
  const sentences = splitSentences(text, { preserveLines: profileName === 'creative' });
  const paragraphs = layoutStructure.splitReadableParagraphs(text);
  const sentenceLengths = sentences.map(value => normalizeCompact(value).length).filter(value => value >= 3);
  const paragraphLengths = paragraphs.map(value => normalizeCompact(value).length).filter(Boolean);
  const compactLength = normalizeCompact(text).length;
  const punctuationCount = (text.match(/[.!?。？！]/gu) || []).length;
  const punctuationSparse = profileName !== 'creative'
    && compactLength >= 240
    && sentenceLengths.length <= 2
    && punctuationCount <= 2;
  const sparseSplitTarget = punctuationSparse ? sparseSentenceTargets(compactLength) : null;
  const povSeed = computePovSeed(text);
  const firstSingular = povSeed.fp_singular;
  const firstPlural = povSeed.fp_plural;
  const endings = endingHistogram(sentences);
  const lineBreakSensitive = profileName === 'creative' && isLineBreakSensitive(text);
  const layout = layoutStructure.analyzeLineStructure(text);
  const lineBoundaryPolicy = linePolicyFor(text, context, layout, { lineBreakSensitive, mode });
  const lineStructureSensitive = lineBoundaryPolicy !== 'none';
  return {
    version: 1,
    documentProfile: profileName,
    compactLength,
    safetyProfiles: context.safetyProfiles,
    formatProfile: context.formatProfile,
    register: detectRegister(text),
    pov: {
      firstSingular,
      firstPlural,
      type: firstSingular > 0 ? 'individual' : (firstPlural > 0 ? 'collective' : 'impersonal')
    },
    sentence: {
      ...distribution(sentenceLengths),
      lengthSequence: sentenceLengths.length <= 20 ? sentenceLengths : [],
      punctuationCount,
      punctuationSparse,
      sparseSplitTarget
    },
    paragraph: distribution(paragraphLengths),
    endings,
    directQuoteCount: directQuoteContents(text).length,
    listItemCount: (text.match(/^\s*(?:[-*+•▪◦·●○■□◆◇▶▷※]|\d+[.)]|[가-힣][.)]|[①-⑳])\s+.+$/gmu) || []).length,
    headingCount: (text.match(/^\s*(?:(?:제\s*\d+\s*(?:장|절|항|조))(?:\s+\S.*)?|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?\s*\S.*|\d+(?:\.\d+){0,3}[.)]?\s+\S.*|(?:서론|본론|결론|초록|요약|참고\s*문헌|부록))\s*$/gmu) || []).length,
    questionnaireQuestionCount: countQuestionnaireQuestions(text),
    lineCount: lineCount(text),
    lineBreakSensitive,
    lineStructureSensitive,
    lineBoundaryPolicy,
    layout
  };
}

function voicePromptBlock(profile) {
  if (!profile) return '';
  const avgSentence = Math.round(profile.sentence?.mean || 0);
  const avgParagraph = Math.round(profile.paragraph?.mean || 0);
  const sentenceCount = profile.sentence?.count || 0;
  const minSentence = Math.round(profile.sentence?.min || 0);
  const maxSentence = Math.round(profile.sentence?.max || 0);
  const sentenceSequence = Array.isArray(profile.sentence?.lengthSequence) ? profile.sentence.lengthSequence : [];
  const sparseSplitTarget = profile.sentence?.sparseSplitTarget || null;
  const povAnchors = [];
  if ((profile.pov?.firstSingular || 0) > 0) povAnchors.push('1인칭 단수(나는·저는·제가 등)');
  if ((profile.pov?.firstPlural || 0) > 0) povAnchors.push('1인칭 복수(우리·저희 등)');
  const povAnchorInstruction = povAnchors.length
    ? `원문에 있는 ${povAnchors.join('와 ')} 표현은 종류별로 최소 한 곳 남긴다. 자연스러운 주어 생략을 이유로 화자를 완전히 지우지 않는다.`
    : '원문에 없는 나는·저는·제가·우리·저희 같은 1인칭 화자를 새로 만들지 않는다.';
  const sparseRunOnInstruction = profile.sentence?.punctuationSparse && sparseSplitTarget
    ? [
        `원문은 구두점이 거의 없이 이어진 초안이다. 의미 단위에 따라 약 ${sparseSplitTarget.minCount}~${sparseSplitTarget.maxCount}문장으로 나눈다.`,
        `문장을 비슷한 길이로 자르지 말고 ${sparseSplitTarget.shortMax}자 이하의 짧은 문장과 ${sparseSplitTarget.longMin}자 이상의 긴 문장을 각각 최소 한 개 남긴다.`,
        '짧은 문장은 원문에 이미 있던 완전한 절을 독립시켜 만들고, 바로 앞 문장을 요약·평가·되풀이하는 새 덧문장을 만들지 않는다.',
        '길이 차이를 만들기 위해 원문 내용을 삭제하거나 서로 다른 주장을 억지로 합치지 않는다.'
      ].join(' ')
    : '';
  const rhythmInstruction = sentenceCount >= 3
    ? '문법적으로 성립하는 원문 문장은 길이를 고르게 만들 목적으로 합치거나 쪼개지 않는다. 특히 원문의 짧은 문장과 긴 문장 차이를 남긴다.'
    : (sparseRunOnInstruction || (maxSentence >= 90
        ? '구두점 누락이나 비문 때문에 긴 문장을 나눠야 한다면 같은 길이로 균등 분할하지 말고, 실제 의미 단위에 따라 짧고 긴 문장이 섞이게 한다.'
        : '원문의 적은 문장 수와 길이 차이를 불필요하게 바꾸지 않는다.'));
  return [
    '[원문 화자·리듬 계약]',
    `화자=${profile.pov?.type || 'impersonal'}, 종결체=${profile.register || 'mixed'}`,
    `문장 수≈${sentenceCount}, 길이 범위≈${minSentence}~${maxSentence}자, 평균≈${avgSentence}자, 변동계수≈${round(profile.sentence?.cv || 0, 2)}; 문단 길이 평균≈${avgParagraph}자`,
    sentenceSequence.length >= 3
      ? `원문 문장별 길이 순서≈${sentenceSequence.join('→')}자. 짧은 문장을 늘리거나 긴 문장을 줄여 중간 길이로 맞추지 않는다.`
      : '',
    `직접 인용=${profile.directQuoteCount || 0}, 목록=${profile.listItemCount || 0}, 제목=${profile.headingCount || 0}`,
    '원문의 인칭과 종결체를 유지한다. 평균 길이만 맞추지 말고 문장·문단 길이 분포를 보존한다.',
    povAnchorInstruction,
    rhythmInstruction,
    profile.lineBoundaryPolicy === 'all'
      ? `원문의 행 수=${profile.lineCount || 1}다. 각 행의 역할과 줄바꿈 위치를 그대로 유지한다.`
      : (profile.lineBoundaryPolicy === 'structural'
          ? '제목·항목 라벨·표·목록과 완결된 문단 행의 경계를 유지한다. 단순 자동 줄바꿈만 합칠 수 있다.'
          : ''),
    profile.lineBreakSensitive ? '이 글은 줄바꿈 자체가 구조다. 행을 합치거나 새로 나누지 않는다.' : ''
  ].filter(Boolean).join('\n');
}

function auditVoice(sourceProfile, output, {
  documentProfile = 'unknown',
  mode = '',
  sourceText = '',
  layoutPolicy = '',
  layoutTargetCount = 0,
  formattingParagraphRemovalCount = 0,
  formattingSentenceSpaceRepairCount = 0
} = {}) {
  const context = normalizeDocumentContext(
    documentProfile,
    sourceProfile?.safetyProfiles || [],
    sourceProfile?.formatProfile || null
  );
  const current = buildVoiceProfile(output, { documentProfile: context, mode });
  const warnings = [];
  if ((sourceProfile?.pov?.firstSingular || 0) === 0 && current.pov.firstSingular > 0) {
    warnings.push(warning('speaker_injected', '원문에 없던 1인칭 단수 화자가 추가됐을 수 있어요.'));
  }
  const sourcePluralSignature = sourceText ? pluralSpeakerSignature(sourceText) : null;
  const currentPluralSignature = sourceText ? pluralSpeakerSignature(output) : null;
  const pluralInjected = sourcePluralSignature && currentPluralSignature
    ? (currentPluralSignature.explicit > 0 && sourcePluralSignature.explicit === 0)
      || (signatureTotal(currentPluralSignature) > 0 && signatureTotal(sourcePluralSignature) === 0)
    : (sourceProfile?.pov?.firstPlural || 0) === 0 && current.pov.firstPlural > 0;
  const pluralRemoved = sourcePluralSignature && currentPluralSignature
    ? signatureTotal(sourcePluralSignature) > 0 && signatureTotal(currentPluralSignature) === 0
    : (sourceProfile?.pov?.firstPlural || 0) > 0 && current.pov.firstPlural === 0;
  if (pluralInjected) {
    warnings.push(warning('speaker_injected', '원문에 없던 1인칭 복수 화자가 추가됐을 수 있어요.'));
  }
  if ((sourceProfile?.pov?.firstSingular || 0) > 0 && current.pov.firstSingular === 0) {
    warnings.push(warning('speaker_removed', '원문의 1인칭 화자가 결과에서 사라졌을 수 있어요.'));
  }
  if (pluralRemoved) {
    warnings.push(warning('speaker_removed', '원문의 집단 화자가 결과에서 사라졌을 수 있어요.'));
  }
  if (sourceProfile?.register && current.register !== sourceProfile.register && !['mixed'].includes(sourceProfile.register)) {
    warnings.push(warning('register_shift', `원문 종결체(${sourceProfile.register})가 결과(${current.register})에서 달라졌을 수 있어요.`));
  }
  const directQuoteIntegrity = sourceText
    ? auditDirectQuoteIntegrity(sourceText, output)
    : null;
  if (directQuoteIntegrity) {
    if (directQuoteIntegrity.countChanged && !directQuoteIntegrity.punctuationOnlyChange) {
      warnings.push(warning('quote_count_changed', '직접 인용의 개수가 달라졌을 수 있어요.'));
    } else if (directQuoteIntegrity.contentChanged) {
      warnings.push(warning('quote_content_changed', '직접 인용의 내용이나 순서가 원문과 달라졌을 수 있어요.'));
    }
  } else if ((sourceProfile?.directQuoteCount || 0) !== current.directQuoteCount) {
    warnings.push(warning('quote_count_changed', '직접 인용의 개수가 달라졌을 수 있어요.'));
  }
  const protectedProfiles = new Set([context.profile, ...context.safetyProfiles]);
  const listStructureLocked = mode === 'polish'
    || context.formatProfile?.flags?.includes?.('questionnaire')
    || context.formatProfile?.flags?.includes?.('list_heavy')
    || [...protectedProfiles].some(profile => [
      'academic_paper',
      'report_assignment',
      'student_record_teacher',
      'student_self_assessment',
      'resume_application'
    ].includes(profile));
  if (listStructureLocked && current.listItemCount !== (sourceProfile?.listItemCount || 0)) {
    warnings.push(warning('list_structure_changed', '원문의 목록 항목 수나 구조가 달라졌을 수 있어요.'));
  } else if ((sourceProfile?.listItemCount || 0) > 0 && current.listItemCount < sourceProfile.listItemCount) {
    warnings.push(warning('list_structure_changed', '목록 항목 일부가 합쳐지거나 누락됐을 수 있어요.'));
  }
  if (current.headingCount !== (sourceProfile?.headingCount || 0)) {
    warnings.push(warning('heading_structure_changed', '제목이나 절 구조의 개수가 달라졌을 수 있어요.'));
  }
  if (context.formatProfile?.flags?.includes?.('questionnaire')
      && current.questionnaireQuestionCount !== (sourceProfile?.questionnaireQuestionCount || 0)) {
    warnings.push(warning('questionnaire_structure_changed', '질문 번호나 질문·답변 경계가 달라졌을 수 있어요.'));
  }
  const sourceParagraphs = sourceProfile?.paragraph?.count || 0;
  const currentParagraphs = current.paragraph?.count || 0;
  const paragraphLimit = paragraphExpansionLimit(sourceParagraphs, sourceProfile?.compactLength || 0);
  const readablePolish = mode === 'polish' && layoutPolicy === 'readable_polish';
  const layoutAuthorizedParagraphs = [
    'semantic_prose_roles',
    'source_paragraph_roles',
    'source_readable_units',
    'readability_cap',
    'bounded_sensitive_report',
    'bounded_source_paragraphs',
    'structural_visual_gaps',
    'creative_preserve'
  ].includes(layoutPolicy)
    && Number(layoutTargetCount) >= 1;
  const formattingRemovalCount = Math.max(0, Number(formattingParagraphRemovalCount) || 0);
  const formattingMinimum = sourceParagraphs > 0
    ? Math.max(1, sourceParagraphs - formattingRemovalCount)
    : 0;
  const formattingMaximum = Math.max(
    formattingMinimum,
    (Number(layoutTargetCount) || sourceParagraphs) - formattingRemovalCount
  );
  const paragraphChanged = layoutAuthorizedParagraphs
    ? currentParagraphs !== Number(layoutTargetCount)
    : mode === 'polish'
    ? (readablePolish
        ? currentParagraphs < formattingMinimum || currentParagraphs > formattingMaximum
        : currentParagraphs !== formattingMinimum)
    : sourceParagraphs === 1
      ? currentParagraphs > paragraphLimit
      : sourceParagraphs >= 2 && (currentParagraphs < Math.min(formattingMinimum, sourceParagraphs * 0.6)
        || currentParagraphs > sourceParagraphs * 1.5);
  if (paragraphChanged) {
    warnings.push(warning('paragraph_structure_changed', '문단 수나 문단 구성이 원문과 크게 달라졌을 수 있어요.'));
  }
  const sentenceSourceProfile = sourceText && Number(formattingSentenceSpaceRepairCount) > 0
    ? buildVoiceProfile(normalizeSentenceSpacingForAudit(sourceText), { documentProfile: context, mode })
    : sourceProfile;
  const sourceSentence = sentenceSourceProfile?.sentence || sourceProfile?.sentence || {};
  const sparseTarget = sourceSentence.sparseSplitTarget || null;
  const sparseDistributionShift = sourceSentence.punctuationSparse === true
    && sparseTarget
    && ((current.sentence?.count || 0) < sparseTarget.minCount
      || (current.sentence?.count || 0) > sparseTarget.maxCount
      || (current.sentence?.min || 0) > sparseTarget.shortMax
      || (current.sentence?.max || 0) < sparseTarget.longMin);
  const existingDistribution = sentenceDistributionShift(sourceSentence, current.sentence);
  if (sparseDistributionShift || existingDistribution.shift) {
    warnings.push(warning('sentence_distribution_shift', '원문의 짧고 긴 문장 차이가 결과에서 지나치게 평탄해졌을 수 있어요.'));
  }
  const sourceLayout = sourceProfile?.layout || {};
  const currentLayout = current.layout || {};
  if ((sourceLayout.titleLineCount || 0) > (currentLayout.titleLineCount || 0)) {
    warnings.push(warning('title_line_merged', '원문의 제목 줄이 본문에 붙었을 수 있어요.'));
  }
  if ((sourceLayout.labelLineCount || 0) > (currentLayout.labelLineCount || 0)
      || (sourceLayout.tableLineCount || 0) > (currentLayout.tableLineCount || 0)
      || (sourceLayout.listLineCount || 0) > (currentLayout.listLineCount || 0)) {
    warnings.push(warning('structural_line_loss', '원문의 항목 라벨·표·목록 행 일부가 합쳐졌을 수 있어요.'));
  }
  const sourceBoundaryCount = Math.max(
    Number(sourceLayout.semanticBoundaryCount) || 0,
    Number(sourceLayout.preservedBoundaryCount) || 0
  );
  const currentBoundaryCount = Math.max(
    Number(currentLayout.semanticBoundaryCount) || 0,
    Number(currentLayout.preservedBoundaryCount) || 0
  );
  const boundaryCollapsed = sourceBoundaryCount >= 3
    && currentBoundaryCount < Math.ceil(sourceBoundaryCount * 0.6);
  if (sourceProfile?.lineBoundaryPolicy === 'all' && lineCount(output) !== sourceProfile.lineCount) {
    warnings.push(sourceProfile.lineBreakSensitive
      ? warning('creative_line_structure', '창작문의 행 구조를 확인해야 해요.')
      : warning('line_structure_changed', '원문의 제목·항목 행 또는 줄바꿈 구조가 달라졌을 수 있어요.'));
  } else if (boundaryCollapsed) {
    warnings.push(warning('line_structure_changed', '원문의 의미 있는 문단·행 경계가 지나치게 합쳐졌을 수 있어요.'));
  }
  if (context.profile !== 'creative' && (currentLayout.readability?.overlongCount || 0) > 0) {
    warnings.push(warning('paragraph_readability', '한 문단이 지나치게 길어 읽기 어려울 수 있어요.'));
  }
  return {
    profile: current,
    directQuoteIntegrity,
    distributionDelta: {
      sentenceCountRatio: ratio(current.sentence.count, sourceProfile?.sentence?.count),
      paragraphCountRatio: ratio(current.paragraph.count, sourceProfile?.paragraph?.count),
      sentenceCvDelta: round((current.sentence.cv || 0) - (sourceProfile?.sentence?.cv || 0), 4),
      paragraphCvDelta: round((current.paragraph.cv || 0) - (sourceProfile?.paragraph?.cv || 0), 4)
    },
    warnings,
    pass: warnings.length === 0
  };
}

function sentenceDistributionShift(sourceSentence, currentSentence) {
  const before = sourceSentence || {};
  const after = currentSentence || {};
  const empty = {
    shift: false,
    cvLoss: 0,
    spreadLoss: 0,
    beforeSpread: relativeSentenceSpread(before),
    afterSpread: relativeSentenceSpread(after),
    detail: ''
  };
  if ((before.count || 0) < 4 || (before.count || 0) > 20 || (after.count || 0) < 4) return empty;
  if (isLocalizedMinimalLengthChange(before.lengthSequence, after.lengthSequence)) return empty;
  const cvLoss = (Number(before.cv) || 0) - (Number(after.cv) || 0);
  const beforeSpread = relativeSentenceSpread(before);
  const afterSpread = relativeSentenceSpread(after);
  const spreadLoss = beforeSpread - afterSpread;
  const shortSequence = before.count <= 6;
  const cvFloor = shortSequence ? 0.10 : 0.15;
  const cvTolerance = Math.max(shortSequence ? 0.004 : 0.015, (Number(before.cv) || 0) * (shortSequence ? 0.025 : 0.08));
  const spreadFloor = shortSequence ? 0.25 : 0.45;
  const spreadTolerance = Math.max(shortSequence ? 0.02 : 0.06, beforeSpread * (shortSequence ? 0.04 : 0.1));
  const shift = ((Number(before.cv) || 0) >= cvFloor && cvLoss > cvTolerance)
    || (beforeSpread >= spreadFloor && spreadLoss > spreadTolerance);
  return {
    shift,
    cvLoss,
    spreadLoss,
    beforeSpread,
    afterSpread,
    detail: shift
      ? `원문 장단문 분포가 평탄해짐: CV ${round(before.cv || 0, 3)}→${round(after.cv || 0, 3)}, 상대 범위 ${round(beforeSpread, 3)}→${round(afterSpread, 3)}`
      : ''
  };
}

function isLocalizedMinimalLengthChange(sourceSequence, outputSequence) {
  if (!Array.isArray(sourceSequence) || !Array.isArray(outputSequence)
      || sourceSequence.length < 4 || sourceSequence.length !== outputSequence.length) return false;
  const changed = [];
  for (let index = 0; index < sourceSequence.length; index += 1) {
    const before = Number(sourceSequence[index]) || 0;
    const after = Number(outputSequence[index]) || 0;
    if (before !== after) changed.push({ before, after });
  }
  if (changed.length !== 1) return false;
  const { before, after } = changed[0];
  return Math.abs(after - before) <= Math.max(4, Math.ceil(before * 0.08));
}

function relativeSentenceSpread(sentence) {
  const average = Number(sentence?.mean) || 0;
  return average ? ((Number(sentence?.max) || 0) - (Number(sentence?.min) || 0)) / average : 0;
}

function endingHistogram(sentences) {
  return sharedEndingHistogram(sentences);
}

function distribution(values) {
  const avg = mean(values);
  const sd = standardDeviation(values);
  return {
    count: values.length,
    mean: round(avg, 3),
    sd: round(sd, 3),
    cv: round(avg ? sd / avg : 0, 4),
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0
  };
}

function sparseSentenceTargets(compactLength) {
  const targetCount = Math.max(4, Math.min(10, Math.round((Number(compactLength) || 0) / 60)));
  const averageLength = (Number(compactLength) || 0) / targetCount;
  return {
    minCount: Math.max(4, targetCount - 1),
    maxCount: Math.min(10, targetCount + 1),
    shortMax: Math.max(20, Math.round(averageLength * 0.55)),
    longMin: Math.min(120, Math.round(averageLength * 1.45))
  };
}

function isLineBreakSensitive(text) {
  const lines = String(text || '').split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  const short = lines.filter(line => line.length <= 40).length;
  return short / lines.length >= 0.6;
}

function linePolicyFor(text, documentProfile, layout, { lineBreakSensitive = false, mode = '' } = {}) {
  const context = normalizeDocumentContext(documentProfile);
  const flags = new Set(context.formatProfile?.flags || []);
  if (lineBreakSensitive || flags.has('line_sensitive') || flags.has('questionnaire')) return 'all';
  const profiles = new Set([context.profile, ...context.safetyProfiles]);
  const sensitiveProfile = [...profiles].some(profile => [
    'academic_paper',
    'report_assignment',
    'student_record_teacher',
    'student_self_assessment',
    'resume_application',
    'mail_notice'
  ].includes(profile));
  const structuredFormat = ['table_heavy', 'list_heavy', 'sectioned', 'label_heavy']
    .some(flag => flags.has(flag));
  const meaningfulBoundaries = Number(layout?.preservedBoundaryCount) || 0;
  const structuralLines = Number(layout?.structuralLineCount) || 0;
  const polishStructure = String(mode || '') === 'polish' && (meaningfulBoundaries > 0 || structuralLines > 0);
  if (meaningfulBoundaries >= 2 || structuredFormat || polishStructure) return 'structural';
  if (sensitiveProfile && (meaningfulBoundaries > 0 || structuralLines > 0)) return 'structural';
  return 'none';
}

function normalizeDocumentContext(documentProfile, safetyProfiles = [], formatProfile = null) {
  if (documentProfile && typeof documentProfile === 'object') {
    return {
      profile: String(documentProfile.profile || documentProfile.contentGenre || 'unknown'),
      safetyProfiles: uniqueStrings(documentProfile.safetyProfiles || safetyProfiles),
      formatProfile: documentProfile.formatProfile || formatProfile || null
    };
  }
  return {
    profile: String(documentProfile || 'unknown'),
    safetyProfiles: uniqueStrings(safetyProfiles),
    formatProfile: formatProfile || null
  };
}

function countQuestionnaireQuestions(text) {
  return String(text || '').split(/\r?\n/u).filter(line => {
    const value = line.trim();
    return /^(?:\d{1,2}[.)]|[①②③④⑤⑥⑦⑧⑨⑩])\s+\S/u.test(value)
      && (/[?？]\s*$/u.test(value)
        || /(?:무엇|어떻게|어떠했|왜|어떤|얼마나|서술|작성|설명|기술)/u.test(value));
  }).length;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '').trim()).filter(Boolean))];
}

function paragraphExpansionLimit(sourceCount, compactLength = 0) {
  const count = Math.max(0, Number(sourceCount) || 0);
  if (!count) return 0;
  if (count > 1) return Math.max(count + 1, Math.ceil(count * 1.5));
  const length = Math.max(0, Number(compactLength) || 0);
  if (length <= 1000) return 2;
  return Math.min(12, Math.max(3, Math.ceil(length / 350)));
}

function pluralSpeakerSignature(value) {
  const lexical = {};
  const nounPattern = OUR_LEXICAL_NOUNS.join('|');
  const particlePattern = '(?:에서는|에게서|으로|부터|까지|한테|에서|에도|에는|에게|은|는|이|가|을|를|의|에|로|와|과|도|만)?';
  const pattern = new RegExp(
    `(^|[^가-힣A-Za-z0-9_])우리[ \\t]*(${nounPattern})(?=${particlePattern}(?:$|[^가-힣A-Za-z0-9_]))`,
    'gu'
  );
  const masked = String(value || '').replace(pattern, (_match, prefix, noun) => {
    lexical[noun] = (lexical[noun] || 0) + 1;
    return `${prefix}대상`;
  });
  return {
    explicit: countPovKind(masked, 'firstPlural'),
    lexical
  };
}

function signatureTotal(signature) {
  return Number(signature?.explicit || 0)
    + Object.values(signature?.lexical || {}).reduce((sum, count) => sum + Number(count || 0), 0);
}

function isQuotePunctuationOnlyChange(source, output) {
  if (!source) return false;
  const sourceQuotes = directQuoteContents(source);
  const outputQuotes = directQuoteContents(output);
  if (!sourceQuotes.length && !outputQuotes.length) return false;
  const sourceEvidence = normalizeQuoteEvidence(source);
  const outputEvidence = normalizeQuoteEvidence(output);
  return sourceQuotes.every(content => outputEvidence.includes(normalizeQuoteEvidence(content)))
    && outputQuotes.every(content => sourceEvidence.includes(normalizeQuoteEvidence(content)));
}

function auditDirectQuoteIntegrity(source, output) {
  const sourceQuotes = directQuoteContents(source);
  const outputQuotes = directQuoteContents(output);
  const countChanged = sourceQuotes.length !== outputQuotes.length;
  const punctuationOnlyChange = countChanged && isQuotePunctuationOnlyChange(source, output);
  const changedOrdinals = [];
  if (!countChanged) {
    for (let index = 0; index < sourceQuotes.length; index += 1) {
      if (normalizeExactQuote(sourceQuotes[index]) !== normalizeExactQuote(outputQuotes[index])) {
        changedOrdinals.push(index + 1);
      }
    }
  }
  return {
    version: 1,
    pass: (!countChanged || punctuationOnlyChange) && changedOrdinals.length === 0,
    sourceCount: sourceQuotes.length,
    outputCount: outputQuotes.length,
    countChanged,
    punctuationOnlyChange,
    contentChanged: changedOrdinals.length > 0,
    changedCount: changedOrdinals.length,
    changedOrdinals
  };
}

/**
 * 직접 인용의 개수와 위치가 그대로일 때만 인용 내부를 원문으로 복원한다.
 * 개수가 달라진 결과를 순서대로 끼워 맞추면 주변 문맥과 잘못 결합할 수
 * 있으므로 그 경우에는 자동 수리하지 않고 감사 경고로 남긴다.
 */
function restoreDirectQuoteContents(source, output) {
  const before = String(output || '');
  const auditBefore = auditDirectQuoteIntegrity(source, before);
  if (auditBefore.countChanged || !auditBefore.contentChanged) {
    return {
      text: before,
      applied: false,
      restoredCount: 0,
      reason: auditBefore.countChanged ? 'quote_count_changed' : 'quote_content_unchanged',
      auditBefore,
      auditAfter: auditBefore
    };
  }
  const sourceQuotes = directQuoteContents(source);
  let quoteIndex = 0;
  const repairedText = before.replace(new RegExp(QUOTED_SPAN_RE.source, QUOTED_SPAN_RE.flags), match => {
    const content = match.slice(1, -1);
    const sourceContent = sourceQuotes[quoteIndex] ?? content;
    quoteIndex += 1;
    return `${match.slice(0, 1)}${sourceContent}${match.at(-1)}`;
  });
  const auditAfter = auditDirectQuoteIntegrity(source, repairedText);
  const applied = repairedText !== before && auditAfter.pass;
  return {
    // 검증에 실패한 중간 문자열은 절대 호출자에게 돌려주지 않는다.
    // 과거 구현은 applied=false여도 잘못 조립한 문자열을 함께 반환해,
    // 호출자가 필드를 잘못 사용하면 인용문이 중복될 여지가 있었다.
    text: applied ? repairedText : before,
    applied,
    restoredCount: applied ? auditBefore.changedCount : 0,
    reason: auditAfter.pass ? 'restored' : 'post_restore_validation_failed',
    auditBefore,
    auditAfter
  };
}

function directQuoteContents(value) {
  const contents = [];
  for (const match of String(value || '').matchAll(new RegExp(QUOTED_SPAN_RE.source, QUOTED_SPAN_RE.flags))) {
    contents.push(match[0].slice(1, -1));
  }
  return contents;
}

function normalizeExactQuote(value) {
  return String(value || '').normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
}

function normalizeQuoteEvidence(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[^\p{L}\p{N}]/gu, '');
}

function normalizeSentenceSpacingForAudit(value) {
  return String(value || '').replace(/([.!?。！？])(?=[가-힣])/gu, '$1 ');
}

function safeMatches(text, pattern) {
  pattern.lastIndex = 0;
  return (String(text || '').match(pattern) || []).length;
}

function warning(code, message) {
  return { code, severity: 'warning', message };
}

function round(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function lineCount(value) {
  return String(value || '').split(/\r?\n/u).length;
}

function ratio(current, source) {
  const base = Number(source) || 0;
  return round(base ? (Number(current) || 0) / base : ((Number(current) || 0) ? 0 : 1), 4);
}

module.exports = {
  buildVoiceProfile,
  voicePromptBlock,
  auditVoice,
  auditDirectQuoteIntegrity,
  restoreDirectQuoteContents,
  sentenceDistributionShift,
  paragraphExpansionLimit
};
