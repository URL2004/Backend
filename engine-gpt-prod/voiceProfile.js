'use strict';

const { splitSentences, normalizeCompact, mean, standardDeviation, koreanEnd } = require('../engine/koreanText');
const { detectRegister } = require('../engine/contract');

const POV_PATTERNS = Object.freeze({
  firstSingular: /(?:^|[^가-힣A-Za-z0-9_])(?:나는|내가|나의|저는|제가|저의|저에게)(?=$|[^가-힣A-Za-z0-9_])/gu,
  firstPlural: /(?:^|[^가-힣A-Za-z0-9_])(?:우리는|우리가|우리의|저희는|저희가|저희의)(?=$|[^가-힣A-Za-z0-9_])/gu
});

function buildVoiceProfile(source, { documentProfile = 'unknown' } = {}) {
  const text = String(source || '');
  const sentences = splitSentences(text, { preserveLines: documentProfile === 'creative' });
  const paragraphs = text.split(/\n{2,}/u).map(value => value.trim()).filter(Boolean);
  const sentenceLengths = sentences.map(value => normalizeCompact(value).length).filter(Boolean);
  const paragraphLengths = paragraphs.map(value => normalizeCompact(value).length).filter(Boolean);
  const firstSingular = safeMatches(text, POV_PATTERNS.firstSingular);
  const firstPlural = safeMatches(text, POV_PATTERNS.firstPlural);
  const endings = endingHistogram(sentences);
  const lineBreakSensitive = documentProfile === 'creative' && isLineBreakSensitive(text);
  return {
    version: 1,
    register: detectRegister(text),
    pov: {
      firstSingular,
      firstPlural,
      type: firstSingular > 0 ? 'individual' : (firstPlural > 0 ? 'collective' : 'impersonal')
    },
    sentence: distribution(sentenceLengths),
    paragraph: distribution(paragraphLengths),
    endings,
    directQuoteCount: (text.match(/[“"][^”"\n]{2,}[”"]/gu) || []).length,
    listItemCount: (text.match(/^\s*(?:[-*•]|\d+[.)]|[가-힣][.)])\s+.+$/gmu) || []).length,
    headingCount: (text.match(/^\s*(?:(?:제\s*\d+\s*(?:장|절|항))(?:\s+\S.*)?|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?\s*\S.*|\d+(?:\.\d+){0,3}[.)]?\s+\S.*|(?:서론|본론|결론|초록|요약|참고\s*문헌|부록))\s*$/gmu) || []).length,
    lineCount: lineCount(text),
    lineBreakSensitive
  };
}

function voicePromptBlock(profile) {
  if (!profile) return '';
  const avgSentence = Math.round(profile.sentence?.mean || 0);
  const avgParagraph = Math.round(profile.paragraph?.mean || 0);
  return [
    '[원문 화자·리듬 계약]',
    `화자=${profile.pov?.type || 'impersonal'}, 종결체=${profile.register || 'mixed'}`,
    `문장 길이 평균≈${avgSentence}자, 변동계수≈${round(profile.sentence?.cv || 0, 2)}; 문단 길이 평균≈${avgParagraph}자`,
    `직접 인용=${profile.directQuoteCount || 0}, 목록=${profile.listItemCount || 0}, 제목=${profile.headingCount || 0}`,
    '원문의 인칭과 종결체를 유지한다. 문장·문단 길이를 같은 크기로 평탄화하지 않는다.',
    profile.lineBreakSensitive ? '이 글은 줄바꿈 자체가 구조다. 행을 합치거나 새로 나누지 않는다.' : ''
  ].filter(Boolean).join('\n');
}

function auditVoice(sourceProfile, output, { documentProfile = 'unknown', mode = '' } = {}) {
  const current = buildVoiceProfile(output, { documentProfile });
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
  if ((sourceProfile?.listItemCount || 0) > 0 && current.listItemCount < sourceProfile.listItemCount) {
    warnings.push(warning('list_structure_changed', '목록 항목 일부가 합쳐지거나 누락됐을 수 있어요.'));
  }
  if (mode === 'polish' && current.listItemCount !== (sourceProfile?.listItemCount || 0)) {
    warnings.push(warning('list_structure_changed', '보존형 윤문에서 목록 구조가 달라졌을 수 있어요.'));
  }
  if (current.headingCount !== (sourceProfile?.headingCount || 0)) {
    warnings.push(warning('heading_structure_changed', '제목이나 절 구조의 개수가 달라졌을 수 있어요.'));
  }
  const sourceParagraphs = sourceProfile?.paragraph?.count || 0;
  const currentParagraphs = current.paragraph?.count || 0;
  const paragraphChanged = mode === 'polish'
    ? currentParagraphs !== sourceParagraphs
    : sourceParagraphs >= 2 && (currentParagraphs < sourceParagraphs * 0.6 || currentParagraphs > sourceParagraphs * 1.6);
  if (paragraphChanged) {
    warnings.push(warning('paragraph_structure_changed', '문단 수나 문단 구성이 원문과 크게 달라졌을 수 있어요.'));
  }
  if (sourceProfile?.lineBreakSensitive && lineCount(output) !== sourceProfile.lineCount) {
    // 실제 행 수 비교는 structure audit가 맡고, 여기서는 민감도만 표기한다.
    warnings.push(warning('creative_line_structure', '창작문의 행 구조를 확인해야 해요.'));
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

function isLineBreakSensitive(text) {
  const lines = String(text || '').split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  const short = lines.filter(line => line.length <= 40).length;
  return short / lines.length >= 0.6;
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

module.exports = { POV_PATTERNS, buildVoiceProfile, voicePromptBlock, auditVoice };
