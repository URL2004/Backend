'use strict';

const { splitSentences } = require('../engine/koreanText');
const { isV248FeatureEnabled } = require('../lib/humanizeV248Flags');

const VERSION = 1;
const GUARDED_FAMILIES = Object.freeze([
  {
    code: 'limitative_additive',
    patterns: [
      /데서\s*그치지\s*않고/gu,
      /데서\s*멈추지\s*않고/gu,
      /에\s*머무르지\s*않고/gu
    ]
  },
  {
    code: 'possibility_point',
    patterns: [/수\s*있다는\s*점도/gu]
  }
]);

const SHADOW_PATTERNS = Object.freeze([
  { code: 'in_the_process', pattern: /그\s*과정에서/gu },
  { code: 'can_and', pattern: /수\s*있고/gu }
]);

function isEnabled() {
  return isV248FeatureEnabled('fingerprintAudit');
}

function auditFingerprint(source, output) {
  const before = String(source || '');
  const after = String(output || '');
  const families = GUARDED_FAMILIES.map(family => {
    const sourceCount = countFamily(before, family);
    const outputCount = countFamily(after, family);
    const introducedCount = Math.max(0, outputCount - sourceCount);
    return {
      code: family.code,
      sourceCount,
      outputCount,
      introducedCount,
      excessIntroducedCount: Math.max(0, introducedCount - 1)
    };
  });
  const relationShift = detectContrastRelationShift(before, after);
  const violations = [];
  for (const family of families) {
    if (family.excessIntroducedCount > 0) {
      violations.push({
        code: 'engine_phrase_fingerprint',
        family: family.code,
        count: family.excessIntroducedCount
      });
    }
  }
  if (relationShift.detected) {
    violations.push({
      code: 'contrast_relation_shift',
      family: 'negative_to_additive',
      count: relationShift.count,
      sentenceOrdinals: relationShift.sentenceOrdinals
    });
  }
  const shadow = SHADOW_PATTERNS.map(item => {
    const sourceCount = countMatches(before, item.pattern);
    const outputCount = countMatches(after, item.pattern);
    return { code: item.code, sourceCount, outputCount, delta: outputCount - sourceCount };
  });
  return {
    version: VERSION,
    enabled: isEnabled(),
    pass: violations.length === 0,
    families,
    introducedCount: families.reduce((sum, item) => sum + item.introducedCount, 0),
    excessIntroducedCount: families.reduce((sum, item) => sum + item.excessIntroducedCount, 0),
    violations,
    issueCodes: [...new Set(violations.map(item => item.code))],
    relationShift,
    shadow
  };
}

function detectContrastRelationShift(source, output) {
  const sourceSentences = splitSentences(String(source || '')).map(value => String(value || '').trim()).filter(Boolean);
  const outputSentences = splitSentences(String(output || '')).map(value => String(value || '').trim()).filter(Boolean);
  const sentenceOrdinals = [];
  for (let index = 0; index < sourceSentences.length; index += 1) {
    const sourceSentence = sourceSentences[index];
    if (!/(?:아니라|아닌\s+것이(?:라|고)|아님을)/u.test(sourceSentence)) continue;
    const center = sourceSentences.length <= 1
      ? 0
      : Math.round(index * Math.max(0, outputSentences.length - 1) / Math.max(1, sourceSentences.length - 1));
    const candidates = [center - 1, center, center + 1]
      .filter(value => value >= 0 && value < outputSentences.length)
      .map(value => outputSentences[value]);
    const sourceTokens = contentTokens(sourceSentence);
    const shifted = candidates.some(candidate => {
      if (!/(?:데서\s*(?:그치지|멈추지)\s*않고|에\s*머무르지\s*않고)/u.test(candidate)) return false;
      if (/(?:아니라|아닌\s+것이(?:라|고)|아님을)/u.test(candidate)) return false;
      const candidateTokens = new Set(contentTokens(candidate));
      const shared = sourceTokens.filter(token => candidateTokens.has(token)).length;
      return sourceTokens.length >= 2 && shared / sourceTokens.length >= 0.35;
    });
    if (shifted) sentenceOrdinals.push(index + 1);
  }
  return { detected: sentenceOrdinals.length > 0, count: sentenceOrdinals.length, sentenceOrdinals };
}

function countFamily(text, family) {
  return (family.patterns || []).reduce((sum, pattern) => sum + countMatches(text, pattern), 0);
}

function countMatches(text, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return (String(text || '').match(new RegExp(pattern.source, flags)) || []).length;
}

function contentTokens(value) {
  return (String(value || '').match(/[가-힣]{2,}|[A-Za-z]{3,}/gu) || [])
    .map(token => token.toLowerCase().replace(/(?:에서는|으로는|에게는|이라는|으로|에서|에게|보다|처럼|은|는|이|가|을|를|의|에|도|만|와|과|로)$/u, ''))
    .filter(token => token.length >= 2 && !['그러나', '하지만', '그리고', '또한', '따라서'].includes(token));
}

function isImproved(before, after) {
  if (!before || !after) return false;
  if (after.violations.length < before.violations.length) return true;
  if (after.excessIntroducedCount < before.excessIntroducedCount) return true;
  return before.relationShift?.detected === true && after.relationShift?.detected !== true;
}

module.exports = {
  VERSION,
  GUARDED_FAMILIES,
  SHADOW_PATTERNS,
  isEnabled,
  auditFingerprint,
  detectContrastRelationShift,
  isImproved
};
