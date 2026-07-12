'use strict';

const { splitSentences, normalizeCompact, mean, standardDeviation, koreanEnd } = require('../engine/koreanText');
const { detectRegister } = require('../engine/contract');

const POV_PATTERNS = Object.freeze({
  firstSingular: /(?:^|[^가-힣A-Za-z0-9_])(?:나는|내가|나의|저는|제가|저의|저에게)(?=$|[^가-힣A-Za-z0-9_])/gu,
  firstPlural: /(?:^|[^가-힣A-Za-z0-9_])(?:우리는|우리가|우리의|저희는|저희가|저희의)(?=$|[^가-힣A-Za-z0-9_])/gu
});

function buildVoiceProfile(source, { documentProfile = 'unknown', safetyProfiles = [], formatProfile = null } = {}) {
  const context = normalizeDocumentContext(documentProfile, safetyProfiles, formatProfile);
  const profileName = context.profile;
  const text = String(source || '');
  const sentences = splitSentences(text, { preserveLines: profileName === 'creative' });
  const paragraphs = text.split(/\n{2,}/u).map(value => value.trim()).filter(Boolean);
  const sentenceLengths = sentences.map(value => normalizeCompact(value).length).filter(value => value >= 3);
  const paragraphLengths = paragraphs.map(value => normalizeCompact(value).length).filter(Boolean);
  const compactLength = normalizeCompact(text).length;
  const punctuationCount = (text.match(/[.!?。？！]/gu) || []).length;
  const punctuationSparse = profileName !== 'creative'
    && compactLength >= 240
    && sentenceLengths.length <= 2
    && punctuationCount <= 2;
  const sparseSplitTarget = punctuationSparse ? sparseSentenceTargets(compactLength) : null;
  const firstSingular = safeMatches(text, POV_PATTERNS.firstSingular);
  const firstPlural = safeMatches(text, POV_PATTERNS.firstPlural);
  const endings = endingHistogram(sentences);
  const lineBreakSensitive = profileName === 'creative' && isLineBreakSensitive(text);
  const lineStructureSensitive = lineBreakSensitive || isStructuredLineSensitive(text, context);
  return {
    version: 1,
    documentProfile: profileName,
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
    directQuoteCount: (text.match(/[“"][^”"\n]{2,}[”"]/gu) || []).length,
    listItemCount: (text.match(/^\s*(?:[-*•]|\d+[.)]|[가-힣][.)])\s+.+$/gmu) || []).length,
    headingCount: (text.match(/^\s*(?:(?:제\s*\d+\s*(?:장|절|항))(?:\s+\S.*)?|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?\s*\S.*|\d+(?:\.\d+){0,3}[.)]?\s+\S.*|(?:서론|본론|결론|초록|요약|참고\s*문헌|부록))\s*$/gmu) || []).length,
    questionnaireQuestionCount: countQuestionnaireQuestions(text),
    lineCount: lineCount(text),
    lineBreakSensitive,
    lineStructureSensitive
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
    rhythmInstruction,
    profile.lineStructureSensitive ? `원문의 행 수=${profile.lineCount || 1}다. 각 행의 역할과 줄바꿈 위치를 그대로 유지한다.` : '',
    profile.lineBreakSensitive ? '이 글은 줄바꿈 자체가 구조다. 행을 합치거나 새로 나누지 않는다.' : ''
  ].filter(Boolean).join('\n');
}

function auditVoice(sourceProfile, output, { documentProfile = 'unknown', mode = '' } = {}) {
  const context = normalizeDocumentContext(
    documentProfile,
    sourceProfile?.safetyProfiles || [],
    sourceProfile?.formatProfile || null
  );
  const current = buildVoiceProfile(output, { documentProfile: context });
  const warnings = [];
  if ((sourceProfile?.pov?.firstSingular || 0) === 0 && current.pov.firstSingular > 0) {
    warnings.push(warning('speaker_injected', '원문에 없던 1인칭 단수 화자가 추가됐을 수 있어요.'));
  }
  if ((sourceProfile?.pov?.firstPlural || 0) === 0 && current.pov.firstPlural > 0) {
    warnings.push(warning('speaker_injected', '원문에 없던 1인칭 복수 화자가 추가됐을 수 있어요.'));
  }
  if ((sourceProfile?.pov?.firstSingular || 0) > 0 && current.pov.firstSingular === 0) {
    warnings.push(warning('speaker_removed', '원문의 1인칭 화자가 결과에서 사라졌을 수 있어요.'));
  }
  if ((sourceProfile?.pov?.firstPlural || 0) > 0 && current.pov.firstPlural === 0) {
    warnings.push(warning('speaker_removed', '원문의 집단 화자가 결과에서 사라졌을 수 있어요.'));
  }
  if (sourceProfile?.register && current.register !== sourceProfile.register && !['mixed'].includes(sourceProfile.register)) {
    warnings.push(warning('register_shift', `원문 종결체(${sourceProfile.register})가 결과(${current.register})에서 달라졌을 수 있어요.`));
  }
  if ((sourceProfile?.directQuoteCount || 0) !== current.directQuoteCount) {
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
  const paragraphChanged = mode === 'polish'
    ? currentParagraphs !== sourceParagraphs
    : sourceParagraphs >= 2 && (currentParagraphs < sourceParagraphs * 0.6 || currentParagraphs > sourceParagraphs * 1.6);
  if (paragraphChanged) {
    warnings.push(warning('paragraph_structure_changed', '문단 수나 문단 구성이 원문과 크게 달라졌을 수 있어요.'));
  }
  const sparseTarget = sourceProfile?.sentence?.sparseSplitTarget || null;
  const sparseDistributionShift = sourceProfile?.sentence?.punctuationSparse === true
    && sparseTarget
    && ((current.sentence?.count || 0) < sparseTarget.minCount
      || (current.sentence?.count || 0) > sparseTarget.maxCount
      || (current.sentence?.min || 0) > sparseTarget.shortMax
      || (current.sentence?.max || 0) < sparseTarget.longMin);
  const existingDistribution = sentenceDistributionShift(sourceProfile?.sentence, current.sentence);
  if (sparseDistributionShift || existingDistribution.shift) {
    warnings.push(warning('sentence_distribution_shift', '원문의 짧고 긴 문장 차이가 결과에서 지나치게 평탄해졌을 수 있어요.'));
  }
  if (sourceProfile?.lineStructureSensitive && lineCount(output) !== sourceProfile.lineCount) {
    warnings.push(sourceProfile.lineBreakSensitive
      ? warning('creative_line_structure', '창작문의 행 구조를 확인해야 해요.')
      : warning('line_structure_changed', '원문의 제목·항목 행 또는 줄바꿈 구조가 달라졌을 수 있어요.'));
  }
  return {
    profile: current,
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
  const out = { plain: 0, polite: 0, haeyo: 0, nominal: 0, other: 0 };
  for (const sentence of sentences) {
    const s = sentence.replace(/[.!?…。！？"'”’」』】)\]]+$/gu, '').trim();
    if (koreanEnd('(?:습니다|ㅂ니다|습니까|합니다|됩니다)', 'u').test(s)) out.polite += 1;
    else if (koreanEnd('(?:요|죠|네요|거든요|잖아요)', 'u').test(s)) out.haeyo += 1;
    else if (koreanEnd('(?:다|한다|된다|였다|었다|있다|없다|않다)', 'u').test(s)) out.plain += 1;
    else if (koreanEnd('(?:함|됨|임|음)', 'u').test(s)) out.nominal += 1;
    else out.other += 1;
  }
  return out;
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

function isStructuredLineSensitive(text, documentProfile) {
  const context = normalizeDocumentContext(documentProfile);
  const profiles = new Set([context.profile, ...context.safetyProfiles]);
  const sensitiveProfile = [...profiles].some(profile => [
    'student_record_teacher',
    'student_self_assessment',
    'resume_application',
    'mail_notice'
  ].includes(profile));
  if (!sensitiveProfile && !context.formatProfile?.flags?.includes?.('questionnaire')) return false;
  const lines = String(text || '').split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 30) return false;
  return lines.some(line => !/[.!?。？！]$/u.test(line));
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

module.exports = { POV_PATTERNS, buildVoiceProfile, voicePromptBlock, auditVoice, sentenceDistributionShift };
