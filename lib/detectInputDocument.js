'use strict';

const { sourceSentences } = require('./detectGrounding');

const DETECT_INPUT_DOCUMENT_VERSION = 'detect-input-document-v1';

// Blank lines mark paragraphs. A single newline can be a visual wrap and must
// not change the model's view of the paragraph. Offsets always reference the
// exact supplied source, including CRLF; do not normalize before locating it.
function paragraphSpans(value) {
  const source = String(value || '');
  const spans = [];
  let start = 0;
  const append = end => {
    let from = start;
    let to = end;
    while (from < to && /\s/u.test(source[from])) from += 1;
    while (to > from && /\s/u.test(source[to - 1])) to -= 1;
    if (from < to) spans.push({ index: spans.length, start: from, end: to });
  };
  // Accept a whitespace-only blank line as well as an empty one. CRLF is one
  // newline. The final newline belongs to the boundary, not either paragraph.
  const boundary = /(?:\r\n|\r(?!\n)|(?<!\r)\n)[\t ]*(?:(?:\r\n|\r(?!\n)|(?<!\r)\n)[\t ]*)+/gu;
  for (const match of source.matchAll(boundary)) {
    append(match.index);
    start = match.index + match[0].length;
  }
  append(source.length);
  return spans;
}

function buildDetectInputDocument(value) {
  const source = String(value || '');
  const paragraphs = paragraphSpans(source);
  const paragraphSentenceIndices = paragraphs.map(() => []);
  let paragraphCursor = 0;
  const sentences = sourceSentences(source).map((sentence, index) => {
    while (paragraphCursor < paragraphs.length - 1
        && paragraphs[paragraphCursor].end <= sentence.start) paragraphCursor += 1;
    const first = paragraphCursor;
    let last = first;
    while (last < paragraphs.length - 1
        && paragraphs[last + 1].start < sentence.end) last += 1;
    for (let paragraph = first; paragraph <= last && paragraph < paragraphs.length; paragraph += 1) {
      paragraphSentenceIndices[paragraph].push(index);
    }
    return {
      index,
      ...sentence,
      paragraphIndex: paragraphs.length ? first : null,
      paragraphEndIndex: paragraphs.length ? last : null
    };
  });
  return {
    version: DETECT_INPUT_DOCUMENT_VERSION,
    sentences,
    paragraphs: paragraphs.map((paragraph, index) => ({
      ...paragraph,
      sentenceIndices: paragraphSentenceIndices[index]
    }))
  };
}

function modelSentences(value) {
  return buildDetectInputDocument(value).sentences.map(sentence => ({
    index: sentence.index,
    paragraphIndex: sentence.paragraphIndex,
    ...(sentence.paragraphEndIndex !== sentence.paragraphIndex
      ? { paragraphEndIndex: sentence.paragraphEndIndex }
      : {}),
    text: sentence.text
  }));
}

// Scoring uses source.trim(). Match its exact ranges before translating to
// the submitted document. Presentation must not highlight displaced text when
// the user supplied leading whitespace, CRLF or a whitespace-only blank line.
function locatePublicEvidence(evidence, value) {
  const source = String(value || '');
  const trimmed = source.trim();
  const offset = source.indexOf(trimmed);
  const document = buildDetectInputDocument(source);
  const originalSentences = sourceSentences(trimmed);
  return (Array.isArray(evidence) ? evidence : []).map(item => {
    const locations = [];
    const seen = new Set();
    if (item?.locationStatus === 'source_range_verified') {
      for (const loc of Array.isArray(item.locations) ? item.locations : []) {
        const original = originalSentences[loc?.sentenceIndex];
        const located = document.sentences[loc?.sentenceIndex];
        if (!original || !located || seen.has(loc.sentenceIndex)
          || loc.start !== original.start || loc.end !== original.end
          || located.start !== original.start + offset || located.end !== original.end + offset) continue;
        seen.add(loc.sentenceIndex);
        locations.push({ sentenceIndex: loc.sentenceIndex, start: located.start, end: located.end,
          paragraphIndex: located.paragraphIndex, paragraphEndIndex: located.paragraphEndIndex });
      }
    }
    return { ...item, locations, locationStatus: locations.length ? 'source_range_verified' : 'unlocated' };
  });
}

module.exports = {
  DETECT_INPUT_DOCUMENT_VERSION,
  paragraphSpans,
  buildDetectInputDocument,
  locatePublicEvidence,
  modelSentences
};
