'use strict';

// ASCII quote glyphs also occur in angles, imperial dimensions and derivatives.
// Recognize these from local positive evidence; never rewrite the source glyphs.
function isNotationPrime(text, index) {
  const ch = text[index];
  if (ch !== "'" && ch !== '"') return false;
  const left = text.slice(Math.max(0, index - 64), index);
  const right = text.slice(index + 1, index + 40);
  if (ch === "'" && /\d+(?:\.\d+)?\s*°\s*\d+(?:\.\d+)?\s*$/u.test(left)) return true;
  if (ch === '"' && /\d+(?:\.\d+)?\s*°\s*\d+(?:\.\d+)?\s*['′]\s*\d+(?:\.\d+)?\s*$/u.test(left)) return true;
  if (ch === "'" && /\d+(?:\.\d+)?$/u.test(left) && /^\s*\d+(?:\.\d+)?\s*["″]/u.test(right)) return true;
  if (ch === '"' && /\d+(?:\.\d+)?\s*['′]\s*\d+(?:\.\d+)?\s*$/u.test(left)) return true;
  // A single function symbol followed by primes and an argument, not an English
  // word or a quoted single letter. Closing quotes are handled by the caller.
  return ch === "'" && /(?:^|[^\p{L}\p{N}_])(?:[A-Za-zα-ωΑ-Ω])'{0,3}$/u.test(left)
    && /^'{0,3}\s*\(/u.test(right);
}

// Offset-only syntax ownership, shared by sentence counting and detection.
// No normalization: all offsets are UTF-16 offsets into the submitted text.
function syntaxSpans(value) {
  const text = String(value || '');
  return require('./textAnalysisCache').memoizeSpans('syntax', text, () => analyzeSyntaxSpans(text));
}

function analyzeSyntaxSpans(text) {
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
  if (!/[“‘「『《〈"'(\[（]/u.test(text)) return spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const pairs = { '“': '”', '‘': '’', '「': '」', '『': '』', '《': '》', '〈': '〉', '"': '"', "'": "'", '(': ')', '[': ']', '（': '）' };
  const codeSpans = spans.filter(span => span.spanType === 'code').sort((a,b) => a.start-b.start);
  let codeCursor = 0;
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    while (codeCursor < codeSpans.length && codeSpans[codeCursor].end <= i) codeCursor++;
    if (codeSpans[codeCursor] && codeSpans[codeCursor].start <= i) { i = codeSpans[codeCursor].end - 1; continue; }
    if (text[i - 1] === '\\') continue;
    const ch = text[i];
    // A numeral immediately followed by a mark with no quote to close is a
    // postfix notation (feet/inches/arcminutes), not a new quote opener.
    if ((ch === "'" || ch === '"') && /\d/u.test(text[i - 1] || '') && stack.at(-1)?.close !== ch) continue;
    const quotedSingleSymbol = ch === "'" && stack.at(-1)?.close === ch
      && i - stack.at(-1).start === 2;
    // If the entire quote is a numeric/angle literal, its final mark closes
    // that quote. Do not let a quoted coordinate consume the next quotation.
    const quotedNumericLiteral = stack.at(-1)?.close === ch
      && /^\d[\d.°′″'"\s]*$/u.test(text.slice(stack.at(-1).start + 1, i))
      && !/^\s*\d/u.test(text.slice(i + 1));
    if (!quotedSingleSymbol && !quotedNumericLiteral && isNotationPrime(text, i)) continue;
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
