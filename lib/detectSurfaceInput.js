'use strict';

const { protectedRanges } = require('./detectInputDocument');
const sg = require('../engine/surfaceguard');
const { splitSentenceSpans } = require('../engine/koreanText');

// Presentation must measure the same eligible prose as the score model. Mask
// protected spans without removing lines, so public paragraph indices stay put.
function buildDetectSurfaceInput(paragraphs) {
  const original = paragraphs.map(value => String(value || ''));
  const joined = original.join('\n\n');
  const ranges = protectedRanges(joined);
  let masked = '', cursor = 0;
  for (const range of ranges) {
    masked += joined.slice(cursor, range.start);
    masked += joined.slice(range.start, range.end).replace(/[^\r\n]/g, ' ');
    cursor = range.end;
  }
  masked += joined.slice(cursor);
  cursor = 0;
  const previewParagraphs = [];
  const analysisParagraphs = original.map(paragraph => {
    const value = masked.slice(cursor, cursor + paragraph.length);
    // Never send a quote-stripped fragment as if it were the user's original
    // sentence to the paid rewrite preview. Only intact prose is eligible.
    previewParagraphs.push(splitSentenceSpans(paragraph)
      .filter(span => !ranges.some(range => range.start < cursor + span.end && range.end > cursor + span.start))
      .map(span => span.text).join('\n\n'));
    cursor += paragraph.length + 2;
    return value;
  });
  const detail = analysisParagraphs.map((paragraph, index) => {
    const parts = sg.analyzeParagraphs(paragraph).detail;
    if (!paragraph.trim()) return { idx: index, kind: 'thin', sents: 0, lived: 0, specific: 0, grounded: 0, excluded: true };
    // A protected code block may leave multiple prose paragraphs in one UI row.
    const merged = { ...(parts[0] || {}), idx: index };
    for (const field of ['sents', 'lived', 'specific', 'grounded', 'generic', 'stanced']) merged[field] = parts.reduce((sum, item) => sum + Number(item[field] || 0), 0);
    merged.kind = merged.lived || merged.specific ? 'concrete' : merged.generic / Math.max(1, merged.sents) >= .34 ? 'abstract_risk' : 'thin';
    return merged;
  });
  return { analysisParagraphs, previewParagraphs, detail, measurements: {
    uniformity: sg.measureUniformity(masked), genericness: sg.measureGenericness(masked),
    realAnchorDensity: sg.measureRealAnchorDensity(masked), stance: sg.measureStance(masked), detail
  }, text: masked };
}

module.exports = { buildDetectSurfaceInput };
