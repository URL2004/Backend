'use strict';
const { splitSentences } = require('../engine/koreanText');
const { buildDetectInputDocument } = require('./detectInputDocument');
// Keep the historical raw sentence view stable for versioned research features
// and saved-history fallback metadata. Active detection uses the canonical
// document directly, including eligibility and independent sample units.
function sourceSentences(source) {
  const text = String(source || '');
  let cursor = 0;
  return splitSentences(text).map(sentence => {
    const start = text.indexOf(sentence, cursor);
    if (start < 0) return null;
    cursor = start + sentence.length;
    return { start, end: cursor, text: sentence };
  }).filter(Boolean);
}
function groundSignals(signals, source) {
  const document = buildDetectInputDocument(source);
  const sentences = document.sentences;
  const eligible = sentences.filter(sentence => sentence.eligibleForDetection);
  const eligibleUnits = [...new Set(eligible.map(sentence => sentence.sampleUnitIndex))];
  const ranks = new Map(eligibleUnits.map((unit, rank) => [unit, rank]));
  const paragraphs = new Set(eligible.map(sentence => sentence.paragraphIndex));
  return (Array.isArray(signals) ? signals : []).filter(signal => signal && typeof signal === 'object').map(signal => {
    const indices = [...new Set(Array.isArray(signal.evidenceSentences) ? signal.evidenceSentences : [])]
      .filter(index => Number.isInteger(index) && index >= 0 && index < sentences.length && sentences[index].eligibleForDetection).slice(0, 8);
    const locations = indices.map(index => ({ sentenceIndex: index, start: sentences[index].start, end: sentences[index].end }));
    // Pervasive needs examples spread through the analyzable document, not just
    // several adjacent sentences at its start. Do not infer semantic independence
    // from shared locations or reject different causes merely for sharing a span.
    const coveredParagraphs = new Set(indices.map(index => sentences[index].paragraphIndex));
    const positions = [...new Set(indices.map(index => ranks.get(sentences[index].sampleUnitIndex)))];
    const broad = positions.length >= Math.min(3, eligibleUnits.length)
      && (paragraphs.size <= 1 || coveredParagraphs.size >= 2)
      && Math.max(...positions) - Math.min(...positions) >= (eligibleUnits.length - 1) / 2;
    return { ...signal, locations, locationStatus: locations.length ? 'source_range_verified' : 'unlocated',
      ...(signal.scope === 'pervasive' && !broad ? { scope: 'recurring' } : {}),
      ...(positions.length < 2 ? { scope: 'isolated' } : {}),
      ...(!locations.length ? { strength: 'weak' } : {}) };
  });
}
module.exports = { sourceSentences, groundSignals };
