'use strict';

const { splitSentences, koreanEnd } = require('../engine/koreanText');
const { detectRegister } = require('../engine/contract');

const VERSION = 1;
const STYLES = Object.freeze(['plain', 'polite', 'haeyo', 'nominal']);

function auditEndingStyle(source, output) {
  const sourceSections = splitSections(source);
  const outputSections = splitSections(output);
  const sections = [];
  const issues = [];
  for (let index = 0; index < sourceSections.length; index += 1) {
    const before = sourceSections[index];
    const after = outputSections[index] || { heading: '', body: '' };
    const sourceSentences = eligibleSentences(before.body);
    const outputSentences = eligibleSentences(after.body);
    const sourceHistogram = endingHistogram(sourceSentences);
    const outputHistogram = endingHistogram(outputSentences);
    const sourceRecognized = styleTotal(sourceHistogram);
    const dominant = dominantStyle(sourceHistogram);
    const dominantRatio = sourceRecognized ? sourceHistogram[dominant] / sourceRecognized : 0;
    let introducedOtherCount = 0;
    const introducedStyles = [];
    if (sourceSentences.length >= 6 && sourceRecognized >= 6 && dominantRatio >= 0.75) {
      for (const style of STYLES) {
        if (style === dominant) continue;
        const introduced = Math.max(0, Number(outputHistogram[style] || 0) - Number(sourceHistogram[style] || 0));
        if (introduced <= 0) continue;
        introducedOtherCount += introduced;
        introducedStyles.push({ style, count: introduced });
      }
    }
    const issue = introducedOtherCount >= 2;
    const record = {
      index,
      heading: before.heading || `section_${index + 1}`,
      sourceSentenceCount: sourceSentences.length,
      outputSentenceCount: outputSentences.length,
      sourceHistogram,
      outputHistogram,
      dominantStyle: dominantRatio >= 0.75 ? dominant : '',
      dominantRatio: round4(dominantRatio),
      introducedOtherCount,
      introducedStyles,
      issue
    };
    sections.push(record);
    if (issue) issues.push(record);
  }
  return {
    version: VERSION,
    pass: issues.length === 0,
    issueCodes: issues.length ? ['ending_style_mixed'] : [],
    issueCount: issues.length,
    introducedOtherCount: issues.reduce((sum, item) => sum + item.introducedOtherCount, 0),
    sections,
    issues
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

function eligibleSentences(value) {
  const proseLines = String(value || '').split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line && !isProtectedLine(line));
  return splitSentences(proseLines.join('\n'))
    .map(sentence => String(sentence || '').trim())
    .filter(sentence => sentence.replace(/[^가-힣A-Za-z0-9]/gu, '').length >= 3);
}

function endingHistogram(sentences) {
  const out = { plain: 0, polite: 0, haeyo: 0, nominal: 0, other: 0 };
  for (const sentence of sentences || []) out[endingStyle(sentence)] += 1;
  return out;
}

function endingStyle(sentence) {
  const text = String(sentence || '').replace(/[.!?…。！？"'”’」』】)\]]+$/gu, '').trim();
  if (koreanEnd('(?:함|됨|임|음)', 'u').test(text)) return 'nominal';
  const register = detectRegister(sentence);
  if (register === 'polite') return 'polite';
  if (register === 'haeyo') return 'haeyo';
  if (register === 'plain') return 'plain';
  return 'other';
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

function round4(value) {
  const number = Number(value) || 0;
  return Math.round(number * 10000) / 10000;
}

module.exports = {
  VERSION,
  STYLES,
  auditEndingStyle,
  splitSections,
  eligibleSentences,
  endingHistogram,
  endingStyle,
  isImproved
};
