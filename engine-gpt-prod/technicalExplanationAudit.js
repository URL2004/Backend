'use strict';

// A source can contain both a precise definition and an unqualified visual
// shortcut. Use the source's own formula, never external facts, to clarify
// the shortcut. This is deliberately narrower than technical fact checking.
const CONVOLUTION = /콘벌루션|컨볼루션|convolution/iu;
const PRODUCT_INTEGRAL = /∫[^.\n]{0,160}[A-Za-z]\s*\([^)]{1,40}\)\s*(?:[·×*]\s*)?[A-Za-z]\s*\([^)]{1,40}\)/u;
const UNQUALIFIED_AREA = /겹(?:친|치는)\s*면적의\s*크기에\s*(?:비례하여|따라)/gu;
const QUALIFIED_AREA = '겹친 구간에서 두 함수의 곱을 적분한 값에 따라';
const SPECIAL_CASE = /단위\s*(?:높이|진폭)|높이\s*1|진폭\s*1|직사각|구형\s*펄스|rectangular\s*pulse/iu;

function hasAttestedDefinition(source) {
  const text = String(source || '');
  return CONVOLUTION.test(text) && PRODUCT_INTEGRAL.test(text);
}

function auditConvolutionPrecision(source, outputText) {
  if (!hasAttestedDefinition(source)) return { applicable: false, pass: true, issues: [] };
  const issues = [];
  const text = String(outputText || '');
  const paragraphPattern = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/gu;
  for (const match of text.matchAll(paragraphPattern)) {
    const paragraph = match[0];
    if (!CONVOLUTION.test(paragraph) || SPECIAL_CASE.test(paragraph)) continue;
    for (const sentenceMatch of paragraph.matchAll(/[^.!?\n]+[.!?]/gu)) {
      const sentence = sentenceMatch[0];
      if (/[“”"`]/u.test(sentence)) continue;
      UNQUALIFIED_AREA.lastIndex = 0;
      if (!UNQUALIFIED_AREA.test(sentence)) continue;
      UNQUALIFIED_AREA.lastIndex = 0;
      issues.push({ start: match.index + sentenceMatch.index, sentence });
    }
  }
  return { applicable: true, pass: issues.length === 0, issues };
}

function clarifyConvolutionPrecision(source, outputText) {
  const before = auditConvolutionPrecision(source, outputText);
  let text = String(outputText || '');
  let clarifiedCount = 0;
  for (const issue of [...before.issues].reverse()) {
    const replacement = issue.sentence.replace(UNQUALIFIED_AREA, QUALIFIED_AREA)
      .replace(/적분한 값에 따라 결과 값이/gu, '적분한 값에 따라 결과가')
      .replace(/적분한 값에 따라 결과 값은/gu, '적분한 값에 따라 결과는');
    UNQUALIFIED_AREA.lastIndex = 0;
    if (replacement === issue.sentence) continue;
    text = text.slice(0, issue.start) + replacement + text.slice(issue.start + issue.sentence.length);
    clarifiedCount += 1;
  }
  return { text, applied: clarifiedCount > 0, clarifiedCount,
    before, after: auditConvolutionPrecision(source, text) };
}

module.exports = { auditConvolutionPrecision, clarifyConvolutionPrecision };
