'use strict';

// Only high-confidence, complete braced functions and include directives.
// A missing fence must not expose program text to prose editing. Conversely,
// an unmatched brace must not freeze the rest of an ordinary document.
function bareCodeSpans(value) {
  const text = String(value || '');
  const spans = [];
  for (const match of text.matchAll(/^[ \t]*#\s*include\s*[<"][^>"\r\n]+[>"][ \t]*(?=\r?$)/gm)) {
    spans.push({ start: match.index, end: match.index + match[0].length, spanType: 'code', form: 'bare_directive' });
  }
  const headers = /^[ \t]*(?:(?:(?:static|inline|public|private|protected|unsigned|signed|async)\s+)*(?:int|void|double|float|char|long|short|bool|boolean|String|size_t)\s+[*&\s]*[A-Za-z_]\w*\s*\([^\r\n{};]{0,240}\)|(?:async\s+)?function\s+[A-Za-z_]\w*\s*\([^\r\n{};]{0,240}\))[ \t]*\{/gm;
  let match;
  while ((match = headers.exec(text))) {
    if (spans.some(span => span.start <= match.index && span.end > match.index)) continue;
    const open = match.index + match[0].lastIndexOf('{');
    const end = closingBrace(text, open);
    if (end < 0) continue;
    const newline = text.indexOf('\n', end);
    const lineEnd = newline < 0 ? text.length : newline;
    if (!/^[ \t]*(?:;[ \t]*)?(?:\/\/[^\r\n]*)?\r?$/u.test(text.slice(end, lineEnd))) continue;
    spans.push({ start: match.index, end: lineEnd, spanType: 'code', form: 'bare_braced' });
    headers.lastIndex = lineEnd;
  }
  return spans.sort((a, b) => a.start - b.start);
}

function closingBrace(text, start) {
  let depth = 0, quote = '', comment = '';
  for (let i = start; i < Math.min(text.length, start + 20000); i++) {
    const ch = text[i], next = text[i + 1];
    if (comment === 'line') { if (ch === '\n') comment = ''; continue; }
    if (comment === 'block') { if (ch === '*' && next === '/') { comment = ''; i++; } continue; }
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

module.exports = { bareCodeSpans };
