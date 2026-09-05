'use strict';
const { splitSentences } = require('../engine/koreanText');
function sourceSentences(source) {
  let cursor = 0;
  return splitSentences(String(source || '')).map(text => {
    const start = String(source).indexOf(text, cursor);
    if (start < 0) return null;
    cursor = start + text.length;
    return { start, end: cursor, text };
  }).filter(Boolean);
}
function groundSignals(signals, source) {
  const sentences = sourceSentences(source);
  return (signals || []).map(signal => {
    const indices = [...new Set(signal.evidenceSentences || [])]
      .filter(index => Number.isInteger(index) && index >= 0 && index < sentences.length).slice(0, 8);
    const locations = indices.map(index => ({ sentenceIndex: index, start: sentences[index].start, end: sentences[index].end }));
    return { ...signal, locations, locationStatus: locations.length ? 'source_range_verified' : 'unlocated',
      ...(locations.length < 2 ? { scope: 'isolated' } : {}),
      ...(!locations.length ? { strength: 'weak' } : {}) };
  });
}
module.exports = { sourceSentences, groundSignals };
