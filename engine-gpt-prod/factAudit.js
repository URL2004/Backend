'use strict';

// Audit every numeric token as a multiset. Bare section/list numbers are
// included because v2 preserves document structure as well as factual values.
const NUMBER_TOKEN_RE = /(?<![A-Za-z0-9_])[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?:[-/]\d+(?:\.\d+)?)*(?:\s*(?:퍼센트|개월|만원|억원|조원|시간|페이지|명|개|건|회|년|월|일|분|초|점|배|장|절|항|위|쪽|원|평|곳|대|권|차|화|%|％|kg|km|cm|mm|㎡|m|g))?(?![A-Za-z0-9_])/giu;

function compareNumberMultiset(source, outputText, allowedExtra = '') {
  const sourceCounts = count(extractNumberTokens(source));
  const allowedCounts = count(extractNumberTokens([source, allowedExtra].filter(Boolean).join('\n')));
  const outputCounts = count(extractNumberTokens(outputText));
  const removed = difference(sourceCounts, outputCounts);
  const added = difference(outputCounts, allowedCounts);
  return {
    changed: removed.count > 0 || added.count > 0,
    removedCount: removed.count,
    addedCount: added.count,
    removedTokens: removed.items.slice(0, 12),
    addedTokens: added.items.slice(0, 12),
    sourceTokenCount: total(sourceCounts),
    outputTokenCount: total(outputCounts)
  };
}

function extractNumberTokens(value) {
  const text = String(value || '').normalize('NFC');
  return [...text.matchAll(NUMBER_TOKEN_RE)].map(match => normalizeNumberToken(match[0])).filter(Boolean);
}

function normalizeNumberToken(value) {
  return String(value || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/gu, '')
    .replace(/퍼센트|％/gu, '%')
    .replace(/,(?=\d{3}(?:\D|$))/gu, '');
}

function count(values) {
  const out = new Map();
  for (const value of values) out.set(value, (out.get(value) || 0) + 1);
  return out;
}

function difference(left, right) {
  let countValue = 0;
  const items = [];
  for (const [token, occurrences] of left.entries()) {
    const delta = occurrences - (right.get(token) || 0);
    if (delta <= 0) continue;
    countValue += delta;
    items.push({ token, count: delta });
  }
  return { count: countValue, items };
}

function total(values) {
  let out = 0;
  for (const value of values.values()) out += value;
  return out;
}

module.exports = {
  compareNumberMultiset,
  extractNumberTokens,
  normalizeNumberToken
};
