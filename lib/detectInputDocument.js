'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');

const DETECT_INPUT_DOCUMENT_VERSION = 'detect-input-document-v2-eligible-prose';

// Protect syntax that can be identified without guessing who wrote the text.
// Unmarked quotations/headings remain the model's responsibility. In particular,
// a numbered item is editable prose, not an entire excluded list.
function protectedRanges(value) {
  const source = String(value || '');
  const ranges = [];
  let fence = '', references = false;
  const add = (start, end, spanType) => { if (end > start) ranges.push({ start, end, spanType }); };
  for (const match of source.matchAll(/[^\r\n]+(?:\r\n|\r|\n|$)|(?:\r\n|\r|\n)/gu)) {
    const line = match[0].replace(/[\r\n]+$/u, '');
    const start = match.index, end = start + line.length;
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fence) {
      add(start, end, 'code');
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
      continue;
    }
    if (marker) { fence = marker[1]; add(start, end, 'code'); continue; }
    const heading = /^\s*#{1,6}\s+\S/u.test(line);
    const bare = line.replace(/^\s*#{1,6}\s*/u, '').trim();
    if (/^(?:참고\s*문헌|참고\s*자료|references|bibliography)\s*[:：]?$/iu.test(bare)) references = true;
    else if (heading) references = false;
    if (references) { add(start, end, 'reference'); continue; }
    if (heading || /^\s*제\s*\d+\s*[장절](?:\s|$)/u.test(line)) { add(start, end, 'heading'); continue; }
    if (/^\s*>/u.test(line)) { add(start, end, 'quote'); continue; }
    if (/^\s*\|/u.test(line)) { add(start, end, 'table'); continue; }
    if (/^\s*[“「『"][\s\S]+[”」』"]\s*[.!?。！？]?\s*$/u.test(line)) add(start, end, 'quote');
  }
  // Protect long/sentence quotations inside a paragraph, while ordinary quoted
  // terms such as "AI" do not fragment the sample into artificial sentences.
  for (const match of source.matchAll(/“[^”]+”|「[^」]+」|『[^』]+』|"[^"\r\n]+"/gu)) {
    if (match[0].length >= 100 || /[.!?。！？](?:\s|[”」』"])/u.test(match[0])) add(match.index, match.index + match[0].length, 'quote');
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function canonicalSentenceSpans(value) {
  const source = String(value || '');
  const protectedSpans = protectedRanges(source);
  const spans = [];
  const append = (start, end, spanType, eligibleForDetection) => {
    for (const sentence of splitSentenceSpans(source.slice(start, end))) {
      spans.push({ start: start + sentence.start, end: start + sentence.end, text: sentence.text,
        spanType: eligibleForDetection && /^\s*(?:\d+[.)]|[-*•])\s+/u.test(sentence.text) ? 'list_prose' : spanType,
        eligibleForDetection });
    }
  };
  let cursor = 0;
  for (const range of protectedSpans) {
    append(cursor, range.start, 'prose', true);
    append(range.start, range.end, range.spanType, false);
    cursor = range.end;
  }
  append(cursor, source.length, 'prose', true);
  return { spans, protectedSpans };
}

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
  const { spans, protectedSpans } = canonicalSentenceSpans(source);
  const sampleUnits = splitSentenceSpans(source);
  const paragraphs = paragraphSpans(source);
  const paragraphSentenceIndices = paragraphs.map(() => []);
  let paragraphCursor = 0;
  let sampleCursor = 0;
  const sentences = spans.map((sentence, index) => {
    while (sampleCursor < sampleUnits.length - 1 && sampleUnits[sampleCursor].end <= sentence.start) sampleCursor += 1;
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
      sampleUnitIndex: sampleCursor,
      paragraphIndex: paragraphs.length ? first : null,
      paragraphEndIndex: paragraphs.length ? last : null
    };
  });
  return {
    version: DETECT_INPUT_DOCUMENT_VERSION,
    sentences,
    protectedSpans,
    // A quotation can split one sentence into two editable fragments. Those
    // fragments remain one unit for sample sufficiency and recurring evidence.
    eligibleSentenceCount: new Set(sentences.filter(sentence => sentence.eligibleForDetection).map(sentence => sentence.sampleUnitIndex)).size,
    eligibleText: sentences.filter(sentence => sentence.eligibleForDetection).map(sentence => sentence.text).join('\n'),
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
    sampleUnitIndex: sentence.sampleUnitIndex,
    spanType: sentence.spanType,
    eligibleForDetection: sentence.eligibleForDetection,
    ...(sentence.paragraphEndIndex !== sentence.paragraphIndex
      ? { paragraphEndIndex: sentence.paragraphEndIndex }
      : {}),
    text: sentence.text
  }));
}

function buildDetectModelInput(value, { referenceContext = '' } = {}) {
  return {
    version: DETECT_INPUT_DOCUMENT_VERSION,
    sentences: modelSentences(value),
    // Context is data too, but is never part of sentence IDs, sample size,
    // statistical features, evidence offsets, billing length or the input score.
    ...(String(referenceContext || '').trim() ? { referenceContext: String(referenceContext).trim().slice(-300) } : {})
  };
}

// Scoring uses source.trim(). Match its exact ranges before translating to
// the submitted document. Presentation must not highlight displaced text when
// the user supplied leading whitespace, CRLF or a whitespace-only blank line.
function locatePublicEvidence(evidence, value) {
  const source = String(value || '');
  const trimmed = source.trim();
  const offset = source.indexOf(trimmed);
  const document = buildDetectInputDocument(source);
  const originalSentences = buildDetectInputDocument(trimmed).sentences;
  return (Array.isArray(evidence) ? evidence : []).map(item => {
    const locations = [];
    const seen = new Set();
    if (item?.locationStatus === 'source_range_verified') {
      for (const loc of Array.isArray(item.locations) ? item.locations : []) {
        const original = originalSentences[loc?.sentenceIndex];
        const located = document.sentences[loc?.sentenceIndex];
        if (!original || !located || !original.eligibleForDetection || !located.eligibleForDetection || seen.has(loc.sentenceIndex)
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
  protectedRanges,
  buildDetectInputDocument,
  buildDetectModelInput,
  locatePublicEvidence,
  modelSentences
};
