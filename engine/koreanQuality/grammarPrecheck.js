'use strict';

const { splitSentences } = require('./styleConsistency');

function findAdjacentDuplicates(text) {
  const sentences = splitSentences(text)
    .map(s => ({ raw: s, key: normalizeSentence(s) }))
    .filter(s => s.key.length >= 12);
  const duplicates = [];
  for (let i = 1; i < sentences.length; i += 1) {
    if (sentences[i].key === sentences[i - 1].key) {
      duplicates.push({
        id: 'adjacent_duplicate_sentence',
        label: '인접 중복 문장',
        sentence: sentences[i].raw.slice(0, 120)
      });
    }
  }
  return duplicates;
}

function normalizeSentence(sentence) {
  return String(sentence || '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function findUnfinishedFinalSentence(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (/(?:며|으며|고|지만|는데|면서|거나|하여|해서|하되|및)\s*[,.]?$/.test(trimmed)) {
    return [{
      id: 'unfinished_final_sentence',
      label: '마지막 문장 미완결',
      sentence: trimmed.slice(-120)
    }];
  }
  return [];
}

module.exports = {
  findAdjacentDuplicates,
  findUnfinishedFinalSentence,
  normalizeSentence
};
