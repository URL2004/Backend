'use strict';

const { splitSentenceSpans, hasSentenceTerminator } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');

// Preserve physical rows and cells, including tables pasted without a divider.
// Pipes inside code or escaped pipes are content, never cell boundaries.
function tableCells(source) {
  const code = syntaxSpans(source).filter(span => span.spanType === 'code');
  const cells = [];
  let rowIndex = 0;
  for (const match of source.matchAll(/[^\r\n]+/gu)) {
    if (!/^\s*\|/u.test(match[0])) continue;
    const pipes = [];
    for (let i = 0; i < match[0].length; i += 1) {
      const offset = match.index + i;
      if (source[offset] !== '|' || code.some(span => span.start <= offset && offset < span.end)) continue;
      let escapes = 0;
      while (source[offset - escapes - 1] === '\\') escapes += 1;
      if (escapes % 2 === 0) pipes.push(offset);
    }
    if (pipes.length < 2) continue;
    const rowEnd = match.index + match[0].length;
    if (source.slice(pipes.at(-1) + 1, rowEnd).trim()) pipes.push(rowEnd);
    for (let columnIndex = 0; columnIndex < pipes.length - 1; columnIndex += 1) {
      let start = pipes[columnIndex] + 1, end = pipes[columnIndex + 1];
      while (start < end && /\s/u.test(source[start])) start += 1;
      while (end > start && /\s/u.test(source[end - 1])) end -= 1;
      const text = source.slice(start, end);
      // Nominal headers, separators, numeric cells and keyword lists do not
      // become evidence merely because they occupy a table cell.
      const prose = /[가-힣A-Za-z]/u.test(text) && text.length >= 12
        && (hasSentenceTerminator(text) || /(?:습니다|입니다|한다|된다|했다|있다|없다|어요|까요|나요)$/u.test(text));
      cells.push({ start, end, rowStart: match.index, rowEnd, rowIndex, columnIndex, prose });
    }
    rowIndex += 1;
  }
  return cells;
}

// Only dense, narrow, repeatedly wrapped prose enables this repair. A blank
// line in an ordinary document remains a boundary. We mask layout whitespace
// at the same UTF-16 positions, never concatenate source text or move offsets.
function wrappedSource(source) {
  const lines = [...source.matchAll(/[^\r\n]+/gu)].filter(match => match[0].trim());
  const code = syntaxSpans(source).filter(span => span.spanType === 'code');
  const structural = value => /^\s*(?:#{1,6}|>|\||```|~~~|\d+[.)]\s|[-*•]\s|참고\s*문헌|references\b)/iu.test(value)
    || /\t/u.test(value) || /^[^.!?。！？]{0,25}[:：]/u.test(value)
    || /(?:과제|발표\s*원고|감상문|보고서)\s*$/u.test(value);
  const finite = value => /(?:[.!?。！？…:：]["”’」』)]?|다|요|죠|까|음|함|임|됨)\s*$/u.test(value);
  const narrow = lines.filter(match => match[0].trim().length >= 30 && match[0].trim().length <= 110 && !structural(match[0])
    && !code.some(span => span.start <= match.index && match.index < span.end));
  if (narrow.length < 6 || narrow.length < lines.length * 0.5
      || narrow.filter(match => !finite(match[0])).length < 4) return source;
  const widths = narrow.map(match => match[0].trim().length).sort((a, b) => a - b);
  if (widths[Math.floor(widths.length * 0.75)] - widths[Math.floor(widths.length * 0.25)] > 18) return source;
  const chars = source.split('');
  for (let i = 0; i < lines.length - 1; i += 1) {
    const left = lines[i], right = lines[i + 1];
    if (!narrow.includes(left) || finite(left[0]) || structural(right[0])
      || code.some(span => span.start <= right.index && right.index < span.end)) continue;
    const from = left.index + left[0].length, to = right.index;
    if (!/^\s+$/u.test(source.slice(from, to))) continue;
    for (let offset = from; offset < to; offset += 1) chars[offset] = ' ';
  }
  return chars.join('');
}

function detectionSentenceSpans(source, analysisSource = wrappedSource(source)) {
  return splitSentenceSpans(analysisSource).map(span => ({ ...span, text: source.slice(span.start, span.end) }));
}

module.exports = { tableCells, wrappedSource, detectionSentenceSpans };
