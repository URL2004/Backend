'use strict';

// Offset-only syntax ownership, shared by sentence counting and detection.
// No normalization: all offsets are UTF-16 offsets into the submitted text.
function syntaxSpans(value) {
  const text = String(value || '');
  const spans = [];
  const code = /^(?:[ \t]*)(`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r)/gm;
  let match;
  while ((match = code.exec(text))) {
    // Backtick info strings cannot contain backticks. A same-line triple
    // backtick span is inline code, not an unclosed fence owning the document.
    if (match[1][0] === '`' && match[0].trimStart().slice(match[1].length).includes('`')) continue;
    const endRe = new RegExp('^[ \\t]*' + match[1][0] + '{' + match[1].length + ',}[ \\t]*(?=\\r?$)', 'gm');
    endRe.lastIndex = code.lastIndex;
    const close = endRe.exec(text);
    const end = close ? close.index + close[0].length : text.length;
    spans.push({ start: match.index, end, spanType: 'code' });
    code.lastIndex = end;
  }
  const insideCode = index => spans.some(span => span.spanType === 'code' && index >= span.start && index < span.end);
  for (const inline of text.matchAll(/(`+)([^`\r\n]+)\1/gu)) {
    if (!insideCode(inline.index)) spans.push({ start: inline.index, end: inline.index + inline[0].length, spanType: 'code' });
  }
  for (const bare of require('./bareCode').bareCodeSpans(text)) {
    if (!spans.some(span => span.start < bare.end && span.end > bare.start)) spans.push(bare);
  }
  const pairs = { '“': '”', '‘': '’', '「': '」', '『': '』', '《': '》', '〈': '〉', '"': '"', "'": "'", '(': ')', '[': ']', '（': '）' };
  const codeSpans = spans.filter(span => span.spanType === 'code').sort((a,b) => a.start-b.start);
  let codeCursor = 0;
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    while (codeCursor < codeSpans.length && codeSpans[codeCursor].end <= i) codeCursor++;
    if (codeSpans[codeCursor] && codeSpans[codeCursor].start <= i) { i = codeSpans[codeCursor].end - 1; continue; }
    if (text[i - 1] === '\\') continue;
    const ch = text[i];
    // Apostrophes inside Latin words (don't / don’t) are not quote ends.
    // Korean quoted terms attach particles directly: ‘검증’을 must close.
    if ((ch === "'" || ch === '’') && /[\p{Script=Latin}\p{N}]/u.test(text[i - 1] || '') && /[\p{Script=Latin}\p{N}]/u.test(text[i + 1] || '')) continue;
    if (stack.length && stack.at(-1).close === ch) {
      const open = stack.pop();
      spans.push({ start: open.start, end: i + 1, spanType: open.type });
    } else if (pairs[ch]) {
      stack.push({ start: i, close: pairs[ch], type: /[(\[（]/u.test(ch) ? 'parenthetical' : 'quote' });
    }
  }
  return spans.sort((a, b) => a.start - b.start || b.end - a.end);
}

module.exports = { syntaxSpans };
