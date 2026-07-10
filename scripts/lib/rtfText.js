'use strict';

const decoder = new TextDecoder('euc-kr', { fatal: false });
const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer',
  'headerl', 'headerr', 'footerl', 'footerr', 'filetbl', 'listtable', 'listoverridetable',
  'generator', 'datastore', 'themedata', 'colorschememapping'
]);

function rtfToText(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : Buffer.from(buffer || '').toString('latin1');
  const stack = [];
  let state = { skip: false, uc: 1, ignorable: false };
  let output = '';
  let bytes = [];
  let unicodeFallback = 0;

  const flushBytes = () => {
    if (!bytes.length || state.skip) {
      bytes = [];
      return;
    }
    output += decoder.decode(Uint8Array.from(bytes));
    bytes = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (unicodeFallback > 0) {
      if (ch === '\\' && source[i + 1] === "'") i += 3;
      unicodeFallback -= 1;
      continue;
    }
    if (ch === '{') {
      flushBytes();
      stack.push({ ...state });
      continue;
    }
    if (ch === '}') {
      flushBytes();
      state = stack.pop() || state;
      continue;
    }
    if (ch !== '\\') {
      if (!state.skip && ch !== '\r' && ch !== '\n') output += ch;
      continue;
    }

    flushBytes();
    const next = source[i + 1] || '';
    if (next === "'" && /^[0-9a-f]{2}$/iu.test(source.slice(i + 2, i + 4))) {
      while (source[i] === '\\' && source[i + 1] === "'" && /^[0-9a-f]{2}$/iu.test(source.slice(i + 2, i + 4))) {
        bytes.push(parseInt(source.slice(i + 2, i + 4), 16));
        i += 4;
      }
      i -= 1;
      flushBytes();
      continue;
    }
    if ('{}\\'.includes(next)) {
      if (!state.skip) output += next;
      i += 1;
      continue;
    }
    if (next === '*') {
      state.ignorable = true;
      state.skip = true;
      i += 1;
      continue;
    }
    if (next === '~') {
      if (!state.skip) output += ' ';
      i += 1;
      continue;
    }
    if (next === '-') {
      i += 1;
      continue;
    }

    const match = source.slice(i + 1).match(/^([A-Za-z]+)(-?\d+)? ?/u);
    if (!match) continue;
    const word = match[1];
    const number = match[2] == null ? null : Number(match[2]);
    i += match[0].length;
    if (SKIP_DESTINATIONS.has(word)) {
      state.skip = true;
      continue;
    }
    if (state.skip) continue;
    if (word === 'par' || word === 'line') output += '\n';
    else if (word === 'tab') output += '\t';
    else if (word === 'emdash') output += '—';
    else if (word === 'endash') output += '–';
    else if (word === 'bullet') output += '•';
    else if (word === 'lquote') output += '‘';
    else if (word === 'rquote') output += '’';
    else if (word === 'ldblquote') output += '“';
    else if (word === 'rdblquote') output += '”';
    else if (word === 'uc' && Number.isFinite(number)) state.uc = Math.max(0, number);
    else if (word === 'u' && Number.isFinite(number)) {
      const codePoint = number < 0 ? number + 65536 : number;
      output += String.fromCharCode(codePoint);
      unicodeFallback = state.uc;
    }
  }
  flushBytes();
  return output
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/\u0000/gu, '')
    .trim();
}

module.exports = { rtfToText };
