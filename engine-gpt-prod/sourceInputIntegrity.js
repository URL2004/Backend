'use strict';

const { syntaxSpans } = require('../engine/textSyntax');
const { createHash } = require('node:crypto');
const VERSION = 'source-input-integrity-v1';
const hash = value => createHash('sha256').update(value).digest('hex');

// Decode only unambiguous prose spacing/ampersands. Never recursively decode,
// turn entities into markup/quotes, or alter code, URLs, quoted literals or math.
function normalizeProseEntities(value) {
  const source = String(value || '');
  const protectedSpans = [...syntaxSpans(source)];
  for (const match of source.matchAll(/https?:\/\/\S+|www\.\S+|<[^>\n]*>|\$[^$\n]*\$|\\\([\s\S]*?\\\)|&(?:quot|apos|#34|#39);[^\n]*/gu)) {
    protectedSpans.push({ start: match.index, end: match.index + match[0].length });
  }
  const changes = [];
  let delta = 0;
  const text = source.replace(/&(?:nbsp|#160|#x0*a0|amp);/giu, (entity, start) => {
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    const end = source.indexOf('\n', start);
    const line = source.slice(lineStart, end < 0 ? source.length : end);
    if (/^\s*>/u.test(line) || /[“”‘’「」『』"']/u.test(line)
        || protectedSpans.some(span => span.start <= start && span.end > start)
        || /^&amp;/iu.test(entity) && /^(?:#\w+|\w+);/u.test(source.slice(start + entity.length))) return entity;
    const replacement = /^&amp;/iu.test(entity) ? '&' : ' ';
    changes.push({ sourceStart: start, sourceEnd: start + entity.length,
      normalizedStart: start + delta, normalizedEnd: start + delta + replacement.length,
      code: 'source_prose_entity_decoded' });
    delta += replacement.length - entity.length;
    return replacement;
  });
  return { text, changed: text !== source, version: VERSION, unit: 'utf16',
    sourceDigest: hash(source), normalizedDigest: hash(text), changes };
}

// Ambiguous clipped token: flag and preserve it; there is no evidence to choose
// between 과제/문제/주제/etc. This is deliberately not a Korean typo dictionary.
function clippedOpening(value) {
  const text = String(value || '');
  const match = text.match(/^\s*(제를)(?=\s+[가-힣])/u);
  if (!match || text.trim().length < 20) return null;
  const start = match[0].lastIndexOf(match[1]);
  return { code: 'source_clipped_opening_review', start, end: start + match[1].length };
}

function auditInputCompletion(source, output) {
  const opening = clippedOpening(source);
  if (!opening || /^\s*제를(?=\s)/u.test(String(output || ''))) return [];
  return [{ code: 'source_clipped_opening_replaced', sourceStart: opening.start,
    sourceEnd: opening.end, outputStart: 0,
    outputEnd: String(output || '').match(/^\s*\S+/u)?.[0].length || 0 }];
}

function inputStatus(preflight = {}, semanticStatus = 'unknown', effectStatus = 'unknown') {
  const codes = [...new Set(preflight.issueCodes || [])];
  const defects = codes.filter(code => /source_(?:clipped_opening_review|truncated_|incomplete_sentence|math_content_gap|unclosed_delimiter|template_placeholder)/u.test(code));
  return { version: VERSION,
    completeness: defects.length ? 'review_required' : 'no_issue_detected',
    // No local checker can establish that omitted input never existed.
    structure: codes.includes('source_pdf_reading_order_unverified') ? 'review_required'
      : preflight.changed ? 'normalized' : 'unchanged',
    semantic: ['pass', 'fail', 'stale', 'uncertain', 'skipped'].includes(semanticStatus) ? semanticStatus : 'unknown',
    style: ['normal', 'limited', 'effective', 'improved', 'not_applicable'].includes(effectStatus) ? effectStatus : 'unknown',
    issueCodes: defects.slice(0, 30), entityRepairCount: preflight.encodingNormalization?.changes?.length || 0 };
}

module.exports = { VERSION, normalizeProseEntities, clippedOpening, auditInputCompletion, inputStatus };
