'use strict';

const { syntaxSpans } = require('../engine/textSyntax');

// A quoted clause followed by its particle is inline prose, even when copied
// across blank lines. Its literal contents remain owned by the quote. This
// module owns only surrounding whitespace, never punctuation or quoted words.
function dependentQuoteLayout(value) {
  const text = String(value || '');
  if (!/\n/u.test(text) || !/^[ \t]*[“‘「『《〈"']/mu.test(text)) {
    return {text,applied:false,repairCount:0,proseLines:new Set(),edits:[]};
  }
  const lines = []; let offset = 0;
  for (const raw of text.split('\n')) {
    lines.push({ start: offset, end: offset + raw.length, raw, text: raw.trim() });
    offset += raw.length + 1;
  }
  const spans = syntaxSpans(text);
  // syntaxSpans is sorted by start/end. Track earlier-start coverage instead of
  // comparing every span to every other span (quadratic on quote-heavy input).
  const quotes = [], codeSpans = [];
  let groupStart = -1, groupEnd = -1, earlierEnd = -1;
  for (const span of spans) {
    if (span.start !== groupStart) {
      earlierEnd = Math.max(earlierEnd, groupEnd);
      groupStart = span.start;
      groupEnd = span.end;
    } else groupEnd = Math.max(groupEnd, span.end);
    if (span.spanType === 'quote' && earlierEnd <= span.end) quotes.push(span);
    if (span.spanType === 'code') codeSpans.push(span);
  }
  const edits = new Map(), proseLines = new Set();
  const blocked = new Set(); let reference = false, codeCursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i];
    while (codeCursor < codeSpans.length && codeSpans[codeCursor].end <= row.start) codeCursor++;
    if (/^(?:참고\s*문헌|참고\s*자료|출처|References|Bibliography)(?:\s|$|[:：])/iu.test(row.text)) reference = true;
    if (reference || /^(?:>|#{1,6}\s|[-*+]\s|\d+[.)]\s|[①-⑳]|제\s*\d+\s*조|표\s*\d|그림\s*\d|[-—–]\s*\S)/u.test(row.text)
        || /\t|\|/u.test(row.raw)
        || (codeSpans[codeCursor]?.start <= row.end && codeSpans[codeCursor]?.end > row.start)) blocked.add(i);
  }
  const add = (start, end, replacement) => {
    const gap = text.slice(start, end);
    if (/\n/u.test(gap) && /^\s+$/u.test(gap)) edits.set(start, { start, end, replacement });
  };
  let lineCursor = 0;
  for (const quote of quotes) {
    if (text.slice(quote.start, quote.end).includes('\n')) continue;
    while (lineCursor + 1 < lines.length && lines[lineCursor + 1].start <= quote.start) lineCursor++;
    const index = lineCursor;
    if (lines[index].end < quote.end || blocked.has(index)) continue;
    const row = lines[index];
    // Only a detached quotation, not a trailing quotation in a complete line.
    if (text.slice(row.start, quote.start).trim()) continue;
    const inlineTail = text.slice(quote.end, row.end).trim();
    let next = inlineTail ? index : index + 1;
    while (next < lines.length && !lines[next].text) next++;
    if (!lines[next] || blocked.has(next)) continue;
    const tail = inlineTail || lines[next].text;
    const copula = /^(?:이었다|였다|이다|입니다|였습니다|이었습니다)(?=$|[.!?。！？]|\s)/u.test(tail);
    const particle = /^(?:은|는|을|를|이|가|와|과|에|로|으로|에서|이라고|라고|이라는|라는|이라며|라며)(?=\s)/u.test(tail);
    if (!copula && (!particle || tail.split(/\s+/u).length < 2)) continue;
    // A bare demonstrative is not a particle belonging to the quotation.
    if (/^(?:이|가)\s/u.test(tail)) continue;
    const tailStart = lines[next].start + lines[next].raw.indexOf(tail);
    add(quote.end, tailStart, '');
    proseLines.add(index); proseLines.add(next);
    let prev = index - 1;
    while (prev >= 0 && !lines[prev].text) prev--;
    if (prev < 0 || blocked.has(prev)) continue;
    const lead = lines[prev].text;
    // Require an unfinished grammatical lead-in. Complete sentences, labels,
    // attribution bylines and nominal headings retain their own boundaries.
    if (lead.length < 6 || lead.split(/\s+/u).length < 2
        || /[.!?。！？:：;；”’」』》〉"']$/u.test(lead)
        || !/(?:이었던|였던|이라는|라는|이란|란|인|하면서|하며|통해|하여|하고|이며|되어|은|는|을|를)$/u.test(lead)) continue;
    add(lines[prev].end - (lines[prev].raw.length - lines[prev].raw.trimEnd().length), quote.start, ' ');
    proseLines.add(prev);
  }
  const changes = [...edits.values()].sort((a,b) => b.start-a.start);
  // Assemble once; repeatedly copying the complete document per edit was also
  // quadratic. Keep the public edit list in its original descending order.
  const parts = []; let cursor = 0;
  for (let i = changes.length - 1; i >= 0; i--) {
    const edit = changes[i];
    parts.push(text.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  parts.push(text.slice(cursor));
  const result = changes.length ? parts.join('') : text;
  return { text: result, applied: changes.length > 0, repairCount: changes.length, proseLines, edits: changes };
}

function canRepairDependentQuoteLayout(profile, { lineSensitive = false, mode = '' } = {}) {
  const name = typeof profile === 'string' ? profile : profile?.profile;
  return mode !== 'polish' && !lineSensitive
    && ['report_assignment', 'academic_paper', 'long_explainer', 'general', 'general_essay', 'personal_essay', 'resume_application', 'review_blog', 'blog_review'].includes(name);
}

module.exports = { dependentQuoteLayout, canRepairDependentQuoteLayout };
