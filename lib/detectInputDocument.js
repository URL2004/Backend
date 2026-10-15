'use strict';

const { splitSentenceSpans, hasSentenceTerminator } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const { tableCells, wrappedSource, detectionSentenceSpans, nonProseTableRanges } = require('./detectSourceStructure');

const DETECT_INPUT_DOCUMENT_VERSION = 'detect-input-document-v13-nominal-table';
const MAX_MODEL_SENTENCES = 1000;
const MAX_MODEL_INPUT_BYTES = 240000;

// Protect syntax that can be identified without guessing who wrote the text.
// Unmarked quotations/headings remain the model's responsibility. In particular,
// a numbered item is editable prose, not an entire excluded list.
function protectedRanges(value, cells = tableCells(String(value || ''))) {
  const source = String(value || '');
  const ranges = nonProseTableRanges(source);
  const authoredWrapper = require('./blockquoteDocument').isAuthoredBlockquoteDocument(source);
  let references = false;
  const syntax = syntaxSpans(source);
  const speech = require('./authoredSpeechDocument').authoredSpeechRanges(source, syntax);
  const code = syntax.filter(span => span.spanType === 'code');
  const add = (start, end, spanType) => { if (end > start) ranges.push({ start, end, spanType }); };
  for (const range of speech) {
    add(range.cueStart, range.cueEnd, 'heading');
    add(range.start, range.start + 1, 'format_marker');
    add(range.end - 1, range.end, 'format_marker');
  }
  for (const match of source.matchAll(/[^\r\n]+(?:\r\n|\r|\n|$)|(?:\r\n|\r|\n)/gu)) {
    const line = match[0].replace(/[\r\n]+$/u, '');
    const start = match.index, end = start + line.length;
    if (code.some(span => span.start <= start && span.end >= end)) continue;
    const numbered = line.match(/^\s*\d+(?:\.\d+)*[.)]?\s+(.+)$/u);
    const numberedHeading = numbered && numbered[1].length <= 100
      && !hasSentenceTerminator(numbered[1])
      && /(?:비교|분석|방법|개념|원리|결과|고찰|서론|결론|배경|목적|한계|의의|해석|정리|방안|논의|차이|시사점|현황|과제|전망|요약)\s*$/u.test(numbered[1]);
    const heading = /^\s*#{1,6}\s+\S/u.test(line) || numberedHeading;
    const bare = line.replace(/^\s*#{1,6}\s*/u, '').trim();
    if (/^(?:참고\s*문헌|참고\s*자료|references|bibliography)\s*[:：]?$/iu.test(bare)) references = true;
    else if (heading) references = false;
    if (references) { add(start, end, 'reference'); continue; }
    if (heading || /^\s*제\s*\d+\s*[장절](?:\s|$)/u.test(line)) { add(start, end, 'heading'); continue; }
    if (/^\s*>/u.test(line)) {
      // Keep exact source offsets; only the display marker is non-prose.
      add(start, authoredWrapper ? start + line.match(/^\s*>\s*/u)[0].length : end,
        authoredWrapper ? 'format_marker' : 'quote');
      continue;
    }
    if (/^\s*\|/u.test(line)) {
      let cursor = start;
      for (const cell of cells.filter(cell => cell.rowStart === start && cell.prose)) {
        add(cursor, cell.start, 'table');
        cursor = cell.end;
      }
      add(cursor, end, 'table');
      continue;
    }
  }
  // Protect long/sentence quotations inside a paragraph, while ordinary quoted
  // terms such as "AI" do not fragment the sample into artificial sentences.
  for (const span of syntax) {
    if (span.spanType === 'code') add(span.start, span.end, 'code');
    if (span.spanType !== 'quote') continue;
    if (speech.some(range => range.start === span.start && range.end === span.end)) continue;
    const quoted = source.slice(span.start, span.end);
    if (quoted.length >= 100 || hasSentenceTerminator(quoted.slice(1, -1))) add(span.start, span.end, 'quote');
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
  const cells = tableCells(source);
  const analysisSource = wrappedSource(source);
  const protectedSpans = protectedRanges(source, cells);
  const spans = [];
  const append = (start, end, spanType, eligibleForDetection) => {
    for (const sentence of detectionSentenceSpans(source.slice(start, end), analysisSource.slice(start, end))) {
      const cell = cells.find(cell => cell.start <= start + sentence.start && start + sentence.end <= cell.end);
      const nonLetterFragment = !/\p{L}/u.test(sentence.text);
      spans.push({ start: start + sentence.start, end: start + sentence.end, text: sentence.text,
        spanType: eligibleForDetection && cell ? 'table_prose'
          : eligibleForDetection && /^\s*(?:\d+[.)]|[-*•])\s+/u.test(sentence.text) ? 'list_prose' : spanType,
        ...(cell ? { tableCell: { rowIndex: cell.rowIndex, columnIndex: cell.columnIndex, start: cell.start, end: cell.end } } : {}),
        eligibleForDetection: eligibleForDetection && !nonLetterFragment });
    }
  };
  let cursor = 0;
  for (const range of protectedSpans) {
    append(cursor, range.start, 'prose', true);
    append(range.start, range.end, range.spanType, false);
    cursor = range.end;
  }
  append(cursor, source.length, 'prose', true);
  return { spans, protectedSpans, cells, analysisSource };
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
  const { spans, protectedSpans, cells, analysisSource } = canonicalSentenceSpans(source);
  // A verified script wrapper is typography, not one giant quoted sample.
  // Mask only its delimiters, preserving every UTF-16 source coordinate and
  // retaining nested external quotations for the shared sentence analyzer.
  let sampleSource = analysisSource;
  for (const span of [...protectedSpans].reverse()) {
    if (span.spanType !== 'format_marker') continue;
    sampleSource = sampleSource.slice(0, span.start)
      + sampleSource.slice(span.start, span.end).replace(/["“”「」『』]/gu, ' ')
      + sampleSource.slice(span.end);
  }
  // A cell owns its sample units; never join two cells through pipe syntax.
  const cuts = [...new Set([0, source.length, ...cells.flatMap(cell => [cell.rowStart, cell.start, cell.end, cell.rowEnd])])].sort((a, b) => a - b);
  const sampleUnits = cuts.slice(0, -1).flatMap((start, index) =>
    splitSentenceSpans(sampleSource.slice(start, cuts[index + 1])).map(span => ({ start: start + span.start, end: start + span.end })));
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
    inputIncomplete: incompleteTail(source, protectedSpans),
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

// Deliberately conservative: missing punctuation alone is not damaged input.
// Flag only a dangling connective in the last supplied prose, not quotations,
// code, a nominal heading or a complete sentence ending without a full stop.
function incompleteTail(source, protectedSpans = []) {
  const end = String(source).trimEnd().length;
  if (!end || protectedSpans.some(s => s.start < end && s.end >= end)) return false;
  const tail = String(source).slice(0, end).split(/[\r\n]/u).at(-1).trim();
  return tail.length >= 15 && /(?:다가|도록|면서|하며|지만|때문에|위해서|경우에는|한다면|된다면|이므로)\s*$/u.test(tail);
}

function modelSentences(value) {
  return buildDetectInputDocument(value).sentences.map(sentence => ({
    index: sentence.index,
    paragraphIndex: sentence.paragraphIndex,
    sampleUnitIndex: sentence.sampleUnitIndex,
    spanType: sentence.spanType,
    eligibleForDetection: sentence.eligibleForDetection,
    ...(sentence.tableCell ? { tableCell: sentence.tableCell } : {}),
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
          sampleUnitIndex: located.sampleUnitIndex,
          ...(located.tableCell ? { tableCell: located.tableCell } : {}),
          paragraphIndex: located.paragraphIndex, paragraphEndIndex: located.paragraphEndIndex });
      }
    }
    return { ...item, locations, locationStatus: locations.length ? 'source_range_verified' : 'unlocated' };
  });
}

// Reject before provider work or charging; never sample away user prose to fit
// a token budget. The span count bounds metadata before JSON serialization.
function assertDetectInputAdmissible(value, { referenceContext = '' } = {}) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 422, retryable: false, charged: 0 }); };
  const source = String(value || '').trim();
  if (Buffer.byteLength(source, 'utf8') > MAX_MODEL_INPUT_BYTES) fail('DETECT_INPUT_TOO_FRAGMENTED', '분석 입력이 너무 커요. 글을 나누어 분석해 주세요. 크레딧은 차감되지 않았어요.');
  const document = buildDetectInputDocument(source);
  if (!document.eligibleSentenceCount) fail('DETECT_NO_ELIGIBLE_PROSE', '분석할 본문 문장이 없어요. 표·제목·인용·코드 외의 본문을 포함해 주세요. 크레딧은 차감되지 않았어요.');
  if (document.sentences.length > MAX_MODEL_SENTENCES) fail('DETECT_INPUT_TOO_FRAGMENTED', '문장과 표 항목이 너무 많아 한 번에 분석하기 어려워요. 글을 나누어 분석해 주세요. 크레딧은 차감되지 않았어요.');
  const modelInput = buildDetectModelInput(value, { referenceContext });
  const serialized = JSON.stringify(modelInput);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MODEL_INPUT_BYTES) fail('DETECT_INPUT_TOO_FRAGMENTED', '분석 입력이 너무 커요. 글을 나누어 분석해 주세요. 크레딧은 차감되지 않았어요.');
  return { document, modelInput, serialized };
}

// Legacy detection can remove URL tracking parameters and collapse split-word
// whitespace before scoring. Map only unchanged, uniquely owned source ranges.
// Earliest/latest subsequence embeddings must agree; repeated text cannot supply
// a guessed location, and a changed URL sentence remains explicitly unlocated.
function locateNormalizedEvidence(evidence, submitted, detectorText) {
  const source = String(submitted || ''), normalized = String(detectorText || '').trim();
  if (source.trim() === normalized) return locatePublicEvidence(evidence, source);
  const project = text => {
    const chars = [], positions = [];
    for (let i = 0; i < text.length; i++) if (!/\s/u.test(text[i])) { chars.push(text[i]); positions.push(i); }
    return { chars, positions };
  };
  const a = project(source), b = project(normalized), first = [], last = [];
  let cursor = 0;
  for (let i = 0; i < b.chars.length; i++) {
    while (cursor < a.chars.length && a.chars[cursor] !== b.chars[i]) cursor++;
    if (cursor === a.chars.length) return (Array.isArray(evidence) ? evidence : []).map(item => ({ ...item, locations: [], locationStatus: 'unlocated' }));
    first[i] = cursor++;
  }
  cursor = a.chars.length - 1;
  for (let i = b.chars.length - 1; i >= 0; i--) {
    while (cursor >= 0 && a.chars[cursor] !== b.chars[i]) cursor--;
    last[i] = cursor--;
  }
  const offsets = new Map(b.positions.map((offset, index) => [offset, index]));
  const original = buildDetectInputDocument(normalized).sentences;
  const spans = new Map(buildDetectInputDocument(source).sentences.filter(s => s.eligibleForDetection)
    .map(s => [`${s.start}:${s.end}`, s]));
  return (Array.isArray(evidence) ? evidence : []).map(item => {
    const locations = [];
    for (const loc of item?.locationStatus === 'source_range_verified' && Array.isArray(item.locations) ? item.locations : []) {
      const sentence = original[loc.sentenceIndex];
      if (!sentence?.eligibleForDetection || sentence.start !== loc.start || sentence.end !== loc.end) continue;
      const from = offsets.get(loc.start), to = offsets.get(loc.end - 1);
      if (from == null || to == null || first[from] !== last[from] || first[to] !== last[to]
          || first[to] - first[from] !== to - from) continue;
      const start = a.positions[first[from]], end = a.positions[first[to]] + 1, target = spans.get(`${start}:${end}`);
      if (!target) continue;
      locations.push({ sentenceIndex: target.index, start, end, sampleUnitIndex: target.sampleUnitIndex,
        ...(target.tableCell ? { tableCell: target.tableCell } : {}),
        paragraphIndex: target.paragraphIndex, paragraphEndIndex: target.paragraphEndIndex });
    }
    return { ...item, locations, locationStatus: locations.length ? 'source_range_verified' : 'unlocated' };
  });
}

module.exports = {
  DETECT_INPUT_DOCUMENT_VERSION,
  MAX_MODEL_SENTENCES,
  MAX_MODEL_INPUT_BYTES,
  assertDetectInputAdmissible,
  paragraphSpans,
  protectedRanges,
  buildDetectInputDocument,
  buildDetectModelInput,
  locatePublicEvidence,
  locateNormalizedEvidence,
  modelSentences
};
